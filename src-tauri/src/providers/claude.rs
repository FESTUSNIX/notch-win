//! Claude Code's usage, read the way Claude Code's own `/usage` reads it.
//!
//! **This is the subsystem Windows makes simpler, not harder.** On macOS the
//! token lives in the login keychain, which brings an access-control list, a
//! one-time "Always Allow" grant, a requirement to sign every build with a
//! stable Developer ID so that grant survives a rebuild, and a five-case
//! OSStatus taxonomy to tell "signed out" from "refused" from "the machine is
//! in dark wake". On Windows, Claude Code writes the same payload as plain
//! JSON in its config directory. The whole of `ClaudeCredentials.swift` and
//! `ClaudeKeychain` collapses into a file read.
//!
//! What does NOT change: this only ever *reads*. Refreshing is Claude Code's
//! job — minting a token would mean writing a credential this app does not own
//! and racing the owner for the file. An expired token is reported as expired,
//! and the last good reading stays on screen.

use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{DateTime, TimeZone, Utc};
use serde::Deserialize;

use crate::model::{Fidelity, LimitWindow, ProviderError, Snapshot, Status};

const ENDPOINT: &str = "https://api.anthropic.com/api/oauth/usage";
const BETA_HEADER: &str = "oauth-2025-04-20";

pub struct Credentials {
    pub access_token: String,
    pub expires_at: DateTime<Utc>,
    pub subscription_type: Option<String>,
}

impl Credentials {
    pub fn is_expired(&self) -> bool {
        self.expires_at <= Utc::now()
    }
}

/// `%USERPROFILE%\.claude\.credentials.json`.
///
/// The default profile. Claude Code also honours `CLAUDE_CONFIG_DIR`, so a work
/// login under `~/.claude-work` is a second directory with its own token and
/// its own ring — the same as the macOS app's `ClaudeProfile`. Discovering
/// those is the next step; the path is a parameter here so it costs nothing.
pub fn default_config_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".claude"))
}

pub fn credentials_path(config_dir: &Path) -> PathBuf {
    config_dir.join(".credentials.json")
}

pub fn load_credentials(config_dir: &Path) -> Result<Credentials, ProviderError> {
    #[derive(Deserialize)]
    struct Payload {
        #[serde(rename = "claudeAiOauth")]
        claude_ai_oauth: OAuth,
    }

    #[derive(Deserialize)]
    struct OAuth {
        #[serde(rename = "accessToken")]
        access_token: String,
        /// Milliseconds since the epoch, the same as the keychain payload.
        #[serde(rename = "expiresAt")]
        expires_at: i64,
        #[serde(rename = "subscriptionType")]
        subscription_type: Option<String>,
    }

    let path = credentials_path(config_dir);
    let text = std::fs::read_to_string(&path).map_err(|_| ProviderError::NeedsAuth)?;
    let payload: Payload = serde_json::from_str(&text).map_err(|_| ProviderError::NeedsAuth)?;

    let expires_at = Utc
        .timestamp_millis_opt(payload.claude_ai_oauth.expires_at)
        .single()
        .ok_or(ProviderError::NeedsAuth)?;

    Ok(Credentials {
        access_token: payload.claude_ai_oauth.access_token,
        expires_at,
        subscription_type: payload.claude_ai_oauth.subscription_type,
    })
}

/// The endpoint's response.
///
/// `limits` is the forward-compatible shape — it grows new kinds as Anthropic
/// adds them — and the two named windows are merged in rather than used only as
/// a fallback: Claude Code's own schema says an entry is present only while its
/// reset has not passed, so a window that has just rolled over drops out of
/// `limits` while `five_hour` still carries it. Relying on the array alone
/// loses the session exactly when it resets, which is when someone is most
/// likely to be looking.
#[derive(Debug, Deserialize)]
struct UsageResponse {
    limits: Option<Vec<Limit>>,
    five_hour: Option<Window>,
    seven_day: Option<Window>,
}

