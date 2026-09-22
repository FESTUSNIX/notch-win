//! One coin's price, for the board.
//!
//! Binance's **public** market endpoints: no account, no API key, no signing,
//! and a weight budget a one-minute poll does not come close to. That is the
//! whole reason this reads a price and not a balance.
//!
//! ⚠️ **A WALLET is a different feature and deliberately not this one.**
//! Reading a balance needs an API key and an HMAC-SHA256 signature over every
//! request — which means this app would be holding a secret that can, with the
//! wrong permission box ticked, move somebody's money. The app keeps its
//! credentials in Windows Credential Manager and takes them in the native
//! editor, never in a WebView and never over an IPC payload; a wallet belongs
//! behind that door, with read-only keys and a clear warning, and it is worth
//! doing on its own rather than as a corner of a widget. A public price needs
//! none of it.
//!
//! ⚠️ **Opt-in, like the weather.** Nothing here runs and nothing leaves the
//! machine until somebody names a symbol.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::credentials;
use crate::drag::Settings;

/// A minute. ⚠️ Not a second: this is a number you glance at on a board, not a
/// trading screen, and the difference between the two is a poll budget and a
/// thing that twitches in the corner of your eye all day.
const POLL: Duration = Duration::from_secs(60);

/// How many points the sparkline carries. One a day for a month — enough for
/// the line to have a shape, few enough that it stays a line rather than a
/// chart somebody might try to read a value off.
const SPARK: usize = 30;

/// ⚠️ A failed request must not clear a good reading, for the reason `Weather`
/// gives: a blank is indistinguishable from "nothing configured".
/// ⚠️ `camelCase`. Without it `change_pct` reaches the web layer under that
/// name, the widget reads `changePct`, gets `undefined`, and prints "—" for
/// both the percentage and the money — which is exactly what a coin with no
/// movement would look like if the app were working.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Coin {
    /// Empty when nothing is configured, which is the "module off" signal.
    pub symbol: String,
    /// What to call it on screen — `BTCUSDT` is the symbol, `BTC` is the name.
    pub name: String,
    /// What it is priced in, so the widget can put a sign in front.
    pub quote: String,
    pub price: f64,
    /// Over the last 24h, as a percentage. Negative is a fall.
    pub change_pct: f64,
    /// The day's range, for the widget's scale.
    pub high: f64,
    pub low: f64,
    /// Closing prices, oldest first, for the sparkline.
    pub spark: Vec<f64>,
    pub read_at_ms: i64,
}

#[derive(Default)]
pub struct Latest(pub std::sync::Mutex<Option<Coin>>);

#[tauri::command]
pub fn get_crypto(state: tauri::State<Latest>) -> Option<Coin> {
    state.0.lock().ok().and_then(|held| held.clone())
}

/// Set (or clear, with an empty string) the symbol the board follows.
#[tauri::command]
pub async fn set_crypto_symbol(app: AppHandle, symbol: String) -> Result<Option<Coin>, String> {
    let symbol = symbol.trim().to_uppercase();
    {
        let settings = app.state::<Settings>();
        let mut config = settings.0.lock().map_err(|_| "Settings are locked.")?;
        config.crypto_symbol = symbol.clone();
        crate::config::save(&config);
    }
    if symbol.is_empty() {
        if let Ok(mut held) = app.state::<Latest>().0.lock() {
            *held = None;
        }
        let _ = app.emit("notch:crypto", Option::<Coin>::None);
        return Ok(None);
    }
    refresh(&app).await
}

#[derive(Deserialize)]
struct Ticker {
    #[serde(rename = "lastPrice")]
    last_price: String,
    #[serde(rename = "priceChangePercent")]
    change_percent: String,
    #[serde(rename = "highPrice")]
    high_price: String,
    #[serde(rename = "lowPrice")]
    low_price: String,
}

/// ⚠️ Every number in Binance's replies is a STRING, and a parse failure has to
/// be a failed reading rather than a zero: a price of 0.00 on a board is a
/// number somebody might believe.
fn number(said: &str) -> Result<f64, String> {
    said.parse::<f64>().map_err(|_| format!("Not a number: {said}"))
}

