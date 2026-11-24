use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Instant, UNIX_EPOCH};

use serde::Serialize;

/// A `Command` that never flashes a console window on Windows.
pub fn cmd(program: &str) -> Command {
    let mut c = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

/// Run blocking work off the async runtime and flatten the join error.
pub async fn blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("background task failed: {e}"))?
}

/// Per-user cache folder for thumbnails and preview proxies.
pub fn cache_dir() -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join("gigreel-cache");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create cache folder: {e}"))?;
    Ok(dir)
}

/// Stable-enough key for a file: its path, size and modification time.
pub fn file_key(path: &str, extra: &str) -> String {
    let mut h = DefaultHasher::new();
    path.hash(&mut h);
    extra.hash(&mut h);
    if let Ok(meta) = std::fs::metadata(path) {
        meta.len().hash(&mut h);
        if let Ok(m) = meta.modified() {
            m.duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0).hash(&mut h);
        }
    }
    format!("{:016x}", h.finish())
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub percent: f64,
    pub elapsed: f64,
    pub eta: Option<f64>,
    pub speed: Option<String>,
}

/// Run ffmpeg with `-progress pipe:1`, reporting progress against `total` seconds of output.
/// The child is parked in `slot` so another thread can kill it.
pub fn run_ffmpeg(
    args: &[String],
    cwd: Option<&Path>,
    total: f64,
    slot: &Mutex<Option<Child>>,
    mut on_progress: impl FnMut(Progress),
    on_log: impl Fn(String) + Send + 'static,
) -> Result<(), String> {
    let mut c = cmd("ffmpeg");
    c.args(["-hide_banner", "-nostdin", "-nostats", "-v", "warning", "-progress", "pipe:1"])
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = cwd {
        c.current_dir(dir);
    }
    let mut child = c.spawn().map_err(|e| format!("could not start ffmpeg: {e}"))?;
    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");
    *slot.lock().unwrap() = Some(child);

    let err_thread = std::thread::spawn(move || {
        let mut tail: Vec<String> = Vec::new();
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if line.trim().is_empty() {
                continue;
            }
            on_log(line.clone());
            tail.push(line);
            if tail.len() > 30 {
                tail.remove(0);
            }
        }
        tail
    });

    let started = Instant::now();
    let mut speed = None;
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        let Some((key, value)) = line.split_once('=') else { continue };
        match key {
            "speed" => speed = Some(value.trim().to_string()).filter(|s| s != "N/A"),
            "out_time_us" => {
                let Ok(us) = value.trim().parse::<f64>() else { continue };
                let done = (us / 1_000_000.0).max(0.0);
                let frac = if total > 0.0 { (done / total).clamp(0.0, 1.0) } else { 0.0 };
                let elapsed = started.elapsed().as_secs_f64();
                let eta = (frac > 0.02).then(|| elapsed * (1.0 - frac) / frac);
                on_progress(Progress { percent: frac * 100.0, elapsed, eta, speed: speed.clone() });
            }
            _ => {}
        }
    }

    let status = slot.lock().unwrap().take().map(|mut c| c.wait());
    let tail = err_thread.join().unwrap_or_default();
    match status {
        Some(Ok(s)) if s.success() => Ok(()),
        Some(Ok(s)) => Err(format!(
            "ffmpeg failed (exit {}).\n{}",
            s.code().map(|c| c.to_string()).unwrap_or_else(|| "killed".into()),
            tail.join("\n")
        )),
        Some(Err(e)) => Err(format!("ffmpeg did not finish: {e}")),
        None => Err("ffmpeg process was lost".into()),
    }
}

#[tauri::command]
pub fn reveal(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let p = path.replace('/', "\\");
        Command::new("explorer").raw_arg(format!("/select,\"{p}\"")).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    Command::new("open").args(["-R", &path]).spawn().map_err(|e| e.to_string())?;
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dir = Path::new(&path).parent().map(|p| p.to_path_buf()).unwrap_or_default();
        Command::new("xdg-open").arg(dir).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let p = path.replace('/', "\\");
        // `start "" "<path>"` opens with the default app.
        cmd("cmd").raw_arg(format!("/C start \"\" \"{p}\"")).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    Command::new("open").arg(&path).spawn().map_err(|e| e.to_string())?;
    #[cfg(all(unix, not(target_os = "macos")))]
    Command::new("xdg-open").arg(&path).spawn().map_err(|e| e.to_string())?;
    Ok(())
}
