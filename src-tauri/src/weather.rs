//! Weather for the resting pill.
//!
//! Open-Meteo: no account, no API key, no attribution requirement, and a free
//! tier that a thirty-minute poll does not come close to. The alternatives all
//! want a key in a config file, which is a credential this app would then have
//! to keep somewhere — and it keeps its credentials in Windows Credential
//! Manager for reasons that do not apply to a public forecast.
//!
//! ⚠️ **Opt-in, by typing a place.** Nothing here runs and nothing leaves the
//! machine until someone fills in a city. The obvious alternative — resolving
//! the location from the IP address — means every launch tells a third party
//! where this machine is, in exchange for saving one text field. Windows'
//! own Geolocation API would avoid that but needs a capability the app does
//! not otherwise want and a consent prompt on first run.
//!
//! The place is geocoded **once** and the coordinates cached in the config, so
//! the ordinary case is one request every half hour to one host.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::drag::Settings;

/// Long enough that a day of running costs 48 requests; short enough that a
/// front coming through is on the pill within the hour.
const POLL: Duration = Duration::from_secs(30 * 60);

/// ⚠️ A failed request must not clear a good reading. A sleeping laptop, a
/// captive portal or a flaky VPN would otherwise blank the pill, and a blank
/// is indistinguishable from "no place configured".
/// ⚠️ `camelCase`, and it was missing. Serde writes a Rust field name straight
/// through unless told otherwise, so `is_day` and `read_at_ms` arrived in the
/// web layer under those names while every reader asked for `isDay` and
/// `readAtMs` — which is `undefined`, not an error. The night sky never came on
/// and nothing ever looked stale, silently, for as long as both have existed.
/// `Slot` and `Day` below have always carried this; the parent did not.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Weather {
    /// Empty when no place is configured, which is the "module off" signal.
    pub place: String,
    pub celsius: i32,
    /// A short phrase, not a sentence: this lands in a 35px pill.
    pub summary: String,
    /// Maps to one of the pill's weather icons.
    pub icon: String,
    /// Unix milliseconds of the reading, so the web layer can dim a stale one.
    pub read_at_ms: i64,

    /* ── Everything the widgets want and the pill does not ───────────────
     * ⚠️ All of it OPTIONAL or empty-by-default. The pill has shown one line
     * for a year and must keep working when a reply arrives without these;
     * the widgets that want a forecast check for one and say so when it is
     * missing, which is a state they have to handle anyway on the first poll
     * after a cold start. */
    /// Whether the sun is up where the reading was taken.
    pub is_day: bool,
    /// Today's high and low, as the forecast has them.
    pub high: Option<i32>,
    pub low: Option<i32>,
    /// Local `HH:MM` for each, so nothing downstream parses a date.
    pub sunrise: String,
    pub sunset: String,
    /// The next few hours, from the one now.
    pub hours: Vec<Slot>,
    /// The next few days, starting with today.
    pub days: Vec<Day>,
}

/// One hour of the forecast.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Slot {
    /// Local `HH:MM`. ⚠️ Formatted HERE rather than handed over as an ISO
    /// string: the hour a forecast is for is the PLACE's hour, and a browser
    /// asked to format it would use the machine's timezone instead.
    pub at: String,
    pub celsius: i32,
    pub icon: String,
}

/// One day of the forecast.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Day {
    /// `2026-09-21`, for the web layer to name in the user's own language.
    pub date: String,
    pub icon: String,
    pub high: i32,
    pub low: i32,
}

#[derive(Default)]
pub struct Latest(pub std::sync::Mutex<Option<Weather>>);

#[tauri::command]
pub fn get_weather(state: tauri::State<Latest>) -> Option<Weather> {
    state.0.lock().ok().and_then(|held| held.clone())
}