/// Split `BTCUSDT` into `BTC` and `USDT`.
///
/// ⚠️ By the KNOWN QUOTES rather than a fixed length. `BTCUSDT` is 3+4 and
/// `ETHBTC` is 3+3; taking the last four characters turns `ETHBTC` into `ETH` +
/// `HBTC`, which is a coin that exists. Longest first, so `BUSD` cannot be read
/// as `USD`.
fn split(symbol: &str) -> (String, String) {
    const QUOTES: [&str; 8] = ["USDT", "FDUSD", "TUSD", "BUSD", "USDC", "EUR", "BTC", "ETH"];
    let mut best = "";
    for quote in QUOTES {
        if symbol.len() > quote.len() && symbol.ends_with(quote) && quote.len() > best.len() {
            best = quote;
        }
    }
    if best.is_empty() {
        return (symbol.to_string(), String::new());
    }
    (symbol[..symbol.len() - best.len()].to_string(), best.to_string())
}

/// The last `SPARK` daily closes, or nothing at all.
///
/// ⚠️ Every failure folds to `None` on purpose — see the call site. Each row of
/// the reply is a mixed array and index 4 is the close, as a string.
async fn closes(client: &reqwest::Client, symbol: &str) -> Option<Vec<f64>> {
    let rows: Vec<Vec<serde_json::Value>> = client
        .get(format!(
            "https://api.binance.com/api/v3/klines?symbol={symbol}&interval=1d&limit={SPARK}"
        ))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()?;
    Some(
        rows.iter()
            .filter_map(|row| row.get(4)?.as_str()?.parse::<f64>().ok())
            .collect(),
    )
}

async fn refresh(app: &AppHandle) -> Result<Option<Coin>, String> {
    let symbol = {
        let settings = app.state::<Settings>();
        let config = settings.0.lock().map_err(|_| "Settings are locked.")?;
        config.crypto_symbol.trim().to_uppercase()
    };
    if symbol.is_empty() {
        return Ok(None);
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|error| error.to_string())?;

    let ticker: Ticker = client
        .get(format!("https://api.binance.com/api/v3/ticker/24hr?symbol={symbol}"))
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|_| format!("No such symbol: {symbol}"))?
        .json()
        .await
        .map_err(|error| error.to_string())?;

    /* The sparkline. ⚠️ A FAILURE HERE IS NOT A FAILURE: the price is the
     * point and the line is decoration, so a klines request that times out
     * leaves the widget with a number and no shape rather than with nothing. */
    let spark = closes(&client, &symbol).await.unwrap_or_default();

    let (name, quote) = split(&symbol);
    let coin = Coin {
        symbol: symbol.clone(),
        name,
        quote,
        price: number(&ticker.last_price)?,
        change_pct: number(&ticker.change_percent).unwrap_or(0.0),
        high: number(&ticker.high_price).unwrap_or(0.0),
        low: number(&ticker.low_price).unwrap_or(0.0),
        spark,
        read_at_ms: chrono::Utc::now().timestamp_millis(),
    };

    if let Ok(mut held) = app.state::<Latest>().0.lock() {
        *held = Some(coin.clone());
    }
    let _ = app.emit("notch:crypto", Some(coin.clone()));
    Ok(Some(coin))
}


/* ── The wallet ───────────────────────────────────────────────────────────
 * What the account actually holds, which is the one thing a public endpoint
 * cannot tell us.
 *
 * ⚠️ READ ONLY, by construction. The only private endpoint this file knows is
 * `GET /api/v3/account`. Nothing here can place an order or start a withdrawal,
 * and a key created with only "Enable Reading" ticked is enough for all of it —
 * which is what the settings copy tells people to make. A key that can trade
 * still works, and the app still never asks it to.
 *
 * ⚠️ The SECRET never leaves this process. It goes into Windows Credential
 * Manager on the way in and is read back only to sign a request; no command
 * returns it, no event carries it, and every error below is written so that it
 * cannot contain it — see `scrub`.
 */

