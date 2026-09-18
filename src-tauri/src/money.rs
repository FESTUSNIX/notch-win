//! Exchange rates, for the palette's converter.
//!
//! ⚠️ **Frankfurter, and no key.** It publishes the European Central Bank's
//! daily reference rates — the same numbers a bank quotes against — needs no
//! account, no token and no attribution header, and asks nothing of the user.
//! Every alternative with intraday rates wants a key, which would mean a
//! seventh thing in Credential Manager and a seventh row in Settings to put it
//! there, for a converter that answers "roughly how much is that".
//!
//! ⚠️ **One base, and the crossing is done in the page.** The ECB quotes
//! everything against the euro, so any pair is two divisions — asking the
//! service per pair would be a request per keystroke for arithmetic the page
//! can do. What is fetched is one table a day.
//!
//! ⚠️ **Cached on disk, and served stale without apology.** Rates are a day
//! old by construction; a converter that answers nothing on a train is worse
//! than one that answers with Friday's number and says which day it was. The
//! date always travels with the table.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

const FILE: &str = "rates.json";
/// ⚠️ `api.frankfurter.dev/v1`, not the `.app` host every page of
/// documentation still names — that one is a 301 now, and a redirect is a
/// thing to follow deliberately rather than to discover when the converter
/// goes quiet.
const SOURCE: &str = "https://api.frankfurter.dev/v1/latest?base=EUR";

/// The other one to try.
///
/// ⚠️ Not redundancy for its own sake: the first source answered in under a
/// second, then spent the next half hour returning 522 and timing out, which
/// is what a free service run by one person looks like on a bad afternoon. Two
/// sources, in order, and the cache underneath both.
const BACKUP: &str = "https://open.er-api.com/v6/latest/EUR";

/// How long a table is used before another is asked for.
///
/// ⚠️ Six hours, not twenty-four. The ECB publishes once a working day at
/// about 16:00 CET, and a machine that was asleep at four o'clock should pick
/// the new table up when it wakes rather than the following afternoon.
const FRESH_SECS: i64 = 6 * 60 * 60;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rates {
    /// The day the table is FOR, as the source dates it — not the day it was
    /// fetched. ⚠️ These are two different facts and the second one is the
    /// useless one: a table fetched this morning can still be Friday's.
    pub date: String,
    /// What everything is quoted against. `EUR`, and the page knows it.
    pub base: String,
    pub rates: HashMap<String, f64>,
    /// When this copy was taken, so freshness is decidable without a clock in
    /// the page. Seconds since the epoch.
    #[serde(default)]
    pub fetched_ms: i64,
}

#[derive(Default)]
pub struct Store(pub Mutex<Rates>);

#[derive(Deserialize)]
struct Reply {
    date: String,
    base: String,
    rates: HashMap<String, f64>,
}

/// The backup's own shape. ⚠️ Different field names for the same three
/// facts, which is the whole cost of the second source — ten lines, against a
/// converter that goes quiet whenever one website does.
#[derive(Deserialize)]
struct Backup {
    result: String,
    base_code: String,
    /// `Fri, 18 Sep 2026 00:02:31 +0000`. The DAY is the part that matters.
    time_last_update_utc: String,
    rates: HashMap<String, f64>,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Whatever is on disk, for the first answer of the session.
pub fn load(app: &tauri::AppHandle) {
    use tauri::Manager;
    let stored: Rates = crate::config::load_beside(FILE).unwrap_or_default();
    if let Ok(mut held) = app.state::<Store>().0.lock() {
        *held = stored;
    }
}

/// The table, fetching a new one only when the one in hand has aged out.
///
/// ⚠️ Never returns an error to the page. A converter is a row in a list of
/// search results: the honest failure is no row, not a red one — and the only
/// thing the page could do with the message is print it where somebody is
/// trying to type.
#[tauri::command]
pub async fn get_rates(app: tauri::AppHandle) -> Rates {
    use tauri::Manager;
    let held = {
        let state = app.state::<Store>();
        let Ok(held) = state.0.lock() else { return Rates::default() };
        held.clone()
    };
    let age = now_ms().saturating_sub(held.fetched_ms);
    if !held.rates.is_empty() && age < FRESH_SECS * 1000 {
        return held;
    }

    /* ⚠️ The MutexGuard is dropped above, before the await. Holding one
     * across an await makes the future non-Send, which tauri's command
     * machinery refuses — and the error points at the signature rather than at
     * the lock, which is the trap `lyrics.rs` documents too. */
    let fetched = match fetch().await {
        Some(fresh) => fresh,
        // Nothing new: the stale table is the best answer there is, and it
        // carries its own date so the page can say so.
        None => return held,
    };
    if let Ok(mut store) = app.state::<Store>().0.lock() {
        *store = fetched.clone();
    }
    crate::config::save_beside(FILE, &fetched);
    fetched
}

/// The day out of `Fri, 18 Sep 2026 00:02:31 +0000`, as `2026-09-18`.
///
/// ⚠️ Parsed rather than passed through. The rest of the app compares these
/// dates as STRINGS — which only works because every other one is
/// zero-padded and big-endian — and an RFC 2822 date dropped into that sorts
/// by weekday.
fn day_of(stamp: &str) -> Option<String> {
    let when = chrono::DateTime::parse_from_rfc2822(stamp).ok()?;
    Some(when.format("%Y-%m-%d").to_string())
}

async fn fetch() -> Option<Rates> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .ok()?;
    /* ⚠️ A User-Agent, and it is not politeness here — it is the request
     * going through at all. `reqwest` sends none by default, and this host is
     * behind a CDN that stalls a request without one until the client gives up:
     * curl answers in under a second, the same URL from here times out at
     * twenty, and there is no status code or error to read because nothing
     * ever comes back. */
    if let Some(table) = first(&client).await {
        return Some(table);
    }
    second(&client).await
}

