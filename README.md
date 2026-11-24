# Gigreel

Desktop app (Rust + Tauri) that trims video clips, adds an "Artist – Title" overlay,
optionally verifies the song with AcoustID, and joins everything into one MP4.

## Requirements

- `ffmpeg` and `ffprobe` on PATH (`winget install Gyan.FFmpeg`)
- `fpcalc` (Chromaprint) on PATH, only for "Identify song" — https://acoustid.org/chromaprint
- A free AcoustID key (https://acoustid.org/new-application), entered in **Settings**.
  It is stored in Windows Credential Manager; `ACOUSTID_KEY` env var also works.

## Run / build

```powershell
npm install
npm run dev      # development window with hot reload of the UI
npm run build    # release exe + installer in src-tauri/target/release
cd src-tauri; cargo test   # renders real clips through the export pipeline
```

## Using it

- Drop videos onto the window (or **Add** / Ctrl+O). Drag cards to reorder.
- Select a clip, scrub the preview, and press **I** / **O** to set In / Out
  (or drag the handles, or type times like `1:23.5`).
- Files the web view can't play (HEVC, MKV, AVI…) get a light preview copy
  automatically; export always uses the originals.
- **Export** (Ctrl+E) shows progress, time left and can be cancelled. The file is
  written as `name.partial.mp4` and only replaces the target when it finished.

| Key | Action |
| --- | --- |
| Space | Play / pause |
| I / O | Set In / Out at playhead |
| P | Play just the trimmed range |
| , / . | Previous / next frame |
| ← / → (Shift) | Seek 1 s (5 s) |
| Home / End | Go to In / Out |
| ↑ / ↓ | Previous / next clip |
| Alt+↑ / Alt+↓ | Move clip up / down |
| Delete | Remove clip |
| M | Mute preview |

## Output options

- **Format**: 9:16, 4:5, 1:1, 16:9, 4K 16:9.
- **Framing**: *Blur fill* (blurred copy behind the clip), *Fit* (black bars), *Crop*.
- **Encoder**: x264 on the CPU, plus any NVIDIA / Intel / AMD hardware encoder
  that actually works on this machine (tested at startup).
- **Song title**: how long it shows (0 = whole clip), position and size.
- **Fade between clips**, **Even out loudness** (EBU R128, −14 LUFS).
- Clips without an audio track get silence, so mixing them in no longer fails.

Settings and the current clip list are saved and restored on the next launch.
