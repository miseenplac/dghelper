// DungKey Tracker — entry point.
//
// Flow:
//   1. Alt1 identifies the app from appconfig.json.
//   2. We construct an @alt1/chatbox reader, seed it with a comprehensive
//      colour set so key-colour text (blue/green/purple/etc) is OCR'd too.
//   3. Poll loop every ~100ms: find chatbox if unknown, read new lines,
//      parse with parser.js, dispatch to tracker.js which updates ui.js.
//      Tick was reduced 600 → 300 → 100 ms across iterations to cut
//      chat-polling lag for the solo-pin race (info → teleport →
//      plugin reads late → pin lands at post-teleport cell). Probe
//      multipliers tripled (from the 600 → 300 baseline) so the
//      runAutoWinterfaceProbe / runPartyPanelRead / runDgMapRead
//      cadences stay at their original 1.8s / 3s / 3s real-world rates.
//      drawPinnedOverlays gates on state fingerprint — draws fire only
//      when tracker state changes (door-info, key-found, key-used,
//      floor-end) plus a 3s keep-alive heartbeat to refresh Alt1's
//      overlay timers. Overlay duration is 5s so the heartbeat has
//      2s of buffer → no flicker.

import * as a1lib from 'alt1/base';
import ChatBoxReader from 'alt1/chatbox';
import * as OCR from 'alt1/ocr';
import './style.css';

import { parseChatLine, resolvePlayerName } from './parser.js';
import { tracker } from './tracker.js';
import { mount, renderStatus, dbg, setDebugStats, render as renderUI, setRenderContext, renderPartySlots } from './ui.js';
import * as floor from './floor.js';
import { captureEndDungeonTimer, peekForWinterface } from './timer.js';
import { readPartyPanel } from './partyPanel.js';
import { findDgMap, findTrianglePx } from './dgMap.js';
import { preRenderIcon, drawKeyOverlay } from './overlay.js';

// Read current mouse position (RS-client-relative) as {x, y}, or null if the
// cursor is off the RS window. alt1.mousePosition return format varies
// between Alt1 builds (packed int, {x,y} object, {mouseRs:{x,y}} composite) —
// accept all three shapes defensively.
function readMousePosition() {
  if (!window.alt1) return null;
  const raw = alt1.mousePosition;
  let x = null, y = null;
  if (typeof raw === 'number' && raw >= 0) {
    if (raw === 0) return null;
    x = (raw >>> 16) & 0xFFFF;
    y = raw & 0xFFFF;
  } else if (raw && typeof raw === 'object') {
    if (typeof raw.x === 'number' && typeof raw.y === 'number') {
      x = raw.x; y = raw.y;
    } else if (raw.mouseRs && typeof raw.mouseRs.x === 'number') {
      x = raw.mouseRs.x; y = raw.mouseRs.y;
    }
  }
  if (x === null || y === null) return null;
  if (x === 0 && y === 0) return null;
  return { x, y };
}

console.log('[dkt] index.js loaded; booting…');
console.log('[dkt] window.alt1 present?', !!window.alt1,
  'permissionPixel?', (window.alt1 && alt1.permissionPixel));

// ---- Chatbox reader handle (declared early; actual construction happens
// inside setupReader() once we're inside the tick loop). ----
let reader = null;
const seenLines = new Set();

// ---- UI mount first so status messages are visible immediately ----
mount();

// ---- User settings -------------------------------------------------------
// Single-object settings blob persisted in localStorage. Currently holds
// just the floor-log cap, but the shape is extensible for future toggles.
// The hard cap (floor.getHardMaxFloors()) is the upper bound — user
// preference can only LOWER it.
const SETTINGS_STORAGE_KEY = 'dkt:settings:v1';
const DEFAULT_SETTINGS = {
  maxFloors: 100,
  // Opt-in: match chat-line [HH:MM:SS] timestamp to historical
  // red-triangle snapshots so solo-pin attributes the door to the
  // cell the player was IN at the time of the chat event, not at
  // the time the plugin OCR'd the line. Handles info→teleport
  // races when OCR lag exceeds the teleport window (rare but real).
  // Requires RS3 chat timestamps to be enabled (Game Settings →
  // Chat → Show timestamps); the feature silently no-ops if the
  // line has no timestamp prefix.
  timestampedChat: false,
  // Optional: when set to an https:// (or http://) URL, the plugin
  // fire-and-forget POSTs each completed floor's timer row to that
  // URL as JSON text. Intended target is a Google Apps Script web
  // app bound to a Sheet (zero-auth setup), but any HTTP endpoint
  // accepting JSON bodies works (local bridges, Zapier hooks, etc).
  // Empty string disables the feature.
  floorLogWebhookUrl: '',
  // UI toggle: whether the Debug section at the bottom of the plugin
  // window is visible. When false, the entire section (counter + log)
  // is hidden. dbg() calls still execute internally so turning it
  // back on later shows historical entries up to the 250-line cap.
  // Default true for backward compatibility with existing users.
  showDebugPanel: true,
};
let settings = { ...DEFAULT_SETTINGS };
function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      if (typeof obj.maxFloors === 'number' && isFinite(obj.maxFloors)) {
        settings.maxFloors = Math.min(Math.max(10, Math.floor(obj.maxFloors)),
          floor.getHardMaxFloors());
      }
      if (typeof obj.timestampedChat === 'boolean') {
        settings.timestampedChat = obj.timestampedChat;
      }
      if (typeof obj.floorLogWebhookUrl === 'string') {
        settings.floorLogWebhookUrl = obj.floorLogWebhookUrl;
      }
      if (typeof obj.showDebugPanel === 'boolean') {
        settings.showDebugPanel = obj.showDebugPanel;
      }
    }
  } catch (_) {}
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings)); }
  catch (_) {}
}
loadSettings();
floor.setMaxFloors(settings.maxFloors);

// ---- Party roster --------------------------------------------------------
// Internal structure: `partyRoster` is an array. Index 0 = user's own
// in-game name (set once via Settings → Your name). Index 1+ = teammate
// names auto-discovered by `autoPopulateRosterFromPanel` as the Ring of
// Kinship panel is read. Users no longer type teammate names manually —
// the "Your name" settings field only edits index 0.
//
// At dispatch time, mangled OCR names ("Aar i") fuzzy-snap to the
// closest roster entry ("Aari the Iceborn"). See parser.resolvePlayerName.
const PARTY_STORAGE_KEY = 'dkt:party:v1';
let partyRoster = [];
function loadParty() {
  try {
    const raw = localStorage.getItem(PARTY_STORAGE_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) partyRoster = arr.filter(s => typeof s === 'string' && s.trim());
    }
  } catch (_) {}
}
function saveParty() {
  try { localStorage.setItem(PARTY_STORAGE_KEY, JSON.stringify(partyRoster)); } catch (_) {}
}
loadParty();

// ---- Learned-alias map ---------------------------------------------------
// Maps a player's composite signature (computed in parser.computePlayerSignature)
// to a roster name. Persists across sessions. Filled interactively when the
// user clicks a player pill in a door row and picks a roster member — every
// future door-info from that same signature resolves to the chosen name, and
// existing rows retro-update via re-render.
const ALIAS_STORAGE_KEY = 'dkt:ocrAlias:v1';
let aliasMap = {};
function loadAlias() {
  try {
    const raw = localStorage.getItem(ALIAS_STORAGE_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object') aliasMap = obj;
    }
  } catch (_) {}
}
function saveAlias() {
  try { localStorage.setItem(ALIAS_STORAGE_KEY, JSON.stringify(aliasMap)); } catch (_) {}
}
loadAlias();

function setAlias(signature, name) {
  if (!signature) return;
  if (name) aliasMap[signature] = name;
  else delete aliasMap[signature];
  saveAlias();
  pushRenderContext();
  renderUI(tracker.getSnapshot());
}

// ---- Calibration ---------------------------------------------------------
// User-defined scan regions for the user-positioned UI elements: party
// interface and DG map widget. Captured via a two-hover flow (TL corner →
// 3s countdown → capture; BR corner → 3s countdown → capture), persisted
// to localStorage. When present, these regions REPLACE the default auto-
// scan rectangles — the plugin scans only inside them.
//
// Benefits:
//   - Scan cost drops ~5-8× vs the wide auto-detection region.
//   - False positives from similar UI chrome (inventory BG, action bar,
//     world pixels) are eliminated by construction.
//   - Re-calibrate anytime the user moves the panel; no state-machine
//     recovery logic needed.
//
// Metrics NOT calibrated here:
//   - Winterface: appears briefly at floor end; auto-detected via
//     peek-anchored gold-title scan. Screen-centred, not user-movable.
//   - Chatbox: Alt1's ChatBoxReader auto-detects reliably; `Recal`
//     button covers edge cases.
const CALIBRATION_STORAGE_KEY = 'dkt:calibration:v1';
let calibration = { partyPanel: null, dgMap: null, winterface: null };
function isValidRegion(r) {
  return r && typeof r === 'object' &&
    Number.isFinite(r.x) && Number.isFinite(r.y) &&
    Number.isFinite(r.w) && Number.isFinite(r.h) &&
    r.w > 0 && r.h > 0;
}
// Winterface calibration is just an anchor point {x, y} (the peek
// centroid at calibration time) — no TL/BR region like the other
// two. Different validation.
function isValidAnchor(p) {
  return p && typeof p === 'object' &&
    Number.isFinite(p.x) && Number.isFinite(p.y);
}
function loadCalibration() {
  try {
    const raw = localStorage.getItem(CALIBRATION_STORAGE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      if (isValidRegion(obj.partyPanel)) calibration.partyPanel = obj.partyPanel;
      if (isValidRegion(obj.dgMap))      calibration.dgMap      = obj.dgMap;
      if (isValidAnchor(obj.winterface)) calibration.winterface = obj.winterface;
    }
  } catch (_) {}
}
function saveCalibration() {
  try { localStorage.setItem(CALIBRATION_STORAGE_KEY, JSON.stringify(calibration)); }
  catch (_) {}
}
loadCalibration();