/* ── The balance over time ────────────────────────────────────────────────
 * ⚠️ WE KEEP IT. Binance hands out a snapshot, not a history: `/api/v3/account`
 * is what you hold right now and nothing else. There IS a
 * `/sapi/v1/accountSnapshot` with thirty daily points — and it is the wrong
 * source here twice over. It covers SPOT only, so for anybody whose coins sit
 * in Earn it would draw a flat zero and then jump the moment our own readings
 * took over; and at 2400 weight a call it cannot be polled beside everything
 * else. A line we recorded ourselves is a line that always agrees with the
 * number printed above it, which is the only property that actually matters.
 *
 * ⚠️ Stored in USDT, never in the display currency. The currency is a setting
 * somebody can change; converting on the way IN would leave a file whose older
 * half means something different from its newer half, and no way to tell.
 */

/// One reading of what everything was worth.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    /// Unix milliseconds.
    pub at: i64,
    /// In USDT — see the note above.
    pub value: f64,
}

/// How often a point is kept. ⚠️ Not every poll: at one a minute that is 1,440
/// points a day, which is a file that grows without bound to draw a line
/// nobody can see the resolution of.
const KEEP_EVERY_MS: i64 = 15 * 60 * 1000;

/// How far back the file goes. Ninety days at a point every quarter hour is
/// about 8,600 rows — a few hundred kilobytes, and more than any sparkline
/// needs.
const KEEP_FOR_MS: i64 = 90 * 24 * 60 * 60 * 1000;

/// How many points the web layer is sent. ⚠️ Far fewer than are kept: a
/// sparkline 300px wide cannot show 8,600 of them, and sending them all would
/// put a megabyte through the IPC boundary once a minute.
const SPARK_POINTS: usize = 90;

fn history_path() -> Option<std::path::PathBuf> {
    dirs::config_dir().map(|dir| dir.join("codenotch-win").join("wallet-history.json"))
}

fn history_load() -> Vec<Point> {
    let Some(path) = history_path() else { return Vec::new() };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<Point>>(&text).ok())
        .unwrap_or_default()
}

/// Add today's reading, if it is time for one, and hand back the whole run.
fn history_note(value: f64, now: i64) -> Vec<Point> {
    let mut points = history_load();
    /* ⚠️ Anything from the FUTURE is dropped. A machine whose clock was wrong
     * and has since been fixed leaves points that sort after everything and
     * stretch the line to the right for ever. */
    points.retain(|one| one.at <= now + KEEP_EVERY_MS && now - one.at < KEEP_FOR_MS);
    let due = points.last().is_none_or(|last| now - last.at >= KEEP_EVERY_MS);
    if due {
        points.push(Point { at: now, value });
    } else if let Some(last) = points.last_mut() {
        /* ⚠️ The newest point is UPDATED rather than left stale. Without this
         * the line's right-hand end lags the total above it by up to a quarter
         * of an hour — two numbers on one block disagreeing. */
        last.value = value;
    }
    if let Some(path) = history_path() {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(text) = serde_json::to_string(&points) {
            let _ = std::fs::write(path, text);
        }
    }
    points
}

/// One asset the account holds, valued in the quote currency.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Holding {
    pub asset: String,
    pub amount: f64,
    /// What it is worth right now, or 0 when nothing prices it.
    pub value: f64,
}

/// ⚠️ `connected` is separate from "has holdings". An account with a key and an
/// empty balance is a working connection, and showing it as disconnected would
/// send somebody back to Settings to fix what is not broken.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Wallet {
    pub connected: bool,
    /// What everything adds up to, in `quote`.
    pub total: f64,
    pub quote: String,
    /// Biggest first, and only the ones worth showing — see `DUST`.
    pub holdings: Vec<Holding>,
    /// What it has been worth, oldest first, in the DISPLAY currency.
    /// ⚠️ Converted on the way out, not on the way in — see `Point`.
    pub history: Vec<Point>,
    /// Over the whole of `history`, as a percentage. ⚠️ Not 24h: the run is as
    /// long as the app has been watching, and quoting a day's change off a file
    /// that starts an hour ago would be a number about a period it has no data
    /// for.
    pub change_pct: f64,
    /// How long the run actually covers, in milliseconds, so the block can say
    /// "6 hours" rather than implying a month.
    pub span_ms: i64,
    pub read_at_ms: i64,
}

