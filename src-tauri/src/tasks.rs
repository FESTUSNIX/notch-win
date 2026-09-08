//! TickTick is authoritative. Failed reads retain the last snapshot; writes are
//! never automatically retried (especially creates and recurring completions).
use crate::credentials;
use chrono::{Local, TimeZone, Utc};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicI64, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSnapshot {
    #[serde(default)]
    pub demo: bool,
    pub connected: bool,
    pub tasks: Vec<Value>,
    pub projects: Vec<Value>,
    pub updated_at: Option<String>,
    pub day: String,
    pub error: Option<String>,
    pub history_complete: bool,
}

pub struct TaskState {
    view: Mutex<TaskSnapshot>,
    gate: tokio::sync::Mutex<()>,
    client: reqwest::Client,
    retry_at: AtomicI64,
}

impl TaskState {
    pub fn new() -> Self {
        let mut snapshot = TaskSnapshot::default();
        if crate::fixtures::enabled() {
            let fixture = include_str!("../../src/task-demo.json")
                .replace("$today", &Local::now().format("%Y-%m-%d").to_string())
                .replace("$now", &Utc::now().to_rfc3339());
            snapshot = serde_json::from_str(&fixture).expect("bundled task fixture");
        } else {
            match credentials::read() {
                Ok(token) => snapshot.connected = token.is_some(),
                Err(e) => snapshot.error = Some(e),
            }
        }
        Self {
            view: Mutex::new(snapshot),
            gate: tokio::sync::Mutex::new(()),
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(20))
                .redirect(reqwest::redirect::Policy::none())
                .user_agent("codenotch-win-tasks/0.1")
                .build()
                .expect("HTTP client"),
            retry_at: AtomicI64::new(0),
        }
    }
}

fn allow(window: &WebviewWindow, editor_only: bool) -> Result<(), String> {
    if window.label() == "task-editor" || (!editor_only && window.label() == "tasks") {
        Ok(())
    } else {
        Err("This command belongs to the task windows.".into())
    }
}

fn publish(app: &AppHandle, state: &TaskState, snapshot: TaskSnapshot) {
    *state.view.lock().unwrap() = snapshot.clone();
    for label in ["tasks", "task-editor"] {
        let _ = app.emit_to(label, "tasks:changed", &snapshot);
    }
}

fn failure(app: &AppHandle, state: &TaskState, message: &str) {
    let mut snapshot = state.view.lock().unwrap().clone();
    snapshot.error = Some(message.into());
    publish(app, state, snapshot);
}

fn id(value: &str) -> Result<(), String> {
    if !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        Ok(())
    } else {
        Err("Invalid task or list identifier.".into())
    }
}

fn title(value: &str) -> Result<&str, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 1000 {
        Err("Enter a task title of 1–1000 characters.".into())
    } else {
        Ok(value)
    }
}

async fn request(
    state: &TaskState,
    token: &str,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let wait = state.retry_at.load(Ordering::Relaxed) - Utc::now().timestamp();
    if wait > 0 {
        return Err(format!("TickTick rate limited. Retry in {wait} seconds."));
    }
    let mut req = state
        .client
        .request(method, format!("https://api.ticktick.com/open/v1/{path}"))
        .bearer_auth(token);
    if let Some(body) = body {
        req = req.json(&body);
    }
    let response = req.send().await.map_err(|_| "Cannot reach TickTick. If saving, refresh before retrying: the server may have received the change.".to_string())?;
    let status = response.status();
    if status.as_u16() == 429 {
        let seconds = response
            .headers()
            .get("retry-after")
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(60)
            .clamp(60, 86400);
        state
            .retry_at
            .store(Utc::now().timestamp() + seconds, Ordering::Relaxed);
        return Err(format!(
            "TickTick rate limited. Retry in {seconds} seconds."
        ));
    }
    if !status.is_success() {
        return Err(match status.as_u16() {
            401 | 403 => {
                "TickTick denied access. Check your token and list permissions in Tasks settings."
                    .into()
            }
            404 => {
                "This task or list is no longer available. Refresh to see the latest tasks.".into()
            }
            _ => format!(
                "TickTick returned HTTP {}. Refresh before retrying a change.",
                status.as_u16()
            ),
        });
    }
    let bytes = response.bytes().await.map_err(|_| {
        "TickTick's response was interrupted. Refresh before retrying a change.".to_string()
    })?;
    if bytes.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_slice(&bytes).map_err(|_| {
        "TickTick returned an unreadable response. Refresh before retrying a change.".into()
    })
}

fn array(value: Value) -> Result<Vec<Value>, String> {
    value
        .as_array()
        .cloned()
        .ok_or_else(|| "TickTick returned an unexpected task list.".into())
}