// ---- Self-slot detection --------------------------------------------------
// Auto-detects WHICH slot colour ('red' | 'teal' | 'lime' | 'yellow' |
// 'pale') corresponds to the local user on the DG map. Derived on each
// successful RoK panel read by matching OCR'd slot names against the
// partyRoster:
//
//   Primary match: any slot whose OCR'd name fuzzy-matches partyRoster[0]
//   (the user's own name, by the "You, then others" convention of the
//   Party input placeholder) → that slot's colour is self.
//
//   Elimination fallback: if every non-user roster entry fuzzy-matches a
//   distinct teammate slot and exactly one slot remains unmatched → the
//   unmatched slot is self by elimination. Load-bearing on clients where
//   the user's own slot has OCR-defeating rendering (e.g., a clan-title
//   icon splitting the name into unreadable fragments) — in that case
//   the user is identified not by reading their own name but by being
//   the only slot whose OCR doesn't resolve to any known teammate.
//
// Cache key: localStorage['dkt:selfSlot:v1']. Cleared on leave-party —
// party composition just changed; next party needs fresh detection.
const SELF_SLOT_STORAGE_KEY = 'dkt:selfSlot:v1';
const SLOT_COLOR_KEYS = ['red', 'teal', 'lime', 'yellow', 'pale'];
let _selfSlotColor = null;
function loadSelfSlot() {
  try {
    const raw = localStorage.getItem(SELF_SLOT_STORAGE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (obj && typeof obj.color === 'string' && SLOT_COLOR_KEYS.includes(obj.color)) {
      _selfSlotColor = obj.color;
    }
  } catch (_) {}
}
function saveSelfSlot() {
  try {
    localStorage.setItem(SELF_SLOT_STORAGE_KEY, JSON.stringify({
      color: _selfSlotColor, at: Date.now(),
    }));
  } catch (_) {}
}
function clearSelfSlot() {
  if (_selfSlotColor === null) return 0;
  _selfSlotColor = null;
  try { localStorage.removeItem(SELF_SLOT_STORAGE_KEY); } catch (_) {}
  return 1;
}
loadSelfSlot();

/**
 * The user's own triangle colour on the DG map. Returns 'red' for solo
 * (by elimination — only one triangle exists, always red by game
 * convention), the cached detected colour for multi-party once detection
 * has fired, or null when unknown (multi-party + no detection yet this
 * session). Consumers in the solo-pin cascade gate on `!== null` before
 * searching for the user's triangle.
 */
function getSelfColor() {
  if (_partySize === 'SOLO') return 'red';
  if (_partySize === 'MULTI' && _selfSlotColor) return _selfSlotColor;
  return null;
}

/**
 * Did the local user originate this event? Solo = always yes (only
 * one actor). Multi-party requires one of:
 *
 *   1. Signature alias binding — `aliasMap[ev.playerSignature] ===
 *      partyRoster[0]`. Strict, no false positives. Set by the user
 *      clicking their own player pill on a door row.
 *
 *   2. Raw OCR name fuzzy-matches partyRoster[0] — fallback for the
 *      common cases where (a) signature binding is stale (roster[0]
 *      changed since binding was set), (b) user hasn't bound their
 *      signature yet, or (c) client-specific chat rendering produces
 *      a slightly different signature than when first bound. Uses
 *      resolvePlayerName's normalised-substring + Levenshtein match,
 *      constrained to the single-entry `[partyRoster[0]]` roster so
 *      teammates can't accidentally resolve to self.
 *
 * Events that fail this check flow through the tracker and UI unchanged
 * (still appear in the Doors list) — only the overlay-pin path is
 * gated here.
 */
function isSelfEvent(ev) {
  if (_partySize === 'SOLO') return true;
  if (!ev || !partyRoster.length) return false;
  if (ev.playerSignature && aliasMap[ev.playerSignature] === partyRoster[0]) return true;
  if (ev.player && resolvePlayerName(ev.player, [partyRoster[0]]) === partyRoster[0]) return true;
  return false;
}

// Guard for a one-shot "teammate names missing" hint in multi-party. We
// log it the first time a multi-party door-info event fires without
// a resolved self-slot AND the roster only contains the user's own
// name — tells them they need to add teammates for multi-party mode.
// Reset on leave-party + on roster change.
let _loggedMissingTeammatesHint = false;

/**
 * Run self-slot detection from a fresh panel read. Updates _selfSlotColor
 * cache on successful match via primary or elimination. No-op when roster
 * is empty, no slots filled, or match is ambiguous (retries next read).
 */
function detectSelfSlotFromPanel(res) {
  if (!res || !res.found) return;
  const filled = res.slots.filter(s => s.filled);
  if (!filled.length) return;
  if (!partyRoster.length) return;

  const self = partyRoster[0];
  const others = partyRoster.slice(1);

  // Primary: any slot's OCR'd name fuzzy-matches the user's roster entry.
  for (const s of filled) {
    if (!s.name) continue;
    if (resolvePlayerName(s.name, [self]) === self) {
      setSelfSlotColor(s.color, `primary: roster[0] matched slot ${s.index + 1}`);
      return;
    }
  }

  // Elimination: every non-user roster entry fuzzy-maps to a distinct
  // slot, leaving exactly one slot unmatched — that's self. Requires
  // the roster to list teammates (otherwise no elimination is possible).
  if (others.length === 0) return;

  const matchedSlotColors = new Set();
  const usedRosterEntries = new Set();
  for (const s of filled) {
    if (!s.name) continue;
    const resolved = resolvePlayerName(s.name, others);
    if (resolved && others.includes(resolved) && !usedRosterEntries.has(resolved)) {
      matchedSlotColors.add(s.color);
      usedRosterEntries.add(resolved);
    }
  }

  const unmatched = filled.filter(s => !matchedSlotColors.has(s.color));
  if (unmatched.length === 1) {
    setSelfSlotColor(
      unmatched[0].color,
      `elimination: ${matchedSlotColors.size} teammate(s) matched, 1 slot left`
    );
  }
  // Else: ambiguous (0 or ≥2 unmatched). Retry on next panel read.
}

function setSelfSlotColor(color, reason) {
  if (_selfSlotColor === color) return;
  const prev = _selfSlotColor;
  _selfSlotColor = color;
  saveSelfSlot();
  dbg('match', `self-slot: ${prev || 'unknown'} → ${color} (${reason})`);
}

/**
 * Auto-populate partyRoster from RoK panel OCR. Any teammate slot name
 * that reads cleanly AND isn't already in the roster (exact or fuzzy
 * match) gets appended — removes the "add teammate names manually"
 * friction, especially for host-slot users whose own-slot OCR is
 * defeated by clan-title icons and who need teammate names in the
 * roster for elimination-based self-slot detection.
 *
 * Guard rails:
 *   - No-op when roster is empty. We need the user's own name as a
 *     baseline entry before auto-append makes sense — otherwise the
 *     first readable name (which might BE the user's, on a joiner
 *     slot) would seed the roster as a teammate.
 *   - Skip entries that fuzzy-match any existing roster name
 *     (resolvePlayerName substring/Levenshtein). Handles re-visits
 *     to the same party, OCR jitter producing slightly different
 *     spellings, and the local user's own-slot-when-joiner case.
 *   - Skip entries whose normalised alphanumeric length is < 3 —
 *     guards against OCR artefacts that the palette cleanup
 *     couldn't reduce to empty (e.g., "_ " or "a'").
 *
 * On additions: saves to localStorage, pushes the updated render
 * context (ui.js displayPlayer reads through it), and clears the
 * missing-teammates hint so a subsequent self-detection can re-log
 * if still stuck. The "Your name" input (Settings) only edits
 * partyRoster[0] — auto-discovered teammates live silently in the
 * array but aren't shown in any UI field (user never needs to see
 * them). A "Clear known teammates" button in Settings wipes
 * partyRoster[1+] for cleanup.
 */
function autoPopulateRosterFromPanel(res) {
  if (!res || !res.found) return;
  if (!partyRoster.length) return;

  const added = [];
  for (const s of res.slots) {
    if (!s.filled || !s.name) continue;
    if (partyRoster.includes(s.name)) continue;
    const match = resolvePlayerName(s.name, partyRoster);
    if (partyRoster.includes(match)) continue;
    const normalized = s.name.replace(/[^A-Za-z0-9 ]/g, '').trim();
    if (normalized.length < 3) continue;
    partyRoster.push(s.name);
    added.push(s.name);
  }

  if (added.length) {
    saveParty();
    pushRenderContext();
    _loggedMissingTeammatesHint = false;
    dbg('match',
      `auto-roster: added ${added.length} teammate name(s): ${added.join(', ')}`);
  }
}

function pushRenderContext() {
  setRenderContext({
    roster: partyRoster,
    aliasMap,
    setAlias,
    resolveFuzzy: resolvePlayerName,
  });
}
pushRenderContext();

document.getElementById('reset-btn').addEventListener('click', () => {
  tracker.reset();
  seenLines.clear();
});

// Chat "Refind" (formerly the header Recal button) is now wired inside
// the Settings modal's Calibration subsection — see the cal-btn-chat
// handler further down, co-located with the winterface / RoK / DG Map
// calibration buttons.

// Eyedrop — click, hover a pixel, 3s countdown, then its RGB is dumped to
// the in-app debug panel. Diagnostic tool for pinning missing chat-text
// colours against the OCR palette.
function readPixelRgb(x, y) {
  try {
    const img = a1lib.captureHoldFullRs();
    if (!img) return null;
    const p = img.toData(x, y, 1, 1).getPixel(0, 0);
    return { r: p[0], g: p[1], b: p[2] };
  } catch (_) { return null; }
}
const eyedropBtn = document.getElementById('eyedrop-btn');
let eyedropActive = false;
if (eyedropBtn) {
  eyedropBtn.addEventListener('click', () => {
    if (eyedropActive) return;
    if (!window.alt1) { dbg('error', 'Eyedrop: not running inside Alt1.'); return; }
    eyedropActive = true;
    const delayMs = 3000;
    const start = Date.now();
    const tick = () => {
      const rem = Math.max(0, delayMs - (Date.now() - start));
      const pos = readMousePosition();
      const secs = Math.ceil(rem / 1000);
      eyedropBtn.textContent = secs > 0 ? `Eyedrop ${secs}s` : 'Sampling\u2026';
      if (rem <= 0) {
        eyedropActive = false;
        eyedropBtn.textContent = 'Eyedrop';
        if (!pos) { dbg('error', 'Eyedrop: mouse was not over the RS window at capture.'); return; }
        const px = readPixelRgb(pos.x, pos.y);
        if (!px) { dbg('error', 'Eyedrop: pixel read failed.'); return; }
        const hex = '#' + [px.r, px.g, px.b].map(n => n.toString(16).padStart(2, '0')).join('');
        dbg('match', `EYEDROP @ (${pos.x},${pos.y}) = rgb(${px.r}, ${px.g}, ${px.b})  ${hex}`);
        return;
      }
      setTimeout(tick, 200);
    };
    tick();
  });
}

// ---- Calibrate button ----------------------------------------------------
// Pure diagnostic: walks every required piece (Alt1 runtime, pixel perm,
// chat reader, screen capture, winterface peek, timer OCR) and emits a
// ✓/✗/⚠ line per check. Failures include actionable fixes — concrete steps
// for users on a fresh install / different client layout. No offsets are
// persisted; the live detection logic handles positioning each probe via
// peek-anchoring. This just surfaces *what's working and what isn't*.
const calibrateBtn = document.getElementById('calibrate-btn');
if (calibrateBtn) {
  calibrateBtn.addEventListener('click', runCalibration);
}

function ensureDebugPanelVisible() {
  const list = document.getElementById('debug-list');
  const toggle = document.getElementById('debug-toggle');
  if (list && list.hidden) {
    list.hidden = false;
    if (toggle) toggle.textContent = 'Hide';
  }
}

function runCalibration() {
  ensureDebugPanelVisible();
  dbg('info', '================ Calibration ================');

  // 1. Alt1 runtime
  if (!window.alt1) {
    dbg('error', '\u2717 Alt1 runtime not available');
    dbg('info', '   Fix: Open this plugin from Alt1\u2019s app list \u2014 it cannot run in a standalone browser.');
    dbg('info', '================ Aborted ================');
    return;
  }
  dbg('match', '\u2713 Alt1 runtime present');

  // 2. Pixel permission
  if (!alt1.permissionPixel) {
    dbg('miss', '\u2717 Pixel permission NOT granted');
    dbg('info', '   Fix: Right-click the DungKey Tracker icon in Alt1 \u2192 Permissions \u2192 enable \u201CPixel\u201D.');
    dbg('info', '================ Aborted (pixel access required for further checks) ================');
    return;
  }
  dbg('match', '\u2713 Pixel permission granted');

  // 3. Chatbox reader
  if (!reader) {
    dbg('miss', '\u26A0 Chatbox reader not initialised yet');
    dbg('info', '   Fix: Plugin may still be booting \u2014 wait a second and retry.');
  } else if (!reader.pos) {
    dbg('miss', '\u2717 Chatbox position not located');
    dbg('info', '   Fix: Make sure the RS3 chat window is visible on screen (not minimised / hidden behind');
    dbg('info', '        other windows), then click Recal in this plugin. If this persists, try toggling');
    dbg('info', '        an RS3 chat tab and re-Recal.');
  } else {
    dbg('match', '\u2713 Chatbox located');
  }

  // 4. Screen capture
  let screen;
  try { screen = a1lib.captureHoldFullRs(); }
  catch (e) {
    dbg('error', `\u2717 Screen capture threw: ${e && e.message ? e.message : e}`);
    dbg('info', '   Fix: Pixel permission may have been revoked mid-session. Re-grant it in Alt1.');
    dbg('info', '================ Aborted ================');
    return;
  }
  if (!screen) {
    dbg('miss', '\u2717 Screen capture returned null');
    dbg('info', '   Fix: Is RS3 actually running and visible? Bring it to the foreground and retry.');
    dbg('info', '================ Aborted ================');
    return;
  }
  dbg('match', `\u2713 Screen capture OK (${screen.width}\u00D7${screen.height})`);

  // 5. Winterface peek
  let peek = null;
  try { peek = peekForWinterface(screen); } catch (_) {}
  if (!peek) {
    dbg('miss', '\u26A0 No winterface detected on current screen');
    dbg('info', '   (This check only works when the end-dungeon screen is actually open.)');
    dbg('info', '   Fix: Finish a floor, let the end-interface appear, then click Calibrate again.');
    dbg('info', '================ Partial calibration complete (open winterface to test timer OCR) ================');
    return;
  }
  if (peek.hits < 20) {
    dbg('miss', `\u26A0 Weak winterface signal: ${peek.hits} hits @ (${peek.x},${peek.y}). Strong hits are 20+.`);
    dbg('info', '   Likely cause: your client renders the \u201CCONGRATULATIONS\u201D title in a gold that');
    dbg('info', '        doesn\u2019t match the anchor palette closely enough.');
    dbg('info', '   Fix: use the Eyedrop button, hover over the title text in-game for 3s, and share the');
    dbg('info', '        RGB so the gold variant can be added to the anchor palette.');
  } else {
    dbg('match', `\u2713 Winterface detected (${peek.hits} hits) @ (${peek.x},${peek.y})`);
  }

  // 6. Timer OCR
  let res;
  try { res = captureEndDungeonTimer({ verbose: false, screen, calibratedAnchor: calibration.winterface }); }
  catch (e) {
    dbg('error', `\u2717 Timer OCR threw: ${e && e.message ? e.message : e}`);
    dbg('info', '================ Calibration complete (with errors) ================');
    return;
  }
  if (res.ok) {
    if (res.font === 'pixel_8px_digits') {
      dbg('match', `\u2713 Timer OCR: ${res.time} (${res.timeSeconds}s) via pixel_8px_digits (canonical)`);
    } else {
      dbg('miss', `\u26A0 Timer OCR: ${res.time} (${res.timeSeconds}s) via ${res.font} \u2014 NOT the canonical font`);
      dbg('info', '   pixel_8px_digits is the font RS3 actually uses for the timer. A different font');
      dbg('info', '        matching means the scan landed slightly off, reading a nearby digit cluster.');
      dbg('info', '        The value may be wrong.');
      dbg('info', '   Fix: set RS3 Interface Scale to 100% (Game Settings \u2192 Graphics \u2192 Interface Scale).');
      dbg('info', '        The dialog and timer dimensions assume 100%.');
    }
  } else {
    dbg('miss', `\u2717 Timer OCR failed (${res.error || 'unknown'})`);
    if (res.scanRect) {
      dbg('info', `   Scanned rect ${res.scanRect.w}\u00D7${res.scanRect.h} @ (${res.scanRect.x},${res.scanRect.y})`);
    }
    if (res.timerTries && res.timerTries.length) {
      dbg('info', `   ${res.timerTries.length} text-bearing tries (first 4):`);
      for (const t of res.timerTries.slice(0, 4)) {
        const where = (typeof t.xRel === 'number') ? ` @ rel(${t.xRel},${t.yRel})` : '';
        dbg('info', `     ${t.font}${where}: ${JSON.stringify(t.text)}`);
      }
    }
    dbg('info', '   Fixes to try, in order:');
    dbg('info', '     (a) Set RS3 Interface Scale to 100% (Game Settings \u2192 Graphics \u2192 Interface Scale).');
    dbg('info', '         The timer-position math assumes default scale.');
    dbg('info', '     (b) If scale is already 100%: use Eyedrop on the timer digits');
    dbg('info', '         and share the RGB \u2014 your client may render them in a shade not in the palette.');
    dbg('info', '     (c) Verify no overlay / window is covering the clock + timer region of the winterface.');
  }

  // 7. Party panel (user-calibrated region). Requires the RoK panel to
  // actually be visible on screen for a useful ✓ — a ✗ when the panel
  // is closed is expected behaviour, not a layout error. We flag that
  // distinction in the fix hints.
  if (!calibration.partyPanel) {
    dbg('miss', '\u26A0 Party interface: no calibration set');
    dbg('info', '   Detection falls back to a wider auto-scan rect \u2014 slower and can misfire');
    dbg('info', '   on similar UI elsewhere. Calibration section \u2192 Party interface \u2192 Calibrate');
    dbg('info', '   to pin the scan region.');
  } else {
    let partyRes;
    try { partyRes = readPartyPanel({ screen, region: calibration.partyPanel }); }
    catch (e) { partyRes = null; dbg('error', `\u2717 Party panel test threw: ${e && e.message ? e.message : e}`); }
    if (partyRes && partyRes.found) {
      const filled = partyRes.slots.filter(s => s.filled).length;
      const method = partyRes.detectionMethod || 'unknown';
      dbg('match', `\u2713 Party interface detected [${method}]: ${filled}/5 filled, slot1 @ (${partyRes.origin.x},${partyRes.origin.y})`);
    } else if (partyRes) {
      dbg('miss', `\u2717 Party interface NOT detected in calibrated region (${partyRes.reason || 'no reason'})`);
      dbg('info', '   If the RoK panel is CLOSED right now this is expected \u2014 open it and');
      dbg('info', '   re-click Calibrate. If the panel IS open and this still fails, your');
      dbg('info', '   client likely moved/resized since calibration. Re-run Calibration section');
      dbg('info', '   \u2192 Party interface \u2192 Calibrate to update the region.');
    }
  }

  // 8. DG map widget (user-calibrated region). Same visibility caveat.
  if (!calibration.dgMap) {
    dbg('miss', '\u26A0 DG map: no calibration set');
    dbg('info', '   Detection falls back to left-half scan then full-screen \u2014 slower and');
    dbg('info', '   can over-scan. Calibration section \u2192 DG map \u2192 Calibrate to pin.');
  } else {
    let dgRes;
    try { dgRes = findDgMap({ screen, region: calibration.dgMap, classifyCells: false }); }
    catch (e) { dgRes = null; dbg('error', `\u2717 DG map test threw: ${e && e.message ? e.message : e}`); }
    if (dgRes && dgRes.found) {
      dbg('match', `\u2713 DG map detected: origin (${dgRes.origin.x},${dgRes.origin.y}) pitch=${dgRes.pitch} clusters=${dgRes.clusters} support=${dgRes.support}/${dgRes.totalPairs}`);
    } else if (dgRes) {
      dbg('miss', `\u2717 DG map NOT detected in calibrated region (${dgRes.reason || 'no reason'})`);
      dbg('info', '   If the DG map widget is CLOSED/not in a dungeon, this is expected \u2014 open');
      dbg('info', '   the map in a dungeon and re-click Calibrate. If it IS open and detection');
      dbg('info', '   still fails, re-run Calibration section \u2192 DG map \u2192 Calibrate.');
    }
  }

  dbg('info', '================ Calibration complete ================');
}

// ---- Floor log UI ---------------------------------------------------------
//
// Collapsed by default — the floor list eats window space we'd rather spend
// on doors/keys. The Show button reveals a scrollable container that always
// shows the full log (most recent at the bottom) clipped to ~11 rows visible;
// user scrolls up to see older floors. An "avg M:SS" pill shows the mean
// completion time of the most recent 11 floors that have recorded timers.
// Export copies the CSV to the clipboard; on CEF clipboard block (common in
// Alt1's browser) we fall back to dumping the raw CSV into the debug log.

const floorsCountEl  = document.getElementById('floors-count');
const floorsAvgEl    = document.getElementById('floors-avg');
const floorsListEl   = document.getElementById('floors-list');
const floorsExportBtn= document.getElementById('floors-export');
const floorsClearBtn = document.getElementById('floors-clear');
const floorsToggleBtn= document.getElementById('floors-toggle');

const FLOORS_AVG_WINDOW = 11;
let floorsShown = false;

function formatClock(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function formatMMSS(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${m}:${String(ss).padStart(2, '0')}`;
}

function renderFloors(log) {
  if (floorsCountEl) floorsCountEl.textContent = String(log.length);
  if (!floorsListEl) return;

  // Average of the most recent N floors that have a recorded timer. Null
  // floors (timer OCR missed, outfit-only closes, unended) are dropped.
  if (floorsAvgEl) {
    const window = log.slice(-FLOORS_AVG_WINDOW)
      .filter(f => typeof f.timeSeconds === 'number' && f.timeSeconds > 0);
    if (window.length === 0) {
      floorsAvgEl.hidden = true;
      floorsAvgEl.textContent = '';
    } else {
      const mean = window.reduce((a, f) => a + f.timeSeconds, 0) / window.length;
      floorsAvgEl.hidden = false;
      floorsAvgEl.textContent = `avg ${formatMMSS(mean)} · ${window.length} floor${window.length === 1 ? '' : 's'}`;
      floorsAvgEl.title = `mean of last ${window.length} floor(s) with recorded timers`
        + (window.length < FLOORS_AVG_WINDOW ? ` (fewer than ${FLOORS_AVG_WINDOW} available)` : '');
    }
  }

  if (!log.length) {
    floorsListEl.innerHTML = '<li class="empty">No floors yet \u2014 the '
      + '"Floor N" banner on dungeon entry starts one.</li>';
    return;
  }

  const parts = [];
  for (let i = 0; i < log.length; i++) {
    const f = log[i];
    const n = i + 1;
    const unended = !f.ended;
    const timeCell = f.time
      ? `<span class="floor-time">${f.time}</span>`
      : `<span class="floor-time missing">\u2014</span>`;
    const whenCell = f.endedAt
      ? `finished ${formatClock(f.endedAt)}`
      : `started ${formatClock(f.startedAt)}`;
    parts.push(
      `<li class="floor-row${unended ? ' unended' : ''}" data-started="${f.startedAt}">` +
        `<span class="floor-num">#${n}</span>` +
        `<span class="floor-sep">\u00B7</span>` +
        timeCell +
        `<span class="floor-sep">\u00B7</span>` +
        `<span class="floor-when">${whenCell}</span>` +
        `<button class="floor-del" title="Delete this floor">\u00D7</button>` +
      `</li>`
    );
  }
  floorsListEl.innerHTML = parts.join('');

  // Keep the most recent floor visible after re-render — the list renders
  // oldest-first so new rows land at the bottom.
  if (floorsShown) floorsListEl.scrollTop = floorsListEl.scrollHeight;
}

// Event-delegated per-row delete. startedAt is a stable id (indices shift
// when rows are deleted). The row's dataset carries it as a string.
if (floorsListEl) {
  floorsListEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.floor-del');
    if (!btn) return;
    const row = btn.closest('li.floor-row');
    if (!row) return;
    const startedAt = Number(row.dataset.started);
    if (!Number.isFinite(startedAt)) return;
    const removed = floor.deleteByStartedAt(startedAt);
    if (removed) dbg('info', `Floor deleted (started ${formatClock(startedAt)}).`);
  });
}

if (floorsToggleBtn) {
  floorsToggleBtn.addEventListener('click', () => {
    floorsShown = !floorsShown;
    if (floorsListEl) {
      floorsListEl.hidden = !floorsShown;
      if (floorsShown) floorsListEl.scrollTop = floorsListEl.scrollHeight;
    }
    floorsToggleBtn.textContent = floorsShown ? 'Hide' : 'Show';
  });
}

// Subscribe BEFORE initial render so any race between load() and this point
// is impossible — we get the current snapshot via the initial manual call.
floor.onChange(renderFloors);
renderFloors(floor.getAll());

// ---- Tab nav -------------------------------------------------------------
// Two top-level tabs: Tracker (full UI) and Floors (stream-friendly view —
// hides everything except the floor log). Active choice persists across
// reloads in localStorage. The Floors view reuses the existing #floors-list
// render path; CSS rules on #app[data-active-tab="floors"] hide non-floor
// blocks and force the list visible regardless of the Show/Hide toggle.

const TAB_STORAGE_KEY = 'dkt:activeTab:v1';
const tabTrackerBtn = document.getElementById('tab-tracker');
const tabFloorsBtn  = document.getElementById('tab-floors');
const appEl         = document.getElementById('app');

