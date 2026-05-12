// dghelper — RS3 Dungeoneering floor-times tracker (Alt1 plugin).
//
// Architecture:
//   1. Sentinel poll loop (setInterval @ DEFAULT_CADENCE_MS).
//      Reads three small zones of pixels at fixed RS-view-center-relative
//      offsets. Each zone must match the "CONGRATULATIONS" title-gold
//      palette for the dialog to be considered present. Per-call cost is
//      ~one captureHold + ~75 pixel comparisons — sub-millisecond.
//   2. Rising-edge dedupe (_dialogOpen / _captureAttempts).
//      OCR fires once per dialog opening. While the dialog stays open
//      with a successful capture, no further work happens. A short retry
//      window (MAX_CAPTURE_ATTEMPTS) handles the case where the dialog
//      hasn't fully rendered on the first sentinel-match tick.
//   3. Triggered OCR (readTimerOnce).
//      Single-font (pixel_8px_digits) scan at the dialog-relative timer
//      position with a 3x3 grid sweep. Parser applies the same sanity
//      gates the original plugin used (hh<=2, no all-identical-digits).
//
// What was dropped vs the original plugin (May 2026 rebuild):
//   - Floor lifecycle (start event from "Floor N" banner) — only end events
//     are logged now.
//   - Chat reading entirely — Tier-2/3 fallbacks (outfit-bonus + leave-party)
//     are gone. If sentinel detection misses, that floor is silently not
//     logged.
//   - Multi-font OCR fallback — pixel_8px_digits only.
//   - The peek scan — replaced with 3 fixed-offset sentinel zones.
//   - Real-life clock timestamps on rows ("finished 14:23").
//   - Tab navigation, calibration panels for chat/RoK/DG-map, party panel,
//     dgmap rendering, overlay drawing, debug panel.
//
// See dghelper-archive/winterface-findings.md for the calibration history,
// rejected approaches, and the empirical findings on alt1.bindRegion cost.

import * as a1lib from 'alt1/base';
import * as OCR from 'alt1/ocr';
import font_pixel_digits from 'alt1/fonts/pixel_8px_digits.js';
import './style.css';
import * as floor from './floor.js';

// =====================================================================
//                          Sentinel configuration
// =====================================================================

// Three zones with distinct color identities and spatial positions.
// Detection requires ALL THREE zones to match — wide spatial + color
// diversity makes a false positive essentially impossible (you'd need
// the right colors at the right relative positions on screen, which
// only the winterface produces).
//
// Offsets are RS-view-center-relative. At UI scale 100% the dialog top
// sits 175 px above center and the bottom 175 px below. All three zones
// fall inside the dialog.
//
// Color palettes are eyedropped from a live RS3 client:
//   - title-gold:    2026-04 (preserved from original plugin)
//   - dark-interior: 2026-05-12 (this session)
//   - ready-orange:  2026-05-12 (this session)
//
// `tol` is per-zone because the targets have different specificity:
// title-gold spans a brown→saturated gradient (wide tol=32), the dark
// dialog chrome is consistent solid black (tight tol=8 to reject false
// positives from any random dark UI), READY orange has minor AA
// variation (tol=32).
const ZONE_DEFAULTS = [
  {
    label: 'title-gold',
    dx: 0,
    dy: -156,  // 2026-05-12 eyedrop: title row sits ~21 px higher than the
               // old plugin's TITLE_Y_OFFSET=40 assumed. RS3 UI nudge.
    tol: 32,
    colors: [
      [182, 145,  94],
      [176, 139,  89],
      [240, 190, 121],
      [239, 201,   0],
      [255, 223,   0],
      [255, 214,  40],
    ],
  },
  {
    label: 'dark-interior',
    dx: -200,
    dy: 141,
    tol: 8,
    colors: [
      [20, 18, 14],
    ],
  },
  {
    label: 'ready-orange',
    dx: 198,
    dy: 144,
    tol: 32,
    colors: [
      [255, 189,   0],
      [237, 171,  40],
    ],
  },
];

