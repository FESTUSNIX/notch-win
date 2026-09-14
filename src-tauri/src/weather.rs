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
#[derive(Clone, Debug, Default, Serialize)]
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
}

#[derive(Deserialize)]
struct Forecast {
    current: Current,
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

    let url = format!(
        "https://api.open-meteo.com/v1/forecast\
         ?latitude={lat}&longitude={lon}&current=temperature_2m,weather_code&timezone=auto"
    );
    let forecast: Forecast = reqwest::get(&url)
        .await
        .map_err(|_| "Could not reach the forecast.".to_string())?
        .json()
        .await
        .map_err(|_| "The forecast answered with something unexpected.".to_string())?;

    let (summary, icon) = describe(forecast.current.weather_code);
    let reading = Weather {
        place,
        celsius: forecast.current.temperature_2m.round() as i32,
        summary: summary.to_string(),
        icon: icon.to_string(),
        read_at_ms: chrono::Utc::now().timestamp_millis(),
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
                "https://api.open-meteo.com/v1/forecast?latitude=50.06&longitude=19.94\
                 &current=temperature_2m,weather_code&timezone=auto",
            )
            .await
            .unwrap()
            .text()
            .await
            .unwrap()
        });
        println!("{body}");
        assert!(body.contains("temperature_2m"));
    }
}