function setActiveTab(name) {
  const tab = (name === 'floors') ? 'floors' : 'tracker';
  if (appEl) appEl.dataset.activeTab = tab;
  if (tabTrackerBtn) {
    const active = (tab === 'tracker');
    tabTrackerBtn.classList.toggle('active', active);
    tabTrackerBtn.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  if (tabFloorsBtn) {
    const active = (tab === 'floors');
    tabFloorsBtn.classList.toggle('active', active);
    tabFloorsBtn.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  try { localStorage.setItem(TAB_STORAGE_KEY, tab); } catch (_) {}
}

if (tabTrackerBtn) tabTrackerBtn.addEventListener('click', () => setActiveTab('tracker'));
if (tabFloorsBtn)  tabFloorsBtn.addEventListener('click',  () => setActiveTab('floors'));

(function loadActiveTab() {
  let stored = null;
  try { stored = localStorage.getItem(TAB_STORAGE_KEY); } catch (_) {}
  setActiveTab(stored === 'floors' ? 'floors' : 'tracker');
})();

// ---- Calibration UI ------------------------------------------------------
// Two-hover capture flow: user clicks Calibrate → UI prompts for TL hover
// (3s countdown, captures mousePosition at end), then BR hover (same),
// then commits {x, y, w, h} to calibration[metric]. Mirrors the Eyedrop
// button pattern — proven to work inside Alt1's CEF.
//
// Disables the Calibrate button during capture to prevent re-entry.
// Clear button wipes the stored region; detection falls back to default
// auto-scan.
// Calibration panel is always visible in the new layout (one section
// with all 4 detection / calibration metrics). The inline show/hide
// toggle was removed — the section is informational enough that
// collapsing it added clicks without saving significant space.

// DOM handles per metric.
const CAL_METRICS = [
  { key: 'partyPanel', label: 'Ring of Kinship',
    statusId: 'cal-status-party',
    btnId:    'cal-btn-party',
    clearId:  'cal-clear-party' },
  { key: 'dgMap',      label: 'DG Map',
    statusId: 'cal-status-dgmap',
    btnId:    'cal-btn-dgmap',
    clearId:  'cal-clear-dgmap' },
];

// Freshness window for auto-detected calibration metrics (chat +
// winterface). Chat is purely auto-detected (ChatBoxReader.find()).
// Winterface is PRIMARILY auto-detected (peekForWinterface runs every
// auto-probe tick) but ALSO has an optional user-lockable anchor via
// the Calibrate button — when locked, status shows the stored anchor
// regardless of runtime freshness.
// 60 s chosen so that closing chat / the winterface flips the
// indicator within a minute without being so tight that brief
// occlusions cause flicker.
const CAL_FRESHNESS_MS = 60_000;
let _chatLastSeenAt = 0;
let _winterfaceLastDetectedAt = 0;

function renderCalibrationStatus() {
  // User-calibratable REGION metrics (party panel + DG map): a
  // {x, y, w, h} rectangle is stored in calibration[key] when set.
  for (const m of CAL_METRICS) {
    const statusEl = document.getElementById(m.statusId);
    const region = calibration[m.key];
    if (!statusEl) continue;
    if (region) {
      statusEl.textContent =
        `\u2713 (${region.x},${region.y}) ${region.w}\u00D7${region.h}`;
      statusEl.classList.add('set');
      statusEl.classList.remove('active');
    } else {
      statusEl.textContent = '\u26A0 not calibrated';
      statusEl.classList.remove('set', 'active');
    }
  }

  // Winterface — dual-state status. Primarily auto-detected via
  // peekForWinterface (runtime freshness). User can OPTIONALLY lock
  // the anchor via Settings → Calibrate for a stable timer-OCR anchor;
  // when locked, the stored coordinates are shown and the status
  // stays ✓ regardless of whether the dialog is currently visible.
  //
  // Priority:
  //   1. Calibrated (user clicked Calibrate) → "✓ locked at (x,y)".
  //   2. Not calibrated + recently auto-detected → "✓ detected".
  //   3. Not calibrated + stale → "⚠ last seen Xs ago".
  //   4. Not calibrated + never seen → "⚠ never detected".
  const wfEl = document.getElementById('cal-status-winterface');
  if (wfEl) {
    const nowMs = Date.now();
    const wf = calibration.winterface;
    if (wf) {
      wfEl.textContent = `\u2713 locked at (${wf.x},${wf.y})`;
      wfEl.classList.add('set');
    } else if (_winterfaceLastDetectedAt === 0) {
      wfEl.textContent = '\u26A0 never detected';
      wfEl.classList.remove('set');
    } else if (nowMs - _winterfaceLastDetectedAt < CAL_FRESHNESS_MS) {
      wfEl.textContent = '\u2713 detected';
      wfEl.classList.add('set');
    } else {
      const secs = Math.round((nowMs - _winterfaceLastDetectedAt) / 1000);
      wfEl.textContent = `\u26A0 last seen ${secs}s ago`;
      wfEl.classList.remove('set');
    }
  }

  // Chat — still auto-detected via ChatBoxReader.find(). Freshness-
  // gated so closing chat flips the indicator to ⚠.
  const chatEl = document.getElementById('cal-status-chat');
  if (chatEl) {
    const now = Date.now();
    if (reader && reader.pos) {
      _chatLastSeenAt = now;
      chatEl.textContent = '\u2713 located';
      chatEl.classList.add('set');
    } else if (_chatLastSeenAt === 0) {
      chatEl.textContent = '\u26A0 not located';
      chatEl.classList.remove('set');
    } else if (now - _chatLastSeenAt < CAL_FRESHNESS_MS) {
      chatEl.textContent = '\u2713 located (recent)';
      chatEl.classList.add('set');
    } else {
      const secs = Math.round((now - _chatLastSeenAt) / 1000);
      chatEl.textContent = `\u26A0 lost ${secs}s ago`;
      chatEl.classList.remove('set');
    }
  }
}
renderCalibrationStatus();

// Re-render calibration status every second so chat's ✓/⚠ flips on
// freshness expiry without waiting for a manual refresh. 1 s cadence
// is imperceptible on CPU (pure DOM text writes against ~5 elements).
setInterval(renderCalibrationStatus, 1000);

// One active capture at a time; prevents buttons from being re-entered
// mid-countdown.
let _calActive = false;

/**
 * Countdown + capture mousePosition. Resolves to { x, y } on success, or
 * null if the cursor wasn't over the RS window at capture time. Updates
 * the provided status element with a live countdown label so the user
 * sees how much time is left.
 */
function captureMouseAfterDelay(label, delayMs, statusEl) {
  return new Promise(resolve => {
    const start = Date.now();
    const tick = () => {
      const rem = Math.max(0, delayMs - (Date.now() - start));
      const secs = Math.ceil(rem / 1000);
      if (statusEl) {
        statusEl.textContent = `${label} — ${secs}s`;
        statusEl.classList.add('active');
        statusEl.classList.remove('set');
      }
      if (rem <= 0) {
        const pos = readMousePosition();
        resolve(pos || null);
        return;
      }
      setTimeout(tick, 150);
    };
    tick();
  });
}

async function runCalibrationForMetric(meta) {
  if (_calActive) return;
  if (!window.alt1) {
    dbg('error', `Calibration (${meta.label}): not running inside Alt1.`);
    return;
  }
  _calActive = true;
  const btn = document.getElementById(meta.btnId);
  const statusEl = document.getElementById(meta.statusId);
  if (btn) btn.disabled = true;

  try {
    const p1 = await captureMouseAfterDelay(
      `Hover TOP-LEFT of ${meta.label}`, 3000, statusEl);
    if (!p1) {
      dbg('error', `Calibration (${meta.label}): mouse not over RS window at TL capture. Aborted.`);
      renderCalibrationStatus();
      return;
    }
    const p2 = await captureMouseAfterDelay(
      `Hover BOTTOM-RIGHT of ${meta.label}`, 3000, statusEl);
    if (!p2) {
      dbg('error', `Calibration (${meta.label}): mouse not over RS window at BR capture. Aborted.`);
      renderCalibrationStatus();
      return;
    }

    const region = {
      x: Math.min(p1.x, p2.x),
      y: Math.min(p1.y, p2.y),
      w: Math.abs(p2.x - p1.x),
      h: Math.abs(p2.y - p1.y),
    };
    // Minimum-size guard — if TL and BR captures land on roughly the same
    // point the user probably didn't move their cursor between captures.
    if (region.w < 20 || region.h < 20) {
      dbg('error',
        `Calibration (${meta.label}): region too small (${region.w}×${region.h}). `
        + `Re-run and make sure you hover TL and BR separately.`);
      renderCalibrationStatus();
      return;
    }

    calibration[meta.key] = region;
    saveCalibration();
    renderCalibrationStatus();
    dbg('match',
      `Calibration (${meta.label}): saved (${region.x},${region.y}) ${region.w}×${region.h}.`);

    // Reset any cached detection state so the next tick uses the new
    // region from a clean slate instead of trying to reconcile with a
    // prior lock somewhere else.
    if (meta.key === 'partyPanel') {
      _lastPartyPanelResult = null;
      _provisionalPanel = null;
      _panelAbsentStreak = 0;
      _lastPartyPanelLog = null;
      renderPartySlots(null);
    } else if (meta.key === 'dgMap') {
      _dgState = 'UNKNOWN';
      _dgLocked = null;
      _dgMissStreak = 0;
      _lastDgMapLog = null;
    }
  } finally {
    _calActive = false;
    if (btn) btn.disabled = false;
  }
}

function clearCalibrationForMetric(meta) {
  if (!calibration[meta.key]) {
    dbg('info', `Calibration (${meta.label}): already empty.`);
    return;
  }
  calibration[meta.key] = null;
  saveCalibration();
  renderCalibrationStatus();
  dbg('info', `Calibration (${meta.label}): cleared. Falling back to auto-detect.`);
  // Reset detection state so next read doesn't carry over a locked
  // position that's no longer backed by calibration.
  if (meta.key === 'partyPanel') {
    _lastPartyPanelResult = null;
    _provisionalPanel = null;
    renderPartySlots(null);
  } else if (meta.key === 'dgMap') {
    _dgState = 'UNKNOWN';
    _dgLocked = null;
  }
}

for (const meta of CAL_METRICS) {
  const btn = document.getElementById(meta.btnId);
  if (btn) btn.addEventListener('click', () => runCalibrationForMetric(meta));
  const clearBtn = document.getElementById(meta.clearId);
  if (clearBtn) clearBtn.addEventListener('click', () => clearCalibrationForMetric(meta));
}

// ---- Winterface calibration ----------------------------------------------
// Different flow from partyPanel / dgMap (no TL/BR corner hover). The
// user opens the end-of-floor dialog in-game, then clicks Calibrate
// once. Plugin captures the screen, runs peek, stores the anchor
// coordinates if the dialog was successfully detected. Future timer
// OCR uses the stored anchor instead of the dynamic per-capture peek
// — reduces anchor wobble and speeds up each timer read.
const calBtnWinterface   = document.getElementById('cal-btn-winterface');
const calClearWinterface = document.getElementById('cal-clear-winterface');

if (calBtnWinterface) {
  calBtnWinterface.addEventListener('click', () => {
    if (!window.alt1) {
      dbg('error', 'Calibration (Winterface): not running inside Alt1.');
      return;
    }
    if (!alt1.permissionPixel) {
      dbg('error', 'Calibration (Winterface): pixel permission not granted.');
      return;
    }
    let screen = null;
    try { screen = a1lib.captureHoldFullRs(); }
    catch (e) {
      dbg('error', 'Calibration (Winterface): capture threw \u2014 ' + (e && e.message ? e.message : e));
      return;
    }
    if (!screen) {
      dbg('error', 'Calibration (Winterface): screen capture returned null.');
      return;
    }
    let peek = null;
    try { peek = peekForWinterface(screen); }
    catch (_) { peek = null; }
    if (!peek) {
      dbg('error', 'Calibration (Winterface): no winterface detected. '
        + 'Make sure the end-of-floor dialog is OPEN in-game before clicking Calibrate.');
      return;
    }
    calibration.winterface = { x: peek.x, y: peek.y };
    saveCalibration();
    renderCalibrationStatus();
    dbg('match',
      `Calibration (Winterface): saved anchor (${peek.x},${peek.y}) with ${peek.hits} hits.`);
  });
}

if (calClearWinterface) {
  calClearWinterface.addEventListener('click', () => {
    if (!calibration.winterface) {
      dbg('info', 'Calibration (Winterface): already empty.');
      return;
    }
    calibration.winterface = null;
    saveCalibration();
    renderCalibrationStatus();
    dbg('info', 'Calibration (Winterface): cleared. Falling back to dynamic peek.');
  });
}

// ---- Chat "Refind" button -------------------------------------------------
// Chat isn't user-calibrated (the plugin auto-detects it via
// ChatBoxReader.find()). The Refind button just nulls reader.pos so
// the next tick re-runs find() — useful after moving the chat window
// or if detection was lost.
const calBtnChat = document.getElementById('cal-btn-chat');
if (calBtnChat) {
  calBtnChat.addEventListener('click', () => {
    if (reader) {
      reader.pos = null;
      _chatLastSeenAt = 0;
      renderStatus('Re-finding chatbox\u2026');
      renderCalibrationStatus();
    } else {
      dbg('info', 'Chat refind: chatbox reader not initialised yet.');
    }
  });
}

// ---- Settings UI ---------------------------------------------------------
// Everything settings / calibration-related lives in a MODAL opened by
// the Settings button in the header. Closed via the Done button inside
// the modal, a backdrop click, or the Escape key. The modal houses
// infrequently-touched config (name, prefs, calibration) so the main
// window stays focused on runtime state the user actually cares about
// during dungeon runs (doors, keys, floors, party slots).
const settingsModal     = document.getElementById('settings-modal');
const settingsBackdrop  = document.getElementById('settings-modal-backdrop');
const settingsDoneBtn   = document.getElementById('settings-done');
const maxFloorsInput    = document.getElementById('settings-max-floors');
const settingsHeaderBtn = document.getElementById('settings-btn');
const settingsNameInput = document.getElementById('settings-name');
const showDebugInput    = document.getElementById('settings-show-debug');
const clearTeammatesBtn = document.getElementById('settings-clear-teammates');
const debugSection      = document.getElementById('debug-section');

function openSettingsModal() {
  if (settingsModal) settingsModal.hidden = false;
}
function closeSettingsModal() {
  if (settingsModal) settingsModal.hidden = true;
}

if (settingsHeaderBtn) {
  settingsHeaderBtn.addEventListener('click', openSettingsModal);
}
if (settingsDoneBtn) {
  settingsDoneBtn.addEventListener('click', closeSettingsModal);
}
if (settingsBackdrop) {
  // Click on the dimmed backdrop (outside the modal panel) dismisses.
  settingsBackdrop.addEventListener('click', closeSettingsModal);
}
// Escape key — global listener, only acts when the modal is open so
// we don't intercept keystrokes otherwise.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && settingsModal && !settingsModal.hidden) {
    closeSettingsModal();
  }
});

// "Your name" input — edits partyRoster[0] only. Teammates at
// partyRoster[1+] are preserved (auto-discovered via RoK OCR). When
// the name is cleared entirely, the whole roster is wiped since
// elimination requires a baseline self-name.
if (settingsNameInput) {
  settingsNameInput.value = partyRoster[0] || '';
  const commit = () => {
    const newName = settingsNameInput.value.trim();
    if (newName === (partyRoster[0] || '')) return;
    if (!newName) {
      // User cleared their name — wipe the whole roster. Auto-populate
      // will re-seed teammates once a new name is entered and the
      // next panel read fires.
      partyRoster = [];
    } else if (partyRoster.length === 0) {
      partyRoster.push(newName);
    } else {
      partyRoster[0] = newName;
    }
    saveParty();
    pushRenderContext();
    // Roster changed — invalidate self-slot detection so the next
    // panel read re-derives against the new roster[0]. Elimination
    // depends on a current self-name.
    clearSelfSlot();
    _loggedMissingTeammatesHint = false;
    renderUI(tracker.getSnapshot());
    dbg('info', newName ? `Your name set: ${newName}` : 'Your name cleared.');
  };
  settingsNameInput.addEventListener('change', commit);
  settingsNameInput.addEventListener('blur', commit);
}

// "Show debug panel" — hides the entire Debug section when off. dbg()
// calls still execute, so flipping back on shows historical entries.
if (showDebugInput && debugSection) {
  showDebugInput.checked = !!settings.showDebugPanel;
  debugSection.hidden = !settings.showDebugPanel;
  showDebugInput.addEventListener('change', () => {
    const enabled = !!showDebugInput.checked;
    if (enabled === settings.showDebugPanel) return;
    settings.showDebugPanel = enabled;
    saveSettings();
    debugSection.hidden = !enabled;
  });
}

// "Clear known teammates" — wipes partyRoster[1+] (auto-discovered
// teammate names) while keeping the user's own name at index 0.
// Useful for cleaning out stale entries from past parties. Also
// clears the self-slot cache since the elimination baseline just
// changed, and resets the missing-teammates hint so the user can
// see it again on the next multi-party event if still unresolved.
if (clearTeammatesBtn) {
  clearTeammatesBtn.addEventListener('click', () => {
    if (partyRoster.length <= 1) {
      dbg('info', 'Clear teammates: already empty (roster has only your name).');
      return;
    }
    const n = partyRoster.length - 1;
    partyRoster = partyRoster.slice(0, 1);
    saveParty();
    pushRenderContext();
    clearSelfSlot();
    _loggedMissingTeammatesHint = false;
    dbg('match', `Cleared ${n} known teammate(s). Next RoK panel read will re-populate.`);
  });
}

if (maxFloorsInput) {
  // Reflect stored preference, clamped to the hard cap enforced by floor.js.
  maxFloorsInput.max = String(floor.getHardMaxFloors());
  maxFloorsInput.value = String(settings.maxFloors);
  const commit = () => {
    const raw = parseInt(maxFloorsInput.value, 10);
    if (!Number.isFinite(raw)) {
      // Invalid input — revert visual to current setting.
      maxFloorsInput.value = String(settings.maxFloors);
      return;
    }
    const clamped = Math.min(Math.max(10, raw), floor.getHardMaxFloors());
    if (clamped !== raw) maxFloorsInput.value = String(clamped);
    if (clamped === settings.maxFloors) return;
    settings.maxFloors = clamped;
    saveSettings();
    // setMaxFloors handles pruning + notifying the floor UI re-render.
    floor.setMaxFloors(clamped);
    dbg('info', `Max floors kept: ${clamped}`);
  };
  maxFloorsInput.addEventListener('change', commit);
  maxFloorsInput.addEventListener('blur', commit);
}

// Chat-timestamp-matched pin accuracy (opt-in). When enabled, every
// TRIANGLE_SNAPSHOT_INTERVAL_TICKS a lightweight trianglePx sample
// is cached into a ring buffer; on door-info events with a parseable
// chat timestamp, the solo-pin code uses the historical snapshot
// matching the chat's in-game time instead of a fresh capture.
// Zero overhead when disabled — the runTriangleSnapshot hook early-
// returns and tier-0 of solo-pin is gated on the setting.
const timestampedChatInput = document.getElementById('settings-timestamped-chat');
if (timestampedChatInput) {
  timestampedChatInput.checked = !!settings.timestampedChat;
  timestampedChatInput.addEventListener('change', () => {
    const enabled = !!timestampedChatInput.checked;
    if (enabled === settings.timestampedChat) return;
    settings.timestampedChat = enabled;
    saveSettings();
    if (!enabled) {
      // Flush the buffer when disabling so a subsequent re-enable
      // doesn't briefly match against stale snapshots captured pre-
      // disable.
      _triangleSnapshots = [];
    }
    dbg('info', `Chat-timestamp pin matching: ${enabled ? 'ON' : 'OFF'}`);
  });
}

// Floor log webhook URL input. Accepts http(s):// URLs only; empty
// disables the feature. postFloorToWebhook fires on each successful
// timer-attach.
const floorWebhookInput = document.getElementById('settings-floor-webhook');
if (floorWebhookInput) {
  floorWebhookInput.value = settings.floorLogWebhookUrl || '';
  const commit = () => {
    const raw = String(floorWebhookInput.value || '').trim();
    if (raw === settings.floorLogWebhookUrl) return;
    if (raw && !/^https?:\/\//i.test(raw)) {
      dbg('error', `Floor log webhook: URL must start with http:// or https:// — leaving unchanged.`);
      floorWebhookInput.value = settings.floorLogWebhookUrl || '';
      return;
    }
    settings.floorLogWebhookUrl = raw;
    saveSettings();
    if (raw) {
      const shown = raw.length > 60 ? raw.slice(0, 57) + '...' : raw;
      dbg('info', `Floor log webhook: set to ${shown}`);
    } else {
      dbg('info', 'Floor log webhook: cleared');
    }
  };
  floorWebhookInput.addEventListener('change', commit);
  floorWebhookInput.addEventListener('blur', commit);
}