const ZONE_HALF = 2;        // 5x5 sample (-2..+2)
const ZONE_MIN_HITS = 5;    // >=5 of 25 pixels in each zone must match

// =====================================================================
//                            OCR configuration
// =====================================================================

const WINTERFACE_W = 526;          // dialog width at UI scale 100%
const DIALOG_TOP_FROM_CENTER = -175; // dialog top Y relative to RS view center
const TIMER_COLORS = [
  [255, 255, 255],
  [240, 240, 240],
  [220, 220, 220],
  [200, 200, 200],
];

// 3x3 scan grid around the canonical timer position (45, 321) inside the
// dialog. pixel_8px_digits is the only font that matches the timer
// cleanly — fallback fonts cause false hits (e.g. "33:33:33" from the
// clock-icon strokes), so we don't include them.
const TIMER_X_SCAN = [45, 40, 50];
const TIMER_Y_SCAN = [321, 313, 329];

// =====================================================================
//                              Loop config
// =====================================================================

const DEFAULT_CADENCE_MS = 250;       // 4 Hz
const MAX_CAPTURE_ATTEMPTS = 6;       // ~1.5 s of retries on OCR failure
const CLEAR_ARM_MS = 3000;
const STATUS_CLEAR_MS = 4000;

// =====================================================================
//                         Settings + calibration
// =====================================================================

const SETTINGS_KEY = 'dgh:settings:v2';
const CALIBRATION_KEY = 'dgh:cal:winterface:v3';

const FLOORS_AVG_WINDOW_DEFAULT = 11;
const HEADER_TITLE_MAX_LEN = 40;

const settings = {
  maxFloors: floor.getMaxFloors(),
  avgWindow: FLOORS_AVG_WINDOW_DEFAULT,
  headerTitle: '',
};
let _calibration = null;

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (typeof parsed.maxFloors === 'number') {
      settings.maxFloors = parsed.maxFloors;
      floor.setMaxFloors(parsed.maxFloors);
    }
    if (typeof parsed.avgWindow === 'number' && parsed.avgWindow >= 2) {
      settings.avgWindow = Math.min(100, Math.floor(parsed.avgWindow));
    }
    if (typeof parsed.headerTitle === 'string') {
      settings.headerTitle = parsed.headerTitle.slice(0, HEADER_TITLE_MAX_LEN);
    }
  } catch (_) {}
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
  catch (_) {}
}

function loadCalibration() {
  try {
    const raw = localStorage.getItem(CALIBRATION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.zones) && parsed.zones.length === ZONE_DEFAULTS.length) return parsed;
  } catch (_) {}
  return null;
}

function saveCalibration(payload) {
  try { localStorage.setItem(CALIBRATION_KEY, JSON.stringify(payload)); }
  catch (_) {}
}

function clearCalibration() {
  try { localStorage.removeItem(CALIBRATION_KEY); }
  catch (_) {}
}

loadSettings();
_calibration = loadCalibration();

// =====================================================================
//                            Sentinel check
// =====================================================================

function pixelMatchesAny(px, palette, tol) {
  for (const c of palette) {
    if (Math.abs(px[0] - c[0]) <= tol &&
        Math.abs(px[1] - c[1]) <= tol &&
        Math.abs(px[2] - c[2]) <= tol) return true;
  }
  return false;
}

function getActiveZones() {
  // If user has calibrated, layer their captured colors ON TOP of the
  // defaults per zone (calibrated first, defaults appended as fallback).
  // Offsets and tolerances stay from ZONE_DEFAULTS.
  if (_calibration && Array.isArray(_calibration.zones) && _calibration.zones.length === ZONE_DEFAULTS.length) {
    return ZONE_DEFAULTS.map((z, i) => ({
      ...z,
      colors: [..._calibration.zones[i].colors, ...z.colors],
    }));
  }
  return ZONE_DEFAULTS;
}