#[derive(Default)]
pub struct Held(pub std::sync::Mutex<Option<Wallet>>);

/// Below this, in the quote currency, an asset is not a holding — it is the
/// change left behind by a trade. ⚠️ A wallet listing nine dust balances is a
/// wallet you have to read past to find the two that matter.
const DUST: f64 = 1.0;

/// What everything is VALUED in, which is not the same as what it is shown in.
/// ⚠️ Fixed, because it is the currency Binance actually quotes: every price
/// lookup goes through USDT and the display currency is one conversion at the
/// end. Valuing each holding in the display currency directly would mean a
/// second cross-rate per asset, thirty times over.
const QUOTE: &str = "USDT";

/// What it is SHOWN in, from the settings. ⚠️ Empty means USDT — somebody who
/// has never opened the setting gets the currency the prices came in.
fn display_quote(app: &AppHandle) -> String {
    let said = app
        .state::<Settings>()
        .0
        .lock()
        .ok()
        .map(|config| config.wallet_quote.trim().to_uppercase())
        .unwrap_or_default();
    if said.is_empty() { QUOTE.to_string() } else { said }
}

/// Set (or clear, with an empty string) what the wallet is shown in.
#[tauri::command]
pub async fn set_wallet_quote(app: AppHandle, quote: String) -> Result<Option<Wallet>, String> {
    {
        let settings = app.state::<Settings>();
        let mut config = settings.0.lock().map_err(|_| "Settings are locked.")?;
        config.wallet_quote = quote.trim().to_uppercase();
        crate::config::save(&config);
    }
    refresh_wallet(&app).await?;
    Ok(app.state::<Held>().0.lock().ok().and_then(|held| held.clone()))
}

#[derive(Deserialize)]
struct Keys {
    key: String,
    secret: String,
}

/// Take the secret out of anything on its way to a log or a message.
///
/// ⚠️ Belt and braces. Nothing below deliberately puts a secret in an error —
/// but `reqwest` will happily print a URL, and a signed request carries the
/// signature in its query string. Every error out of this module goes through
/// here.
#[allow(dead_code)]
fn scrub(said: String, keys: &Keys) -> String {
    let mut out = said;
    for secret in [keys.secret.as_str(), keys.key.as_str()] {
        if secret.len() >= 8 {
            out = out.replace(secret, "…");
        }
    }
    /* ⚠️ The SIGNATURE as well, which the first version missed — and it is the
     * one that actually escaped, because `reqwest`'s own error Display prints
     * the URL and a signed request carries the signature in its query string.
     * The real fix is that nothing builds a message from a URL any more; this
     * is the net under it. */
    if let Some(at) = out.find("signature=") {
        let end = out[at..].find(['&', ')', ' ']).map_or(out.len(), |one| at + one);
        out.replace_range(at + "signature=".len()..end, "…");
    }
    out
}

fn stored() -> Result<Option<Keys>, String> {
    let Some(raw) = credentials::read(credentials::BINANCE)? else {
        return Ok(None);
    };
    serde_json::from_str::<Keys>(&raw)
        .map(Some)
        .map_err(|_| "The saved Binance credential is unreadable. Reconnect it.".to_string())
}

/// The signature Binance wants: HMAC-SHA256 of the query string, in hex.
fn sign(query: &str, secret: &str) -> String {
    type Mac = hmac::Hmac<sha2::Sha256>;
    use hmac::Mac as _;
    let mut mac = Mac::new_from_slice(secret.as_bytes()).expect("HMAC takes any key length");
    mac.update(query.as_bytes());
    mac.finalize().into_bytes().iter().map(|byte| format!("{byte:02x}")).collect()
}