if (floorsExportBtn) {
  floorsExportBtn.addEventListener('click', async () => {
    if (floor.count() === 0) {
      dbg('info', 'Floor export: log is empty.');
      return;
    }
    const csv = floor.exportCsv();
    let copied = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(csv);
        copied = true;
      }
    } catch (_) { /* CEF likely blocked it \u2014 fall through */ }
    if (copied) {
      dbg('match', `Floor CSV copied to clipboard (${floor.count()} row(s)).`);
    } else {
      dbg('info',
        `Clipboard blocked \u2014 dumping CSV to log (${floor.count()} row(s)). Select and copy manually:`);
      for (const ln of csv.split('\n')) dbg('raw', ln);
    }
  });
}

// Two-click arm/confirm: Alt1's CEF silently suppresses window.confirm(), so
// the old single-click-with-dialog flow looked broken. First click arms the
// button (visual change + 3s timeout); second click within that window wipes
// the log.
let _clearArmed = false;
let _clearArmedTimer = null;
function disarmClearBtn() {
  _clearArmed = false;
  if (floorsClearBtn) {
    floorsClearBtn.textContent = 'Clear';
    floorsClearBtn.classList.remove('armed');
  }
}
if (floorsClearBtn) {
  floorsClearBtn.addEventListener('click', () => {
    const n = floor.count();
    if (n === 0) { dbg('info', 'Floor log: already empty.'); disarmClearBtn(); return; }
    if (!_clearArmed) {
      _clearArmed = true;
      floorsClearBtn.textContent = 'Confirm?';
      floorsClearBtn.classList.add('armed');
      if (_clearArmedTimer) clearTimeout(_clearArmedTimer);
      _clearArmedTimer = setTimeout(disarmClearBtn, 3000);
      return;
    }
    if (_clearArmedTimer) { clearTimeout(_clearArmedTimer); _clearArmedTimer = null; }
    disarmClearBtn();
    floor.clear();
    dbg('info', `Floor log: cleared ${n} record(s).`);
  });
}

// ---- Alt1 overlay: key-icon pins on the RS3 DG map widget -----------
// Draws every entry in tracker.doorsPending that has cellCoords as a
// small key glyph on the actual map widget, at the cell where the
// user info'd the door. Icon is 16 px, positioned in the E / SE / S
// quadrant of the cell (triangle anchors top-left). Multiple doors
// in the same room take different quadrant slots based on chat-event
// order so they don't stack.
//
// Lifecycle is driven entirely by tracker state: as soon as a chat
// door-info event fires in solo mode, the solo-pin logic attaches
// cellCoords to the tracker entry; the overlay draws from that next
// tick. When the corresponding key is used (key-used event) the
// tracker deletes the entry → overlay no longer iterated → fades via
// duration timeout. No explicit clear needed.
let _overlayReady = false;

// Frozen origin+pitch snapshot used for ALL overlay position
// computations. Captured on the first successful map read and held
// until significant drift is detected (widget moved / resized).
// Anchoring prevents the derived pitch drifting 1-2 px between reads
// from shifting the icon's relative-in-cell position across rooms.
let _overlayMapAnchor = null; // { origin: {x, y}, pitch }
let _overlayLastAnchorCheckAt = 0; // _latestDgMapAt last evaluated

// Thresholds for detecting that the RS3 map widget itself moved/
// resized, meaning our frozen anchor is stale and needs refreshing.
// Normal tick-to-tick drift is < 2 px on origin and ≤ 1 on pitch; a
// real widget move usually shifts tens of pixels.
const OVERLAY_ANCHOR_REFRESH_ORIGIN_PX = 15;
const OVERLAY_ANCHOR_REFRESH_PITCH_PX = 4;

// Per-cell draw-position cache. Key = "col,row,slot"; value = {x, y}
// already rounded. Rounding once at first compute stops sub-pixel
// drift + floating-point noise from producing ±1 px jitter on every
// tick's redraw. Invalidated wholesale whenever the anchor refreshes
// (widget was moved/resized) since every cached position becomes stale
// simultaneously.
const _overlayPosCache = new Map();

// Pre-render every (colour, shape) at 16 px in BOTH variants — default
// (need-key) and ready (chartreuse halo ring, signals "matching key
// acquired"). 128 promises resolve in parallel at startup — typically
// completes in a few hundred ms. drawPinnedOverlays picks the variant
// based on each door's tracker.haveKey flag.
(async () => {
  try {
    const { KEY_COLOR_HEX: colors, KEY_SHAPE_PATHS: shapes } = await import('./keyIcon.js');
    const promises = [];
    for (const c of Object.keys(colors)) {
      for (const s of Object.keys(shapes)) {
        promises.push(preRenderIcon(c, s, 16, false)); // need-key variant
        promises.push(preRenderIcon(c, s, 16, true));  // key-ready variant
      }
    }
    await Promise.all(promises);
    _overlayReady = true;
    const total = Object.keys(colors).length * Object.keys(shapes).length * 2;
    dbg('match', `overlay: pre-rendered ${total} key icons @ 16 px (need-key + key-ready halo variants)`);
  } catch (e) {
    dbg('error', 'overlay pre-render failed: ' + (e && e.message ? e.message : e));
  }
})();

// ---- Alt1 identification ----
try { a1lib.identifyApp('appconfig.json'); } catch (e) { /* noop outside Alt1 */ }

// ---- Chatbox setup --------------------------------------------------------
function setupReader() {
  reader = new ChatBoxReader();
  // Extend the colour list so coloured key-name text (Blue / Green / Purple /
  // Gold / Silver / Crimson / Orange / ...) is included in the OCR pass.
  // Defaults cover white/yellow/green/orange/red but not every key colour.
  const extraColors = [
    // ---- Memoryerror-sourced canonical chat palette ----
    // Exact RGBs RS3 renders `<col=HEX>` key-name text in, sourced from the
    // memoryerror tool (which reads pre-render chat buffers). Listed first
    // so OCR lands on the canonical colour before falling back to the
    // fuzzy variants below.
    a1lib.mixColor( 51, 102, 255), // blue
    a1lib.mixColor(220,  20,  60), // crimson
    a1lib.mixColor(255, 223,   0), // gold
    a1lib.mixColor(  0, 255,   0), // green
    a1lib.mixColor(255, 102,   0), // orange
    a1lib.mixColor(102,   0, 255), // purple
    a1lib.mixColor(192, 192, 192), // silver
    a1lib.mixColor(255, 255,   0), // yellow
    // Broadcast purple #5B1A91: used by the "Your warped gorajan trailblazer
    // outfit boosts..." floor-end line AND as the accent on the "Floor N"
    // banner number (white "Floor" + this purple for the digit).
    a1lib.mixColor( 91,  26, 145),
    // Broadcast body colour for "Your party found/used a key: ..." lines.
    // Shares the RGB with the keybag icon's frame in memoryerror's palette.
    a1lib.mixColor(167,  65,  20),

    // Dungeoneering key colours (best-guess RS3 chat RGBs)
    a1lib.mixColor(255, 215,   0), // gold
    a1lib.mixColor(230, 180,   0), // darker gold
    a1lib.mixColor(245, 200,  66), // pale gold
    a1lib.mixColor(200, 200, 200), // silver
    a1lib.mixColor(180, 180, 180), // darker silver
    a1lib.mixColor(220,  60,  60), // red
    a1lib.mixColor(180,  40,  40), // crimson
    a1lib.mixColor(230,  50,  50), // bright red
    a1lib.mixColor( 45, 130, 220), // deep blue (key)
    a1lib.mixColor( 80, 170, 255), // light blue (key)
    a1lib.mixColor( 40, 180,  80), // green (key)
    a1lib.mixColor( 80, 220, 100), // bright green
    a1lib.mixColor(180,  80, 220), // purple (key)
    a1lib.mixColor(155, 120, 220), // lavender
    a1lib.mixColor(255, 140,   0), // orange
    a1lib.mixColor(255, 110,   0), // darker orange
    // RS system chat colours we may otherwise miss
    a1lib.mixColor(255,   0, 255), // magenta
    a1lib.mixColor(  0, 255, 255), // cyan
    a1lib.mixColor(255, 255, 255), // white
    // Public-chat default username off-whites (user-eyedropped from live chat).
    // Dark-background anti-aliasing pulls interior pixels off pure white; these
    // three were sampled from letter interiors in the Dungeoneering chat feed
    // and cover the common brightness range of the default name colour.
    a1lib.mixColor(242, 242, 242),
    a1lib.mixColor(234, 234, 234),
    a1lib.mixColor(216, 216, 216),

    // ----- Clan-rank text palette (RS3 lets clans pick from a wide range). -----
    // Reds
    a1lib.mixColor(255,   0,   0), // pure red
    a1lib.mixColor(200,   0,   0), // dark red
    a1lib.mixColor(255, 100, 100), // pink-red
    // Oranges / browns
    a1lib.mixColor(200, 100,   0), // brown-orange
    a1lib.mixColor(255, 200, 100), // tan
    // Yellows
    a1lib.mixColor(255, 255, 100), // pale yellow
    a1lib.mixColor(200, 200,   0), // dark yellow
    // Greens
    a1lib.mixColor(  0, 200,   0), // pure green
    a1lib.mixColor(  0, 150,   0), // mid green
    a1lib.mixColor(150, 255, 150), // pale green
    a1lib.mixColor(  0, 255, 100), // green-teal
    // Blues / cyans
    a1lib.mixColor(100, 100, 255), // medium blue
    a1lib.mixColor(  0, 100, 200), // navy
    a1lib.mixColor(100, 200, 255), // sky
    a1lib.mixColor(150, 200, 255), // pale sky
    // Purples / magentas
    a1lib.mixColor(200, 100, 200), // pink purple
    a1lib.mixColor(150,   0, 200), // dark purple
    a1lib.mixColor(255, 150, 255), // pale magenta
    // Greys
    a1lib.mixColor(150, 150, 150), // mid grey
    a1lib.mixColor(100, 100, 100), // dark grey

    // ----- Dungeoneering / system alert colours -----
    // "Your party found a key:" and similar system alerts use shades of
    // dark orange / red-orange that aren't always in the defaults.
    a1lib.mixColor(255, 102,   0), // bright orange
    a1lib.mixColor(204,  85,   0), // dark orange
    a1lib.mixColor(255,  85,   0), // deep orange
    a1lib.mixColor(255,  60,   0), // red-orange
    a1lib.mixColor(220, 100,  50), // rust
    a1lib.mixColor(180,  90,  20), // brown-orange
    a1lib.mixColor(255, 170,  80), // peach
    a1lib.mixColor(255, 200,  50), // amber
    // RS3 dungeoneering-specific found/used colors (common guesses)
    a1lib.mixColor(255, 127,   0),
    a1lib.mixColor(255, 165,   0),
    // Extra gold/yellow family — RS3 broadcasts & dungeoneering status lines
    // often use a yellow-gold distinct from pure yellow (255,255,0).
    a1lib.mixColor(239, 201,   0), // RS3 broadcast gold
    a1lib.mixColor(255, 230,   0), // pale gold-yellow
    a1lib.mixColor(240, 220, 130), // cream
    a1lib.mixColor(220, 190,  90), // muted gold

    // ----- Wider net for "Your party found/used a key:" body text -----
    // Empirically these lines OCR empty after the timestamp, meaning the body
    // text colour isn't in our palette. Cover RS3 broadcast / filter shades.
    a1lib.mixColor(255, 150,  50), // warm orange
    a1lib.mixColor(255, 120,  30), // deep warm orange
    a1lib.mixColor(200, 130,  50), // earth orange
    a1lib.mixColor(160,  82,  45), // sienna
    a1lib.mixColor(153, 102,   0), // dark brown-orange
    a1lib.mixColor(139,  69,  19), // saddle brown
    a1lib.mixColor(210, 105,  30), // chocolate
    a1lib.mixColor(184, 134,  11), // dark goldenrod
    a1lib.mixColor(218, 165,  32), // goldenrod
    a1lib.mixColor(255, 140,  60), // bright peach-orange
    // Extra RS3 canonical chat colours
    a1lib.mixColor(127, 169, 255), // RS3 timestamp blue (defensively)
    a1lib.mixColor(255,  70,  70), // RS3 broadcast red
    a1lib.mixColor(200,   0, 255), // RS3 clan purple
    a1lib.mixColor( 50, 120, 255), // RS3 game blue variant
    a1lib.mixColor(255, 255, 150), // pale lime-yellow

    // ----- Key-name shades (Blue/Green/Purple/etc) for "Key required:" / -----
    // "Door unlockable:" / "found a key:" tails. Every added colour slightly
    // increases false positive anti-alias matches, so we keep the cluster
    // focused rather than going RGB-cube-wide. Use the Eyedrop button to
    // pin any remaining misses exactly.
    // Extra blues — intentionally trimmed. The mid-brightness variants
    // (120,160,240), (100,140,230), (80,140,200), (90,160,220) were catching
    // anti-aliased EDGE pixels of white chat text (the user's username) and
    // winning over the (240/234/216) off-white entries above for edge
    // samples. That made usernames OCR back as blue gibberish. We now keep
    // only saturated blues for the "Blue <shape> key" body colour — those
    // are far enough from grey that they don't steal white edges.
    a1lib.mixColor( 60, 110, 200), // saturated deep blue
    a1lib.mixColor( 40, 100, 180), // dark ocean
    a1lib.mixColor( 30,  90, 160), // navy blue
    // Extra greens (in case Green key text is also missed)
    a1lib.mixColor( 60, 200,  90), // vivid green
    a1lib.mixColor( 30, 150,  60), // forest green
    a1lib.mixColor(100, 220, 120), // pale green
    a1lib.mixColor( 20, 180, 100), // jade
    // Extra purples
    a1lib.mixColor(140,  60, 180), // deep violet
    a1lib.mixColor(180, 100, 220), // bright lavender
    a1lib.mixColor(120,  40, 200), // royal purple
    // Extra oranges (for Orange key)
    a1lib.mixColor(230, 110,  40), // warm pumpkin
    a1lib.mixColor(220, 140,  60), // terracotta
    // Extra golds (distinct from yellow — RS3 uses a specific gold)
    a1lib.mixColor(220, 170,  40), // rich gold
    a1lib.mixColor(200, 160,  30), // antique gold
    // Extra crimsons
    a1lib.mixColor(200,  50,  60), // blood red
    a1lib.mixColor(160,  30,  50), // dark crimson
    // Extra silvers
    a1lib.mixColor(210, 210, 215), // light silver
    a1lib.mixColor(160, 165, 170), // dim silver

    // ----- Dungeoneering Ring-of-Kinship slot-colour palette -----
    // Without these, Alt1's ChatBoxReader treats slot-coloured
    // usernames as unknown icons and the skipUnknownBadge nudge skips
    // past them entirely → no username fragment at all → door-info
    // events come back with player='?' and slotColor=null. ev.slotColor
    // is informational today (attribution goes through aliasMap /
    // fuzzy roster match), but these colours are still needed so the
    // reader can OCR slot-coloured names in the first place.
    //
    // References are the per-slot peak RGBs documented in partyPanel.js
    // (eyedropped originally via memoryerror). Observed variants are
    // values the user has eyedropped on the current / a previous client
    // — included so the reader's palette matching catches the actual
    // rendering on their specific setup, not just the reference peaks.
    a1lib.mixColor(210,  53,  0), // slot 1 red — reference peak
    a1lib.mixColor(203,  52,  1), // slot 1 red — current-client observed
    a1lib.mixColor(192,  50,  2), // slot 1 red — prior-client observed
    a1lib.mixColor( 18,  84, 80), // slot 2 teal — reference peak
    a1lib.mixColor(  0, 137, 133), // slot 2 teal — current-client observed
    a1lib.mixColor( 71, 125,  1), // slot 3 lime — reference peak
    a1lib.mixColor( 52,  92,  1), // slot 3 lime — current-client observed
    a1lib.mixColor(141, 145,  1), // slot 4 yellow — reference peak
    a1lib.mixColor(106, 130, 94), // slot 5 pale — reference peak (desaturated)
  ];
  for (const c of extraColors) {
    if (!reader.readargs.colors.includes(c)) reader.readargs.colors.push(c);
  }

  // ----- Custom forward-nudge: skip past unknown clan-title icons mid-line. -----
  // Alt1's chatbox reader knows only its built-in badges (vip, pmod, broadcast,
  // ironman, league trophies, link). Custom clan-title icons stop the read at
  // the icon. This nudge fires AFTER all built-in nudges fail; it scans a
  // range of pixel offsets and resumes OCR using readLine (more forgiving
  // than readChar — accepts any text starting near the offset, not just one
  // exactly-aligned glyph).
  // Telemetry counters (read by tick logging) so we can see if the nudge runs.
  window.__dkt_nudge = { calls: 0, hits: 0, lastTextOnEntry: '' };
  // Dense scan from 8px to 100px in 2px steps, then coarser out to 180px.
  // RS3 clan icons can be 16-32px wide; account for icon width + leading/trailing
  // space + occasional double icons (clan icon + extra title decoration). The
  // wider tail catches system-message lines where the entire prefix before the
  // body (e.g. a dungeoneering status icon sitting close to "Your party ...")
  // may stretch past 100px.
  const SKIP_WIDTHS = [];
  for (let w = 8;  w <= 100; w += 2) SKIP_WIDTHS.push(w);
  for (let w = 104; w <= 180; w += 4) SKIP_WIDTHS.push(w);
  const SKIP_PLACEHOLDER = '\u00B7'; // middle dot — distinct in regex
  // Long multi-icon lines (e.g. "Aari●the Iceborn●: Door unlockable: Silver corner door")
  // may need 3-5 skips. Cap is still needed to prevent runaway on truly garbled lines.
  const MAX_SKIPS_PER_LINE = 6;
  reader.forwardnudges.push({
    // Fire whenever there's ANY existing text — not just word-char endings.
    // This is what unblocks multi-icon lines like "…the Iceborn●: Door unlockable:"
    // where the read stops at a non-word char (".", "!", ":"). The MAX_SKIPS cap
    // prevents runaway.
    match: /./,
    name: 'skipUnknownBadge',
    fn(ctx) {
      window.__dkt_nudge.calls++;
      window.__dkt_nudge.lastTextOnEntry = ctx.text;
      const existingSkips = (ctx.text.match(/\u00B7/g) || []).length;
      if (existingSkips >= MAX_SKIPS_PER_LINE) return false;

      for (const w of SKIP_WIDTHS) {
        const x = ctx.rightx + w;
        // readLine is more forgiving than readChar — it scans for any
        // contiguous text in any of ctx.colors starting at x.
        const data = OCR.readLine(ctx.imgdata, ctx.font, ctx.colors, x, ctx.baseliney, true, false);
        // Accept only REAL text after the skip. With ~60 colours in the
        // palette, readLine will happily pick up icon-gradient pixels as
        // 1-2 character alphanumeric glyphs (e.g. "l" from the vertical bar
        // of an iron-mode chat icon), then accept them as the "skipped"
        // text. That's the root cause of usernames coming back in garbled
        // blue: the nudge latches onto icon pixels and never reaches the
        // real name behind it.
        //
        // Tighter gate: need ≥3 chars total AND ≥2 alphabetic, AND alpha
        // chars must make up ≥50% of the recovered text. Real words like
        // "the", "Aar", "Iceborn" pass easily; icon gradients matched as
        // ".-" or "l." do not.
        if (data && data.text) {
          const t = data.text;
          const alpha = (t.match(/[A-Za-z]/g) || []).length;
          const total = t.length;
          if (total >= 3 && alpha >= 2 && alpha * 2 >= total) {
            window.__dkt_nudge.hits++;
            ctx.addfrag({
              color: [128, 128, 128], index: -1,
              text: SKIP_PLACEHOLDER, xstart: ctx.rightx, xend: x
            });
            data.fragments.forEach(f => ctx.addfrag(f));
            return true;
          }
        }
      }
      return false;
    }
  });

  console.log('[dkt] chatbox reader setup. total colours:',
    reader.readargs.colors.length, '+ skipUnknownBadge nudge installed');
}