// Bounding rect (in RS-absolute coords) covering all three sentinel zones.
// Returns null if RS isn't linked or the rect would fall outside the client.
function computeSentinelRect() {
  if (!window.alt1 || !alt1.rsLinked || alt1.rsWidth <= 0 || alt1.rsHeight <= 0) return null;
  const cx = Math.floor(alt1.rsWidth / 2);
  const cy = Math.floor(alt1.rsHeight / 2);
  const zones = getActiveZones();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const z of zones) {
    const zx = cx + z.dx, zy = cy + z.dy;
    if (zx - ZONE_HALF < minX) minX = zx - ZONE_HALF;
    if (zx + ZONE_HALF > maxX) maxX = zx + ZONE_HALF;
    if (zy - ZONE_HALF < minY) minY = zy - ZONE_HALF;
    if (zy + ZONE_HALF > maxY) maxY = zy + ZONE_HALF;
  }
  minX = Math.max(0, minX);
  minY = Math.max(0, minY);
  const w = Math.min(alt1.rsWidth - minX, maxX - minX + 1);
  const h = Math.min(alt1.rsHeight - minY, maxY - minY + 1);
  if (w <= 0 || h <= 0) return null;
  return { x: minX, y: minY, w, h, cx, cy };
}

function checkSentinels() {
  if (!window.alt1 || !alt1.permissionPixel) return false;
  const rect = computeSentinelRect();
  if (!rect) return false;
  let bind;
  try { bind = a1lib.captureHold(rect.x, rect.y, rect.w, rect.h); }
  catch (_) { return false; }
  if (!bind) return false;
  let data;
  try { data = bind.toData(rect.x, rect.y, rect.w, rect.h); }
  catch (_) { return false; }
  const zones = getActiveZones();
  for (const z of zones) {
    const cx = rect.cx + z.dx;
    const cy = rect.cy + z.dy;
    let hits = 0;
    for (let dy = -ZONE_HALF; dy <= ZONE_HALF; dy++) {
      for (let dx = -ZONE_HALF; dx <= ZONE_HALF; dx++) {
        const lx = cx + dx - rect.x;
        const ly = cy + dy - rect.y;
        if (lx < 0 || ly < 0 || lx >= data.width || ly >= data.height) continue;
        const px = data.getPixel(lx, ly);
        if (px && pixelMatchesAny(px, z.colors, z.tol)) hits++;
      }
    }
    if (hits < ZONE_MIN_HITS) return false;
  }
  return true;
}

// =====================================================================
//                           Triggered timer OCR
// =====================================================================

// Parser lifted from the original timer.js. Three sanity gates catch the
// false positives observed in the wild — see winterface-findings.md sec 3.
function parseTimer(text) {
  if (!text) return null;
  const m = text.trim().match(/(\d{2})\D+(\d{2})\D+(\d{2})/);
  if (!m) return null;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const ss = parseInt(m[3], 10);
  if (mm >= 60 || ss >= 60) return null;
  if (hh > 2) return null;                          // no floor takes 2 h+
  if (m[1] === m[2] && m[2] === m[3]) return null;  // all-identical garbage
  return {
    time: `${m[1]}:${m[2]}:${m[3]}`,
    timeSeconds: hh * 3600 + mm * 60 + ss,
  };
}

function readTimerOnce() {
  if (!window.alt1 || !alt1.permissionPixel || !alt1.rsLinked) return null;
  let screen;
  try { screen = a1lib.captureHoldFullRs(); }
  catch (_) { return null; }
  if (!screen) return null;
  let screenData;
  try { screenData = screen.toData(0, 0, screen.width, screen.height); }
  catch (_) { return null; }
  const cx = Math.floor(alt1.rsWidth / 2);
  const cy = Math.floor(alt1.rsHeight / 2);
  const dialogLeft = cx - Math.floor(WINTERFACE_W / 2);
  const dialogTop  = cy + DIALOG_TOP_FROM_CENTER;
  for (const yRel of TIMER_Y_SCAN) {
    for (const xRel of TIMER_X_SCAN) {
      const tCx = dialogLeft + xRel;
      const tCy = dialogTop + yRel;
      try {
        const res = OCR.findReadLine(screenData, font_pixel_digits, TIMER_COLORS, tCx, tCy);
        const parsed = parseTimer((res && res.text) || '');
        if (parsed) return parsed;
      } catch (_) { /* out-of-bounds throws are common, silent */ }
    }
  }
  return null;
}

