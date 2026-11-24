use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::util::{blocking, cache_dir, cmd, file_key};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Match {
    score: f64,
    artist: String,
    title: String,
}

/// Fingerprint up to two minutes of audio from `start` and look it up on AcoustID.
/// Returns candidates best first, one per distinct artist/title.
#[tauri::command]
pub async fn identify(path: String, key: String, start: f64) -> Result<Vec<Match>, String> {
    blocking(move || {
        let key = key.trim().to_string();
        if key.is_empty() {
            return Err("Add your AcoustID API key in Settings first.".into());
        }
        let wav = cache_dir()?.join(format!("fp_{}.wav", file_key(&path, &format!("{start:.2}"))));
        let status = cmd("ffmpeg")
            .args(["-hide_banner", "-v", "error", "-y", "-ss", &format!("{:.3}", start.max(0.0)), "-i"])
            .arg(&path)
            .args(["-vn", "-ac", "1", "-ar", "11025", "-t", "120"])
            .arg(&wav)
            .stdin(Stdio::null())
            .status()
            .map_err(|e| format!("could not start ffmpeg: {e}"))?;
        if !status.success() {
            return Err("Could not read the clip's audio.".into());
        }
        let fp = cmd("fpcalc").arg("-json").arg(&wav).output();
        let _ = std::fs::remove_file(&wav);
        let fp = fp.map_err(|_| {
            "fpcalc (Chromaprint) is not installed or not on PATH. Get it from acoustid.org/chromaprint.".to_string()
        })?;
        if !fp.status.success() {
            return Err(format!("fpcalc failed: {}", String::from_utf8_lossy(&fp.stderr).trim()));
        }
        let fp: Value = serde_json::from_slice(&fp.stdout).map_err(|e| e.to_string())?;
        let duration = fp["duration"].as_f64().unwrap_or(0.0).round() as i64;
        let fingerprint = fp["fingerprint"].as_str().ok_or("fpcalc returned no fingerprint")?;

        let resp = ureq::post("https://api.acoustid.org/v2/lookup")
            .timeout(Duration::from_secs(30))
            .send_form(&[
                ("client", key.as_str()),
                ("meta", "recordings"),
                ("duration", &duration.to_string()),
                ("fingerprint", fingerprint),
            ]);
        let body: Value = match resp {
            Ok(r) => r.into_json().map_err(|e| e.to_string())?,
            // AcoustID explains bad keys etc. in a JSON body on 4xx.
            Err(ureq::Error::Status(_, r)) => r.into_json().map_err(|e| e.to_string())?,
            Err(e) => return Err(format!("Could not reach AcoustID: {e}")),
        };
        if body["status"] != "ok" {
            let msg = body["error"]["message"].as_str().unwrap_or("lookup failed");
            return Err(format!("AcoustID: {msg}"));
        }

        let mut found: Vec<Match> = Vec::new();
        for hit in body["results"].as_array().into_iter().flatten() {
            let score = hit["score"].as_f64().unwrap_or(0.0);
            for rec in hit["recordings"].as_array().into_iter().flatten() {
                let (Some(title), Some(artist)) =
                    (rec["title"].as_str(), rec["artists"][0]["name"].as_str())
                else {
                    continue;
                };
                let dup = found.iter_mut().find(|m| {
                    m.artist.eq_ignore_ascii_case(artist) && m.title.eq_ignore_ascii_case(title)
                });
                match dup {
                    Some(m) => m.score = m.score.max(score),
                    None => found.push(Match { score, artist: artist.into(), title: title.into() }),
                }
            }
        }
        found.sort_by(|a, b| b.score.total_cmp(&a.score));
        found.truncate(8);
        Ok(found)
    })
    .await
}