#[derive(Deserialize)]
struct Account {
    balances: Vec<Balance>,
}

#[derive(Deserialize)]
struct Balance {
    asset: String,
    free: String,
    locked: String,
}

#[derive(Deserialize)]
struct Price {
    symbol: String,
    price: String,
}

/// The funding wallet. ⚠️ `freeze` as well as free and locked: money held
/// against a P2P order is still money.
#[derive(Deserialize)]
struct Funding {
    asset: String,
    free: String,
    locked: String,
    freeze: String,
}

/// Simple Earn answers in pages, whichever product it is.
#[derive(Deserialize)]
struct EarnPage<T> {
    rows: Vec<T>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Flexible {
    asset: String,
    total_amount: String,
}

#[derive(Deserialize)]
struct Locked {
    asset: String,
    amount: String,
}

/// How far this machine's clock is from Binance's, in milliseconds.
///
/// ⚠️ Binance rejects a signed request whose timestamp is outside `recvWindow`
/// of ITS clock, not of any absolute truth — and a Windows box that has not
/// synced in a while is routinely a second or two out. That comes back as a 400
/// with code -1021, which reads like a bad key and is not. Carrying an offset
/// makes the whole class of problem go away instead of explaining it.
static SKEW: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);

/// Ask Binance what time it thinks it is, and remember the difference.
async fn resync(client: &reqwest::Client) -> Result<(), String> {
    #[derive(Deserialize)]
    struct Time {
        #[serde(rename = "serverTime")]
        server_time: i64,
    }
    let now = chrono::Utc::now().timestamp_millis();
    let time: Time = client
        .get("https://api.binance.com/api/v3/time")
        .send()
        .await
        .map_err(|_| "Could not reach Binance.".to_string())?
        .json()
        .await
        .map_err(|_| "Binance's clock reply was unreadable.".to_string())?;
    SKEW.store(time.server_time - now, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

/// What Binance says when it refuses.
#[derive(Deserialize)]
struct Refusal {
    code: i32,
    msg: String,
}

/// One signed GET, with the reply's own explanation read out of it.
///
/// ⚠️ `error_for_status()` is NOT used here and must not be. It throws the body
/// away — and the body is the only place Binance says what was actually wrong —
/// while its own `Display` prints the full URL, which on a signed request
/// carries the signature. That combination put a signed URL in front of the
/// user and told them nothing: "400 Bad Request for url (…&signature=…)".
///
/// ⚠️ Nothing built from the URL, the query or the headers reaches the caller.
/// Every message below is either one of ours or Binance's own `msg` field.
async fn signed<T: serde::de::DeserializeOwned>(
    client: &reqwest::Client, keys: &Keys, path: &str, post: bool,
) -> Result<T, String> {
    for attempt in 0..2 {
        let stamp = chrono::Utc::now().timestamp_millis()
            + SKEW.load(std::sync::atomic::Ordering::Relaxed);
        /* ⚠️ `recvWindow` is small on purpose. It is how long Binance will
         * accept a request after its timestamp, and a generous one is a longer
         * window in which a captured request can be replayed. */
        let query = format!("recvWindow=5000&timestamp={stamp}");
        let signature = sign(&query, &keys.secret);
        let url = format!("https://api.binance.com{path}?{query}&signature={signature}");
        /* ⚠️ Some of these are POST even though they only READ — the funding
         * wallet is one. Binance's choice, not ours, and it changes nothing
         * about what the key is allowed to do: a read-only key can call it and
         * a trading endpoint is not in this file at all. */
        let reply = (if post { client.post(&url) } else { client.get(&url) })
            .header("X-MBX-APIKEY", &keys.key)
            .send()
            .await
            .map_err(|_| "Could not reach Binance.".to_string())?;

        let status = reply.status().as_u16();
        let body = reply.text().await.unwrap_or_default();
        if status < 400 {
            return serde_json::from_str::<T>(&body)
                .map_err(|_| "Binance's reply was not what this build expects.".to_string());
        }

        let refusal = serde_json::from_str::<Refusal>(&body).ok();
        let code = refusal.as_ref().map(|one| one.code).unwrap_or(0);
        /* The clock. ⚠️ Resync and try ONCE more rather than reporting it: the
         * offset is the fix, and a message telling somebody to set their clock
         * is a message about a problem the app can simply not have. */
        if code == -1021 && attempt == 0 {
            resync(client).await?;
            continue;
        }
        return Err(match code {
            -1021 => "This machine's clock is too far from Binance's, even after \
                      syncing. Check Windows' date and time settings.".to_string(),
            -1022 | -2014 => "Binance did not accept that key pair. Check that the \
                              secret is the one shown when the key was created — \
                              it is only shown once.".to_string(),
            -2015 => "Binance refused the key. The commonest cause is an IP \
                      restriction that does not include this machine.".to_string(),
            -1003 => "Binance is rate-limiting this key. It will recover on its \
                      own.".to_string(),
            /* ⚠️ Binance's OWN words when we have no better ones — but only the
             * `msg` field, never the response or the URL around it. */
            _ => refusal
                .map(|one| one.msg)
                .filter(|one| !one.is_empty())
                .unwrap_or_else(|| format!("Binance refused the request ({status}).")),
        });
    }
    Err("Binance kept refusing the request's timestamp.".to_string())
}

/// Ask the account what it holds, and price it.
async fn read_wallet(keys: &Keys, quote: String) -> Result<Wallet, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "Could not build an HTTP client.".to_string())?;

    /* ⚠️ `recvWindow` is small on purpose. It is how long Binance will accept a
     * request after its timestamp, and a generous one is a longer window in
     * which a captured request can be replayed. Five seconds is their own
     * default and is plenty for one call. */
    /* ── Every wallet, not just spot ───────────────────────────────────────
     * ⚠️ `/api/v3/account` is the SPOT wallet and nothing else. Coins in Simple
     * Earn or in Funding are not in it — and Binance puts most people's
     * holdings in Earn by default, so a wallet that only read spot showed zero
     * to somebody who plainly had money. Each extra source is BEST EFFORT: a
     * key without the permission for one of them must still show the rest, and
     * a `sapi` endpoint that has been renamed must not take the whole block
     * down with it. */
    let account: Account = signed(&client, keys, "/api/v3/account", false).await?;
    let mut amounts: std::collections::BTreeMap<String, f64> = Default::default();
    let mut add = |asset: &str, amount: f64| {
        if amount > 0.0 {
            *amounts.entry(asset.to_string()).or_insert(0.0) += amount;
        }
    };
    for one in &account.balances {
        add(&one.asset,
            one.free.parse::<f64>().unwrap_or(0.0) + one.locked.parse::<f64>().unwrap_or(0.0));
    }
    /* Funding. ⚠️ A POST that only reads — Binance's choice, not ours. */
    if let Ok(rows) = signed::<Vec<Funding>>(
        &client, keys, "/sapi/v1/asset/get-funding-asset", true).await
    {
        for one in &rows {
            add(&one.asset,
                one.free.parse::<f64>().unwrap_or(0.0)
                    + one.locked.parse::<f64>().unwrap_or(0.0)
                    + one.freeze.parse::<f64>().unwrap_or(0.0));
        }
    }
    /* Simple Earn, both shapes. */
    if let Ok(page) = signed::<EarnPage<Flexible>>(
        &client, keys, "/sapi/v1/simple-earn/flexible/position", false).await
    {
        for one in &page.rows {
            add(&one.asset, one.total_amount.parse::<f64>().unwrap_or(0.0));
        }
    }
    if let Ok(page) = signed::<EarnPage<Locked>>(
        &client, keys, "/sapi/v1/simple-earn/locked/position", false).await
    {
        for one in &page.rows {
            add(&one.asset, one.amount.parse::<f64>().unwrap_or(0.0));
        }
    }

    /* Everything, in one call. ⚠️ Not one request per asset: an account with
     * thirty balances would be thirty round trips a minute, which is both slow
     * and the fastest way to get a key rate-limited. */
    let prices: Vec<Price> = client
        .get("https://api.binance.com/api/v3/ticker/price")
        .send()
        .await
        .map_err(|_| "Could not reach Binance.".to_string())?
        .json()
        .await
        .map_err(|_| "Binance's price list was unreadable.".to_string())?;

    let at = |symbol: &str| -> Option<f64> {
        prices.iter().find(|one| one.symbol == symbol)?.price.parse::<f64>().ok()
    };
    /* What one unit of an asset is worth in USDT.
     *
     * ⚠️ FOUR ways, not one. Only asking for `{asset}USDT` priced everything
     * else at zero — and a zero here was then dropped by the dust filter, so an
     * asset Binance simply does not quote against USDT vanished from the wallet
     * entirely. That is most fiat (`USDTPLN` exists; `PLNUSDT` does not) and a
     * good many alts, which only pair against BTC.
     *
     * ⚠️ `None` for "cannot price", never `0.0`. The two mean different things
     * and conflating them is what made a holding disappear instead of showing
     * up unpriced. */
    let price_of = |asset: &str| -> Option<f64> {
        if asset == QUOTE {
            return Some(1.0);
        }
        // Stablecoins Binance does not quote against USDT are near enough 1.
        if matches!(asset, "USDC" | "BUSD" | "TUSD" | "FDUSD" | "DAI") {
            return at(&format!("{asset}{QUOTE}")).or(Some(1.0));
        }
        if let Some(direct) = at(&format!("{asset}{QUOTE}")) {
            return Some(direct);
        }
        // Inverted: the asset is the QUOTE side, which is how fiat is listed.
        if let Some(inverted) = at(&format!("{QUOTE}{asset}")).filter(|one| *one > 0.0) {
            return Some(1.0 / inverted);
        }
        // Through a major, which is how most small alts are listed.
        for bridge in ["BTC", "ETH", "BNB"] {
            if let (Some(leg), Some(rate)) =
                (at(&format!("{asset}{bridge}")), at(&format!("{bridge}{QUOTE}")))
            {
                return Some(leg * rate);
            }
        }
        None
    };

    /* ⚠️ What it is DISPLAYED in, applied once at the end. Everything above is
     * valued in USDT because that is what Binance quotes; converting each
     * holding as it is read would be the same rate looked up thirty times. */
    let rate = if quote == QUOTE { 1.0 } else { price_of(&quote).map_or(1.0, |one| 1.0 / one) };

    let mut holdings: Vec<Holding> = amounts
        .iter()
        .filter_map(|(asset, amount)| {
            let worth = price_of(asset);
            /* ⚠️ An asset we cannot PRICE is kept, not dropped. Zero was
             * standing in for both "worth nothing" and "no pair to value it
             * with", so anything Binance does not quote against USDT fell out
             * of the wallet without trace. It shows with no value instead,
             * which is a thing somebody can see and ask about. */
            let value = worth.unwrap_or(0.0) * *amount * rate;
            (worth.is_none() || value >= DUST).then_some(Holding {
                asset: asset.clone(), amount: *amount, value,
            })
        })
        .collect();
    holdings.sort_by(|a, b| b.value.partial_cmp(&a.value).unwrap_or(std::cmp::Ordering::Equal));

    let now = chrono::Utc::now().timestamp_millis();
    let total: f64 = holdings.iter().map(|one| one.value).sum();
    /* ⚠️ Noted in USDT — `total` is already in the display currency, so it is
     * divided back out. Storing the converted figure would make the file mean
     * whatever the setting happened to be that week. */
    let kept = history_note(if rate > 0.0 { total / rate } else { total }, now);

    /* Thinned to what a sparkline can show, keeping the FIRST and LAST. ⚠️ A
     * naive `step_by` drops the newest point whenever the count is not a
     * multiple of the step — so the line would stop short of the number printed
     * above it, by up to a quarter of an hour. */
    let step = (kept.len() / SPARK_POINTS).max(1);
    let mut history: Vec<Point> = kept
        .iter()
        .step_by(step)
        .map(|one| Point { at: one.at, value: one.value * rate })
        .collect();
    if let Some(last) = kept.last() {
        if history.last().map(|one| one.at) != Some(last.at) {
            history.push(Point { at: last.at, value: last.value * rate });
        }
    }

    let first = history.first().map(|one| one.value).unwrap_or(0.0);
    Ok(Wallet {
        connected: true,
        total,
        quote: quote.clone(),
        holdings,
        change_pct: if first > 0.0 { ((total - first) / first) * 100.0 } else { 0.0 },
        span_ms: match (history.first(), history.last()) {
            (Some(a), Some(b)) => b.at - a.at,
            _ => 0,
        },
        history,
        read_at_ms: now,
    })
}