// =====================================================================
//                              Poll loop
// =====================================================================

let _dialogOpen = false;
let _captureAttempts = 0;
let _intervalId = null;

function pollTick() {
  if (!window.alt1) return;
  const present = checkSentinels();
  if (!present) {
    if (_dialogOpen) { _dialogOpen = false; _captureAttempts = 0; }
    return;
  }
  if (!_dialogOpen) { _dialogOpen = true; _captureAttempts = 0; }
  if (_captureAttempts >= MAX_CAPTURE_ATTEMPTS) return;
  _captureAttempts++;
  const parsed = readTimerOnce();
  if (parsed) {
    floor.recordFloor(parsed);
    _captureAttempts = MAX_CAPTURE_ATTEMPTS;  // mark done, no further attempts this opening
  }
  // No status messages — neither success nor failure surfaces a banner.
  // Success is visible via the new row in the floors list; failure is
  // silent (the floor is simply not logged).
}

function startPolling() {
  if (_intervalId !== null) return;
  // Clamp cadence to alt1.captureInterval — never poll faster than Alt1's
  // capture pipeline can refresh fresh pixels.
  const advised = (window.alt1 && typeof alt1.captureInterval === 'number') ? alt1.captureInterval : 0;
  const cadence = Math.max(DEFAULT_CADENCE_MS, advised);
  _intervalId = setInterval(pollTick, cadence);
}

// =====================================================================
//                                UI
// =====================================================================

function formatFloorTime(t) {
  if (typeof t !== 'string' || !t) return '';
  const m = /^(\d+):(\d+):(\d+)$/.exec(t);
  if (!m) return t;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (hh === 0) return `${mm}:${m[3]}`;
  return `${hh}:${String(mm).padStart(2, '0')}:${m[3]}`;
}

function formatAvgTime(totalSeconds) {
  const tenths = Math.max(0, Math.round(totalSeconds * 10) / 10);
  const h = Math.floor(tenths / 3600);
  const m = Math.floor((tenths % 3600) / 60);
  const sec = tenths - h * 3600 - m * 60;
  const secStr = sec.toFixed(1).padStart(4, '0');
  if (h === 0) return `${m}:${secStr}`;
  return `${h}:${String(m).padStart(2, '0')}:${secStr}`;
}

const $app          = document.getElementById('app');
const $viewToggles  = document.querySelectorAll('.view-toggle');
const $floorsAvg    = document.getElementById('floors-avg');
const $floorsList   = document.getElementById('floors-list');
const $floorsExport = document.getElementById('floors-export');
const $floorsClear  = document.getElementById('floors-clear');
const $maxFloors    = document.getElementById('settings-max-floors');
const $avgWindow    = document.getElementById('settings-avg-window');
const $headerTitle  = document.getElementById('settings-header-title');
const $windowTitle  = document.getElementById('window-title');
const $calBtn       = document.getElementById('cal-btn-winterface');
const $calClear     = document.getElementById('cal-clear-winterface');
const $status       = document.getElementById('status');

