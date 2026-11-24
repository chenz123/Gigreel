use std::process::Stdio;
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::util::{blocking, cache_dir, cmd, file_key, run_ffmpeg};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tools {
    ffmpeg: bool,
    ffprobe: bool,
    fpcalc: bool,
    /// Hardware H.264 encoders that actually work on this machine.
    encoders: Vec<String>,
}

fn runs(program: &str, args: &[&str]) -> bool {
    cmd(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[tauri::command]
pub async fn check_tools() -> Result<Tools, String> {
    blocking(|| {
        let ffmpeg = runs("ffmpeg", &["-version"]);
        let ffprobe = runs("ffprobe", &["-version"]);
        let fpcalc = runs("fpcalc", &["-version"]);
        let mut encoders = Vec::new();
        if ffmpeg {
            // An encoder being compiled in says nothing about the GPU, so try a tiny encode.
            let probes: Vec<_> = ["h264_nvenc", "h264_qsv", "h264_amf"]
                .into_iter()
                .map(|enc| {
                    std::thread::spawn(move || {
                        let ok = runs(
                            "ffmpeg",
                            &[
                                "-hide_banner", "-v", "error", "-f", "lavfi", "-i",
                                "color=black:s=256x256:d=0.2", "-frames:v", "2", "-c:v", enc,
                                "-f", "null", "-",
                            ],
                        );
                        (enc, ok)
                    })
                })
                .collect();
            for p in probes {
                if let Ok((enc, true)) = p.join() {
                    encoders.push(enc.to_string());
                }
            }
        }
        Ok(Tools { ffmpeg, ffprobe, fpcalc, encoders })
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    duration: f64,
    width: u32,
    height: u32,
    fps: f64,
    has_audio: bool,
    video_codec: String,
    audio_codec: Option<String>,
    size_bytes: u64,
}

fn num(v: &Value) -> Option<f64> {
    v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}

fn rate(s: &str) -> Option<f64> {
    let (n, d) = s.split_once('/')?;
    let (n, d): (f64, f64) = (n.parse().ok()?, d.parse().ok()?);
    (d > 0.0 && n > 0.0).then_some(n / d)
}

#[tauri::command]
pub async fn probe(path: String) -> Result<Probe, String> {
    blocking(move || {
        let out = cmd("ffprobe")
            .args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams"])
            .arg(&path)
            .output()
            .map_err(|e| format!("could not start ffprobe: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "Not a readable video: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        let info: Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
        let streams = info["streams"].as_array().cloned().unwrap_or_default();
        let video = streams
            .iter()
            .find(|s| s["codec_type"] == "video" && s["disposition"]["attached_pic"] != 1)
            .ok_or("File has no video stream")?;
        let audio = streams.iter().find(|s| s["codec_type"] == "audio");

        let mut width = video["width"].as_u64().unwrap_or(0) as u32;
        let mut height = video["height"].as_u64().unwrap_or(0) as u32;
        // Phone footage is often stored sideways with a rotation flag; report what the viewer sees.
        let rotation = video["side_data_list"]
            .as_array()
            .and_then(|l| l.iter().find_map(|d| num(&d["rotation"])))
            .or_else(|| num(&video["tags"]["rotate"]))
            .unwrap_or(0.0) as i64;
        if rotation.rem_euclid(180) == 90 {
            std::mem::swap(&mut width, &mut height);
        }
        let duration = num(&info["format"]["duration"])
            .or_else(|| num(&video["duration"]))
            .unwrap_or(0.0);
        let fps = video["avg_frame_rate"]
            .as_str()
            .and_then(rate)
            .or_else(|| video["r_frame_rate"].as_str().and_then(rate))
            .unwrap_or(30.0);
        let size_bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        Ok(Probe {
            duration,
            width,
            height,
            fps,
            has_audio: audio.is_some(),
            video_codec: video["codec_name"].as_str().unwrap_or("?").to_string(),
            audio_codec: audio.and_then(|a| a["codec_name"].as_str()).map(String::from),
            size_bytes,
        })
    })
    .await
}

/// Grab one frame as a small JPEG and return its path.
#[tauri::command]
pub async fn thumbnail(path: String, time: f64) -> Result<String, String> {
    blocking(move || {
        let out = cache_dir()?.join(format!("thumb_{}.jpg", file_key(&path, &format!("{time:.2}"))));
        if out.exists() {
            return Ok(out.to_string_lossy().into_owned());
        }
        let status = cmd("ffmpeg")
            .args(["-hide_banner", "-v", "error", "-y", "-ss", &format!("{time:.3}"), "-i"])
            .arg(&path)
            .args(["-frames:v", "1", "-vf", "scale=360:-2", "-q:v", "4"])
            .arg(&out)
            .stdin(Stdio::null())
            .status()
            .map_err(|e| e.to_string())?;
        if status.success() && out.exists() {
            Ok(out.to_string_lossy().into_owned())
        } else {
            Err("could not extract a thumbnail".into())
        }
    })
    .await
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProxyProgress {
    path: String,
    percent: f64,
}

/// Make a small H.264 copy the built-in player can always decode (HEVC, MKV, AVI…).
/// Same duration as the source, so cut points map one to one.
#[tauri::command]
pub async fn make_proxy(app: AppHandle, path: String, duration: f64) -> Result<String, String> {
    blocking(move || {
        let dir = cache_dir()?;
        let key = file_key(&path, "proxy-v1");
        let out = dir.join(format!("proxy_{key}.mp4"));
        if out.exists() {
            return Ok(out.to_string_lossy().into_owned());
        }
        let part = dir.join(format!("proxy_{key}.part"));
        let args: Vec<String> = vec![
            "-y".into(), "-i".into(), path.clone(),
            "-map".into(), "0:v:0".into(), "-map".into(), "0:a:0?".into(),
            "-vf".into(), "scale=-2:'min(540,ih)'".into(),
            "-c:v".into(), "libx264".into(), "-preset".into(), "veryfast".into(),
            "-crf".into(), "28".into(), "-g".into(), "15".into(), "-pix_fmt".into(), "yuv420p".into(),
            "-c:a".into(), "aac".into(), "-b:a".into(), "96k".into(),
            "-movflags".into(), "+faststart".into(), "-f".into(), "mp4".into(),
            part.to_string_lossy().into_owned(),
        ];
        let slot = Mutex::new(None);
        let src = path.clone();
        let result = run_ffmpeg(
            &args,
            None,
            duration,
            &slot,
            |p| {
                let _ = app.emit("proxy-progress", ProxyProgress { path: src.clone(), percent: p.percent });
            },
            |_| {},
        );
        if let Err(e) = result {
            let _ = std::fs::remove_file(&part);
            return Err(e);
        }
        std::fs::rename(&part, &out).map_err(|e| e.to_string())?;
        Ok(out.to_string_lossy().into_owned())
    })
    .await
}