#[derive(Debug, Deserialize)]
struct Limit {
    kind: String,
    percent: f64,
    resets_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
struct Window {
    utilization: f64,
    resets_at: Option<DateTime<Utc>>,
}

impl UsageResponse {
    fn limit_windows(self) -> Vec<LimitWindow> {
        let mut windows: Vec<LimitWindow> = self
            .limits
            .unwrap_or_default()
            .into_iter()
            .filter_map(|limit| {
                limit.resets_at.map(|resets_at| LimitWindow {
                    label: label_for_kind(&limit.kind),
                    id: limit.kind,
                    used_fraction: limit.percent / 100.0,
                    resets_at,
                })
            })
            .collect();

        merge_named(&mut windows, self.five_hour, "session", "Current session");
        merge_named(&mut windows, self.seven_day, "weekly_all", "All models");

        windows.sort_by_key(|w| display_rank(&w.id));
        windows
    }
}

fn merge_named(windows: &mut Vec<LimitWindow>, window: Option<Window>, id: &str, label: &str) {
    let Some(window) = window else { return };
    let Some(resets_at) = window.resets_at else {
        return;
    };
    if windows.iter().any(|w| w.id == id) {
        return;
    }
    windows.push(LimitWindow {
        id: id.to_string(),
        label: label.to_string(),
        used_fraction: window.utilization / 100.0,
        resets_at,
    });
}

fn label_for_kind(kind: &str) -> String {
    match kind {
        "session" => "Current session".to_string(),
        "weekly_all" => "All models".to_string(),
        "weekly_opus" => "Opus".to_string(),
        "weekly_sonnet" => "Sonnet".to_string(),
        other => {
            let cleaned = other.replace("weekly_", "").replace('_', " ");
            let mut chars = cleaned.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => cleaned,
            }
        }
    }
}

/// Session first, then the weekly windows — the order the design frame shows.
fn display_rank(id: &str) -> u8 {
    match id {
        "session" => 0,
        "weekly_all" => 1,
        _ => 2,
    }
}

/// How long to wait after a 429.
///
/// The server's own hint is honoured only as a floor-raiser: this endpoint
/// answers `Retry-After: 0`, and obeying that literally is what keeps you rate
/// limited. So the wait starts at a minute and doubles per consecutive 429,
/// capped so it always recovers on its own.
pub fn backoff_secs(consecutive: u32, retry_after: Option<f64>) -> f64 {
    const FLOOR: f64 = 60.0;
    const CEILING: f64 = 15.0 * 60.0;
    let doubled = FLOOR * 2f64.powi(consecutive.min(4) as i32);
    CEILING.min(doubled.max(retry_after.unwrap_or(0.0)))
}

pub async fn fetch(
    client: &reqwest::Client,
    credentials: &Credentials,
) -> Result<Vec<LimitWindow>, ProviderError> {
    let response = client
        .get(ENDPOINT)
        .bearer_auth(&credentials.access_token)
        .header("anthropic-beta", BETA_HEADER)
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
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.trim().parse::<f64>().ok());
        return Err(ProviderError::RateLimited {
            retry_after_secs: retry_after.unwrap_or(0.0),
        });
    }
    if !(200..300).contains(&status) {
        return Err(ProviderError::BadResponse { status });
    }

    let payload: UsageResponse = response
        .json()
        .await
        .map_err(|error| ProviderError::Transport(error.to_string()))?;

    Ok(payload.limit_windows())
}

/// One reading, with every failure turned into something the notch can render
/// honestly rather than into an invented number.
/// A cell with no reading of its own, carrying a status.
///
/// Used when the fetch is deliberately not attempted — during a rate-limit
/// back-off — so the provider still gets a ring instead of disappearing.
pub fn pending(status: Status) -> Snapshot {
    base(status, Vec::new())
}

fn base(status: Status, windows: Vec<LimitWindow>) -> Snapshot {
    Snapshot {
        id: "claude".to_string(),
        display_name: "Claude".to_string(),
        glyph: "claude".to_string(),
        fidelity: Fidelity::Official,
        status,
        windows,
        headline_id: "session".to_string(),
        read_at_ms: None,
        stale: false,
    }
}

pub async fn snapshot(client: &reqwest::Client, config_dir: &Path) -> Snapshot {
    let credentials = match load_credentials(config_dir) {
        Ok(credentials) => credentials,
        Err(error) => return base(Status::from(&error), Vec::new()),
    };

    // Expired is not signed out. Claude Code rotates this token whenever it
    // runs and this app deliberately does not, so after a restart it is often
    // stale until Claude Code is next used.
    if credentials.is_expired() {
        return base(Status::CredentialExpired, Vec::new());
    }

    match fetch(client, &credentials).await {
        Ok(windows) => {
            let mut snapshot = base(Status::Ok, windows);
            snapshot.read_at_ms = Some(Utc::now().timestamp_millis());
            snapshot
        }
        Err(error) => base(Status::from(&error), Vec::new()),
    }
}