async fn collect(state: &TaskState, token: &str) -> Result<TaskSnapshot, String> {
    let projects = array(request(state, token, Method::GET, "project", None).await?)?;
    let mut tasks = Vec::new();
    for project in &projects {
        if project["closed"] == true || project["kind"] == "NOTE" {
            continue;
        }
        let project_id = project["id"]
            .as_str()
            .ok_or("TickTick returned a list without an ID.")?;
        id(project_id)?;
        let data = request(
            state,
            token,
            Method::GET,
            &format!("project/{project_id}/data"),
            None,
        )
        .await?;
        tasks.extend(array(data["tasks"].clone())?);
    }
    let now = Local::now();
    let start = Local
        .from_local_datetime(&now.date_naive().and_hms_opt(0, 0, 0).unwrap())
        .earliest()
        .ok_or("Could not determine the start of today.")?;
    // Match the active-list scope exactly: counting completions from an Inbox
    // that the list endpoint did not expose would inflate daily progress.
    let project_ids: Vec<&str> = projects
        .iter()
        .filter(|p| p["closed"] != true && p["kind"] != "NOTE")
        .filter_map(|p| p["id"].as_str())
        .collect();
    let completed = if project_ids.is_empty() {
        Vec::new()
    } else {
        array(
            request(
                state,
                token,
                Method::POST,
                "task/completed",
                Some(json!({
                    "projectIds": project_ids,
                    "startDate": start.format("%Y-%m-%dT%H:%M:%S%z").to_string(),
                    "endDate": now.format("%Y-%m-%dT%H:%M:%S%z").to_string()
                })),
            )
            .await?,
        )?
    };
    let history_complete = completed.len() < 200;
    tasks.extend(completed);
    Ok(TaskSnapshot {
        demo: false,
        connected: true,
        tasks,
        projects,
        updated_at: Some(Utc::now().to_rfc3339()),
        day: now.format("%Y-%m-%d").to_string(),
        history_complete,
        error: None,
    })
}

// Caller owns gate, so an in-flight poll cannot resurrect a disconnected account
// or overwrite a successful mutation with an older response.
async fn refresh_locked(app: &AppHandle, state: &TaskState) -> Result<(), String> {
    if crate::fixtures::enabled() {
        return Ok(());
    }
    match credentials::read()? {
        Some(token) => match collect(state, &token).await {
            Ok(snapshot) => {
                publish(app, state, snapshot);
                Ok(())
            }
            Err(e) => {
                failure(app, state, &e);
                Err(e)
            }
        },
        None => {
            publish(app, state, TaskSnapshot::default());
            Ok(())
        }
    }
}

#[tauri::command]
pub fn get_tasks(
    window: WebviewWindow,
    state: tauri::State<TaskState>,
) -> Result<TaskSnapshot, String> {
    allow(&window, false)?;
    Ok(state.view.lock().unwrap().clone())
}

#[tauri::command]
pub async fn refresh_tasks(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    allow(&window, false)?;
    let state = app.state::<TaskState>();
    let _guard = state.gate.lock().await;
    refresh_locked(&app, &state).await
}

#[tauri::command]
pub async fn connect_ticktick(
    app: AppHandle,
    window: WebviewWindow,
    token: String,
) -> Result<(), String> {
    allow(&window, true)?;
    if crate::fixtures::enabled() {
        return Err("Demo mode does not connect to TickTick.".into());
    }
    let token = token.trim();
    if token.is_empty() || token.len() > 2500 || !token.bytes().all(|c| c.is_ascii_graphic()) {
        return Err("Enter a valid TickTick API token.".into());
    }
    let state = app.state::<TaskState>();
    let _guard = state.gate.lock().await;
    // Validate before replacing a working account. No token ever crosses back
    // to either page, even when the API or Credential Manager fails.
    let snapshot = collect(&state, token).await?;
    credentials::write(token)?;
    publish(&app, &state, snapshot);
    Ok(())
}

#[tauri::command]
pub async fn disconnect_ticktick(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    allow(&window, true)?;
    if crate::fixtures::enabled() {
        return Err("Demo mode cannot change saved credentials.".into());
    }
    let state = app.state::<TaskState>();
    let _guard = state.gate.lock().await;
    credentials::delete()?;
    publish(&app, &state, TaskSnapshot::default());
    Ok(())
}

fn token() -> Result<String, String> {
    if crate::fixtures::enabled() {
        return Err("Demo tasks are read-only in the native app.".into());
    }
    credentials::read()?.ok_or_else(|| "Connect TickTick first.".into())
}

async fn fresh(
    state: &TaskState,
    token: &str,
    project_id: &str,
    task_id: &str,
) -> Result<Value, String> {
    id(project_id)?;
    id(task_id)?;
    request(
        state,
        token,
        Method::GET,
        &format!("project/{project_id}/task/{task_id}"),
        None,
    )
    .await
}

async fn after_write(app: &AppHandle, state: &TaskState) {
    // A refresh failure is reported in the snapshot, not as a failed create:
    // otherwise retrying the form would duplicate an already-created task.
    if let Err(e) = refresh_locked(app, state).await {
        failure(app, state, &format!("Change saved. Refresh failed: {e}"));
    }
}