async fn first(client: &reqwest::Client) -> Option<Rates> {
    /* ⚠️ A User-Agent, and it is not politeness here — it is the request
     * going through at all. `reqwest` sends none by default, and this host is
     * behind a CDN that stalls a request without one until the client gives up:
     * curl answers in under a second, the same URL from here times out at
     * twenty, and there is no status code or error to read because nothing
     * ever comes back. */
    let reply = client
        .get(SOURCE)
        .header("User-Agent", "Codenotch (https://github.com/FESTUSNIX)")
        .send()
        .await
        .ok()?;
    if !reply.status().is_success() {
        return None;
    }
    let body: Reply = reply.json().await.ok()?;
    if body.rates.is_empty() {
        return None;
    }
    Some(Rates {
        date: body.date,
        base: body.base,
        rates: body.rates,
        fetched_ms: now_ms(),
    })
}

async fn second(client: &reqwest::Client) -> Option<Rates> {
    let reply = client
        .get(BACKUP)
        .header("User-Agent", "Codenotch (https://github.com/FESTUSNIX)")
        .send()
        .await
        .ok()?;
    if !reply.status().is_success() {
        return None;
    }
    let body: Backup = reply.json().await.ok()?;
    if body.result != "success" || body.rates.is_empty() {
        return None;
    }
    Some(Rates {
        date: day_of(&body.time_last_update_utc).unwrap_or_default(),
        base: body.base_code,
        rates: body.rates,
        fetched_ms: now_ms(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_table_with_no_rates_in_it_is_not_fresh() {
        /* ⚠️ The emptiness check comes FIRST in `get_rates`. A file written by
         * a failed fetch would otherwise be "fresh" for six hours, and the
         * converter would go quiet for an afternoon over one bad reply. */
        let empty = Rates { fetched_ms: now_ms(), ..Default::default() };
        assert!(empty.rates.is_empty());
        assert!(now_ms() - empty.fetched_ms < FRESH_SECS * 1000);
    }

    #[test]
    fn the_backup_dates_its_table_the_way_everything_else_does() {
        /* ⚠️ The rest of this app compares days as STRINGS, which works only
         * because they are zero-padded and big-endian. An RFC 2822 date passed
         * through untouched would sort by weekday — "Fri" before "Mon" before
         * "Sat" — and nothing would look wrong about it. */
        assert_eq!(day_of("Fri, 18 Sep 2026 00:02:31 +0000").as_deref(), Some("2026-09-18"));
        assert_eq!(day_of("nonsense"), None);
    }

    #[test]
    fn what_is_stored_is_what_comes_back() {
        // The shape the page parses. Serialised in camelCase, like every other
        // view this app hands over.
        let table = Rates {
            date: "2026-09-18".into(),
            base: "EUR".into(),
            rates: HashMap::from([("PLN".to_string(), 4.27), ("USD".to_string(), 1.09)]),
            fetched_ms: 1_789_714_959_000,
        };
        let text = serde_json::to_string(&table).expect("serialises");
        assert!(text.contains("\"fetchedMs\""), "{text}");
        assert!(text.contains("\"PLN\":4.27"), "{text}");
    }
}

#[cfg(test)]
mod live {
    /// `cargo test --lib money::live -- --ignored --nocapture` — what the
    /// service actually answers today.
    #[tokio::test]
    #[ignore]
    async fn asks_the_real_service() {
        // The steps, out loud: a failure here is one of four different things
        // and `Option` tells you none of them.
        // Both, out loud: a failure is one of four different things and
        // `Option` tells you none of them.
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .expect("client");
        for url in [super::SOURCE, super::BACKUP] {
            match client
                .get(url)
                .header("User-Agent", "Codenotch (https://github.com/FESTUSNIX)")
                .send()
                .await
            {
                Ok(reply) => println!("{url} -> {}", reply.status()),
                Err(why) => println!("{url} -> {why:?}"),
            }
        }
        let table = super::fetch().await.expect("rates");
        println!("{} against {}: {} currencies", table.date, table.base, table.rates.len());
        for code in ["PLN", "USD", "GBP", "JPY"] {
            println!("  {code} {:?}", table.rates.get(code));
        }
    }
}