// Semantic-event dedupe set (see usage in tick() for rationale).
const seenEvents = new Set();

// Loose timestamp extractor — only requires "[digits:digits:digits" prefix,
// without the closing "]". Crucial for catching re-OCRs where the closing
// bracket got mangled (e.g. "[20:04:38|" or "[20:04:38 ,,") so we still
// share the same timestamp-component across reads of the same logical line.
function extractChatTs(line) {
  const m = line && line.text && line.text.match(/^\[(\d{1,2}:\d{2}:\d{2})/);
  return m ? m[1] : null;
}

function semanticEventKey(line, ev) {
  const ts = extractChatTs(line);
  return `${ts || '?'}|${ev.type}|${ev.color || ''}|${ev.shape || ''}|${ev.player || ''}`;
}

function signatureOf(line) {
  // Dedupe key combines TIMESTAMP + COLOUR FINGERPRINT of the body fragments.
  //
  // Timestamp alone is stable as chat scrolls (and survives OCR drift of the
  // body text), but two DIFFERENT chat lines can share the same in-game
  // timestamp when messages arrive in the same second — e.g.
  //   [16:46:17] You don't have the correct key.
  //   [16:46:17] Aari the Iceborn: Key required: Orange triangle key
  // With timestamp-only dedupe, the first line wins and the second (a real
  // key-required event) gets silently dropped.
  //
  // Adding the colour fingerprint (list of non-timestamp fragment colours)
  // distinguishes these: the two lines render in different colours (red
  // body vs white-name + blue-keyword + orange-body), producing different
  // signatures. Same message re-OCR'd at drifting baseline keeps its colour
  // sequence intact, so the de-flood guarantee still holds.
  const m = line.text && line.text.match(/^\[(\d{1,2}:\d{2}:\d{2})\]/);
  const ts = m ? m[1] : '';
  const frags = Array.isArray(line.fragments) ? line.fragments : [];
  const colorSig = frags
    .filter(f => f && Array.isArray(f.color))
    // Drop the timestamp-blue fragment — it's identical on every line
    // and doesn't help distinguish messages.
    .filter(f => !(Math.abs(f.color[0] - 127) <= 15 &&
                   Math.abs(f.color[1] - 169) <= 15 &&
                   Math.abs(f.color[2] - 255) <= 15))
    .map(f => f.color.join(','))
    .join('/');
  if (ts) return 'ts:' + ts + '|c:' + colorSig;
  return 'raw:' + (line.text || '').slice(0, 60);
}

let tickCount = 0;
let warnedNoPixel = false;
let loggedFound = false;

// Floor END is detected three ways, in order of preference:
//   1. Auto-probe winterface: sparse-pixel peek fires every ~1.8s looking
//      for the end-dungeon title banner. Rising edge (null → hit) triggers
//      the full probe (OCR timer + mark floor ended). Subsequent peeks
//      while the winterface stays open are no-ops; when the winterface
//      closes, state re-arms for the next floor. See runAutoWinterfaceProbe.
//   2. Outfit-bonus chat line (fallback, no timer).
//   3. Leave-party chat line (absolute, closes any open floor).
//
// Floor START is detected by the "Floor N" banner (see parser.detectFloorBanner
// — white "Floor" fragment + purple-digit fragment). No auto-start fallbacks:
// if the banner OCR fails, the user can manually delete any stray rows via
// the per-row × button in the Floors UI.

let nextAutoPeekTick = 0;
const AUTO_PEEK_INTERVAL_TICKS = 18; // ~1.8s at 100ms tick cadence

// Peek hit threshold for AUTO-probe specifically. False positives (gold buff
// icons, inventory glints, etc.) cluster at 5-18 hits in observed logs; the
// real winterface title consistently produces 20+ (it's a row of big gold
// letters across ~400px). 20 filters observed false positives cleanly while
// staying safely below real-winterface values.
const AUTO_PEEK_HIT_THRESHOLD = 20;

// Suppresses repeated "peek hit but timer OCR failed" log spam when the same
// persistent gold UI element keeps clearing the peek threshold during a
// floor. We log the first failure per floor (diagnostically useful) and go
// silent after — resets on floor change via the startedAt key.
let _loggedFailedProbeFor = null;

// One-shot hint for the "plugin booted mid-dungeon" case: winterface peek
// clears its hit threshold but there's no current floor to attach the timer
// to (no floor-start banner was captured — Alt1 page reload mid-run, or
// banner OCR was missed). Without this hint the auto-probe silently no-ops
// and the user can't tell whether winterface detection works on their
// layout. Resets to false whenever a floor IS present (next floor-start
// rearms the pipeline), so the hint fires again if the no-floor state
// recurs later in the session.
let _loggedMidDungeonBootHint = false;

/**
 * Auto-probe winterface detector. No rising-edge — we just check every ~1.8s
 * whether:
 *   (a) there's a floor that still needs a timer (`!cur.time`), AND
 *   (b) the peek reports a strong hit (≥ AUTO_PEEK_HIT_THRESHOLD).
 * If both, we attempt the timer OCR. Floor state is mutated ONLY on OCR
 * success — this prevents false-positive peeks from spuriously ending an
 * ongoing floor. If OCR fails, we retry on the next tick (handles dialog
 * animation timing) until either success, the floor already has a timer,
 * or the winterface closes.
 */
function runAutoWinterfaceProbe() {
  if (!window.alt1 || !alt1.permissionPixel) return;
  if (tickCount < nextAutoPeekTick) return;
  nextAutoPeekTick = tickCount + AUTO_PEEK_INTERVAL_TICKS;

  const cur = floor.current();
  // Short-circuit when the current floor already has its timer — nothing
  // to do until the next floor-start flips cur.time back to null. We
  // deliberately DO NOT early-exit on !cur here: the peek still runs so
  // we can emit the mid-dungeon-boot hint below when a winterface is
  // visible but no floor-start has been captured.
  if (cur && cur.time) return;

  let screen;
  try { screen = a1lib.captureHoldFullRs(); }
  catch (_) { return; }
  if (!screen) return;

  let peek = null;
  try { peek = peekForWinterface(screen); }
  catch (_) { peek = null; }
  if (!peek || peek.hits < AUTO_PEEK_HIT_THRESHOLD) return;

  // Record the runtime detection so the Settings → Calibration
  // → Winterface status row can show freshness-based ✓/⚠ even
  // when the user hasn't locked an anchor via the Calibrate button.
  _winterfaceLastDetectedAt = Date.now();

  if (!cur) {
    // Peek cleared the threshold but we have nowhere to attach the timer
    // because no floor-start banner was ever captured for this run (plugin
    // booted mid-dungeon, or banner OCR was missed). One-shot log per
    // no-floor streak — resets on the normal-path branch below so the
    // hint can fire again if the no-floor state recurs.
    if (!_loggedMidDungeonBootHint) {
      _loggedMidDungeonBootHint = true;
      dbg('info',
        'winterface peek hit but no active floor \u2014 plugin likely started '
        + 'mid-dungeon; this floor\u2019s timer can\u2019t be captured, '
        + 'next floor-start banner will re-arm the pipeline.');
    }
    return;
  }

  _loggedMidDungeonBootHint = false;
  fireAutoProbe(screen);
}

function fireAutoProbe(screen) {
  let res;
  try { res = captureEndDungeonTimer({ verbose: false, screen, calibratedAnchor: calibration.winterface }); }
  catch (e) { dbg('error', 'auto-probe threw: ' + (e && e.message ? e.message : e)); return; }
  if (!res) return;

  const aStr = res.anchor
    ? `hits=${res.anchor.hits} @ (${res.anchor.x},${res.anchor.y})`
    : 'anchor unknown';

  // CRITICAL safety rail: only mutate floor state when timer OCR succeeds.
  // A passing peek with a failed timer OCR almost always means a false
  // positive (gold UI pixel cluster elsewhere on screen happened to clear
  // the hit threshold). Bailing here keeps ongoing floors from being
  // wrongly marked finished. Outfit-bonus line remains the fallback closer.
  if (!res.ok) {
    // Log at most once per floor — prevents spam from persistent false-
    // positive gold UI elements that keep re-clearing the peek threshold.
    const curForLog = floor.current();
    const key = curForLog ? curForLog.startedAt : 'no-floor';
    if (_loggedFailedProbeFor !== key) {
      _loggedFailedProbeFor = key;
      const rect = res.scanRect;
      const rectStr = rect
        ? `rect ${rect.w}x${rect.h} @ (${rect.x},${rect.y})`
        : `offset=${JSON.stringify(res.offset)}`;
      dbg('miss', `auto-probe: peek ${aStr} but timer OCR failed (${rectStr}); floor untouched, will retry next tick. Silencing further failures this floor.`);
      if (res.timerTries && res.timerTries.length) {
        for (const t of res.timerTries.slice(0, 4)) {
          const where = (typeof t.xRel === 'number') ? ` @ rel(${t.xRel},${t.yRel})` : '';
          dbg('info', `  ${t.font}${where}: ${JSON.stringify(t.text)}`);
        }
        if (res.timerTries.length > 4) dbg('info', `  ...and ${res.timerTries.length - 4} more`);
      }
    }
    return;
  }

  // Timer OCR succeeded → this is a real winterface. Mutate state now.
  const cur = floor.current();
  if (!cur) return;
  dbg('match', `Winterface AUTO-detected (${aStr})`);
  if (!cur.ended) {
    floor.floorEnd();
    dbg('match', `FLOOR END (auto) \u2014 floor #${floor.count()} marked ended`);
    tracker.handleEvent({ type: 'floor-end' });
  }
  if (!cur.time) {
    const updated = floor.attachTimerToCurrent(res.time, res.timeSeconds);
    dbg('match', `TIMER OCR (auto): ${res.time} (${res.timeSeconds}s) via ${res.font}`);
    if (updated) postFloorToWebhook(updated);
  }
}

/**
 * Fire-and-forget POST of a completed floor row to the configured
 * webhook URL. No-op when settings.floorLogWebhookUrl is empty.
 *
 * Uses `text/plain` content-type so fetch doesn't trigger a CORS
 * preflight — the body is still JSON, and Google Apps Script /
 * typical local bridges parse `e.postData.contents` independently
 * of the declared content-type. Keeps the integration "just works"
 * against Apps Script web apps without the user configuring CORS.
 *
 * Called from fireAutoProbe on successful timer attach — that's
 * the "floor is fully done" moment for the common path. Floors
 * that end without a timer (outfit-only close / leave-party) are
 * NOT auto-synced in this version; user can fall back to the
 * existing "Export CSV" button for those.
 */
function postFloorToWebhook(floorRow) {
  const url = settings.floorLogWebhookUrl;
  if (!url || !/^https?:\/\//i.test(url)) return;
  if (!floorRow || typeof floorRow.startedAt !== 'number') return;

  const payload = JSON.stringify({
    startedAt: floorRow.startedAt,
    endedAt: floorRow.endedAt || null,
    time: floorRow.time || null,
    timeSeconds: typeof floorRow.timeSeconds === 'number' ? floorRow.timeSeconds : null,
  });

  const stamp = formatClock(floorRow.startedAt);
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: payload,
  }).then(r => {
    if (r.ok) {
      dbg('match', `Webhook: synced floor started ${stamp} (${floorRow.time || '—'})`);
    } else {
      dbg('miss', `Webhook: HTTP ${r.status} for floor started ${stamp}`);
    }
  }).catch(err => {
    dbg('miss', `Webhook: network error (${err && err.message ? err.message : 'unknown'}) for floor started ${stamp}`);
  });
}

// ---- Party panel reader (Phase 1a, milestone A) -------------------------
// Every PARTY_INTERVAL_TICKS we attempt to read the Ring of Kinship panel:
// locate via slot-outline peek, classify each slot colour, and OCR each
// filled slot's name against the near-black interior palette. Findings are
// logged to the debug panel with content-based dedupe (only logs when the
// observed slot state actually changes) so the log doesn't churn.
//
// Milestone A is STRICTLY READ-ONLY: no tracker state, no roster seeding,
// no UI surface beyond debug log. Purpose is to prove the reader works
// reliably in-game before we layer integration on top.
//
// Cadence of 30 ticks at 100ms (~3 s) reflects that the panel changes
// slowly — only on party join/leave — so there's no benefit to reading
// faster, and OCR is not free.
const PARTY_INTERVAL_TICKS = 30;
let nextPartyTick = 0;
let _lastPartyPanelLog = null;
// Cache of the most recent successful party-panel read. Used by the UI
// rendering pipeline — when the user assigns a slot via the click-to-
// assign dropdown, we can re-render immediately against the cached state
// without waiting for the next tick.
let _lastPartyPanelResult = null;

// ---- Temporal confirmation ----------------------------------------------
// A single-tick "found" detection occasionally slips through the filter
// chain even when the user isn't in a party — Daemonheim has enough red/
// panel-BG-coloured world geometry that a random configuration can
// momentarily satisfy every check. The distinguishing feature is
// PERSISTENCE: a real panel produces stable detections across many
// consecutive ticks, whereas a transient world-arrangement match appears
// for one tick and is gone.
//
// We track the previous tick's successful detection and only promote it
// to "confirmed" (logged + rendered) once a second consecutive read
// agrees on anchor position. One-tick false positives never confirm.
// Trade-off: a 3-second delay (one tick at PARTY_INTERVAL_TICKS * 100ms)
// before a newly-opened panel shows in the UI, which is acceptable.
const CONFIRM_X_TOLERANCE = 25;
const CONFIRM_Y_TOLERANCE = 10;
// Provisional detection awaiting confirmation. Stores the tick number it
// was first seen so we can also reset on staleness.
let _provisionalPanel = null;  // { x, y, filledColors, tick }

function panelDetectionMatches(prev, curr) {
  if (!prev) return false;
  if (Math.abs(prev.x - curr.origin.x) > CONFIRM_X_TOLERANCE) return false;
  if (Math.abs(prev.y - curr.origin.y) > CONFIRM_Y_TOLERANCE) return false;
  const prevFilled = prev.filledColors;
  const currFilled = curr.slots.filter(s => s.filled).map(s => s.color).join('|');
  return prevFilled === currFilled;
}

// ---- Pixel-based leave-party detection (for slot-assignment auto-clear) ----
// White "You leave the party" chat text is unreliable to OCR, so we can't
// depend on the parser-level leave-party event to auto-clear slot
// assignments. Instead we watch the PANEL ITSELF: in RS3, the Ring of
// Kinship party interface is only rendered while the player is in a party.
// If we saw the panel earlier and it then vanishes for a sustained run of
// reads, the user is no longer in a party — whatever party forms next
// will have new slot assignments, so we can safely clear.
//
// Threshold: 10 consecutive misses × PARTY_INTERVAL_TICKS × ~100 ms ≈ 30 s
// of continuous absence. Long enough to absorb transient occlusions (other
// windows briefly covering the panel, screenshot hiccups) while still
// catching real party-exits quickly.
const PANEL_ABSENCE_CLEAR_THRESHOLD = 10;
// UI-clear hysteresis. The detection stage can drop for a single read
// at a time (short names + anti-aliased text near the red-classifier
// boundary; brief cursor hover; transient occlusions) without the panel
// actually being gone. Before this threshold existed, any single miss
// wiped the rendered slot rows → "my name flickers on/off" symptom.
// 3 misses × 30-tick cadence × 100 ms ≈ 9 s of tolerance — long enough
// to absorb detection drops, short enough that a genuinely closed panel
// disappears from the UI quickly. Sits below PANEL_ABSENCE_CLEAR_THRESHOLD
// so the UI clears before slot assignments get auto-wiped.
const PANEL_UI_CLEAR_THRESHOLD = 3;
let _panelPresentEverThisSession = false;
let _panelAbsentStreak = 0;
let _autoClearedThisAbsence = false;

// Party-size cache for solo auto-pinning. Updated on every successful
// panel read:
//   'UNKNOWN' — panel never observed this session; auto-pinning disabled.
//   'SOLO'    — most recent panel read showed exactly 1 filled slot.
//   'MULTI'   — most recent panel read showed ≥ 2 filled slots.
// Demoted back to 'UNKNOWN' when panel absence crosses
// PANEL_ABSENCE_CLEAR_THRESHOLD — at that point the cache is stale
// enough that we can't trust "assumed solo" if the user joined a
// party while the panel was closed.
let _partySize = 'UNKNOWN';

