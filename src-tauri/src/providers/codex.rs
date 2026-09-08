//! Codex's usage, borrowed from the session Codex itself keeps.
//!
//! `~/.codex/auth.json` holds `tokens.access_token` and `tokens.account_id`;
//! those authenticate `GET https://chatgpt.com/backend-api/wham/usage`, whose
//! reply carries `rate_limit.{primary_window,secondary_window}`.
//!
//! Read only, never refreshed — the same bargain as Claude's token. Codex mints
//! and rotates it; writing a new one would mean racing the owner for the file.
//!
//! The path is identical to macOS: Codex uses `~/.codex` on Windows too, so
//! this one needed no path translation at all.

use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{DateTime, TimeZone, Utc};
use serde::Deserialize;

use crate::model::{Fidelity, LimitWindow, ProviderError, Snapshot, Status};

const ENDPOINT: &str = "https://chatgpt.com/backend-api/wham/usage";

pub struct Credentials {
    pub access_token: String,
    pub account_id: String,
    /// `chatgpt_plan_type` from the id_token (pro / plus / free…), a label only.
    pub plan: Option<String>,
}

pub fn default_home() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".codex"))
}

pub fn auth_path(home: &Path) -> PathBuf {
    home.join("auth.json")
}

/// A provider that is not installed simply does not get a cell.
pub fn present(home: &Path) -> bool {
    auth_path(home).exists()
}

/// The second JWT segment, base64url. Used only for the plan label — nothing is
/// verified here, which is the server's job.
fn jwt_claims(token: &str) -> Option<serde_json::Value> {
    let part = token.split('.').nth(1)?;
    let mut payload = part.replace('-', "+").replace('_', "/");
    while payload.len() % 4 != 0 {
        payload.push('=');
    }
    use base64::Engine;
    let raw = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .ok()?;
    serde_json::from_slice(&raw).ok()
}

pub fn load_credentials(home: &Path) -> Result<Credentials, ProviderError> {
    let text = std::fs::read_to_string(auth_path(home)).map_err(|_| ProviderError::NeedsAuth)?;
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| ProviderError::NeedsAuth)?;

    let tokens = value.get("tokens").ok_or(ProviderError::NeedsAuth)?;
    let access_token = tokens
        .get("access_token")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or(ProviderError::NeedsAuth)?
        .to_string();
    let account_id = tokens
        .get("account_id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or(ProviderError::NeedsAuth)?
        .to_string();

    let plan = tokens
        .get("id_token")
        .and_then(|v| v.as_str())
        .and_then(jwt_claims)
        .and_then(|claims| {
            claims
                .get("https://api.openai.com/auth")?
                .get("chatgpt_plan_type")?
                .as_str()
                .map(String::from)
        });

    Ok(Credentials {
        access_token,
        account_id,
        plan,
    })
}

/// Codex names its windows only by length, and "5h limit" says more than
/// "primary". The primary window is not always five hours — a free plan has
/// shown thirty days — so the label is derived rather than assumed.
fn label_for(window_seconds: Option<f64>, id: &str) -> String {
    let minutes = window_seconds.map(|s| s / 60.0);
    match minutes {
        Some(m) if m > 0.0 => {
            if m < 60.0 {
                format!("{}m limit", m as i64)
            } else if m < 60.0 * 24.0 {
                format!("{}h limit", (m / 60.0) as i64)
            } else {
                match (m / (60.0 * 24.0)).round() as i64 {
                    7 => "Weekly limit".to_string(),
                    30 => "Monthly limit".to_string(),
                    days => format!("{days}d limit"),
                }
            }
        }
        _ => {
            if id == "primary" {
                "Current session".to_string()
            } else {
                "Longer window".to_string()
            }
        }
    }
}

#[derive(Debug, Deserialize)]
struct Window {
    used_percent: Option<f64>,
    limit_window_seconds: Option<f64>,
    /// Absolute seconds since the epoch.
    reset_at: Option<f64>,
    /// …or a relative hint, when the absolute one is absent.
    reset_after_seconds: Option<f64>,
}

impl Window {
    fn resets_at(&self) -> Option<DateTime<Utc>> {
        if let Some(at) = self.reset_at {
            return Utc.timestamp_opt(at as i64, 0).single();
        }
        self.reset_after_seconds
            .map(|s| Utc::now() + chrono::Duration::seconds(s as i64))
    }
}

/// `additional_rate_limits` and `code_review_rate_limit` meter something else
/// and stay out of the rings.
fn windows_from(value: &serde_json::Value) -> Vec<LimitWindow> {
    let mut out = Vec::new();
    for (id, key) in [("primary", "primary_window"), ("secondary", "secondary_window")] {
        let Some(raw) = value.pointer(&format!("/rate_limit/{key}")) else {
            continue;
        };
        let Ok(window) = serde_json::from_value::<Window>(raw.clone()) else {
            continue;
        };
        let Some(percent) = window.used_percent else {
            continue;
        };
        let Some(resets_at) = window.resets_at() else {
            continue;
        };
        out.push(LimitWindow {
            id: id.to_string(),
            label: label_for(window.limit_window_seconds, id),
            used_fraction: (percent / 100.0).clamp(0.0, 1.0),
            resets_at,
        });
    }
    out
}

pub async fn fetch(
    client: &reqwest::Client,
    credentials: &Credentials,
) -> Result<Vec<LimitWindow>, ProviderError> {
    let response = client
        .get(ENDPOINT)
        .bearer_auth(&credentials.access_token)
        .header("ChatGPT-Account-Id", &credentials.account_id)
        .header("Accept", "application/json")
        .header("Cache-Control", "no-cache, no-store")
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|error| ProviderError::Transport(error.to_string()))?;

    let status = response.status().as_u16();
    if status == 401 || status == 403 {
        return Err(ProviderError::NeedsAuth);
    }
    if status == 429 {
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<f64>().ok());
        return Err(ProviderError::RateLimited {
            retry_after_secs: retry_after.unwrap_or(0.0),
        });
    }
    if !(200..300).contains(&status) {
        return Err(ProviderError::BadResponse { status });
    }

    let payload: serde_json::Value = response
        .json()
        .await
        .map_err(|error| ProviderError::Transport(error.to_string()))?;

    Ok(windows_from(&payload))
}

pub async fn snapshot(client: &reqwest::Client, home: &Path) -> Snapshot {
    fn base(status: Status, windows: Vec<LimitWindow>) -> Snapshot {
        Snapshot {
            id: "codex".to_string(),
            display_name: "Codex".to_string(),
            glyph: "openai".to_string(),
            fidelity: Fidelity::Official,
            status,
            // Codex leads with the shorter window, the way its own /status does.
            headline_id: "primary".to_string(),
            windows,
            read_at_ms: None,
            stale: false,
        }
    }

    let credentials = match load_credentials(home) {
        Ok(credentials) => credentials,
        Err(error) => return base(Status::from(&error), Vec::new()),
    };
    let _ = &credentials.plan;

    match fetch(client, &credentials).await {
        Ok(windows) => {
            let mut snapshot = base(Status::Ok, windows);
            snapshot.read_at_ms = Some(Utc::now().timestamp_millis());
            snapshot
        }
        Err(error) => base(Status::from(&error), Vec::new()),
    }
}
