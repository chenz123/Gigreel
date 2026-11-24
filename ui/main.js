'use strict';

const { invoke, convertFileSrc } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const dialog = window.__TAURI__.dialog;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const FORMATS = {
  vertical: { label: 'Vertical 9:16 · 1080×1920', w: 1080, h: 1920 },
  portrait: { label: 'Portrait 4:5 · 1080×1350', w: 1080, h: 1350 },
  square: { label: 'Square 1:1 · 1080×1080', w: 1080, h: 1080 },
  horizontal: { label: 'Horizontal 16:9 · 1920×1080', w: 1920, h: 1080 },
  uhd: { label: 'Horizontal 16:9 · 3840×2160 (4K)', w: 3840, h: 2160 },
};
const ENCODERS = {
  libx264: 'CPU · x264 (best quality)',
  h264_nvenc: 'NVIDIA NVENC (fast)',
  h264_qsv: 'Intel Quick Sync (fast)',
  h264_amf: 'AMD AMF (fast)',
};
const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mts', 'm2ts', 'wmv', 'flv', '3gp', 'mpg', 'mpeg', 'ts'];
const PLAYABLE_EXT = ['mp4', 'mov', 'm4v', 'webm'];
const PLAYABLE_CODECS = ['h264', 'vp8', 'vp9', 'av1'];
const DEFAULTS = {
  format: 'vertical', fit: 'blur', fps: 30, quality: 'balanced', encoder: 'libx264',
  overlaySecs: 5, overlayPos: 'bottom', overlayScale: 100, fades: true, normalize: false,
  outputPath: '', lastDir: '', session: [],
};

let settings = { ...DEFAULTS };
let apiKey = '';
let tools = { ffmpeg: true, ffprobe: true, fpcalc: true, encoders: [] };
let clips = [];
let selectedId = null;
let exporting = false;
let lastOutput = null;
let nextId = 1;

/* ------------------------------------------------------------------ helpers */

const ext = (p) => (p.split('.').pop() || '').toLowerCase();
const baseName = (p) => p.split(/[\\/]/).pop();
const dirName = (p) => p.replace(/[\\/][^\\/]*$/, '');
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const selected = () => clips.find((c) => c.id === selectedId) || null;
const clipLen = (c) => Math.max(0, c.end - c.start);
const songText = (c) => [c.artist.trim(), c.title.trim()].filter(Boolean).join(' – ');