function runPartyPanelRead() {
  if (!window.alt1 || !alt1.permissionPixel) return;
  if (tickCount < nextPartyTick) return;
  nextPartyTick = tickCount + PARTY_INTERVAL_TICKS;

  let res;
  try {
    // Pass the user-calibrated region when present — it replaces the
    // default panelScanRect inside readPartyPanel. Uncalibrated users
    // fall back to the wider auto-scan.
    res = readPartyPanel({ region: calibration.partyPanel });
  }
  catch (e) {
    dbg('error', 'party-panel read threw: ' + (e && e.message ? e.message : e));
    return;
  }
  if (!res) return;

  // Not-found paths: log only on state transitions, and only for the
  // actionable reasons. `no-button-text` means the panel's button isn't
  // visible at all — silent, happens constantly when the panel is
  // closed. `no-valid-button` means we found button candidates but none
  // had a real panel structure above — worth reporting so we can tune.
  if (!res.found) {
    // Clear provisional state on any not-found tick — a transient flash
    // requires TWO consecutive matching detections to confirm, so any
    // gap in the streak resets the counter.
    _provisionalPanel = null;

    // Increment miss streak before any hysteresis-gated action.
    _panelAbsentStreak++;

    // UI-clear hysteresis (see PANEL_UI_CLEAR_THRESHOLD comment). Don't
    // wipe the rendered slot rows on a single missed read — detection
    // drops of one tick at a time are normal and shouldn't flicker the
    // display. Only clear after sustained absence.
    if (_lastPartyPanelResult && _lastPartyPanelResult.found &&
        _panelAbsentStreak >= PANEL_UI_CLEAR_THRESHOLD) {
      _lastPartyPanelResult = null;
      renderPartySlots(null);
    }

    // Absence-based auto-clear of self-slot. Only meaningful if we've
    // seen the panel at least once this session — otherwise "no panel"
    // could be solo, plugin-just-booted, or panel never opened, and we
    // shouldn't invalidate cached slot info speculatively.
    if (_panelPresentEverThisSession &&
        !_autoClearedThisAbsence &&
        _panelAbsentStreak >= PANEL_ABSENCE_CLEAR_THRESHOLD &&
        _selfSlotColor !== null) {
      _autoClearedThisAbsence = true;
      const approxSeconds = Math.round(_panelAbsentStreak * PARTY_INTERVAL_TICKS * 0.1);
      clearSelfSlot();
      _loggedMissingTeammatesHint = false;
      dbg('info',
        `Party panel absent ${approxSeconds}s \u2014 assuming party left, `
        + `cleared cached self-slot.`);
    }

    // Sustained panel absence also invalidates the party-size cache.
    // Silent idempotent demote — solo auto-pinning disables until the
    // panel is seen again and a fresh size is observed.
    if (_panelAbsentStreak >= PANEL_ABSENCE_CLEAR_THRESHOLD && _partySize !== 'UNKNOWN') {
      _partySize = 'UNKNOWN';
    }

    const missKey = `NF:${res.reason}:${res.peekCandidates || 0}`;
    if (missKey !== _lastPartyPanelLog) {
      _lastPartyPanelLog = missKey;
      if (res.reason === 'no-valid-red' || res.reason === 'no-red') {
        dbg('miss',
          `party panel: ${res.peekCandidates || 0} red cluster(s), `
          + `${res.candidatesTriedCount || 0} tried, none passed panel-BG verification.`);
        // Per-candidate detail: each red cluster, its BG ratio, and how
        // many of the 5 slot rows below it matched panel-BG.
        const shown = res.candidatesTried || [];
        for (const c of shown) {
          const widthTag = typeof c.width === 'number' ? ` w=${c.width}` : '';
          const reasonTag = c.reason ? ` (${c.reason})` : '';
          dbg('info',
            `  (${c.x},${c.y}) rh=${c.hits}${widthTag} bg=${c.bgRatio}% `
            + `slots=${c.multiSlot}/5${reasonTag}`);
        }
        // "All red clusters" dump — same info source as candidatesTried
        // since we're red-first now, but helpful to see top-K even if
        // some weren't verified.
        if (res.redClusters && res.redClusters.length && shown.length === 0) {
          dbg('info', `  red pixels in scan region (top ${res.redClusters.length}):`);
          for (const rc of res.redClusters) {
            dbg('info', `    (${rc.x},${rc.y}) rh=${rc.hits}`);
          }
        }
      }
    }
    return;
  }

  // Panel present (even if only provisional) → reset absence tracking.
  // A transient detection is still a sign the panel isn't CURRENTLY gone;
  // we don't want the auto-clear-after-30s-absence machinery to fire
  // during brief candidate-flicker periods. Once the detection actually
  // confirms, the state is already reset; if it's a one-tick flash and
  // the next tick is "not found", the absence counter starts from 0
  // again, which is correct.
  _panelPresentEverThisSession = true;
  _panelAbsentStreak = 0;
  _autoClearedThisAbsence = false;

  // Temporal-confirmation gate: the filter chain in partyPanel.js can
  // occasionally pass on a single tick when world geometry randomly
  // aligns with all the signals (real panels produce stable detections,
  // world flukes produce one-tick flashes). Require the current read to
  // match the previous successful read before promoting to "confirmed".
  const currentKey = {
    x: res.origin.x,
    y: res.origin.y,
    filledColors: res.slots.filter(s => s.filled).map(s => s.color).join('|'),
    tick: tickCount,
  };
  if (!panelDetectionMatches(_provisionalPanel, res)) {
    // First time seeing this (or it differs from provisional) — record
    // as new provisional and wait for the next tick to confirm. Don't
    // log or render yet.
    _provisionalPanel = currentKey;
    return;
  }
  // Confirmed — two consecutive matching detections. Update provisional
  // to the current (so subsequent ticks continue to confirm against it).
  _provisionalPanel = currentKey;

  // Cache + render on every successful (confirmed) read. Debug logging
  // is still state-change-deduped below.
  _lastPartyPanelResult = res;
  renderPartySlots(res);

  // Update party-size cache — self-pin reads this. 1 filled slot = solo
  // (self is red by elimination), ≥ 2 = multi-party (needs self-slot
  // detection via detectSelfSlotFromPanel below). Updated every
  // confirmed read so mid-session party join/leave is caught quickly.
  _partySize = res.slots.filter(s => s.filled).length === 1 ? 'SOLO' : 'MULTI';

  // Auto-append readable teammate names to the roster if they're not
  // already there. Runs BEFORE detectSelfSlotFromPanel so the fresh
  // roster is available to the same tick's elimination pass — which
  // means a user who just joined a party with fresh teammates can
  // have their self-slot detected on the very first panel read
  // without any manual roster editing.
  autoPopulateRosterFromPanel(res);

  // Run self-slot detection against the just-read panel. Safe to call
  // every read — it no-ops if roster is empty, primary-match succeeds
  // cheaply on most reads (string compare), and elimination only runs
  // when primary misses. Self-slot cache is only updated when the
  // derived colour changes, so repeated reads don't thrash the store.
  detectSelfSlotFromPanel(res);

  // Found path: dedupe by compact per-slot fingerprint, log only on change.
  const summary = res.slots
    .map(s => s.filled ? `${s.index + 1}:${s.color}` : `${s.index + 1}:empty`)
    .join(' | ');
  if (summary === _lastPartyPanelLog) return;
  _lastPartyPanelLog = summary;

  const filled = res.slots.filter(s => s.filled).length;
  const buttonTag = res.buttonY
    ? ` | button y=${res.buttonY} bh=${res.buttonHits}`
    : '';
  // Label the anchor hits by which detection path produced them, so
  // it's visible when the new bg-text anchor is driving vs. the legacy
  // red-cluster fallback. When the fallback fires, surface WHY the
  // primary path rejected so we can tune / diagnose.
  const methodTag = res.detectionMethod === 'bg-text'
    ? '[bg-text]'
    : (res.detectionMethod === 'red-cluster' ? '[red-cluster]' : '');
  const hitsLabel = res.detectionMethod === 'bg-text' ? 'text h' : 'red h';
  const primaryMissTag = (res.detectionMethod === 'red-cluster' && res.primaryReason)
    ? ` | primary miss: ${res.primaryReason}`
    : '';
  dbg('match',
    `PARTY PANEL ${methodTag}: ${filled}/5 filled — slot1 (${res.origin.x},${res.origin.y}) `
    + `${hitsLabel}=${res.anchorHits} bg=${res.anchorBgRatio}% `
    + `slots=${res.anchorMultiSlot}/5${buttonTag}${primaryMissTag}`);
  for (const s of res.slots) {
    if (!s.filled) {
      dbg('info', `  slot ${s.index + 1}: empty`);
      continue;
    }
    const nameTag = s.name ? ` — "${s.name}"` : ' — (OCR unreadable)';
    dbg('info', `  slot ${s.index + 1}: ${s.color.toUpperCase()}${nameTag}`);
  }
}

// ---- DG map reader (Phase 1b.1 locator) ---------------------------------
// Three-state locator for the RS3 Dungeoneering 8×8 map widget. User
// confirmed: map is user-positionable but players rarely move it once set,
// so the search flow is (a) scan-left-then-full until found, (b) lock to
// a narrow region around the known origin for cheap repeat reads, (c)
// fall back to UNKNOWN if the locked region misses for long enough
// (player moved or closed the map).
//
// Milestone scope is STRICTLY READ-ONLY: debug-log on state transitions /
// geometry changes only. No UI, no tracker dispatch, no door-info wiring.
// Phase 1b.2+ will build on {origin, pitch} reported here.
//
// Cadence 30 ticks at 100ms, offset by 12 ticks from runPartyPanelRead
// (30-tick period too) so the two probes don't land on the same tick
// and stack their captureHoldFullRs calls. 12-tick offset = 1.2s phase.

const DGMAP_INTERVAL_TICKS = 30;
let nextDgTick = 12; // offset from runPartyPanelRead (starts at 0)

// 'UNKNOWN' — haven't located the map yet, or user-invalidated via re-find
// 'LOCKED'  — map found; scan only the narrow region around last origin
// 'LOST'    — was LOCKED, missed for DG_LOST_MISS_THRESHOLD reads; re-scan
//             full screen. Transitions back to UNKNOWN handling.
let _dgState = 'UNKNOWN';
let _dgLocked = null;         // { origin, pitch, cellSize } when state === 'LOCKED'
let _dgMissStreak = 0;        // consecutive LOCKED-state misses
let _lastDgMapLog = null;     // debug-log dedupe — state/geometry-change keyed
// Latest successful DG map snapshot — exposed for cross-module lookups
// (e.g. the solo-pin augmentation in the tick loop needs to resolve a
// triangle's cell when a door-info event fires). Keeps only the fields
// the consumer needs; updated each time findDgMap succeeds.
let _latestDgMap = null;      // { origin, pitch, cells } or null
let _latestDgMapAt = 0;       // Date.now() when _latestDgMap was last set

// Staleness threshold for using _latestDgMap as a solo-pin fallback when
// the fresh capture fails (widget closed, DC, transient occlusion, or
// any reason runDgMapRead's regular tick-loop capture also hasn't updated
// the cache recently). Regular reads run every 5 ticks (~3s). A 30s
// gate covers the case where both fresh AND the ongoing tick capture
// briefly stumble — without this, the user would have to re-info a
// door that fell into that window. 30s is still short enough to
// exclude stale pins after deliberate long pauses (map closed, DC).
const DG_MAP_CACHE_STALE_MS = 30_000;

// ---- Opt-in: chat-timestamp-matched triangle snapshot buffer -------------
// Runs when settings.timestampedChat is true. Captures a lightweight
// trianglePx reading every TRIANGLE_SNAPSHOT_INTERVAL_TICKS into a ring
// buffer; on a door-info event, the solo-pin code looks up the snapshot
// closest to the chat line's [HH:MM:SS] in-game timestamp (converted to
// ms epoch) and uses THAT triangle position for the pin — bypassing the
// info→OCR→teleport race where fresh findDgMap sees the post-teleport
// state instead of the info-time state.
//
// Cadence: 3 ticks × 100ms = 300ms sampling; 30-entry ring = ~9s of
// history. OCR lag observed at ±1-2s, so 9s is comfortable headroom.
// Max-delta clamp (5s) prevents matching to a wildly-off snapshot if
// something goes wrong — fall through to the non-timestamped tiers.
//
// Zero overhead when settings.timestampedChat is false: the tick hook
// returns early, no buffer writes, no findTrianglePx calls.
//
// Tracks the USER'S OWN triangle position — getSelfColor() is consulted
// per snapshot so the sampled colour matches whichever slot the user is
// in (red in solo, or detected self-slot colour in multi). Skips
// entirely when self-slot is unknown (multi-party pre-detection).
const TRIANGLE_SNAPSHOT_INTERVAL_TICKS = 3;
const TRIANGLE_SNAPSHOT_BUFFER_SIZE = 30;
const TRIANGLE_SNAPSHOT_MAX_DELTA_MS = 5000;
let _triangleSnapshots = [];
let _nextTriangleSnapshotTick = 0;

function runTriangleSnapshot() {
  if (!settings.timestampedChat) return;
  if (!window.alt1 || !alt1.permissionPixel) return;
  if (!calibration.dgMap) return;
  if (tickCount < _nextTriangleSnapshotTick) return;
  _nextTriangleSnapshotTick = tickCount + TRIANGLE_SNAPSHOT_INTERVAL_TICKS;

  const selfColor = getSelfColor();
  if (!selfColor) return;

  let trianglePx = null;
  try { trianglePx = findTrianglePx({ region: calibration.dgMap, color: selfColor }); }
  catch (_) { trianglePx = null; }
  if (!trianglePx) return;

  _triangleSnapshots.push({
    atMs: Date.now(),
    trianglePx: { x: trianglePx.x, y: trianglePx.y },
    count: trianglePx.count,
  });
  if (_triangleSnapshots.length > TRIANGLE_SNAPSHOT_BUFFER_SIZE) {
    _triangleSnapshots.shift();
  }
}

// Parse an RS3 chat timestamp ("HH:MM:SS") into ms epoch using today's
// local date. Handles the midnight-wrap case where the chat line was
// logged just before midnight but we're now just after — if the
// computed time is more than 60s in the future, it belongs to
// yesterday. Returns null if the input doesn't parse.
function chatTsToEpoch(hhmmss) {
  if (typeof hhmmss !== 'string') return null;
  const m = hhmmss.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const s = parseInt(m[3], 10);
  if (h > 23 || mm > 59 || s > 59) return null;
  const now = new Date();
  const candidate = new Date(
    now.getFullYear(), now.getMonth(), now.getDate(), h, mm, s, 0
  );
  let candidateMs = candidate.getTime();
  if (candidateMs > Date.now() + 60_000) candidateMs -= 86_400_000;
  return candidateMs;
}

// Find the snapshot whose atMs is closest to targetMs, within the
// max-delta clamp. Returns null if the buffer is empty or the closest
// snapshot is too far off. Attached delta is exposed for logging so
// the user can tell how tight the match was.
function findClosestTriangleSnapshot(targetMs, maxDeltaMs = TRIANGLE_SNAPSHOT_MAX_DELTA_MS) {
  if (_triangleSnapshots.length === 0) return null;
  let best = null;
  let bestDelta = Infinity;
  for (const snap of _triangleSnapshots) {
    const delta = Math.abs(snap.atMs - targetMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = snap;
    }
  }
  if (!best || bestDelta > maxDeltaMs) return null;
  return { ...best, deltaMs: bestDelta };
}
// Fingerprint of the last logged cell-contents classification. Updates only
// when a cell actually changes (player moved rooms, new room opened, boss
// revealed, etc.). Keeps the per-tick cell log silent on stable reads.
let _lastDgCellsFingerprint = null;

// Threshold for LOCKED → LOST transition. 6 misses × 30 ticks × 100 ms ≈ 18s
// — absorbs brief occlusions (loot windows, other UI overlays on top of
// the map) without re-running the expensive full-screen scan on every
// blip. If the user actually moved/closed the map, the 18s delay is
// acceptable before we notice and switch to full-screen search.
const DG_LOST_MISS_THRESHOLD = 6;

function _dgFullScreenRegion(screen) {
  return { x: 0, y: 0, w: screen.width, h: screen.height };
}

// Locked scan region covers the full 8×8 grid (8 × pitch) plus a margin
// for map drift / rendering jitter. Recomputed from the last confirmed
// origin each tick so it tracks any small shifts.
function _dgLockedRegion(origin, pitch) {
  const margin = 40;
  const gridSpan = 8 * pitch;
  return {
    x: Math.max(0, origin.x - margin),
    y: Math.max(0, origin.y - margin),
    w: gridSpan + margin * 2,
    h: gridSpan + margin * 2,
  };
}