#[tauri::command]
pub async fn complete_task(
    app: AppHandle,
    window: WebviewWindow,
    project_id: String,
    task_id: String,
    expected_start: Option<String>,
) -> Result<(), String> {
    allow(&window, false)?;
    let state = app.state::<TaskState>();
    let _guard = state.gate.lock().await;
    let token = token()?;
    let task = fresh(&state, &token, &project_id, &task_id).await?;
    if task["status"] == 2 {
        after_write(&app, &state).await;
        return Ok(());
    }
    if task["repeatFlag"].as_str().is_some_and(|r| !r.is_empty())
        && task["startDate"].as_str() != expected_start.as_deref()
    {
        after_write(&app, &state).await;
        return Err("This recurring task has moved to another occurrence. Review the refreshed task before completing it.".into());
    }
    request(
        &state,
        &token,
        Method::POST,
        &format!("project/{project_id}/task/{task_id}/complete"),
        None,
    )
    .await?;
    after_write(&app, &state).await;
    Ok(())
}

fn checklist_patch(mut task: Value, item_id: &str, done: bool) -> Result<Value, String> {
    if task["status"] == 2 {
        return Err("Reopen the completed task in TickTick before changing its checklist.".into());
    }
    let items = task["items"]
        .as_array_mut()
        .ok_or("This task has no checklist.")?;
    let item = items
        .iter_mut()
        .find(|v| v["id"] == item_id)
        .ok_or("This checklist item no longer exists.")?;
    item["status"] = json!(if done { 1 } else { 0 });
    item["completedTime"] = if done {
        json!(Utc::now().format("%Y-%m-%dT%H:%M:%S%z").to_string())
    } else {
        Value::Null
    };
    Ok(json!({ "id": task["id"], "projectId": task["projectId"], "items": task["items"] }))
}

#[tauri::command]
pub async fn set_checklist_item(
    app: AppHandle,
    window: WebviewWindow,
    project_id: String,
    task_id: String,
    item_id: String,
    done: bool,
) -> Result<(), String> {
    allow(&window, false)?;
    let state = app.state::<TaskState>();
    let _guard = state.gate.lock().await;
    let token = token()?;
    let task = fresh(&state, &token, &project_id, &task_id).await?;
    let patch = checklist_patch(task, &item_id, done)?;
    request(
        &state,
        &token,
        Method::POST,
        &format!("task/{task_id}"),
        Some(patch),
    )
    .await?;
    after_write(&app, &state).await;
    Ok(())
}

#[tauri::command]
pub async fn create_task(
    app: AppHandle,
    window: WebviewWindow,
    project_id: String,
    name: String,
    date: Option<String>,
    time_zone: String,
) -> Result<(), String> {
    allow(&window, false)?;
    id(&project_id)?;
    let name = title(&name)?;
    let mut task = json!({"projectId": project_id, "title": name});
    if let Some(date) = date {
        chrono::DateTime::parse_from_rfc3339(&date).map_err(|_| "Invalid task date.")?;
        task["startDate"] = json!(date);
        task["dueDate"] = json!(date);
        task["isAllDay"] = json!(true);
        task["timeZone"] = json!(time_zone);
    }
    let state = app.state::<TaskState>();
    let _guard = state.gate.lock().await;
    let token = token()?;
    request(&state, &token, Method::POST, "task", Some(task)).await?;
    after_write(&app, &state).await;
    Ok(())
}

#[tauri::command]
pub async fn rename_task(
    app: AppHandle,
    window: WebviewWindow,
    project_id: String,
    task_id: String,
    name: String,
) -> Result<(), String> {
    allow(&window, true)?;
    id(&project_id)?;
    id(&task_id)?;
    let name = title(&name)?;
    let state = app.state::<TaskState>();
    let _guard = state.gate.lock().await;
    let token = token()?;
    request(
        &state,
        &token,
        Method::POST,
        &format!("task/{task_id}"),
        Some(json!({
            "id": task_id, "projectId": project_id, "title": name
        })),
    )
    .await?;
    after_write(&app, &state).await;
    Ok(())
}

pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let state = app.state::<TaskState>();
            {
                let _guard = state.gate.lock().await;
                if let Err(e) = refresh_locked(&app, &state).await {
                    failure(&app, &state, &e);
                }
            }
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checklist_patch_preserves_other_items_and_uses_checklist_status() {
        let task = json!({"id":"t", "projectId":"p", "status":0, "title":"Keep", "items":[
            {"id":"a", "title":"One", "status":0, "sortOrder":42, "extra":"keep"},
            {"id":"b", "title":"Two", "status":0}
        ]});
        let patch = checklist_patch(task.clone(), "a", true).unwrap();
        assert_eq!(patch["items"][0]["status"], 1);
        assert_eq!(patch["items"][0]["extra"], "keep");
        assert_eq!(patch["items"][1], task["items"][1]);
        assert!(patch.get("title").is_none());
        assert!(checklist_patch(task, "missing", true).is_err());
    }
    #[test]
    fn validates_titles_and_path_segments() {
        assert!(id("../task").is_err());
        assert!(id("t?token=x").is_err());
        assert!(id("abc123").is_ok());
        assert!(title("  ").is_err());
        assert_eq!(title("  Hello  ").unwrap(), "Hello");
    }
}