function fmt(t, digits = 2) {
  if (!Number.isFinite(t)) return '–';
  t = Math.max(0, t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = (t % 60).toFixed(digits).padStart(digits ? digits + 3 : 2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function fmtShort(t) {
  if (!Number.isFinite(t)) return '–';
  if (t < 60) return `${t.toFixed(1)}s`;
  const m = Math.floor(t / 60);
  const s = Math.round(t % 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}:${String(s).padStart(2, '0')}`;
}

/** Accepts "83.5", "1:23.5", "1:02:03.25" (comma decimals too). */
function parseTime(str) {
  const s = String(str).trim().replace(',', '.');
  if (!s) return null;
  if (!/^\d+(:\d{1,2})*(\.\d+)?$/.test(s) && !/^\d*\.\d+$/.test(s)) return null;
  const parts = s.split(':').map(Number);
  if (parts.length > 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function toast(msg, kind = 'info', ms = 4500) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  const ic = kind === 'error' ? 'alert' : kind === 'success' ? 'check' : 'film';
  el.innerHTML = `${icon(ic)}<div>${esc(msg)}</div>`;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    settings.session = clips
      .filter((c) => c.probe)
      .map(({ path, start, end, artist, title }) => ({ path, start, end, artist, title }));
    invoke('save_settings', { settings }).catch(() => {});
  }, 400);
}

/* ------------------------------------------------------------------ clips */

async function addFiles(paths, restore = null) {
  const videos = paths.filter((p) => VIDEO_EXT.includes(ext(p)));
  const skipped = paths.length - videos.length;
  if (skipped) toast(`Skipped ${skipped} file${skipped > 1 ? 's' : ''} that ${skipped > 1 ? "aren't" : "isn't a"} video.`, 'info');
  if (!videos.length) return;
  if (!restore) {
    settings.lastDir = dirName(videos[0]);
  }

  const added = videos.map((path, i) => {
    const r = restore?.[i] || {};
    return {
      id: nextId++, path, name: baseName(path), probe: null, thumb: null, proxy: null,
      start: r.start ?? 0, end: r.end ?? 0, artist: r.artist ?? '', title: r.title ?? '',
      verify: { state: 'idle', msg: '' }, matches: [],
    };
  });
  clips.push(...added);
  if (!selectedId) selectedId = added[0].id;
  renderClips();
  if (selectedId === added[0].id) loadPlayer();

  await Promise.all(
    added.map(async (c) => {
      try {
        c.probe = await invoke('probe', { path: c.path });
        const d = c.probe.duration;
        c.end = c.end > 0 ? Math.min(c.end, d) : d;
        c.start = clamp(c.start, 0, Math.max(0, c.end - 0.1));
        renderClipCard(c);
        if (c.id === selectedId) { renderInspector(); loadPlayer(); }
        updateSummary();
        persist();
        c.thumb = await invoke('thumbnail', { path: c.path, time: Math.min(d * 0.1, 3) });
        renderClipCard(c);
      } catch (e) {
        if (!restore) toast(`${c.name}: ${e}`, 'error');
        removeClip(c.id, true);
      }
    }),
  );
}

function removeClip(id, silent = false) {
  const idx = clips.findIndex((c) => c.id === id);
  if (idx < 0) return;
  clips.splice(idx, 1);
  if (selectedId === id) {
    selectedId = clips[Math.min(idx, clips.length - 1)]?.id ?? null;
    loadPlayer();
  }
  renderClips();
  if (!silent) persist();
}

function moveSelected(delta) {
  const idx = clips.findIndex((c) => c.id === selectedId);
  const to = idx + delta;
  if (idx < 0 || to < 0 || to >= clips.length) return;
  const [c] = clips.splice(idx, 1);
  clips.splice(to, 0, c);
  renderClips();
  persist();
}

function select(id) {
  if (id === selectedId) return;
  selectedId = id;
  $$('.clip').forEach((el) => el.classList.toggle('selected', Number(el.dataset.id) === id));
  $(`.clip[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
  loadPlayer();
}

/* ------------------------------------------------------------------ rendering */

function clipCardHtml(c, i) {
  const p = c.probe;
  const meta = p
    ? `${p.width}×${p.height} · ${Math.round(p.fps)} fps · ${fmtShort(p.duration)}`
    : 'Reading…';
  const trimmed = p && (c.start > 0.01 || c.end < p.duration - 0.01);
  const song = songText(c);
  const v = c.verify.state;
  const songIcon = v === 'ok' ? icon('check') : v === 'warn' ? icon('alert') : icon('wave');
  const songClass = v === 'ok' ? 'ok' : v === 'warn' ? 'warn' : '';
  return `
    <div class="grip">${icon('grip')}</div>
    <div class="thumb">
      ${c.thumb ? `<img src="${convertFileSrc(c.thumb)}" alt="" draggable="false" />` : ''}
      <span class="num">${i + 1}</span>
      ${p ? `<span class="len">${fmtShort(clipLen(c))}</span>` : ''}
    </div>
    <div class="clip-info">
      <div class="clip-name" title="${esc(c.path)}">${esc(c.name)}</div>
      <div class="clip-meta">${trimmed ? `<span class="badge">${fmt(c.start, 1)}–${fmt(c.end, 1)}</span> ` : ''}${meta}${p && !p.hasAudio ? ' · <span class="badge warn">no audio</span>' : ''}</div>
      <div class="clip-song ${song ? '' : 'empty'}" style="${songClass ? `color:var(--${songClass})` : ''}">
        ${song ? songIcon : ''}<span>${song ? esc(song) : 'No title'}</span>
      </div>
    </div>
    <button class="remove" title="Remove (Delete)">${icon('x')}</button>`;
}

function renderClips() {
  const list = $('#clipList');
  list.innerHTML = '';
  clips.forEach((c, i) => {
    const el = document.createElement('div');
    el.className = `clip${c.id === selectedId ? ' selected' : ''}${c.probe ? '' : ' loading'}`;
    el.dataset.id = c.id;
    el.innerHTML = clipCardHtml(c, i);
    list.appendChild(el);
  });
  $('#emptyList').classList.toggle('hidden', clips.length > 0);
  updateSummary();
  renderInspector();
}

function renderClipCard(c) {
  const el = $(`.clip[data-id="${c.id}"]`);
  if (!el) return;
  el.classList.toggle('loading', !c.probe);
  el.innerHTML = clipCardHtml(c, clips.indexOf(c));
}

function updateSummary() {
  const ready = clips.filter((c) => c.probe);
  if (!clips.length) {
    $('#summary').textContent = 'No clips yet';
    return;
  }
  const total = ready.reduce((s, c) => s + clipLen(c), 0);
  const f = FORMATS[settings.format];
  $('#summary').innerHTML =
    `<b>${clips.length}</b> clip${clips.length > 1 ? 's' : ''} · <b>${fmt(total, 1)}</b> total · ${f.w}×${f.h} @ ${settings.fps} fps`;
}

function renderInspector() {
  const c = selected();
  const enabled = !!(c && c.probe);
  $('#inspector').classList.toggle('disabled', !enabled);
  $('#transport').classList.toggle('disabled', !enabled);
  const set = (sel, v) => { const el = $(sel); if (document.activeElement !== el) el.value = v; };
  if (!c) {
    ['#inInput', '#outInput', '#artistInput', '#titleInput'].forEach((s) => set(s, ''));
    $('#lenOut').textContent = '–';
    renderVerify();
    return;
  }
  set('#inInput', c.probe ? fmt(c.start) : '');
  set('#outInput', c.probe ? fmt(c.end) : '');
  set('#artistInput', c.artist);
  set('#titleInput', c.title);
  $('#lenOut').textContent = c.probe ? fmt(clipLen(c)) : '–';
  $('#identifyBtn').disabled = !tools.fpcalc || c.verify.state === 'busy';
  renderVerify();
  updateTimeline();
}

function renderVerify() {
  const c = selected();
  const status = $('#verifyStatus');
  const matches = $('#matches');
  if (!c || c.verify.state === 'idle') {
    status.innerHTML = '';
    matches.innerHTML = '';
    return;
  }
  const map = { busy: ['info', 'wave'], ok: ['ok', 'check'], warn: ['warn', 'alert'], info: ['info', 'wave'], error: ['danger', 'alert'] };
  const [cls, ic] = map[c.verify.state] || ['info', 'wave'];
  status.innerHTML = `<span class="chip ${cls}">${c.verify.state === 'busy' ? '<span class="spinner" style="width:12px;height:12px;border-width:2px"></span>' : icon(ic)} ${esc(c.verify.msg)}</span>`;
  matches.innerHTML = c.matches
    .slice(0, 5)
    .map((m, i) => `<span class="match" data-i="${i}" title="Use this artist and title">${esc(m.artist)} – ${esc(m.title)}<span class="score">${Math.round(m.score * 100)}%</span></span>`)
    .join('');
}

/* ------------------------------------------------------------------ player */

const video = $('#video');
const frame = $('#frame');
const bgCanvas = $('#bgCanvas');
const bgCtx = bgCanvas.getContext('2d');
let playRange = false;
let loadedPath = null;

function needsProxy(c) {
  return !PLAYABLE_EXT.includes(ext(c.path)) || !PLAYABLE_CODECS.includes(c.probe?.videoCodec);
}

async function loadPlayer() {
  const c = selected();
  $('#stageEmpty').classList.toggle('hidden', !!c);
  frame.classList.toggle('hidden', !c);
  $('#proxyOverlay').classList.add('hidden');
  renderInspector();
  layoutFrame();
  if (!c) {
    video.removeAttribute('src');
    video.load();
    loadedPath = null;
    return;
  }
  if (!c.probe) return; // called again once probed
  if (loadedPath === c.path && video.src) {
    video.currentTime = c.start;
    return;
  }
  video.pause();
  if (c.proxy || !needsProxy(c)) {
    setSource(c, c.proxy || c.path);
  } else {
    await buildProxy(c);
  }
}

function setSource(c, file) {
  loadedPath = c.path;
  video.src = convertFileSrc(file);
  video.dataset.proxy = file === c.path ? '' : '1';
  video.addEventListener('loadedmetadata', () => { video.currentTime = c.start; }, { once: true });
}

async function buildProxy(c) {
  if (c.proxyPending) return;
  c.proxyPending = true;
  if (c.id === selectedId) {
    $('#proxyOverlay').classList.remove('hidden');
    $('#proxyPct').textContent = '0%';
    video.removeAttribute('src');
    loadedPath = null;
  }
  try {
    c.proxy = await invoke('make_proxy', { path: c.path, duration: c.probe.duration });
    if (c.id === selectedId) {
      $('#proxyOverlay').classList.add('hidden');
      setSource(c, c.proxy);
    }
  } catch (e) {
    toast(`Preview failed for ${c.name}: ${e}`, 'error');
    if (c.id === selectedId) $('#proxyOverlay').classList.add('hidden');
  } finally {
    c.proxyPending = false;
  }
}

video.addEventListener('error', () => {
  const c = selected();
  // The web view can't decode this file (e.g. HEVC without the system codec): fall back to a proxy.
  if (c && c.probe && !c.proxy && video.dataset.proxy === '' && loadedPath === c.path) buildProxy(c);
});

listen('proxy-progress', (e) => {
  const c = selected();
  if (c && e.payload.path === c.path) $('#proxyPct').textContent = `${Math.round(e.payload.percent)}%`;
});

function layoutFrame() {
  const stage = $('#stage');
  const f = FORMATS[settings.format];
  const pad = 36;
  const aw = stage.clientWidth - pad;
  const ah = stage.clientHeight - pad;
  if (aw <= 0 || ah <= 0) return;
  const scale = Math.min(aw / f.w, ah / f.h);
  const w = Math.floor(f.w * scale);
  const h = Math.floor(f.h * scale);
  frame.style.width = `${w}px`;
  frame.style.height = `${h}px`;
  frame.classList.toggle('blur', settings.fit === 'blur');
  frame.classList.toggle('fill', settings.fit === 'fill');
  bgCanvas.width = Math.max(16, Math.round(w / 4));
  bgCanvas.height = Math.max(16, Math.round(h / 4));
  const span = $('#titleOverlay span');
  span.style.fontSize = `${(Math.min(w, h) / 20) * (settings.overlayScale / 100)}px`;
  $('#titleOverlay').className = `title-overlay ${settings.overlayPos}`;
  drawBackground();
  updateOverlay();
}
new ResizeObserver(layoutFrame).observe($('#stage'));

function drawBackground() {
  if (settings.fit !== 'blur' || !video.videoWidth) return;
  const cw = bgCanvas.width;
  const ch = bgCanvas.height;
  const s = Math.max(cw / video.videoWidth, ch / video.videoHeight);
  const dw = video.videoWidth * s;
  const dh = video.videoHeight * s;
  bgCtx.filter = 'blur(3px) brightness(0.85)';
  bgCtx.drawImage(video, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
}

function onFrame() {
  drawBackground();
  updateOverlay();
  updateTimeline();
  enforceRange();
  if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(onFrame);
}
if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(onFrame);
video.addEventListener('seeked', () => { drawBackground(); updateOverlay(); updateTimeline(); });
video.addEventListener('loadeddata', () => { drawBackground(); updateOverlay(); updateTimeline(); });
video.addEventListener('timeupdate', () => { updateTimeline(); enforceRange(); });
video.addEventListener('play', () => { $('#playBtn').innerHTML = icon('pause'); });
video.addEventListener('pause', () => { $('#playBtn').innerHTML = icon('play'); playRange = false; $('#playRangeBtn').classList.remove('active'); });

function enforceRange() {
  const c = selected();
  if (playRange && c && video.currentTime >= c.end) {
    video.pause();
    video.currentTime = c.end;
  }
}

/** Mirror ffmpeg's drawtext timing: shown from In for N seconds with a short fade. */
function updateOverlay() {
  const c = selected();
  const el = $('#titleOverlay');
  const text = c ? songText(c) : '';
  if (!c || !text) { el.style.opacity = 0; return; }
  el.firstElementChild.textContent = text;
  const len = clipLen(c);
  const d = settings.overlaySecs > 0 ? Math.min(settings.overlaySecs, len) : len;
  const f = Math.min(0.4, d / 3);
  const t = video.currentTime - c.start;
  let a = 0;
  if (t >= 0 && t < d) a = t < f ? t / f : t < d - f ? 1 : Math.max(0, (d - t) / f);
  // While paused, show the title fully if the playhead is in its window so it's easy to judge.
  if (video.paused && t >= 0 && t < d) a = 1;
  el.style.opacity = a;
}

/* ------------------------------------------------------------------ timeline */

const track = $('.track');

function updateTimeline() {
  const c = selected();
  if (!c || !c.probe) return;
  const d = c.probe.duration || 1;
  const pct = (t) => `${clamp((t / d) * 100, 0, 100)}%`;
  $('#range').style.left = pct(c.start);
  $('#range').style.width = `${clamp(((c.end - c.start) / d) * 100, 0, 100)}%`;
  $('#handleIn').style.left = pct(c.start);
  $('#handleOut').style.left = pct(c.end);
  $('#playhead').style.left = pct(video.currentTime || 0);
  $('#curTime').textContent = fmt(video.currentTime || 0);
  $('#durTime').textContent = fmt(d);
}

function timeAt(clientX) {
  const c = selected();
  const r = track.getBoundingClientRect();
  return clamp((clientX - r.left) / r.width, 0, 1) * (c?.probe?.duration || 0);
}

function seek(t) {
  const c = selected();
  if (!c?.probe) return;
  video.currentTime = clamp(t, 0, c.probe.duration);
  updateTimeline();
}

function setIn(t) {
  const c = selected();
  if (!c?.probe) return;
  c.start = clamp(t, 0, c.end - 0.1);
  afterTrimChange(c);
}

function setOut(t) {
  const c = selected();
  if (!c?.probe) return;
  c.end = clamp(t, c.start + 0.1, c.probe.duration);
  afterTrimChange(c);
}

function afterTrimChange(c) {
  if (c.verify.state !== 'idle' && c.verify.state !== 'busy') { c.verify = { state: 'idle', msg: '' }; c.matches = []; }
  renderClipCard(c);
  renderInspector();
  updateSummary();
  updateOverlay();
  persist();
}

function dragOn(el, onMove) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    el.classList.add('drag');
    const wasPlaying = !video.paused;
    video.pause();
    onMove(e);
    const move = (ev) => onMove(ev);
    const up = () => {
      el.classList.remove('drag');
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (wasPlaying) video.play();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
}
dragOn($('#handleIn'), (e) => { const t = timeAt(e.clientX); setIn(t); seek(selected().start); });
dragOn($('#handleOut'), (e) => { const t = timeAt(e.clientX); setOut(t); seek(selected().end); });
dragOn($('#timeline'), (e) => seek(timeAt(e.clientX)));

/* ------------------------------------------------------------------ transport */

function togglePlay() {
  const c = selected();
  if (!c?.probe || !video.src) return;
  if (video.paused) {
    if (video.currentTime >= c.probe.duration - 0.05) video.currentTime = c.start;
    video.play();
  } else video.pause();
}

function playTrimmed() {
  const c = selected();
  if (!c?.probe || !video.src) return;
  video.currentTime = c.start;
  video.play().then(() => {
    playRange = true;
    $('#playRangeBtn').classList.add('active');
  });
}

function step(frames) {
  const c = selected();
  if (!c?.probe) return;
  video.pause();
  seek(video.currentTime + frames / (c.probe.fps || 30));
}

$('#playBtn').onclick = togglePlay;
$('#playRangeBtn').onclick = playTrimmed;
$('#goInBtn').onclick = () => { const c = selected(); if (c) seek(c.start); };
$('#goOutBtn').onclick = () => { const c = selected(); if (c) seek(c.end); };
$('#stepBackBtn').onclick = () => step(-1);
$('#stepFwdBtn').onclick = () => step(1);
$('#setInBtn').onclick = () => setIn(video.currentTime);
$('#setOutBtn').onclick = () => setOut(video.currentTime);
$('#muteBtn').onclick = () => {
  video.muted = !video.muted;
  $('#muteBtn').innerHTML = icon(video.muted ? 'mute' : 'volume');
};

/* ------------------------------------------------------------------ inspector */

function bindTimeInput(sel, apply) {
  const el = $(sel);
  const commit = () => {
    const c = selected();
    if (!c?.probe) return;
    const t = parseTime(el.value);
    if (t === null) {
      el.classList.add('invalid');
      setTimeout(() => el.classList.remove('invalid'), 900);
      renderInspector();
      return;
    }
    apply(t);
    el.value = fmt(sel === '#inInput' ? selected().start : selected().end);
  };
  el.addEventListener('change', commit);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { commit(); el.blur(); }
    if (e.key === 'Escape') { renderInspector(); el.blur(); }
  });
}
bindTimeInput('#inInput', (t) => { setIn(t); seek(selected().start); });
bindTimeInput('#outInput', (t) => { setOut(t); seek(selected().end); });

for (const [sel, key] of [['#artistInput', 'artist'], ['#titleInput', 'title']]) {
  $(sel).addEventListener('input', (e) => {
    const c = selected();
    if (!c) return;
    c[key] = e.target.value;
    if (c.verify.state !== 'busy') { c.verify = { state: 'idle', msg: '' }; c.matches = []; renderVerify(); }
    renderClipCard(c);
    updateOverlay();
    persist();
  });
  $(sel).addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') e.target.blur(); });
}

const normText = (s) =>
  s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const loose = (a, b) => !!a && !!b && (a.includes(b) || b.includes(a));

$('#identifyBtn').onclick = async () => {
  const c = selected();
  if (!c?.probe) return;
  if (!apiKey) {
    toast('Add your AcoustID API key first.', 'info');
    openSettings();
    return;
  }
  c.verify = { state: 'busy', msg: 'Listening…' };
  c.matches = [];
  renderInspector();
  try {
    const found = await invoke('identify', { path: c.path, key: apiKey, start: c.start });
    c.matches = found;
    const a = normText(c.artist);
    const t = normText(c.title);
    if (!found.length) {
      c.verify = { state: 'warn', msg: 'No match found' };
    } else if (a && t && found.some((m) => m.score >= 0.5 && loose(normText(m.artist), a) && loose(normText(m.title), t))) {
      const best = found.find((m) => loose(normText(m.artist), a) && loose(normText(m.title), t));
      c.verify = { state: 'ok', msg: `Verified · ${Math.round(best.score * 100)}% match` };
    } else if (!c.artist.trim() && !c.title.trim()) {
      c.artist = found[0].artist;
      c.title = found[0].title;
      c.verify = { state: 'info', msg: 'Filled in from the best match — please confirm' };
    } else {
      c.verify = { state: 'warn', msg: `Sounds like ${found[0].artist} – ${found[0].title}` };
    }
  } catch (e) {
    c.verify = { state: 'error', msg: String(e) };
  }
  persist();
  renderClipCard(c);
  if (c.id === selectedId) renderInspector();
};

$('#matches').addEventListener('click', (e) => {
  const el = e.target.closest('.match');
  const c = selected();
  if (!el || !c) return;
  const m = c.matches[Number(el.dataset.i)];
  c.artist = m.artist;
  c.title = m.title;
  c.verify = { state: 'ok', msg: `Using match · ${Math.round(m.score * 100)}%` };
  renderClipCard(c);
  renderInspector();
  updateOverlay();
  persist();
});

/* ------------------------------------------------------------------ clip list interactions */

const list = $('#clipList');
list.addEventListener('pointerdown', (e) => {
  const card = e.target.closest('.clip');
  if (!card || e.button !== 0) return;
  if (e.target.closest('.remove')) {
    removeClip(Number(card.dataset.id));
    return;
  }
  select(Number(card.dataset.id));

  // Pointer-driven reordering (native HTML drag-and-drop is taken by the OS file drop on Windows).
  const startY = e.clientY;
  let dragging = false;
  card.setPointerCapture(e.pointerId);
  const move = (ev) => {
    if (!dragging && Math.abs(ev.clientY - startY) < 5) return;
    if (!dragging) { dragging = true; card.classList.add('dragging'); }
    const siblings = $$('.clip', list).filter((el) => el !== card);
    const after = siblings.find((el) => {
      const r = el.getBoundingClientRect();
      return ev.clientY < r.top + r.height / 2;
    });
    if (after) { if (card.nextElementSibling !== after) list.insertBefore(card, after); }
    else if (list.lastElementChild !== card) list.appendChild(card);
    const lr = list.getBoundingClientRect();
    if (ev.clientY < lr.top + 30) list.scrollTop -= 8;
    if (ev.clientY > lr.bottom - 30) list.scrollTop += 8;
  };
  const up = () => {
    card.removeEventListener('pointermove', move);
    card.removeEventListener('pointerup', up);
    card.removeEventListener('pointercancel', up);
    if (!dragging) return;
    card.classList.remove('dragging');
    const order = $$('.clip', list).map((el) => Number(el.dataset.id));
    clips.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    renderClips();
    persist();
  };
  card.addEventListener('pointermove', move);
  card.addEventListener('pointerup', up);
  card.addEventListener('pointercancel', up);
});

async function browseForClips() {
  const picked = await dialog.open({
    multiple: true,
    defaultPath: settings.lastDir || undefined,
    filters: [{ name: 'Video', extensions: VIDEO_EXT }, { name: 'All files', extensions: ['*'] }],
  });
  if (picked) addFiles(Array.isArray(picked) ? picked : [picked]);
}
$('#addBtn').onclick = browseForClips;
$('#emptyAdd').onclick = (e) => { e.preventDefault(); browseForClips(); };

window.__TAURI__.webview.getCurrentWebview().onDragDropEvent((e) => {
  const p = e.payload;
  if (p.type === 'enter' || p.type === 'over') $('#dropOverlay').classList.remove('hidden');
  else if (p.type === 'leave') $('#dropOverlay').classList.add('hidden');
  else if (p.type === 'drop') {
    $('#dropOverlay').classList.add('hidden');
    if (p.paths?.length) addFiles(p.paths);
  }
});

/* ------------------------------------------------------------------ output settings */

function bindOutputPanel() {
  const fmtSel = $('#formatSel');
  fmtSel.innerHTML = Object.entries(FORMATS).map(([k, f]) => `<option value="${k}">${f.label}</option>`).join('');
  const encSel = $('#encoderSel');
  const encoders = ['libx264', ...tools.encoders];
  // Hardware encoders are added once check_tools finishes; keep the saved choice until then.
  encSel.innerHTML = [...new Set([...encoders, settings.encoder])]
    .map((k) => `<option value="${k}">${ENCODERS[k] || k}</option>`)
    .join('');

  const bind = (sel, key, parse = (v) => v, after = () => {}) => {
    const el = $(sel);
    el.value = settings[key];
    el.addEventListener(el.type === 'range' ? 'input' : 'change', () => {
      settings[key] = parse(el.value);
      after();
      persist();
    });
  };
  bind('#formatSel', 'format', String, () => { layoutFrame(); updateSummary(); });
  bind('#fpsSel', 'fps', Number, updateSummary);
  bind('#qualitySel', 'quality');
  bind('#encoderSel', 'encoder');
  bind('#overlaySecs', 'overlaySecs', (v) => clamp(Number(v) || 0, 0, 120), updateOverlay);
  bind('#overlayPos', 'overlayPos', String, layoutFrame);
  bind('#overlayScale', 'overlayScale', Number, () => {
    $('#overlayScaleOut').textContent = `${settings.overlayScale}%`;
    layoutFrame();
  });
  $('#overlayScaleOut').textContent = `${settings.overlayScale}%`;

  const seg = $('#fitSeg');
  const paintSeg = () => $$('button', seg).forEach((b) => b.classList.toggle('on', b.dataset.value === settings.fit));
  paintSeg();
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    settings.fit = b.dataset.value;
    paintSeg();
    layoutFrame();
    persist();
  });

  for (const [sel, key] of [['#fadesChk', 'fades'], ['#normalizeChk', 'normalize']]) {
    $(sel).checked = settings[key];
    $(sel).addEventListener('change', (e) => { settings[key] = e.target.checked; persist(); });
  }
  renderOutPath();
}

function renderOutPath() {
  const el = $('#outPath');
  el.textContent = settings.outputPath || 'Choose where to save…';
  el.classList.toggle('muted', !settings.outputPath);
  // Right-to-left keeps the file name visible when a long path is cut, but would garble the placeholder.
  el.style.direction = settings.outputPath ? 'rtl' : 'ltr';
  $('#outPathBox').title = settings.outputPath || 'Click to choose where to save';
}

async function chooseOutput() {
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  const dir = settings.outputPath ? dirName(settings.outputPath) : settings.lastDir;
  const name = `combined-${stamp}.mp4`;
  const picked = await dialog.save({
    defaultPath: dir ? `${dir}\\${name}` : name,
    filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
  });
  if (!picked) return false;
  settings.outputPath = /\.mp4$/i.test(picked) ? picked : `${picked}.mp4`;
  renderOutPath();
  persist();
  return true;
}
$('#outPathBox').onclick = () => { if (!exporting) chooseOutput(); };

/* ------------------------------------------------------------------ export */

const logLines = [];
function log(line) {
  logLines.push(line);
  if (logLines.length > 600) logLines.splice(0, logLines.length - 600);
  const pre = $('#logText');
  pre.textContent = logLines.join('\n');
  pre.scrollTop = pre.scrollHeight;
}
listen('export-log', (e) => log(e.payload));
listen('export-progress', (e) => {
  const p = e.payload;
  $('#progressFill').style.width = `${p.percent.toFixed(1)}%`;
  $('#progressPct').textContent = `${Math.floor(p.percent)}%`;
  const eta = p.eta != null ? `about ${fmtShort(Math.max(1, p.eta))} left` : 'estimating…';
  $('#progressEta').textContent = `${eta}${p.speed ? ` · ${p.speed}` : ''}`;
});

function setExporting(on) {
  exporting = on;
  $('#exportBtn').classList.toggle('hidden', on);
  $('#cancelBtn').classList.toggle('hidden', !on);
  $('#progress').classList.toggle('hidden', !on);
  $('#outPathBox').style.opacity = on ? 0.5 : 1;
  if (on) {
    $('#result').classList.add('hidden');
    $('#progressFill').style.width = '0%';
    $('#progressPct').textContent = '0%';
    $('#progressEta').textContent = 'starting…';
  }
}

async function startExport() {
  if (exporting) return;
  const ready = clips.filter((c) => c.probe);
  if (!ready.length) return toast('Add at least one clip first.', 'info');
  if (ready.length < clips.length) return toast('Some clips are still loading.', 'info');
  if (!settings.outputPath && !(await chooseOutput())) return;
  const f = FORMATS[settings.format];
  const job = {
    clips: ready.map((c) => ({ path: c.path, start: c.start, end: c.end, text: songText(c), hasAudio: c.probe.hasAudio })),
    output: settings.outputPath,
    width: f.w, height: f.h, fps: settings.fps, fit: settings.fit, encoder: settings.encoder,
    quality: settings.quality, overlaySecs: settings.overlaySecs, overlayPos: settings.overlayPos,
    overlayScale: settings.overlayScale, fades: settings.fades, normalize: settings.normalize,
  };
  video.pause();
  logLines.length = 0;
  log(`Export started ${new Date().toLocaleTimeString()}`);
  setExporting(true);
  try {
    lastOutput = await invoke('export', { job });
    setExporting(false);
    $('#resultName').textContent = baseName(lastOutput);
    $('#result').classList.remove('hidden');
    toast(`Saved ${baseName(lastOutput)}`, 'success');
  } catch (e) {
    setExporting(false);
    const msg = String(e);
    log(msg);
    if (msg !== 'Export cancelled.') {
      toast(msg.split('\n')[0], 'error', 8000);
      $('#logDrawer').classList.remove('hidden');
    } else toast('Export cancelled.', 'info');
  }
}

$('#exportBtn').onclick = startExport;
$('#cancelBtn').onclick = () => invoke('cancel_export');
$('#revealBtn').onclick = () => lastOutput && invoke('reveal', { path: lastOutput });
$('#playResultBtn').onclick = () => lastOutput && invoke('open_path', { path: lastOutput });
$('#logBtn').onclick = () => $('#logDrawer').classList.toggle('hidden');
$('#logClose').onclick = () => $('#logDrawer').classList.add('hidden');

/* ------------------------------------------------------------------ settings modal */

function openSettings() {
  $('#keyInput').value = apiKey;
  $('#keyInput').type = 'password';
  $('#keyToggle').textContent = 'Show';
  const chip = (ok, label) => `<span class="chip ${ok ? 'ok' : 'danger'}">${icon(ok ? 'check' : 'x')} ${label}</span>`;
  $('#toolsList').innerHTML = [
    chip(tools.ffmpeg, 'ffmpeg'),
    chip(tools.ffprobe, 'ffprobe'),
    chip(tools.fpcalc, 'fpcalc'),
    ...tools.encoders.map((e) => chip(true, ENCODERS[e] || e)),
  ].join('');
  $('#settingsModal').classList.remove('hidden');
  setTimeout(() => $('#keyInput').focus(), 0);
}
const closeSettings = () => $('#settingsModal').classList.add('hidden');
$('#settingsBtn').onclick = openSettings;
$('#settingsCancel').onclick = closeSettings;
$('#settingsModal').addEventListener('pointerdown', (e) => { if (e.target.id === 'settingsModal') closeSettings(); });
$('#keyToggle').onclick = () => {
  const el = $('#keyInput');
  el.type = el.type === 'password' ? 'text' : 'password';
  $('#keyToggle').textContent = el.type === 'password' ? 'Show' : 'Hide';
};
$('#acoustLink').onclick = (e) => { e.preventDefault(); invoke('open_path', { path: 'https://acoustid.org/new-application' }); };
$('#settingsSave').onclick = async () => {
  const key = $('#keyInput').value.trim();
  try {
    await invoke('set_api_key', { key });
    apiKey = key;
    closeSettings();
    toast(key ? 'API key saved.' : 'API key removed.', 'success', 2500);
  } catch (e) {
    toast(`Could not save the key: ${e}`, 'error');
  }
};

/* ------------------------------------------------------------------ keyboard */

document.addEventListener('keydown', (e) => {
  const typing = e.target instanceof Element && e.target.closest('input, select, textarea');
  if (e.key === 'Escape' && !$('#settingsModal').classList.contains('hidden')) return closeSettings();
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); return browseForClips(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') { e.preventDefault(); return startExport(); }
  if (typing || !$('#settingsModal').classList.contains('hidden')) return;
  const c = selected();
  const idx = clips.findIndex((x) => x.id === selectedId);
  const k = e.key;
  const handled = () => e.preventDefault();
  if (k === ' ') { handled(); togglePlay(); }
  else if (k === 'i' || k === 'I') { handled(); setIn(video.currentTime); }
  else if (k === 'o' || k === 'O') { handled(); setOut(video.currentTime); }
  else if (k === 'p' || k === 'P') { handled(); playTrimmed(); }
  else if (k === 'm' || k === 'M') { handled(); $('#muteBtn').click(); }
  else if (k === ',') { handled(); step(-1); }
  else if (k === '.') { handled(); step(1); }
  else if (k === 'ArrowLeft') { handled(); seek(video.currentTime - (e.shiftKey ? 5 : 1)); }
  else if (k === 'ArrowRight') { handled(); seek(video.currentTime + (e.shiftKey ? 5 : 1)); }
  else if (k === 'Home' && c) { handled(); seek(c.start); }
  else if (k === 'End' && c) { handled(); seek(c.end); }
  else if (k === 'ArrowUp' && e.altKey) { handled(); moveSelected(-1); }
  else if (k === 'ArrowDown' && e.altKey) { handled(); moveSelected(1); }
  else if (k === 'ArrowUp' && idx > 0) { handled(); select(clips[idx - 1].id); }
  else if (k === 'ArrowDown' && idx >= 0 && idx < clips.length - 1) { handled(); select(clips[idx + 1].id); }
  else if ((k === 'Delete' || k === 'Backspace') && c) { handled(); removeClip(c.id); }
});

/* ------------------------------------------------------------------ startup */

(async function init() {
  hydrateIcons();
  try {
    const saved = await invoke('load_settings');
    if (saved && typeof saved === 'object') settings = { ...DEFAULTS, ...saved };
  } catch { /* first run */ }
  if (!FORMATS[settings.format]) settings.format = DEFAULTS.format;
  apiKey = await invoke('get_api_key').catch(() => '');
  bindOutputPanel();
  renderClips();
  loadPlayer();

  invoke('check_tools').then((t) => {
    tools = t;
    if (!t.ffmpeg || !t.ffprobe) $('#missingModal').classList.remove('hidden');
    $('#fpcalcWarning').classList.toggle('hidden', t.fpcalc);
    const encSel = $('#encoderSel');
    const encoders = ['libx264', ...t.encoders];
    encSel.innerHTML = encoders.map((k) => `<option value="${k}">${ENCODERS[k] || k}</option>`).join('');
    if (!encoders.includes(settings.encoder)) settings.encoder = 'libx264';
    encSel.value = settings.encoder;
    renderInspector();
  });

  const session = (settings.session || []).filter((s) => s && s.path);
  if (session.length) addFiles(session.map((s) => s.path), session);
})();