function runDgMapRead() {
  if (!window.alt1 || !alt1.permissionPixel) return;
  if (tickCount < nextDgTick) return;
  nextDgTick = tickCount + DGMAP_INTERVAL_TICKS;

  let screen;
  try { screen = a1lib.captureHoldFullRs(); }
  catch (_) { return; }
  if (!screen) return;

  let res;
  // Calibrated region takes precedence over the UNKNOWN→LOCKED→LOST state
  // machine — user has told us exactly where to look, no need to search
  // or maintain a runtime lock. State machine below handles the
  // uncalibrated fallback (auto-find on left half, then full screen).
  if (calibration.dgMap) {
    res = findDgMap({ screen, region: calibration.dgMap, classifyCells: true });
    if (!res.found) {
      // Calibrated region didn't yield a map. User has probably closed
      // the map widget or moved it out of the calibrated box. Log on
      // state transition only (same dedupe pattern as other misses) and
      // return — don't fall through to the geometry log which expects
      // a found result.
      const missKey = `NF:cal:${res.reason}`;
      if (missKey !== _lastDgMapLog) {
        _lastDgMapLog = missKey;
        dbg('miss',
          `dgMap [calibrated]: ${res.reason} `
          + `(clusters=${res.clusters || 0} hits=${res.hitCount || 0})`);
        // When the reason is no-pitch, dump a cluster sample so we can
        // see why derivePitch couldn't converge (over-splitting, world-
        // pixel false positives, genuinely non-grid layout, etc.).
        if (res.reason === 'no-pitch' && Array.isArray(res.clusterSample)) {
          for (const c of res.clusterSample) {
            dbg('info',
              `  cluster @ (${c.x},${c.y}) hits=${c.count} ${c.w}×${c.h}`);
          }
        }
      }
      return;
    }
    // Reflect in state bookkeeping so debug logs and any future code
    // that peeks at _dgState reads sensibly.
    _dgState = 'LOCKED';
    _dgLocked = { origin: res.origin, pitch: res.pitch, cellSize: res.cellSize };
    _dgMissStreak = 0;
  } else if (_dgState === 'LOCKED' && _dgLocked) {
    // Cheap path: narrow region around known origin.
    const region = _dgLockedRegion(_dgLocked.origin, _dgLocked.pitch);
    res = findDgMap({ screen, region, classifyCells: true });
    if (!res.found) {
      _dgMissStreak++;
      if (_dgMissStreak >= DG_LOST_MISS_THRESHOLD) {
        _dgState = 'LOST';
        _dgLocked = null;
        _dgMissStreak = 0;
        const transitionKey = 'state:LOST';
        if (_lastDgMapLog !== transitionKey) {
          _lastDgMapLog = transitionKey;
          dbg('info',
            `dgMap: LOCKED → LOST after ${DG_LOST_MISS_THRESHOLD} misses; `
            + `full-screen re-scan from next tick.`);
        }
      }
      return;
    }
    // LOCKED + found: update cached origin (tracks minor drift) and carry on.
    _dgMissStreak = 0;
    _dgLocked = {
      origin: res.origin,
      pitch: res.pitch,
      cellSize: res.cellSize,
    };
  } else {
    // UNKNOWN or LOST: left-half scan first, full-screen fallback if miss.
    // No explicit region → findDgMap uses its defaultLeftRegion.
    res = findDgMap({ screen, classifyCells: true });
    if (!res.found) {
      res = findDgMap({ screen, region: _dgFullScreenRegion(screen), classifyCells: true });
    }
    if (!res.found) {
      // Silent most of the time — map is closed or off-screen. Log only
      // on transitions (e.g., first miss after being LOCKED).
      const missKey = `NF:${res.reason}`;
      if (missKey !== _lastDgMapLog) {
        _lastDgMapLog = missKey;
        dbg('miss',
          `dgMap: ${res.reason} `
          + `(clusters=${res.clusters || 0} hits=${res.hitCount || 0})`);
      }
      return;
    }
    // Found — transition to LOCKED.
    const wasState = _dgState;
    _dgState = 'LOCKED';
    _dgLocked = {
      origin: res.origin,
      pitch: res.pitch,
      cellSize: res.cellSize,
    };
    _dgMissStreak = 0;
    dbg('match',
      `dgMap: ${wasState} → LOCKED at (${res.origin.x},${res.origin.y}) `
      + `pitch=${res.pitch} cells=${res.clusters} support=${res.support}`);
  }

  // Snapshot the latest successful DG map read for cross-module lookups.
  // The solo-pin logic in the tick loop reads this to resolve the local
  // player's current cell when a door-info event fires. Only the fields
  // a consumer might need are retained; full intermediate state stays
  // local to findDgMap.
  _latestDgMap = {
    origin: res.origin,
    pitch: res.pitch,
    cells: res.cells || {},
  };
  _latestDgMapAt = Date.now();

  // Geometry-change-dedup log: only emit when origin, pitch, or
  // cell-bbox actually changed vs the previous logged value. Clusters
  // count is deliberately NOT in the dedup key — it flickers ±1 tick-
  // to-tick when a boundary pixel crosses the MIN_CLUSTER_HITS threshold
  // (classifier sometimes catches it, sometimes doesn't), and including
  // it re-fired this line every 3 seconds on perfectly stable reads.
  // Real exploration progress always shifts origin or cellSize too, so
  // those events still re-fire through this key.
  const geomKey =
    `geom:${res.origin.x},${res.origin.y}|p=${res.pitch}` +
    `|cs=${res.cellSize.w}x${res.cellSize.h}`;
  if (geomKey !== _lastDgMapLog) {
    _lastDgMapLog = geomKey;
    dbg('info',
      `  origin=(${res.origin.x},${res.origin.y}) pitch=${res.pitch} `
      + `cellSize=${res.cellSize.w}×${res.cellSize.h} clusters=${res.clusters} `
      + `support=${res.support}/${res.totalPairs}`);
  }

  // Cell-contents log (Phase 1b.3). Dedupe via a compact fingerprint
  // of the full cell state so we only log when SOMETHING changes (a
  // player moved rooms, a new room opened, etc.). Silent on stable
  // reads to keep the debug panel readable.
  if (res.cells) {
    const cellKeys = Object.keys(res.cells).sort();
    const fingerprint = cellKeys.map(k => {
      const c = res.cells[k];
      const icons =
        (c.hasLadder ? 'L' : '') +
        (c.hasBoss   ? 'B' : '') +
        (c.hasQGlyph ? 'Q' : '');
      const tris = [...c.triangles].sort().join('');
      return `${k}:${c.type[0]}${icons}${tris}`;
    }).join(';');
    if (fingerprint !== _lastDgCellsFingerprint) {
      _lastDgCellsFingerprint = fingerprint;
      dbg('info', `  cells (${cellKeys.length}):`);
      for (const k of cellKeys) {
        const c = res.cells[k];
        const icons = [];
        if (c.hasLadder) icons.push('LADDER');
        if (c.hasBoss)   icons.push('BOSS');
        if (c.hasQGlyph) icons.push('?glyph');
        const tris = c.triangles.size > 0 ? [...c.triangles].sort().join(',') : '';
        const triTag = tris ? ` triangles=[${tris}]` : '';
        const iconTag = icons.length ? ` icons=[${icons.join(',')}]` : '';
        dbg('info', `    (${c.col.toString().padStart(2)},${c.row.toString().padStart(2)}): ${c.type}${iconTag}${triTag}`);
      }
    }
  }
}

function tick() {
  tickCount++;
  const pixelPerm = !!(window.alt1 && alt1.permissionPixel);
  const nud = window.__dkt_nudge || { calls: 0, hits: 0 };
  // Alternate 1/2 each tick — a visible metronome the user times movements against.
  const beat = ((tickCount - 1) % 2) + 1;
  setDebugStats(
    String(beat),
    `tick ${tickCount} | alt1=${!!window.alt1} pixel=${pixelPerm} pos=${reader && reader.pos ? 'yes' : 'no'} | nudge ${nud.hits}/${nud.calls}`
  );
  if (tickCount === 1 || tickCount % 20 === 0) {
    console.log('[dkt] tick', tickCount,
      'alt1?', !!window.alt1,
      'pixelPerm?', pixelPerm,
      'readerPos?', (reader && reader.pos));
  }
  if (!window.alt1) {
    renderStatus('Not running inside Alt1. Open Alt1 and install this app via appconfig.json.');
    if (tickCount === 1) {
      console.warn('[dkt] window.alt1 not present — not running inside Alt1 browser?');
      dbg('error', 'window.alt1 missing — not in Alt1 browser');
    }
    return;
  }
  if (!alt1.permissionPixel && !warnedNoPixel) {
    console.warn('[dkt] alt1.permissionPixel reports FALSE — attempting capture anyway.');
    dbg('info', 'permissionPixel=false — trying capture anyway');
    warnedNoPixel = true;
  }

  if (!reader) {
    setupReader();
    dbg('info', `reader created with ${reader.readargs.colors.length} colours`);
  }

  if (!reader.pos) {
    let found = null;
    try {
      found = reader.find();
    } catch (e) {
      renderStatus('Chatbox find() threw — likely missing pixel permission. Right-click the app icon in Alt1 \u2192 Permissions \u2192 grant Pixel.');
      console.warn('[dkt] reader.find() threw', e);
      dbg('error', 'find() threw: ' + (e && e.message ? e.message : e));
      return;
    }
    if (!found) {
      renderStatus('Looking for chatbox\u2026 make sure RS chat is visible on screen.');
      if (tickCount % 10 === 0) dbg('miss', 'find() returned null — chatbox not located');
      return;
    }
    renderStatus('Chatbox found. Tracking.');
    console.log('[dkt] chatbox found at', reader.pos);
    if (!loggedFound) {
      dbg('info', 'chatbox found at ' + JSON.stringify(reader.pos));
      loggedFound = true;
    }
    setTimeout(() => renderStatus(''), 1500);
  }

  let lines;
  try {
    lines = reader.read() || [];
  } catch (e) {
    console.warn('[dkt] chatbox read failed', e);
    dbg('error', 'read() threw: ' + (e && e.message ? e.message : e));
    renderStatus('Chatbox read failed: ' + (e && e.message ? e.message : e));
    return;
  }

  if (lines.length > 0) {
    console.log(`[dkt] read() returned ${lines.length} line(s):`);
    for (const line of lines) {
      console.log('[dkt]   raw:', JSON.stringify(line.text));
    }
  }

  for (const line of lines) {
    const sig = signatureOf(line);
    if (seenLines.has(sig)) continue;
    seenLines.add(sig);

    // Always show every new line in the debug panel — keeps a visible OCR feed.
    dbg('raw', 'OCR: ' + (line.text || '(empty)'));
    // For lines we care about — dump the per-fragment colours so we can see
    // which colours the reader is identifying and which it's missing. Three
    // triggers:
    //   (a) line mentions key/door keywords (direct interest)
    //   (b) short lines (<25 chars) — usually truncations, useful colour info
    //   (c) punctuation-heavy lines (>30% non-alphanumeric) — these are the
    //       "party found/used a key" broadcast lines when glyph detection
    //       goes wrong. Their TEXT doesn't contain "key" any more (the word
    //       got garbled), but their FRAG COLOURS are exactly what we need to
    //       see in order to debug the palette / font mismatch.
    const alphaNum = (line.text.match(/[A-Za-z0-9]/g) || []).length;
    const punctRatio = line.text.length > 0
      ? 1 - (alphaNum / line.text.length)
      : 0;
    const wantsFragDump =
      line.text && (
        /required|found|used|key|party/i.test(line.text) ||
        line.text.length < 25 ||
        (line.text.length >= 12 && punctRatio > 0.3)
      );
    if (wantsFragDump && line.fragments) {
      const fragSummary = line.fragments
        .map(f => `"${f.text}"[${(f.color || []).join(',')}]`)
        .join(' | ');
      dbg('info', '  frags: ' + fragSummary);
    }

    // Pass the whole line object — parser.js reads fragment colours to
    // extract the username on door-info lines (titles and clan icons share
    // fragments with the name, so text-regex splitting can't isolate it).
    const ev = parseChatLine(line);

    // Semantic-level dedupe. Line-level dedupe (seenLines) keys on text +
    // fragment colour sequence, which IS NOT stable across re-reads of the
    // same chat line — OCR scanning at drifting baselines produces
    // different fragment breakdowns for the same logical message. Those
    // slip past seenLines → reach parser → emit the same semantic event a
    // 2nd or 3rd time. Previously this was silently adding phantom history
    // entries (same key showing up 3× in the Previous Floor Keys panel,
    // with 0:00 deltas / "never used"). Keying on (chat-timestamp + event
    // type + colour + shape + player) catches this: re-reads of the same
    // event share the key and dedupe. Two genuinely different events can't
    // share all four components at the same in-game second.
    if (ev) {
      const semKey = semanticEventKey(line, ev);
      if (semKey && seenEvents.has(semKey)) continue;
      if (semKey) seenEvents.add(semKey);
    }

    if (ev) {
      console.log('[dkt] MATCHED event:', ev);
      // Floor lifecycle events go to floor.js (their own state machine) —
      // the key/door tracker has no use for them. Everything else continues
      // down the tracker dispatch path.
      if (ev.type === 'floor-start') {
        const { isNew } = floor.floorStart();
        const numTag = typeof ev.floorNumber === 'number' ? ` (game floor ${ev.floorNumber})` : '';
        if (isNew) {
          tracker.handleEvent({ type: 'floor-reset' });
          dbg('match', `FLOOR START${numTag} \u2014 floor #${floor.count()} begins`);
        } else {
          dbg('info', `floor-start${numTag}: duplicate banner ignored (same floor already active).`);
        }
      } else if (ev.type === 'floor-end') {
        // Three-tier floor-end system, routed by `reason`:
        //   Tier 1 (primary)     winterface probe   — closes floor AND captures timer.
        //   Tier 2 (fallback)    outfit bonus line  — closes floor, no timer.
        //   Tier 3 (absolute)    leave-party line   — closes any open floor unconditionally,
        //                                             and wipes tracker state.
        // If the floor is already ended by an earlier tier, redundant end
        // signals are ignored rather than noisily reporting "no floor".
        const reason = ev.reason || 'outfit';
        const cur = floor.current();
        if (reason === 'leave-party') {
          if (cur && !cur.ended) {
            floor.floorEnd();
            dbg('match', `FLOOR END (leave-party) \u2014 floor #${floor.count()} closed on party leave.`);
            tracker.handleEvent({ type: 'floor-end' });
          } else {
            dbg('info', 'floor-end (leave-party): no active floor to close.');
          }
          tracker.handleEvent({ type: 'floor-reset' });
          // Leave-party is the definitive signal that the self-slot
          // mapping is stale: the party the user was in is gone, and
          // whoever joins next (solo, same team re-forming, new team)
          // may put the user in a different slot colour. Clearing the
          // cache forces re-detection on the first panel read of the
          // next party.
          const cleared = clearSelfSlot();
          if (cleared > 0) {
            dbg('info', 'Cleared cached self-slot on leave-party.');
          }
          _loggedMissingTeammatesHint = false;
        } else if (!cur) {
          dbg('miss', 'floor-end (outfit): no floor in log \u2014 plugin started mid-dungeon?');
        } else if (cur.ended) {
          dbg('info', 'floor-end (outfit): already closed via winterface probe, ignoring.');
        } else {
          floor.floorEnd();
          dbg('match', `FLOOR END (outfit, no timer) \u2014 floor #${floor.count()} closed; probe winterface before the outfit line to record a timer.`);
          tracker.handleEvent({ type: 'floor-end' });
        }
      } else {
        // Raw player flows through to the tracker unchanged; the UI does
        // alias-map lookup + fuzzy fallback at render time so changes
        // propagate to already-rendered rows.
        const summary = ev.color && ev.shape
          ? `${ev.color} ${ev.shape}`
          : '(no colour/shape)';
        const fuzzyTag = ev.fuzzy ? ' [fuzzy]' : '';
        // Resolve the "by X" debug label through aliasMap (signature
        // binding) first, then fall back to the raw OCR player text.
        // Keeps the debug log in sync with the rendered UI (displayPlayer
        // uses the same lookup).
        let byName = ev.player;
        if (ev.playerSignature && aliasMap[ev.playerSignature]) {
          byName = aliasMap[ev.playerSignature];
        }
        const slotTag = ev.slotColor ? ` [slot:${ev.slotColor}]` : '';
        dbg('match',
          `MATCH ${ev.type}: ${summary}${fuzzyTag}` + (byName ? ` by ${byName}${slotTag}` : ''));

        // Self-pin augmentation (door → map linkage). Attaches
        // cellCoords / cellPx / trianglePx to events that originated
        // from the LOCAL user, so the Alt1 overlay renders a pin at the
        // cell the user info'd. Teammate events skip this block — they
        // still flow through the tracker and appear in the UI Doors
        // list, they just don't get overlay pins (there's no reliable
        // cross-client triangle position for teammates).
        //
        // Attribution: solo = trivially self (only one actor). Multi =
        // isSelfEvent() requires signature → roster[0] binding in
        // aliasMap (user sets once via click-player-pill, stable per-
        // client-per-player). See isSelfEvent docstring.
        //
        // Map triangle colour: solo = 'red' (only triangle on screen).
        // Multi = detected self-slot colour from RoK panel name OCR +
        // elimination matching against partyRoster. See getSelfColor /
        // detectSelfSlotFromPanel. If unknown in multi, we skip the
        // block (pin not placeable, but event still tracks in UI).
        //
        // Four-tier triangle-finding cascade (each tier runs only if
        // previous didn't yield a usable triangle):
        //   0. Timestamp-matched snapshot (opt-in via
        //      settings.timestampedChat) — bypasses info→teleport race.
        //   1. Fresh findDgMap with cell classification — refreshes
        //      _latestDgMap cache as side-effect.
        //   2. Direct findTrianglePx for the self-colour — closes the
        //      gap where cell classification undershoots TRIANGLE_MIN_
        //      PIXELS for the self triangle.
        //   3. Cached _latestDgMap — last resort, 30s staleness gate.
        if (ev.type === 'door-info' && isSelfEvent(ev)) {
          const selfColor = getSelfColor();

          // Multi-party without detected self-slot: surface a one-shot
          // hint if the roster has only the user (elimination is
          // impossible). Otherwise silently wait for the next panel
          // read to resolve self-slot. Either way, skip this event's
          // augmentation — can't pin without knowing which triangle
          // is the user's.
          if (!selfColor) {
            if (_partySize === 'MULTI' && !_loggedMissingTeammatesHint) {
              _loggedMissingTeammatesHint = true;
              const n = partyRoster.length;
              if (n <= 1) {
                dbg('miss',
                  'multi-party self-pin: self-slot unknown. Roster has ' +
                  `${n} entry — add teammate names to the Party input for ` +
                  'elimination-based detection.');
              } else {
                dbg('miss',
                  'multi-party self-pin: self-slot unknown yet. Will resolve ' +
                  'on next RoK panel read once teammate names match roster.');
              }
            }
          } else {
          let cells = null;
          let searchSource = 'none';
          let bestCell = null;
          let bestTriCount = 0;
          let runnerUpTriCount = 0;
          let tsMatchedPx = null;  // tier-0 hit: historical trianglePx

          // Iterate a cells map and update bestCell / bestTriCount /
          // runnerUpTriCount for the SELF colour. Hoisted so tier 1
          // (fresh) and tier 3 (cache) share logic.
          const searchForSelfTriangle = (cellsMap) => {
            for (const key in cellsMap) {
              const cell = cellsMap[key];
              if (!cell.triangles || !cell.triangles.has(selfColor)) continue;
              const triCount = (cell.counts && cell.counts[selfColor]) || 0;
              if (triCount > bestTriCount) {
                runnerUpTriCount = bestTriCount;
                bestCell = cell;
                bestTriCount = triCount;
              } else if (triCount > runnerUpTriCount) {
                runnerUpTriCount = triCount;
              }
            }
          };

          // Tier 0: timestamp-matched historical snapshot (opt-in).
          if (settings.timestampedChat) {
            const chatTs = extractChatTs(line);
            const targetMs = chatTs ? chatTsToEpoch(chatTs) : null;
            if (targetMs !== null) {
              const snap = findClosestTriangleSnapshot(targetMs);
              if (snap) {
                tsMatchedPx = {
                  x: snap.trianglePx.x,
                  y: snap.trianglePx.y,
                  count: snap.count,
                  deltaMs: snap.deltaMs,
                };
                searchSource = 'timestamp-match';
              }
            }
          }

          // Tier 1: fresh findDgMap. Refreshes _latestDgMap cache on
          // success regardless of whether we use its cells here.
          if (!tsMatchedPx) {
            try {
              const fresh = findDgMap({ region: calibration.dgMap, classifyCells: true });
              if (fresh.found && fresh.cells) {
                cells = fresh.cells;
                searchSource = 'fresh';
                _latestDgMap = { origin: fresh.origin, pitch: fresh.pitch, cells: fresh.cells };
                _latestDgMapAt = Date.now();
              }
            } catch (_) { /* fall through */ }

            if (cells) {
              searchForSelfTriangle(cells);
            }
          }

          // Tier 2: direct triangle scan for the SELF colour. Closes
          // the gap where per-cell classification undershoots
          // TRIANGLE_MIN_PIXELS for the self triangle.
          let directScanTrianglePx = null;
          if (!tsMatchedPx && !bestCell) {
            try { directScanTrianglePx = findTrianglePx({ region: calibration.dgMap, color: selfColor }); }
            catch (_) { directScanTrianglePx = null; }
          }

          // Tier 3: cache. Only when tiers 0, 1, 2 all failed.
          if (!tsMatchedPx && !bestCell && !directScanTrianglePx &&
              _latestDgMap && _latestDgMap.cells &&
              (Date.now() - _latestDgMapAt) < DG_MAP_CACHE_STALE_MS) {
            cells = _latestDgMap.cells;
            searchSource = 'cached';
            bestCell = null;
            bestTriCount = 0;
            runnerUpTriCount = 0;
            searchForSelfTriangle(cells);
          }

          // Shared helper: populate ev.cellCoords / ev.cellPx /
          // ev.trianglePx from a bare trianglePx when the cells map
          // isn't available (tier 0 / tier 2).
          const applyFromTrianglePx = (tpx) => {
            ev.trianglePx = { x: tpx.x, y: tpx.y };
            if (_latestDgMap && _latestDgMap.origin && _latestDgMap.pitch) {
              const pitch = _latestDgMap.pitch;
              const ox = _latestDgMap.origin.x;
              const oy = _latestDgMap.origin.y;
              const col = Math.floor((tpx.x - ox) / pitch);
              const row = Math.floor((tpx.y - oy) / pitch);
              ev.cellCoords = { col, row };
              ev.cellPx = {
                cx: ox + col * pitch + pitch / 2,
                cy: oy + row * pitch + pitch / 2,
                pitch,
              };
            } else {
              const bucket = 20;
              ev.cellCoords = {
                col: Math.round(tpx.x / bucket),
                row: Math.round(tpx.y / bucket),
              };
              ev.cellPx = { cx: tpx.x, cy: tpx.y, pitch: 30 };
            }
          };

          // Sanity gate: top cell must beat runner-up by ≥2 triangle
          // pixels. Weak/tied detections produce wrong pins; silent
          // non-firing is preferred. Accuracy-over-heuristics.
          const MIN_MARGIN = 2;
          if (tsMatchedPx) {
            applyFromTrianglePx(tsMatchedPx);
            bestTriCount = tsMatchedPx.count;
          } else if (bestCell && (bestTriCount - runnerUpTriCount) >= MIN_MARGIN) {
            ev.cellCoords = { col: bestCell.col, row: bestCell.row };
            const frame = _latestDgMap;
            ev.cellPx = {
              cx: frame.origin.x + bestCell.col * frame.pitch + frame.pitch / 2,
              cy: frame.origin.y + bestCell.row * frame.pitch + frame.pitch / 2,
              pitch: frame.pitch,
            };
            if (bestCell.triangleCentroids && bestCell.triangleCentroids[selfColor]) {
              ev.trianglePx = {
                x: bestCell.triangleCentroids[selfColor].x,
                y: bestCell.triangleCentroids[selfColor].y,
              };
            }
          } else if (directScanTrianglePx) {
            searchSource = 'triangle-scan';
            applyFromTrianglePx(directScanTrianglePx);
            bestTriCount = directScanTrianglePx.count;
          }

          if (ev.cellCoords) {
            const px = ev.cellPx;
            const deltaTag = tsMatchedPx ? ` Δt=${tsMatchedPx.deltaMs}ms` : '';
            dbg('info',
              `  pinned to cell (${ev.cellCoords.col}, ${ev.cellCoords.row}) ` +
              `cx=${px.cx.toFixed(1)} cy=${px.cy.toFixed(1)} p=${px.pitch} ` +
              `${selfColor}=${bestTriCount} (runner-up ${runnerUpTriCount}) [${searchSource}]${deltaTag}`);
          } else if (bestTriCount > 0 && bestTriCount - runnerUpTriCount < 2) {
            dbg('miss',
              `  self pin: ambiguous (top ${selfColor}=${bestTriCount}, runner-up=${runnerUpTriCount}, ` +
              `need 2+ margin) — door unpinned`);
          } else {
            // All tiers failed. Dump the top-3 cells by self-colour
            // count from whichever cells map we last looked at.
            const age = _latestDgMap
              ? Math.round((Date.now() - _latestDgMapAt) / 1000) + 's'
              : 'never';
            const checkCells = cells || {};
            const topCells = Object.values(checkCells)
              .map(c => ({ col: c.col, row: c.row, cnt: (c.counts && c.counts[selfColor]) || 0 }))
              .sort((a, b) => b.cnt - a.cnt)
              .slice(0, 3);
            const topStr = topCells.length
              ? topCells.map(t => `(${t.col},${t.row})=${t.cnt}`).join(' ')
              : 'no cells scanned';
            dbg('miss',
              `  self pin: all tiers failed — fresh+triangle-scan+cache(${age}) empty. ` +
              `Top-3 ${selfColor} counts in ${searchSource === 'none' ? 'cache' : searchSource}: ${topStr}`);
          }
          }
        }

        ev.at = Date.now();
        tracker.handleEvent(ev);
      }
    } else if (line.text && /key|door|unlockable|required|welcome|boosts/i.test(line.text)) {
      console.log('[dkt] line looked interesting but did not parse:', JSON.stringify(line.text));
      dbg('miss', 'interesting line, no regex hit: ' + line.text);
    }
  }

  // Keep the seen sets from growing forever.
  if (seenLines.size > 500) {
    const arr = Array.from(seenLines);
    seenLines.clear();
    arr.slice(-250).forEach(s => seenLines.add(s));
  }
  if (seenEvents.size > 500) {
    const arr = Array.from(seenEvents);
    seenEvents.clear();
    arr.slice(-250).forEach(s => seenEvents.add(s));
  }

  // Auto-probe runs AFTER chat processing so floor-start events fired this
  // tick have already been applied to `floor.current()` by the time the
  // probe reads it.
  runAutoWinterfaceProbe();

  // Party panel reader (milestone A: debug-log only, no state mutation).
  runPartyPanelRead();

  // DG map reader (Phase 1b.1: debug-log only, three-state locator).
  runDgMapRead();

  // Opt-in: lightweight triangle snapshot for chat-timestamp matching.
  // No-ops when settings.timestampedChat is false.
  runTriangleSnapshot();

  // Alt1 overlay pins (Phase 4 proper integration). Iterates every door
  // in the tracker with attached cellCoords and renders a coloured key
  // glyph at that cell on the RS3 map widget. Pinning is driven by the
  // chat event path — see the solo-pin logic inside the door-info
  // dispatch above, which attaches cellCoords to events that fire in
  // solo mode. Tracker holds the pin until the matching key is used,
  // so overlay follows the tracker's state automatically.
  drawPinnedOverlays();
}