/// Set (or clear, with an empty string) the place the forecast is for.
///
/// Clearing drops the cached coordinates as well as the reading: leaving them
/// behind would mean a later re-enable silently reported the *old* city until
/// the next geocode, which is the kind of wrongness nobody thinks to check.
#[tauri::command]
pub async fn set_weather_place(app: AppHandle, place: String) -> Result<Option<Weather>, String> {
    let place = place.trim().to_string();
    {
        let settings = app.state::<Settings>();
        let mut config = settings.0.lock().map_err(|_| "Settings are locked.")?;
        if config.weather_place != place {
            config.weather_place = place.clone();
            config.weather_lat = None;
            config.weather_lon = None;
            crate::config::save(&config);
        }
    }
    if place.is_empty() {
        if let Ok(mut held) = app.state::<Latest>().0.lock() {
            *held = None;
        }
        let _ = app.emit("notch:weather", Option::<Weather>::None);
        return Ok(None);
    }
    let reading = refresh(&app).await?;
    Ok(reading)
}

#[derive(Deserialize)]
struct GeoHit {
    latitude: f64,
    longitude: f64,
    name: String,
    country: Option<String>,
}

#[derive(Deserialize)]
struct GeoReply {
    results: Option<Vec<GeoHit>>,
}

#[derive(Deserialize)]
struct Current {
    temperature_2m: f64,
    weather_code: i32,
    /// The moment this reading is for, in the PLACE's own clock
    /// (`2026-09-21T18:15`). ⚠️ Asked for rather than derived: finding "now"
    /// in the hourly array means comparing against the place's hour, and the
    /// machine's clock is the wrong one the moment the place is elsewhere.
    #[serde(default)]
    time: String,
    /// 1 while the sun is up. ⚠️ Open-Meteo's own answer rather than a
    /// comparison against sunrise: it knows the place's timezone and we would
    /// be doing arithmetic on strings to get the same number.
    #[serde(default)]
    is_day: i32,
}

#[derive(Deserialize, Default)]
struct Hourly {
    #[serde(default)]
    time: Vec<String>,
    #[serde(default)]
    temperature_2m: Vec<f64>,
    #[serde(default)]
    weather_code: Vec<i32>,
}

#[derive(Deserialize, Default)]
struct Daily {
    #[serde(default)]
    time: Vec<String>,
    #[serde(default)]
    weather_code: Vec<i32>,
    #[serde(default)]
    temperature_2m_max: Vec<f64>,
    #[serde(default)]
    temperature_2m_min: Vec<f64>,
    #[serde(default)]
    sunrise: Vec<String>,
    #[serde(default)]
    sunset: Vec<String>,
}

#[derive(Deserialize)]
struct Forecast {
    current: Current,
    /// ⚠️ `default` on both, so a reply missing them is a reading with no
    /// forecast rather than a parse failure that loses the temperature too.
    /// The hourly and daily blocks are the part most likely to change shape.
    #[serde(default)]
    hourly: Hourly,
    #[serde(default)]
    daily: Daily,
}

/// WMO 4677, as the pill can say it.
///
/// ⚠️ The label has to fit beside a temperature in a slot about 110px wide, so
/// these are the short forms on purpose — "Thunderstorm with slight hail" is
/// the correct name for code 96 and there is nowhere to put it.
fn describe(code: i32) -> (&'static str, &'static str) {
    match code {
        0 => ("Clear", "wxClear"),
        1 | 2 => ("Partly cloudy", "wxPartly"),
        3 => ("Overcast", "wxCloud"),
        45 | 48 => ("Fog", "wxFog"),
        51 | 53 | 55 | 56 | 57 => ("Drizzle", "wxDrizzle"),
        61 | 63 | 66 | 67 | 80 | 81 => ("Rain", "wxRain"),
        65 | 82 => ("Heavy rain", "wxHeavyRain"),
        71 | 73 | 75 | 77 | 85 | 86 => ("Snow", "wxSnow"),
        95 | 96 | 99 => ("Storm", "wxStorm"),
        _ => ("—", "wxCloud"),
    }
}

/// `HH:MM` out of an Open-Meteo local timestamp (`2026-09-21T14:00`).
///
/// ⚠️ A SLICE, not a parse. The value is already in the place's own timezone
/// — that is what `timezone=auto` is for — so turning it into a moment and
/// formatting it again would only give the machine's timezone a chance to get
/// involved. Anything that does not look like one comes back empty.
fn clock_of(stamp: &str) -> String {
    match stamp.split_once('T') {
        Some((_, time)) if time.len() >= 5 => time[..5].to_string(),
        _ => String::new(),
    }
}