function renderFloors(log) {
  if (!$floorsList) return;

  if ($floorsAvg) {
    const win = log.slice(-settings.avgWindow)
      .filter(f => typeof f.timeSeconds === 'number' && f.timeSeconds > 0);
    if (win.length === 0) {
      $floorsAvg.hidden = true;
      $floorsAvg.textContent = '';
    } else {
      const mean = win.reduce((a, f) => a + f.timeSeconds, 0) / win.length;
      $floorsAvg.hidden = false;
      const isRolling = win.length >= settings.avgWindow;
      const prefix = isRolling ? '↻ ' : '';
      const countPart = `${win.length}/${settings.avgWindow}`;
      const time = formatAvgTime(mean);
      // Wrap the middle dot in a span so CSS padding can give half-space
      // gaps on each side — tighter than full spaces but visually symmetric.
      $floorsAvg.innerHTML = `${prefix}${countPart}<span class="avg-sep">·</span>${time}`;
      const txt = `${prefix}${countPart}· ${time}`;
      $floorsAvg.title = isRolling
        ? `rolling mean of the last ${settings.avgWindow} floors`
        : `mean of last ${win.length} of ${settings.avgWindow} floors`;
      // Auto-shrink font when content is long to avoid heading wrap at minWidth 140.
      // Thresholds chosen empirically: 12px Consolas at ~7px/char keeps a 15-char
      // pill (e.g. "11/11 · 12:34.5") under the 128px content budget; longer
      // strings need a smaller font to stay on one line.
      $floorsAvg.style.fontSize = txt.length >= 17 ? '10px' : txt.length >= 15 ? '11px' : '';
    }
  }

  if (!log.length) {
    $floorsList.innerHTML = '';
    return;
  }

  const parts = [];
  for (let i = 0; i < log.length; i++) {
    const f = log[i];
    const n = i + 1;
    parts.push(
      `<li class="floor-row" data-ended="${f.endedAt}">` +
        `<span class="floor-num">#${n}</span>` +
        `<span class="floor-sep">·</span>` +
        `<span class="floor-time">${formatFloorTime(f.time)}</span>` +
        `<button class="floor-del" title="Delete this floor">×</button>` +
      `</li>`
    );
  }
  $floorsList.innerHTML = parts.join('');
  $floorsList.scrollTop = $floorsList.scrollHeight;
}

let _statusClearTimer = null;
function renderStatus(text, kind) {
  if (!$status) return;
  $status.textContent = text || '';
  $status.className = kind === 'error' ? 'error' : (kind === 'success' ? 'success' : '');
  if (_statusClearTimer) { clearTimeout(_statusClearTimer); _statusClearTimer = null; }
  if (text) _statusClearTimer = setTimeout(() => renderStatus(''), STATUS_CLEAR_MS);
}

// ---- Event bindings ----

// Cogwheel toggle: swaps app between "floors" (default) and "settings".
// One cog button per block (inline in each h2), so we bind the same
// handler to both. CSS hides the inactive block via #app[data-view]
// selectors — no extra render work, just flip the attribute.
for (const btn of $viewToggles) {
  btn.addEventListener('click', () => {
    $app.dataset.view = $app.dataset.view === 'settings' ? 'floors' : 'settings';
  });
}

if ($floorsList) {
  $floorsList.addEventListener('click', (e) => {
    const btn = e.target.closest('.floor-del');
    if (!btn) return;
    const row = btn.closest('li.floor-row');
    if (!row) return;
    const endedAt = Number(row.dataset.ended);
    if (Number.isFinite(endedAt)) floor.deleteByEndedAt(endedAt);
  });
}

if ($floorsExport) {
  $floorsExport.addEventListener('click', () => {
    const csv = floor.exportCsv();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(csv).then(
        () => renderStatus('CSV copied to clipboard', 'success'),
        () => renderStatus('Clipboard blocked', 'error')
      );
    } else {
      renderStatus('Clipboard unavailable', 'error');
    }
  });
}

