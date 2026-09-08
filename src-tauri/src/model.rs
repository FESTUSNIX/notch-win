//! The reading model, ported from Sources/Model/UsageModel.swift.
//!
//! The contract that matters: a failure is a *visible status*, never a made-up
//! percentage. Every provider either produces windows or says why it could not.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// One limit and when it rolls over. `used_fraction` is 0...1; the endpoint
/// speaks in percent and the conversion happens at the parse site, once.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct LimitWindow {
    pub id: String,
    pub label: String,
    pub used_fraction: f64,
    pub resets_at: DateTime<Utc>,
}

/// How much a reading can be trusted. The UI never presents a guess as if a
/// vendor had published it.
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Fidelity {
    Official,
    Derived,
    Manual,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Status {
    Ok,
    /// The owning tool has never signed in, or has signed out.
    NeedsAuth,
    /// A credential that exists but has aged out. Not the same as signed out:
    /// Claude Code rotates its own token, so this resolves itself the next
    /// time the tool is used. The last good reading stays on screen.
    CredentialExpired,
    RateLimited { retry_after_secs: f64 },
    Error { message: String },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub id: String,
    pub display_name: String,
    pub glyph: String,
    pub fidelity: Fidelity,
    pub status: Status,
    pub windows: Vec<LimitWindow>,
    /// Which window the ring shows. Claude leads with the current session,
    /// the same window Claude Code's own /usage leads with, so the two agree.
    pub headline_id: String,
    /// When these windows were actually read, in unix milliseconds.
    pub read_at_ms: Option<i64>,
    /// True when the windows are carried over from an earlier, successful read
    /// because this one failed.
    ///
    /// ⚠️ A failed fetch must not blank the ring. A transient 429 or a dropped
    /// Wi-Fi connection is not new information about your usage — the last
    /// figure is still the best answer anyone has, and replacing it with a dash
    /// throws away a true reading to report a network event. The old figure
    /// stays, dimmed, and the card says how old it is and why.
    pub stale: bool,
}

impl Snapshot {
    /// Carry a previous good reading forward when this round produced none.
    ///
    /// The *status* is this round's — the card has to be able to say why the
    /// figure is old — but the windows and their timestamp are the last ones
    /// that were actually read. A reading only disappears when the provider
    /// itself goes away.
    pub fn or_stale(mut self, previous: Option<&Snapshot>) -> Snapshot {
        if !self.windows.is_empty() {
            return self;
        }
        let Some(previous) = previous.filter(|p| !p.windows.is_empty()) else {
            return self;
        };
        self.windows = previous.windows.clone();
        self.read_at_ms = previous.read_at_ms;
        self.stale = true;
        self
    }

    /// The percentage the ring draws, or None when there is nothing to draw.
    pub fn headline_percent(&self) -> Option<f64> {
        self.windows
            .iter()
            .find(|w| w.id == self.headline_id)
            .or_else(|| self.windows.first())
            .map(|w| w.used_fraction * 100.0)
    }
}

#[derive(Debug)]
pub enum ProviderError {
    NeedsAuth,
    CredentialExpired,
    RateLimited { retry_after_secs: f64 },
    BadResponse { status: u16 },
    Transport(String),
}

impl From<&ProviderError> for Status {
    fn from(error: &ProviderError) -> Self {
        match error {
            ProviderError::NeedsAuth => Status::NeedsAuth,
            ProviderError::CredentialExpired => Status::CredentialExpired,
            ProviderError::RateLimited { retry_after_secs } => Status::RateLimited {
                retry_after_secs: *retry_after_secs,
            },
            ProviderError::BadResponse { status } => Status::Error {
                message: format!("the endpoint answered {status}"),
            },
            ProviderError::Transport(message) => Status::Error {
                message: message.clone(),
            },
        }
    }
}