#[tauri::command]
pub fn get_wallet(state: tauri::State<Held>) -> Option<Wallet> {
    state.0.lock().ok().and_then(|held| held.clone())
}

/// Store a key pair, but only once it has been shown to work.
///
/// ⚠️ VERIFIED FIRST. Writing then testing leaves a bad key in Credential
/// Manager and a wallet that fails quietly once a minute for ever; the only
/// moment anybody is watching is this one.
#[tauri::command]
pub async fn connect_binance(app: AppHandle, key: String, secret: String) -> Result<Wallet, String> {
    let keys = Keys { key: key.trim().to_string(), secret: secret.trim().to_string() };
    if keys.key.is_empty() || keys.secret.is_empty() {
        return Err("Both the API key and the secret are needed.".to_string());
    }
    let wallet = read_wallet(&keys, display_quote(&app)).await?;
    credentials::write(
        credentials::BINANCE,
        &serde_json::to_string(&serde_json::json!({ "key": keys.key, "secret": keys.secret }))
            .map_err(|_| "Could not serialise the credential.")?,
    )?;
    if let Ok(mut held) = app.state::<Held>().0.lock() {
        *held = Some(wallet.clone());
    }
    let _ = app.emit("notch:wallet", Some(wallet.clone()));
    Ok(wallet)
}

