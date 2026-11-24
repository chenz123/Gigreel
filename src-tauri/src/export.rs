use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::util::{blocking, run_ffmpeg};

#[derive(Default)]
pub struct ExportState {
    child: Mutex<Option<Child>>,
    running: AtomicBool,
    cancelled: AtomicBool,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    path: String,
    start: f64,
    end: f64,
    text: String,
    has_audio: bool,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    clips: Vec<Clip>,
    output: String,
    width: u32,
    height: u32,
    fps: u32,
    /// "blur" (blurred background), "fit" (black bars) or "fill" (crop).
    fit: String,
    /// "libx264", "h264_nvenc", "h264_qsv" or "h264_amf".
    encoder: String,
    /// "high", "balanced" or "small".
    quality: String,
    /// Seconds the title stays up; 0 keeps it for the whole clip.
    overlay_secs: f64,
    /// "bottom", "center" or "top".
    overlay_pos: String,
    /// Percent of the default title size.
    overlay_scale: f64,
    fades: bool,
    normalize: bool,
}

const FONTS: &[&str] = &[
    "C:/Windows/Fonts/segoeuib.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
    "C:/Windows/Fonts/arial.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/Library/Fonts/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
];

fn even(n: f64) -> u32 {
    ((n / 2.0).round() as u32).max(1) * 2
}

/// Build the full ffmpeg argument list. Text files and the font are expected in the
/// working directory (`t{i}.txt`, `font.ttf`) so the filter graph needs no path escaping.
fn build_args(job: &Job, has_font: bool, output: &Path) -> Vec<String> {
    let (w, h) = (job.width, job.height);
    let mut args: Vec<String> = vec!["-y".into()];
    for c in &job.clips {
        args.extend([
            "-ss".into(), format!("{:.3}", c.start),
            "-t".into(), format!("{:.3}", c.end - c.start),
            "-i".into(), c.path.clone(),
        ]);
    }

    let font_size = (w.min(h) as f64 / 20.0 * job.overlay_scale / 100.0).round().max(8.0);
    let y = match job.overlay_pos.as_str() {
        "top" => "h*0.10".to_string(),
        "center" => "(h-text_h)/2".to_string(),
        _ => "h-text_h-h*0.14".to_string(),
    };
    let fade = 0.3;
    let mut chains = Vec::new();

    for (i, c) in job.clips.iter().enumerate() {
        let len = c.end - c.start;

        // Geometry: every clip becomes exactly w x h.
        let mut v = match job.fit.as_str() {
            "fill" => format!(
                "[{i}:v:0]setpts=PTS-STARTPTS,scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1"
            ),
            "fit" => format!(
                "[{i}:v:0]setpts=PTS-STARTPTS,scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1"
            ),
            _ => {
                // Blurred, zoomed copy behind the fitted clip. Blur at quarter size: same look, far cheaper.
                let (bw, bh) = (even(w as f64 / 4.0), even(h as f64 / 4.0));
                chains.push(format!("[{i}:v:0]setpts=PTS-STARTPTS,split[s{i}a][s{i}b]"));
                chains.push(format!(
                    "[s{i}a]scale={bw}:{bh}:force_original_aspect_ratio=increase,crop={bw}:{bh},boxblur=10:2,eq=brightness=-0.08,scale={w}:{h},setsar=1[bg{i}]"
                ));
                chains.push(format!(
                    "[s{i}b]scale={w}:{h}:force_original_aspect_ratio=decrease,setsar=1[fg{i}]"
                ));
                format!("[bg{i}][fg{i}]overlay=(W-w)/2:(H-h)/2")
            }
        };
        v += &format!(",fps={},format=yuv420p", job.fps);
        if job.fades && len > 2.0 * fade + 0.2 {
            v += &format!(",fade=t=in:st=0:d={fade},fade=t=out:st={:.3}:d={fade}", len - fade);
        }
        if !c.text.trim().is_empty() {
            let d = if job.overlay_secs > 0.0 { job.overlay_secs.min(len) } else { len };
            let f = 0.4_f64.min(d / 3.0);
            let font = if has_font { "fontfile=font.ttf:" } else { "" };
            v += &format!(
                ",drawtext={font}textfile=t{i}.txt:expansion=none:fix_bounds=1:fontcolor=white:fontsize={font_size}:\
                 x=(w-text_w)/2:y={y}:box=1:boxcolor=black@0.55:boxborderw={border}:\
                 enable='lt(t,{d:.3})':alpha='if(lt(t,{f:.3}),t/{f:.3},if(lt(t,{d:.3}-{f:.3}),1,max(0,({d:.3}-t)/{f:.3})))'",
                border = (font_size * 0.45).round(),
            );
        }
        chains.push(format!("{v}[v{i}]"));

        // Audio: always stereo 48k, padded/trimmed to exactly the clip length so A/V never drift.
        let afade = if job.fades { fade } else { 0.03 };
        let fades = if len > 2.0 * afade {
            format!(",afade=t=in:d={afade},afade=t=out:st={:.3}:d={afade}", len - afade)
        } else {
            String::new()
        };
        if c.has_audio {
            chains.push(format!(
                "[{i}:a:0]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=0:{len:.3}{fades}[a{i}]"
            ));
        } else {
            chains.push(format!(
                "anullsrc=r=48000:cl=stereo,atrim=0:{len:.3},aformat=sample_fmts=fltp:channel_layouts=stereo[a{i}]"
            ));
        }
    }

    let inputs: String = (0..job.clips.len()).map(|i| format!("[v{i}][a{i}]")).collect();
    let n = job.clips.len();
    if job.normalize {
        chains.push(format!("{inputs}concat=n={n}:v=1:a=1[v][ca]"));
        chains.push("[ca]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]".into());
    } else {
        chains.push(format!("{inputs}concat=n={n}:v=1:a=1[v][a]"));
    }

    args.extend(["-filter_complex".into(), chains.join(";"), "-map".into(), "[v]".into(), "-map".into(), "[a]".into()]);

    let q: u32 = match job.quality.as_str() {
        "high" => 18,
        "small" => 25,
        _ => 21,
    };
    let enc: Vec<String> = match job.encoder.as_str() {
        "h264_nvenc" => vec![
            "-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr",
            "-cq", &(q + 1).to_string(), "-b:v", "0", "-profile:v", "high",
        ]
        .into_iter()
        .map(String::from)
        .collect(),
        "h264_qsv" => vec!["-c:v", "h264_qsv", "-preset", "medium", "-global_quality", &(q + 2).to_string()]
            .into_iter()
            .map(String::from)
            .collect(),
        "h264_amf" => vec![
            "-c:v", "h264_amf", "-quality", "quality", "-rc", "cqp",
            "-qp_i", &q.to_string(), "-qp_p", &(q + 2).to_string(),
        ]
        .into_iter()
        .map(String::from)
        .collect(),
        _ => vec![
            "-c:v", "libx264", "-preset", if q == 18 { "slow" } else { "medium" },
            "-crf", &q.to_string(), "-pix_fmt", "yuv420p", "-profile:v", "high",
        ]
        .into_iter()
        .map(String::from)
        .collect(),
    };
    args.extend(enc);
    args.extend(
        ["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-f", "mp4"]
            .into_iter()
            .map(String::from),
    );
    args.push(output.to_string_lossy().into_owned());
    args
}