// Refresh the overlay's frozen origin/pitch anchor only when new map
// data has arrived AND drift exceeds the widget-move thresholds.
// Called from drawPinnedOverlays so anchor setup is co-located with
// draw logic.
function ensureOverlayAnchor() {
  if (!_latestDgMap) return;
  if (!_overlayMapAnchor) {
    _overlayMapAnchor = {
      origin: { x: _latestDgMap.origin.x, y: _latestDgMap.origin.y },
      pitch: _latestDgMap.pitch,
    };
    dbg('info',
      `overlay: map anchor set origin=(${_latestDgMap.origin.x},${_latestDgMap.origin.y}) ` +
      `pitch=${_latestDgMap.pitch}`);
    return;
  }
  const dx = Math.abs(_latestDgMap.origin.x - _overlayMapAnchor.origin.x);
  const dy = Math.abs(_latestDgMap.origin.y - _overlayMapAnchor.origin.y);
  const dp = Math.abs(_latestDgMap.pitch - _overlayMapAnchor.pitch);
  if (dx > OVERLAY_ANCHOR_REFRESH_ORIGIN_PX ||
      dy > OVERLAY_ANCHOR_REFRESH_ORIGIN_PX ||
      dp > OVERLAY_ANCHOR_REFRESH_PITCH_PX) {
    _overlayMapAnchor = {
      origin: { x: _latestDgMap.origin.x, y: _latestDgMap.origin.y },
      pitch: _latestDgMap.pitch,
    };
    // Invalidate every cached cell position — the coordinate system
    // just shifted. Next draw per cell recomputes.
    _overlayPosCache.clear();
    dbg('info',
      `overlay: map anchor refreshed (drift dx=${dx} dy=${dy} dp=${dp}) ` +
      `new origin=(${_latestDgMap.origin.x},${_latestDgMap.origin.y}) pitch=${_latestDgMap.pitch}`);
  }
}

// Compute screen coords for an icon drawn at a specific slot in a cell.
//
// Slot layout (icons positioned around the RED triangle's expected
// top-left-of-cell location, regardless of the USER's actual slot —
// see anchor rule below):
//   slot 0 → east  (right of anchor; first door)
//   slot 1 → SE    (bottom-right; second door)
//   slot 2 → south (bottom-centre; third door)
//   slot 3 → NE fallback (extremely rare 4-doors-in-one-room case)
//
// Anchor rule:
//   - RED self-slot (solo, or multi slot 1): anchor on actual
//     trianglePx. Red always renders at cell top-left on the DG map
//     widget, so the real centroid matches the slot-layout design and
//     gives pixel-perfect positioning (confirmed by user 2026-04-24).
//   - NON-RED self-slot (multi, user is slot 2-5): RS3 renders each
//     slot's triangle at a DIFFERENT sub-cell position (teal/lime/
//     yellow/pale have their own conventional offsets to avoid
//     overlap when multiple players share a cell). If we anchored on
//     the actual non-red trianglePx, icons would drift to different
//     cell-relative spots based on which slot the user is in. Fix:
//     synthesize where RED would be (cell top-left area, ~pitch/3
//     NW of cell centre) so icons always land in the same cell-
//     relative position, matching the "always as if red" semantic
//     the user explicitly requested.
//
// Cache key includes selfColor so red and non-red positions for the
// same (cell, slot) stay separate entries (correct independently).
function computeOverlaySlotPos(cellPx, trianglePx, cellKey, slot, selfColor) {
  const key = `${cellKey}|${slot}|${selfColor || 'none'}`;
  const cached = _overlayPosCache.get(key);
  if (cached) return cached;

  const { pitch } = cellPx;
  let ax, ay;
  if (selfColor === 'red' && trianglePx) {
    ax = trianglePx.x;
    ay = trianglePx.y;
  } else {
    // Synthetic red-triangle-position: ~pitch/3 NW of cell centre.
    // Red triangle sprite sits at cell top-left; its centroid is
    // ~5-8 px inside the corner. At pitch 30 this formula yields
    // (cx-10, cy-10) which matches actual-red trianglePx to within
    // ~1 px, so the red case stays perfect and non-red users get
    // that same effective anchor.
    ax = cellPx.cx - pitch / 3;
    ay = cellPx.cy - pitch / 3;
  }

  // Offset from the anchor: needs to clear the triangle sprite itself
  // (about 8-10 px wide at typical pitches) plus the icon's half width
  // (8 px) plus a small gap. 15 px east puts the icon's left edge
  // ~3-4 px past the triangle's right edge, which reads as "clearly
  // east" without drifting into neighbour cells at normal pitches.
  const eastOff = Math.max(pitch / 3, 15);
  const southOff = Math.max(pitch / 3, 12);
  let x, y;
  if (slot === 0)      { x = ax + eastOff;  y = ay;          } // E
  else if (slot === 1) { x = ax + eastOff;  y = ay + southOff; } // SE
  else if (slot === 2) { x = ax;            y = ay + southOff; } // S
  else                 { x = ax + eastOff;  y = ay - southOff; } // NE (4+)

  const pos = { x: Math.round(x), y: Math.round(y) };
  _overlayPosCache.set(key, pos);
  return pos;
}

// Event-driven overlay draws — we redraw only when tracker state
// actually changes (door pinned, key found/used, floor reset) plus a
// low-frequency keep-alive heartbeat to refresh Alt1's overlay timers.
// Cuts draw rate from every-tick (10Hz at 100ms) to ~0.5Hz, with the
// same visual behaviour because Alt1 holds an overlay for
// OVERLAY_DURATION_MS after each draw call.
//
// Keep-alive cadence and duration must satisfy:
//   OVERLAY_DURATION_MS > OVERLAY_KEEPALIVE_TICKS * TICK_MS
// with enough buffer to absorb setInterval jitter, whole-tick skips,
// and expensive tick work (panel reads + classifyCells can stack to
// 100-150 ms on a slow frame, and consecutive stalls across 2-3 ticks
// can push the heartbeat timer past target). Widened 2026-04-24 from
// 3s/5s (2s buffer) → 2s/6s (4s buffer) after user reported visible
// gap windows >1s during stalls. Redraw cost is ~1-2 ms for a full
// pass (cached icons + Alt1 native overLayImage), so tightening the
// heartbeat is nearly free on CPU.
let _overlayStateFingerprint = null;
let _lastOverlayDrawTick = -Infinity; // ensures first call always draws
const OVERLAY_KEEPALIVE_TICKS = 20;   // 20 ticks × 100ms = 2s heartbeat
const OVERLAY_DURATION_MS = 6000;     // 6s — 4s buffer over keep-alive

function drawPinnedOverlays() {
  if (!_overlayReady) return;

  const snapshot = tracker.getSnapshot();

  // Diagnostic sweep: capture every pinned door in the tracker BEFORE
  // the drawability filter, so entries that would otherwise be
  // silently skipped (missing cellCoords/cellPx) show up in the dump.
  // Fields downstream are populated as the draw pipeline runs below.
  const diag = snapshot.doors.map(d => ({
    color: d.color,
    shape: d.shape,
    haveKey: !!d.haveKey,
    cellCoords: d.cellCoords || null,
    cellPx: d.cellPx || null,
    trianglePx: d.trianglePx || null,
    overlayX: null, overlayY: null, slot: null, drawResult: null,
  }));

  // Input-state fingerprint — derived purely from tracker state,
  // excludes draw-pipeline outputs (overlayX/Y, drawResult). Changes
  // when a door enters/leaves the tracker or its haveKey state flips.
  // Used to gate the draw loop: if state is unchanged AND the keep-
  // alive heartbeat isn't due yet, we skip the draw loop entirely.
  const inputFp = diag.map(e => {
    const cc = e.cellCoords ? `${e.cellCoords.col},${e.cellCoords.row}` : 'x';
    const cpx = e.cellPx ? `${e.cellPx.cx.toFixed(0)},${e.cellPx.cy.toFixed(0)}` : 'x';
    const tpx = e.trianglePx ? `${e.trianglePx.x},${e.trianglePx.y}` : 'x';
    return `${e.color}/${e.shape}|hk=${e.haveKey ? 1 : 0}|${cc}|${cpx}|${tpx}`;
  }).join(';');

  const stateChanged = inputFp !== _overlayStateFingerprint;
  const keepAliveDue = (tickCount - _lastOverlayDrawTick) >= OVERLAY_KEEPALIVE_TICKS;

  if (!stateChanged && !keepAliveDue) {
    return; // nothing to redraw; Alt1 still holds previous overlays alive
  }

  // Group pinned doors by their locked ABSOLUTE cellPx (bucketed)
  // rather than by cellCoords. cellCoords is a LOCAL label relative
  // to findDgMap's "top-leftmost cluster" origin — that origin shifts
  // as exploration reveals new cells west/north, so the same physical
  // cell can be re-labeled between captures, and conversely different
  // physical cells can collide on the same (col,row) label across
  // captures. cellPx is in screen pixels and invariant to origin
  // shifts (origin-shift math cancels in `origin.x + col*pitch +
  // pitch/2`), making it the stable identifier for a physical cell.
  //
  // Bucket size 10 px absorbs small origin/pitch jitter between
  // captures (same physical cell → same bucket). Adjacent cells at
  // minimum pitch (20 px) differ by ≥ 2 buckets, so they stay in
  // separate groups.
  //
  // cellCoords is still stored on the tracker (for the pin log /
  // diagnostic dump); only the overlay grouping switches to pixel-
  // based. haveKey rides along the group so drawKeyOverlay can pick
  // the ready (chartreuse halo) variant.
  const PIXEL_GROUP_BUCKET = 10;
  const byCell = new Map();
  for (let idx = 0; idx < snapshot.doors.length; idx++) {
    const d = snapshot.doors[idx];
    if (!d.cellCoords || !d.cellPx) continue;
    const bx = Math.round(d.cellPx.cx / PIXEL_GROUP_BUCKET);
    const by = Math.round(d.cellPx.cy / PIXEL_GROUP_BUCKET);
    const key = `${bx},${by}`;
    let arr = byCell.get(key);
    if (!arr) { arr = []; byCell.set(key, arr); }
    const latestAt = (d.history[0] && d.history[0].at) || 0;
    arr.push({
      color: d.color, shape: d.shape, at: latestAt,
      cellPx: d.cellPx, trianglePx: d.trianglePx || null,
      haveKey: !!d.haveKey,
      _diagIdx: idx,
    });
  }

  // Read self-slot colour ONCE per draw — drives the anchor-selection
  // branch inside computeOverlaySlotPos (actual trianglePx for red,
  // synthetic top-left for others). Stable within a party session;
  // cache key inside computeOverlaySlotPos keys on it so stale
  // entries for a previous slot don't conflict.
  const selfColor = getSelfColor();

  for (const [cellKey, doors] of byCell) {
    doors.sort((a, b) => a.at - b.at);
    // All doors in the same cell use the first door's cellPx as the
    // reference frame. In practice cellPx is pinned first-info-wins
    // per door, so doors that happened to be info'd at slightly
    // different pitches would have slightly different cellPx — this
    // keeps them visually grouped at one cell center regardless.
    const ref = doors[0].cellPx;
    const tri = doors[0].trianglePx;
    for (let i = 0; i < doors.length; i++) {
      const pos = computeOverlaySlotPos(ref, tri, cellKey, i, selfColor);
      if (!pos) continue;
      const drawResult = drawKeyOverlay(
        pos.x, pos.y, doors[i].color, doors[i].shape, 16, OVERLAY_DURATION_MS, doors[i].haveKey
      );
      const row = diag[doors[i]._diagIdx];
      if (row) {
        row.overlayX = pos.x;
        row.overlayY = pos.y;
        row.slot = i;
        row.drawResult = drawResult;
      }
    }
  }

  _lastOverlayDrawTick = tickCount;

  // Dump only on actual state change. Keep-alive heartbeats redraw
  // the same content and don't need a log entry — would just spam
  // the debug panel every 3s.
  if (stateChanged) {
    _overlayStateFingerprint = inputFp;
    if (diag.length === 0) {
      dbg('info', 'overlay dump: tracker has 0 pinned doors');
    } else {
      dbg('info', `overlay dump: ${diag.length} pinned door(s)`);
      for (const e of diag) {
        const readyTag = e.haveKey ? ' [READY]' : '';
        const cc = e.cellCoords ? `cell(${e.cellCoords.col},${e.cellCoords.row})` : 'cell=NULL';
        const cpx = e.cellPx
          ? `cellPx(${e.cellPx.cx.toFixed(1)},${e.cellPx.cy.toFixed(1)},p=${e.cellPx.pitch})`
          : 'cellPx=NULL';
        const tpx = e.trianglePx
          ? `triPx(${e.trianglePx.x},${e.trianglePx.y})`
          : 'triPx=NULL';
        const ov = (e.overlayX != null)
          ? `→overlay(${e.overlayX},${e.overlayY}) slot=${e.slot} draw=${e.drawResult}`
          : '→NO_DRAW (missing fields)';
        dbg('info', `  ${e.color} ${e.shape}${readyTag}: ${cc} ${cpx} ${tpx} ${ov}`);
      }
    }
  }
}

setInterval(tick, 100);
tick();