#[tauri::command]
pub fn disconnect_binance(app: AppHandle) -> Result<(), String> {
    credentials::delete(credentials::BINANCE)?;
    if let Ok(mut held) = app.state::<Held>().0.lock() {
        *held = None;
    }
    let _ = app.emit("notch:wallet", Option::<Wallet>::None);
    Ok(())
}

/// Whether a key is stored. ⚠️ A BOOLEAN, never the key. Settings needs to know
/// which of two states to draw and nothing more, and a command that returned
/// the key would put it in a WebView — which is the one place it must not be.
#[tauri::command]
pub fn binance_connected() -> bool {
    matches!(credentials::read(credentials::BINANCE), Ok(Some(_)))
}

async fn refresh_wallet(app: &AppHandle) -> Result<(), String> {
    let Some(keys) = stored()? else {
        // Nothing configured is not a failure; it is the resting state.
        if let Ok(mut held) = app.state::<Held>().0.lock() {
            if held.is_some() {
                *held = None;
                let _ = app.emit("notch:wallet", Option::<Wallet>::None);
            }
        }
        return Ok(());
    };
    let wallet = read_wallet(&keys, display_quote(&app)).await?;
    if let Ok(mut held) = app.state::<Held>().0.lock() {
        *held = Some(wallet.clone());
    }
    let _ = app.emit("notch:wallet", Some(wallet));
    Ok(())
}

pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            /* A failure keeps the last good reading — see the note on `Coin`.
             * ⚠️ The two are polled TOGETHER but fail apart: a rate-limited key
             * must not take the public price down with it, and a symbol nobody
             * has set must not stop the wallet. */
            if let Err(message) = refresh(&app).await {
                if cfg!(debug_assertions) {
                    println!("[notch] crypto: {message}");
                }
            }
            if let Err(message) = refresh_wallet(&app).await {
                if cfg!(debug_assertions) {
                    println!("[notch] wallet: {message}");
                }
            }
            tokio::time::sleep(POLL).await;
        }
    });
}