fn same_file(a: &str, b: &str) -> bool {
    let norm = |p: &str| {
        let p = std::fs::canonicalize(p).unwrap_or_else(|_| PathBuf::from(p));
        p.to_string_lossy().to_lowercase()
    };
    norm(a) == norm(b)
}

fn validate(job: &Job) -> Result<(), String> {
    if job.clips.is_empty() {
        return Err("Add at least one clip.".into());
    }
    if job.output.trim().is_empty() {
        return Err("Choose where to save the video.".into());
    }
    if job.width < 16 || job.height < 16 || job.width % 2 == 1 || job.height % 2 == 1 {
        return Err("Output size must be even and at least 16 px.".into());
    }
    for (i, c) in job.clips.iter().enumerate() {
        if c.end - c.start < 0.1 {
            return Err(format!("Clip {} is shorter than 0.1 s — check its In/Out points.", i + 1));
        }
        if same_file(&c.path, &job.output) {
            return Err(format!("The output file is the same as clip {}.", i + 1));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn export(app: AppHandle, job: Job) -> Result<String, String> {
    validate(&job)?;
    {
        let state = app.state::<ExportState>();
        if state.running.swap(true, Ordering::SeqCst) {
            return Err("An export is already running.".into());
        }
        state.cancelled.store(false, Ordering::SeqCst);
    }
    let handle = app.clone();
    let result = blocking(move || run_export(&handle, &job)).await;
    app.state::<ExportState>().running.store(false, Ordering::SeqCst);
    result
}

fn run_export(app: &AppHandle, job: &Job) -> Result<String, String> {
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let tmp = std::env::temp_dir().join(format!("gigreel-job-{}-{stamp}", std::process::id()));
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let result = (|| {
        for (i, c) in job.clips.iter().enumerate() {
            std::fs::write(tmp.join(format!("t{i}.txt")), c.text.trim()).map_err(|e| e.to_string())?;
        }
        let has_font = FONTS
            .iter()
            .find(|f| Path::new(f).exists())
            .map(|f| std::fs::copy(f, tmp.join("font.ttf")).is_ok())
            .unwrap_or(false);

        let output = PathBuf::from(&job.output);
        let stem = output.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or("output".into());
        let partial = output.with_file_name(format!("{stem}.partial.mp4"));
        let args = build_args(job, has_font, &partial);
        let total: f64 = job.clips.iter().map(|c| c.end - c.start).sum();

        let log_app = app.clone();
        let _ = app.emit("export-log", format!("ffmpeg {}", args.join(" ")));
        let state = app.state::<ExportState>();
        let run = run_ffmpeg(
            &args,
            Some(&tmp),
            total,
            &state.child,
            |p| {
                let _ = app.emit("export-progress", p);
            },
            move |line| {
                let _ = log_app.emit("export-log", line);
            },
        );
        if state.cancelled.load(Ordering::SeqCst) {
            let _ = std::fs::remove_file(&partial);
            return Err("Export cancelled.".into());
        }
        if let Err(e) = run {
            let _ = std::fs::remove_file(&partial);
            return Err(e);
        }
        std::fs::rename(&partial, &output).map_err(|e| format!("could not move the finished file into place: {e}"))?;
        Ok(output.to_string_lossy().into_owned())
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::cmd;

    fn make_clip(dir: &Path, name: &str, size: &str, audio: bool) -> String {
        let out = dir.join(name);
        let mut c = cmd("ffmpeg");
        c.args(["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", &format!("testsrc2=s={size}:r=25:d=4")]);
        if audio {
            c.args(["-f", "lavfi", "-i", "sine=f=440:d=4", "-c:a", "aac"]);
        }
        c.args(["-c:v", "libx264", "-pix_fmt", "yuv420p"]).arg(&out);
        assert!(c.status().unwrap().success(), "could not make {name}");
        out.to_string_lossy().into_owned()
    }

    fn duration(path: &Path) -> f64 {
        let out = cmd("ffprobe")
            .args(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0"])
            .arg(path)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().parse().unwrap()
    }

    fn render(fit: &str, normalize: bool) {
        let dir = std::env::temp_dir().join(format!("vc-test-{fit}-{normalize}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let a = make_clip(&dir, "portrait with audio.mp4", "480x640", true);
        let b = make_clip(&dir, "wide silent.mp4", "640x360", false);
        let job = Job {
            clips: vec![
                Clip { path: a, start: 0.5, end: 3.0, text: "Ünïcode – 100% 'quoted', a:b; [x]".into(), has_audio: true },
                Clip { path: b, start: 1.0, end: 2.5, text: "".into(), has_audio: false },
            ],
            output: dir.join("out.mp4").to_string_lossy().into_owned(),
            width: 360,
            height: 640,
            fps: 30,
            fit: fit.into(),
            encoder: "libx264".into(),
            quality: "small".into(),
            overlay_secs: 2.0,
            overlay_pos: "bottom".into(),
            overlay_scale: 100.0,
            fades: true,
            normalize,
        };
        validate(&job).unwrap();
        let tmp = dir.join("work");
        std::fs::create_dir_all(&tmp).unwrap();
        for (i, c) in job.clips.iter().enumerate() {
            std::fs::write(tmp.join(format!("t{i}.txt")), &c.text).unwrap();
        }
        std::fs::copy(FONTS[0], tmp.join("font.ttf")).unwrap();
        let out = PathBuf::from(&job.output);
        let args = build_args(&job, true, &out);
        let slot = Mutex::new(None);
        let mut last = 0.0;
        run_ffmpeg(&args, Some(&tmp), 4.0, &slot, |p| last = p.percent, |l| eprintln!("{l}")).unwrap();
        let d = duration(&out);
        assert!((d - 4.0).abs() < 0.15, "{fit}: expected ~4s, got {d}");
        assert!(last > 90.0, "{fit}: progress only reached {last}%");
    }

    #[test]
    fn renders_blur_with_silent_clip_and_tricky_title() {
        render("blur", false);
    }

    #[test]
    fn renders_fit_with_loudness_normalisation() {
        render("fit", true);
    }

    #[test]
    fn renders_crop() {
        render("fill", false);
    }
}

#[tauri::command]
pub fn cancel_export(state: State<'_, ExportState>) {
    state.cancelled.store(true, Ordering::SeqCst);
    if let Some(child) = state.child.lock().unwrap().as_mut() {
        let _ = child.kill();
    }
}