/// Turn the configured place into coordinates, once, and remember them.
async fn coordinates(app: &AppHandle) -> Result<(f64, f64, String), String> {
    let (place, cached) = {
        let settings = app.state::<Settings>();
        let config = settings.0.lock().map_err(|_| "Settings are locked.")?;
        (
            config.weather_place.clone(),
            config.weather_lat.zip(config.weather_lon),
        )
    };
    if place.is_empty() {
        return Err("No place is set.".into());
    }
    if let Some((lat, lon)) = cached {
        return Ok((lat, lon, place));
    }

    let url = format!(
        "https://geocoding-api.open-meteo.com/v1/search?name={}&count=1&format=json",
        urlencoding(&place)
    );
    let reply: GeoReply = reqwest::get(&url)
        .await
        .map_err(|_| "Could not reach the geocoder.".to_string())?
        .json()
        .await
        .map_err(|_| "The geocoder answered with something unexpected.".to_string())?;
    let hit = reply
        .results
        .and_then(|mut hits| if hits.is_empty() { None } else { Some(hits.remove(0)) })
        .ok_or_else(|| format!("Nowhere called \"{place}\" was found."))?;

    // The resolved name, not what was typed: "krakow" comes back "Kraków", and
    // showing the machine's spelling back is how the person can tell it found
    // the right place rather than a same-named town somewhere else.
    let label = match &hit.country {
        Some(country) if !country.is_empty() => format!("{}, {}", hit.name, country),
        _ => hit.name.clone(),
    };
    {
        let settings = app.state::<Settings>();
        let mut config = settings.0.lock().map_err(|_| "Settings are locked.")?;
        config.weather_lat = Some(hit.latitude);
        config.weather_lon = Some(hit.longitude);
        config.weather_place = label.clone();
        crate::config::save(&config);
    }
    Ok((hit.latitude, hit.longitude, label))
}