let _clearArmed = false;
let _clearArmTimer = null;
function disarmClear() {
  _clearArmed = false;
  if (_clearArmTimer) { clearTimeout(_clearArmTimer); _clearArmTimer = null; }
  if ($floorsClear) {
    $floorsClear.textContent = 'Clear';
    $floorsClear.classList.remove('armed');
  }
}
if ($floorsClear) {
  $floorsClear.addEventListener('click', () => {
    if (!_clearArmed) {
      _clearArmed = true;
      $floorsClear.textContent = 'Confirm?';
      $floorsClear.classList.add('armed');
      _clearArmTimer = setTimeout(disarmClear, CLEAR_ARM_MS);
      return;
    }
    floor.clear();
    disarmClear();
    renderStatus('Cleared', 'success');
  });
}

if ($maxFloors) {
  $maxFloors.value = String(floor.getMaxFloors());
  $maxFloors.max = String(floor.getHardMaxFloors());
  $maxFloors.addEventListener('change', () => {
    const n = parseInt($maxFloors.value, 10);
    if (!isFinite(n)) { $maxFloors.value = String(floor.getMaxFloors()); return; }
    floor.setMaxFloors(n);
    settings.maxFloors = floor.getMaxFloors();
    saveSettings();
    $maxFloors.value = String(settings.maxFloors);
  });
}

if ($avgWindow) {
  $avgWindow.value = String(settings.avgWindow);
  $avgWindow.addEventListener('change', () => {
    const n = parseInt($avgWindow.value, 10);
    if (!isFinite(n) || n < 2) { $avgWindow.value = String(settings.avgWindow); return; }
    settings.avgWindow = Math.min(100, n);
    saveSettings();
    $avgWindow.value = String(settings.avgWindow);
    renderFloors(floor.getAll());
  });
}

if ($headerTitle) {
  $headerTitle.value = settings.headerTitle;
  if ($windowTitle) $windowTitle.textContent = settings.headerTitle;
  $headerTitle.addEventListener('input', () => {
    const v = $headerTitle.value.slice(0, HEADER_TITLE_MAX_LEN);
    settings.headerTitle = v;
    if ($windowTitle) $windowTitle.textContent = v;
    saveSettings();
  });
}

if ($calBtn) {
  $calBtn.addEventListener('click', () => {
    if (!window.alt1) { renderStatus('Not running in Alt1', 'error'); return; }
    if (!alt1.permissionPixel) { renderStatus('Pixel permission not granted', 'error'); return; }
    const rect = computeSentinelRect();
    if (!rect) { renderStatus('RS window not detected', 'error'); return; }
    let bind, data;
    try { bind = a1lib.captureHold(rect.x, rect.y, rect.w, rect.h); }
    catch (_) { renderStatus('Capture failed', 'error'); return; }
    if (!bind) { renderStatus('Capture failed', 'error'); return; }
    try { data = bind.toData(rect.x, rect.y, rect.w, rect.h); }
    catch (_) { renderStatus('Capture failed', 'error'); return; }
    // Sample the center pixel of each zone. The user should have the
    // dialog open before clicking; otherwise this captures background
    // pixels (sanity check is the user's responsibility, per the
    // button's tooltip).
    const capturedZones = [];
    for (const z of ZONE_DEFAULTS) {
      const lx = rect.cx + z.dx - rect.x;
      const ly = rect.cy + z.dy - rect.y;
      const px = data.getPixel(lx, ly);
      if (!px) break;
      capturedZones.push({ colors: [[px[0], px[1], px[2]]] });
    }
    if (capturedZones.length !== ZONE_DEFAULTS.length) {
      renderStatus('Calibration incomplete', 'error');
      return;
    }
    _calibration = { zones: capturedZones, capturedAt: Date.now() };
    saveCalibration(_calibration);
    renderStatus(`Calibrated (${capturedZones.length} zones)`, 'success');
  });
}

if ($calClear) {
  $calClear.addEventListener('click', () => {
    clearCalibration();
    _calibration = null;
    renderStatus('Reset to defaults', 'success');
  });
}

// =====================================================================
//                              Bootstrap
// =====================================================================

floor.onChange(renderFloors);
renderFloors(floor.getAll());
startPolling();