/// Percent-encode a place name for a query string.
///
/// ⚠️ Hand-rolled because this is the only URL this module builds and pulling a
/// crate for it is not worth a dependency — but it must encode, not strip:
/// place names carry spaces, accents and commas ("Kraków", "Sao Paulo, BR"),
/// and a raw one produces a malformed request the API answers with an empty
/// result rather than an error.
pub fn urlencoding(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            b' ' => out.push_str("%20"),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

async fn refresh(app: &AppHandle) -> Result<Option<Weather>, String> {
    let (lat, lon, place) = match coordinates(app).await {
        Ok(found) => found,
        // No place configured is not an error worth reporting anywhere.
        Err(message) if message == "No place is set." => return Ok(None),
        Err(message) => return Err(message),
    };

    /* ⚠️ ONE request for all of it. The hourly and daily blocks cost nothing
     * extra — Open-Meteo answers them from the same model run — and a second
     * call would be a second cache, a second failure mode and two readings that
     * can disagree about what the weather is. `forecast_days=6` is today plus
     * five, which is what the widest forecast block has room for. */
    let url = format!(
        "https://api.open-meteo.com/v1/forecast\
         ?latitude={lat}&longitude={lon}\
         &current=temperature_2m,weather_code,is_day\
         &hourly=temperature_2m,weather_code\
         &daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset\
         &forecast_days=6&timezone=auto"
    );
    let forecast: Forecast = reqwest::get(&url)
        .await
        .map_err(|_| "Could not reach the forecast.".to_string())?
        .json()
        .await
        .map_err(|_| "The forecast answered with something unexpected.".to_string())?;

    let (summary, icon) = describe(forecast.current.weather_code);

    /* The hour the reading is for, as an index into the hourly arrays.
     *
     * ⚠️ Found by matching the PLACE's clock rather than by assuming the first
     * entry is now: `forecast_days` starts the array at midnight local, so at
     * six in the evening "the next six hours" begins eighteen entries in. A
     * reply whose shape surprises us falls back to an empty forecast, which
     * every widget already draws. */
    let now_hour = forecast.current.time.as_str();
    let from = forecast
        .hourly
        .time
        .iter()
        .position(|at| at.as_str() >= now_hour)
        .unwrap_or(0);
    let hours: Vec<Slot> = forecast
        .hourly
        .time
        .iter()
        .enumerate()
        .skip(from)
        .take(8)
        .filter_map(|(at, when)| {
            let celsius = forecast.hourly.temperature_2m.get(at)?;
            let code = forecast.hourly.weather_code.get(at).copied().unwrap_or(-1);
            Some(Slot {
                at: clock_of(when),
                celsius: celsius.round() as i32,
                icon: describe(code).1.to_string(),
            })
        })
        .collect();

    let days: Vec<Day> = forecast
        .daily
        .time
        .iter()
        .enumerate()
        .take(6)
        .filter_map(|(at, date)| {
            Some(Day {
                date: date.clone(),
                icon: describe(
                    forecast.daily.weather_code.get(at).copied().unwrap_or(-1),
                )
                .1
                .to_string(),
                high: forecast.daily.temperature_2m_max.get(at)?.round() as i32,
                low: forecast.daily.temperature_2m_min.get(at)?.round() as i32,
            })
        })
        .collect();

    let reading = Weather {
        place,
        celsius: forecast.current.temperature_2m.round() as i32,
        summary: summary.to_string(),
        icon: icon.to_string(),
        read_at_ms: chrono::Utc::now().timestamp_millis(),
        is_day: forecast.current.is_day != 0,
        high: days.first().map(|one| one.high),
        low: days.first().map(|one| one.low),
        sunrise: forecast.daily.sunrise.first().map(|at| clock_of(at)).unwrap_or_default(),
        sunset: forecast.daily.sunset.first().map(|at| clock_of(at)).unwrap_or_default(),
        hours,
        days,
    };
    if let Ok(mut held) = app.state::<Latest>().0.lock() {
        *held = Some(reading.clone());
    }
    let _ = app.emit("notch:weather", Some(reading.clone()));
    Ok(Some(reading))
}

pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            // A failure keeps the last good reading — see the note on `Weather`.
            if let Err(message) = refresh(&app).await {
                if cfg!(debug_assertions) {
                    println!("[notch] weather: {message}");
                }
            }
            tokio::time::sleep(POLL).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_what_place_names_actually_contain() {
        assert_eq!(urlencoding("Krakow"), "Krakow");
        assert_eq!(urlencoding("Sao Paulo, BR"), "Sao%20Paulo%2C%20BR");
        // Accented, which is the case that silently returns no results when a
        // name is passed through raw.
        assert_eq!(urlencoding("Kraków"), "Krak%C3%B3w");
    }

    #[test]
    fn every_wmo_group_has_a_short_label() {
        for code in [0, 1, 2, 3, 45, 48, 51, 61, 65, 71, 80, 95, 96] {
            let (label, icon) = describe(code);
            assert!(!label.is_empty(), "code {code}");
            assert!(icon.starts_with("wx"), "code {code}");
            // The slot is ~110px. Anything longer than this is a wrapped line.
            assert!(label.len() <= 13, "code {code} says {label:?}");
        }
    }

    /// `cargo test --lib weather -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn reads_a_real_forecast() {
        let body = tokio::runtime::Runtime::new().unwrap().block_on(async {
            reqwest::get(
                /* ⚠️ ONE LINE, however long. The app's own URL is built with
                 * `\` line continuations and that is fine there; written by a
                 * script into this file they arrived as literal `\n` escapes,
                 * so the request carried a newline and seventeen spaces inside
                 * `is_day` — and Open-Meteo answered with a parse error about a
                 * variable name nobody had typed. A long line cannot do that. */
                "https://api.open-meteo.com/v1/forecast?latitude=50.06&longitude=19.94&current=temperature_2m,weather_code,is_day&hourly=temperature_2m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset&forecast_days=6&timezone=auto",
            )
            .await
            .unwrap()
            .text()
            .await
            .unwrap()
        });
        println!("{body}");
        assert!(body.contains("temperature_2m"));
        /* ⚠️ The blocks the widgets need, so a shape change at Open-Meteo is a
         * failing test rather than a forecast block that quietly draws nothing.
         * Every one of these is `serde(default)` on our side precisely because
         * it CAN go missing — which means nothing else would ever notice. */
        assert!(body.contains("\"hourly\""));
        assert!(body.contains("\"daily\""));
        assert!(body.contains("sunset"));
        assert!(body.contains("is_day"));
    }
}
