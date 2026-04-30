// DOM rendering for the DungKey Tracker window.

import { tracker, getKeyHistory } from './tracker.js';
import { renderKeyIcon } from './keyIcon.js';

let doorsEl, keysEl, statusEl, doorsCountEl, keysCountEl;
let debugListEl, debugStatsEl;
let historyListEl, historyCountEl, historyToggleBtn;
let historyOpen = false;
let slotsListEl, slotsCountEl;

// Render context — injected by index.js so ui.js doesn't need to know about
// the roster, the learned-alias map, or the fuzzy resolver directly. Each
// render call reads through this for display-name resolution, so updates to
// the alias map or roster retroactively fix already-rendered rows.
let renderContext = {
  roster: [],
  aliasMap: {},
  setAlias: null,        // (signature, name|null) => void — persists + re-renders
  resolveFuzzy: null,    // (raw, roster) => string — fuzzy roster match
};

export function setRenderContext(ctx) {
  renderContext = { ...renderContext, ...ctx };
}

/**
 * Resolve a player identity for display using a priority cascade:
 *
 *   1. aliasMap[signature] — user-explicit per-signature assignment
 *      (clicked the player pill on a door row and picked a roster name).
 *      Highest priority: user said "this exact OCR signature = this name."
 *
 *   2. resolveFuzzy(rawPlayer, roster) — best-effort fuzzy match of the
 *      (possibly OCR-mangled) raw name against the Party roster.
 *
 *   3. rawPlayer || '?' — last resort when none of the above resolve.
 *
 * `slotColor` is accepted in the signature for call-site back-compat but
 * no longer used — the slot-colour → name binding path (slotAssignMap)
 * was removed after self-slot detection moved to RoK panel name OCR +
 * elimination.
 */
function displayPlayer(rawPlayer, signature /* slotColor unused */) {
  if (signature && renderContext.aliasMap && renderContext.aliasMap[signature]) {
    return renderContext.aliasMap[signature];
  }
  if (renderContext.resolveFuzzy) {
    return renderContext.resolveFuzzy(rawPlayer, renderContext.roster);
  }
  return rawPlayer || '?';
}

export function mount() {
  doorsEl      = document.getElementById('doors-list');
  keysEl       = document.getElementById('keys-list');
  statusEl     = document.getElementById('status');
  doorsCountEl = document.getElementById('doors-count');
  keysCountEl  = document.getElementById('keys-count');
  debugListEl  = document.getElementById('debug-list');
  debugStatsEl = document.getElementById('debug-stats');
  historyListEl    = document.getElementById('history-list');
  historyCountEl   = document.getElementById('history-count');
  historyToggleBtn = document.getElementById('history-toggle');
  slotsListEl      = document.getElementById('slots-list');
  slotsCountEl     = document.getElementById('slots-count');
  // Initial render: empty state (panel not yet detected).
  renderPartySlots(null);
  const clearBtn = document.getElementById('debug-clear');
  if (clearBtn) clearBtn.addEventListener('click', () => { if (debugListEl) debugListEl.innerHTML = ''; });
  const debugToggleBtn = document.getElementById('debug-toggle');
  if (debugToggleBtn) debugToggleBtn.addEventListener('click', () => {
    if (!debugListEl) return;
    const nowHidden = !debugListEl.hidden;
    debugListEl.hidden = nowHidden;
    debugToggleBtn.textContent = nowHidden ? 'Show' : 'Hide';
  });
  if (historyToggleBtn) historyToggleBtn.addEventListener('click', () => {
    historyOpen = !historyOpen;
    if (historyListEl) historyListEl.hidden = !historyOpen;
    historyToggleBtn.textContent = historyOpen ? 'Hide' : 'Show';
    renderHistory();
  });

  render(tracker.getSnapshot());
  renderHistory();
}

// Debug-panel gating: when OFF, dbg() short-circuits before any DOM work.
// Default true so any dbg() calls during module load (before index.js
// flips the flag based on settings) aren't lost. index.js calls
// setDebugEnabled(settings.showDebugPanel) on load + on toggle change.
let _dbgEnabled = true;
export function setDebugEnabled(enabled) {
  _dbgEnabled = !!enabled;
}

// Debug panel — visible inside the app since DevTools is awkward to open.
// kind: 'raw' | 'match' | 'miss' | 'error' | 'info'
export function dbg(kind, msg) {
  if (!_dbgEnabled) return;
  if (!debugListEl) return;
  const li = document.createElement('li');
  li.className = 'dbg-' + (kind || 'info');
  const t = new Date();
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  const ss = String(t.getSeconds()).padStart(2, '0');
  li.textContent = `[${hh}:${mm}:${ss}] ${msg}`;
  debugListEl.appendChild(li);
  // Cap at ~250 entries; trim from top. Larger than feels necessary on purpose:
  // a single failed auto-probe emits ~10 diagnostic lines (timerTries dump),
  // and at 60 they scrolled off before the user could inspect.
  while (debugListEl.childElementCount > 250) {
    debugListEl.removeChild(debugListEl.firstChild);
  }
  // Auto-scroll to bottom
  debugListEl.scrollTop = debugListEl.scrollHeight;
}

export function setDebugStats(text, title) {
  if (!debugStatsEl) return;
  debugStatsEl.textContent = text;
  if (typeof title === 'string') debugStatsEl.title = title;
}

export function renderStatus(msg) {
  if (!statusEl) return;
  if (msg) {
    statusEl.textContent = msg;
    statusEl.style.display = '';
  } else {
    statusEl.textContent = '';
    statusEl.style.display = 'none';
  }
}

export function render(snapshot) {
  if (!doorsEl || !keysEl) return;

  // --- Doors
  doorsEl.innerHTML = '';
  doorsCountEl.textContent = snapshot.doors.length;
  if (snapshot.doors.length === 0) {
    doorsEl.appendChild(emptyLi('No doors info\u2019d yet.'));
  } else {
    for (const d of snapshot.doors) {
      doorsEl.appendChild(renderDoor(d));
    }
  }

  // --- Unmatched keys
  keysEl.innerHTML = '';
  keysCountEl.textContent = snapshot.extraKeys.length;
  if (snapshot.extraKeys.length === 0) {
    keysEl.appendChild(emptyLi('No unmatched keys.'));
  } else {
    for (const k of snapshot.extraKeys) {
      keysEl.appendChild(renderKey(k));
    }
  }

  // History count updates every render so it reflects rotation immediately;
  // the list body only rebuilds if the panel is currently open.
  renderHistory();
}

// Party Slots — reflects what partyPanel.js detected from the Ring of
// Kinship interface. Each filled slot is shown with a large colour
// swatch, its in-game index, and the roster name assigned to that colour
// (or "click to assign" when unassigned). Clicking the assignment button
// opens the same style of dropdown the door-alias pill uses, reusing
// showSlotAssignDropdown below.
//
// `result` is either the full readPartyPanel() result (found === true) or
// null when the panel isn't currently visible. Empty slots in the result
// are hidden from the UI — there's no useful action on a slot that isn't
// filled in-game.
export function renderPartySlots(result) {
  if (!slotsListEl || !slotsCountEl) return;

  const filled = (result && result.found)
    ? result.slots.filter(s => s.filled)
    : [];
  slotsCountEl.textContent = String(filled.length);

  slotsListEl.innerHTML = '';
  if (!result || !result.found) {
    // The RoK party interface is the sole source of truth for
    // detecting the user's slot colour + teammate names. RS3 does
    // NOT re-open this panel automatically when the player enters a
    // new floor from Daemonheim — so if the user closes it (or never
    // opened it), detection stays blocked for the rest of the session
    // until they reopen it. This empty-state is worth expanding into
    // explicit setup steps rather than a one-liner, because a user
    // with no detected panel won't get pins on teammate events and
    // may not know why.
    const li = document.createElement('li');
    li.className = 'slots-setup-note';

    const title = document.createElement('div');
    title.className = 'slots-setup-title';
    title.textContent = 'Ring of Kinship panel not open';
    li.appendChild(title);

    const step1 = document.createElement('div');
    step1.className = 'slots-setup-body';
    step1.innerHTML = 'Right-click your <strong>Ring of Kinship</strong> accessory &rarr; <strong>Party</strong>. Keep the interface open while dungeoneering.';
    li.appendChild(step1);

    const step2 = document.createElement('div');
    step2.className = 'slots-setup-body';
    step2.textContent = 'RS3 does NOT re-open this panel when you enter a new floor from Daemonheim \u2014 if you close it between floors, the plugin loses detection until you reopen it.';
    li.appendChild(step2);

    const note = document.createElement('div');
    note.className = 'slots-setup-body subtle';
    note.textContent = 'Required for auto-detection of your own slot colour and for auto-populating the teammate roster.';
    li.appendChild(note);

    slotsListEl.appendChild(li);
    return;
  }
  if (filled.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'Panel detected but no filled slots.';
    slotsListEl.appendChild(empty);
    return;
  }

  for (const s of filled) {
    slotsListEl.appendChild(renderSlotRow(s));
  }
}

function renderSlotRow(slot) {
  const li = document.createElement('li');
  li.className = `slot-row color-${slot.color}`;
  li.dataset.slotColor = slot.color;

  const sw = document.createElement('span');
  sw.className = `slot-swatch color-${slot.color}`;
  sw.title = `In-game slot colour: ${slot.color}`;
  li.appendChild(sw);

  const meta = document.createElement('div');
  meta.className = 'slot-meta';
  const idx = document.createElement('span');
  idx.className = 'slot-index';
  idx.textContent = `slot ${slot.index + 1} \u00B7 ${slot.color}`;
  meta.appendChild(idx);
  // Show the OCR'd name when partyPanel.js could read it. Garbled /
  // unreadable slots (common for the local user on clients where a
  // clan title icon splits their name) show a placeholder so the row
  // isn't empty-looking. Self-slot detection handles the
  // attribution regardless of whether the local name reads.
  if (slot.name) {
    const nameEl = document.createElement('span');
    nameEl.className = 'slot-name';
    nameEl.textContent = slot.name;
    meta.appendChild(nameEl);
  } else {
    const nameEl = document.createElement('span');
    nameEl.className = 'slot-name unassigned';
    nameEl.textContent = '(OCR unreadable)';
    meta.appendChild(nameEl);
  }
  li.appendChild(meta);

  return li;
}

// Previous-floor key history — one row per key that entered keysFound during
// the previous floor. Shows found-at time and time-to-unlock delta. Keys
// still open when the floor rotated show "never used" (pipeline missed their
// consumption signal, or user died / left before unlocking).
export function renderHistory() {
  if (!historyListEl || !historyCountEl) return;
  const hist = getKeyHistory().previous;
  historyCountEl.textContent = hist.length;
  if (!historyOpen) return;
  historyListEl.innerHTML = '';
  if (hist.length === 0) {
    historyListEl.appendChild(emptyLi('No previous floor yet.'));
    return;
  }
  // Oldest → newest so the reader can scan the floor chronologically.
  const rows = hist.slice().sort((a, b) => a.foundAt - b.foundAt);
  for (const entry of rows) {
    historyListEl.appendChild(renderHistoryRow(entry));
  }
}

function renderHistoryRow(entry) {
  const li = document.createElement('li');
  li.className = 'item history-row-key ' + (entry.usedAt ? 'used' : 'orphan');
  li.appendChild(renderKeyIcon(entry.color, entry.shape, 14));
  const label = (entry.shape && entry.shape !== '?')
    ? `${cap(entry.color)} ${entry.shape} key`
    : `${cap(entry.color)} key`;
  li.appendChild(labelEl(label));

  const delta = document.createElement('span');
  delta.className = 'history-delta';
  if (entry.usedAt) {
    delta.textContent = fmtDelta(entry.usedAt - entry.foundAt);
    delta.title = `found ${fmtTime(entry.foundAt)} → used ${fmtTime(entry.usedAt)}`;
  } else {
    delta.textContent = 'never used';
    delta.classList.add('missing');
    delta.title = `found ${fmtTime(entry.foundAt)}, not consumed before floor ended`;
  }
  li.appendChild(delta);
  return li;
}

function fmtDelta(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${m}:${String(ss).padStart(2, '0')}`;
}

function renderDoor(door) {
  const li = document.createElement('li');
  li.className = 'item door ' + (door.haveKey ? 'ready' : 'pending');

  // Match indicator sits at the far left — ✓ for matched, ✗ for missing key.
  // Big, coloured, unambiguous so the user can scan the list without reading.
  const marker = document.createElement('span');
  marker.className = 'match-marker';
  marker.textContent = door.haveKey ? '\u2713' : '\u2717';
  marker.title = door.haveKey ? 'Key in keybag — ready to open' : 'No matching key yet';
  li.appendChild(marker);

  li.appendChild(renderKeyIcon(door.color, door.shape, 14));
  li.appendChild(labelEl(`${cap(door.color)} ${door.shape} door`));
  li.appendChild(statusEl_(door.haveKey ? 'MATCHED' : 'NEED KEY'));

  // Player-name section: shows last info'd player, hover reveals full history,
  // click opens a roster picker that writes to the learned-alias map.
  const lastEntry = door.history[0];
  if (lastEntry) {
    const playerWrap = document.createElement('span');
    playerWrap.className = 'player-wrap';

    const playerLabel = document.createElement('span');
    playerLabel.className = 'player';
    playerLabel.textContent = displayPlayer(lastEntry.player, lastEntry.playerSignature, lastEntry.slotColor);
    if (door.history.length > 1) {
      playerLabel.classList.add('has-history');
      playerLabel.textContent += ` +${door.history.length - 1}`;
    }
    if (lastEntry.playerSignature && renderContext.setAlias) {
      playerLabel.classList.add('clickable');
      playerLabel.title = 'Click to assign this player to a roster name';
      playerLabel.addEventListener('click', (e) => {
        e.stopPropagation();
        showAliasDropdown(playerLabel, lastEntry.playerSignature);
      });
    }
    playerWrap.appendChild(playerLabel);

    // Cell-location pin (Phase 1 of the door → map linkage). Shows the
    // DG map cell where the door was FIRST info'd (first-info-wins on
    // the tracker entry), when solo auto-pinning was active. Plain text
    // for now; Phase 3 replaces this with an icon on a plugin-rendered
    // map widget. Reading from door.cellCoords (door-level) rather than
    // history[0].cellCoords means the pin stays stable even if the
    // same door gets re-info'd from a different cell.
    if (door.cellCoords) {
      const cellPin = document.createElement('span');
      cellPin.className = 'cell-pin';
      cellPin.textContent = `@(${door.cellCoords.col},${door.cellCoords.row})`;
      cellPin.title = 'DG map cell where this door was info\u2019d (solo auto-pin)';
      playerWrap.appendChild(cellPin);
    }

    // Tooltip with full history — each row resolved through the same alias
    // lookup so corrections propagate everywhere the name appears.
    const tooltip = document.createElement('div');
    tooltip.className = 'history-tooltip';
    const tt = document.createElement('div');
    tt.className = 'history-title';
    tt.textContent = 'Info\u2019d by';
    tooltip.appendChild(tt);
    for (const h of door.history) {
      const row = document.createElement('div');
      row.className = 'history-row';
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = displayPlayer(h.player, h.playerSignature, h.slotColor);
      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = fmtTime(h.at);
      row.appendChild(who);
      row.appendChild(when);
      tooltip.appendChild(row);
    }
    playerWrap.appendChild(tooltip);
    li.appendChild(playerWrap);
  }

  return li;
}

// Popup dropdown for aliasing the clicked player signature to a roster name.
// Appended to document.body so it can escape the chat-row's overflow-hidden,
// positioned near the clicked pill via fixed-coords.
function showAliasDropdown(anchor, signature) {
  const existing = document.querySelector('.alias-dropdown');
  if (existing) existing.remove();

  const dd = document.createElement('div');
  dd.className = 'alias-dropdown';

  const current = renderContext.aliasMap ? renderContext.aliasMap[signature] : null;
  const roster = Array.isArray(renderContext.roster) ? renderContext.roster : [];

  if (!roster.length) {
    const empty = document.createElement('div');
    empty.className = 'alias-empty';
    empty.textContent = 'Add party names first (Party input above).';
    dd.appendChild(empty);
  } else {
    for (const name of roster) {
      const opt = document.createElement('div');
      opt.className = 'alias-option' + (current === name ? ' active' : '');
      opt.textContent = name;
      opt.addEventListener('click', () => {
        if (renderContext.setAlias) renderContext.setAlias(signature, name);
        dd.remove();
      });
      dd.appendChild(opt);
    }
  }
  if (current) {
    const unassign = document.createElement('div');
    unassign.className = 'alias-option unassign';
    unassign.textContent = 'Unassign';
    unassign.addEventListener('click', () => {
      if (renderContext.setAlias) renderContext.setAlias(signature, null);
      dd.remove();
    });
    dd.appendChild(unassign);
  }

  document.body.appendChild(dd);
  const rect = anchor.getBoundingClientRect();
  dd.style.position = 'fixed';
  dd.style.top = `${rect.bottom + 2}px`;
  dd.style.left = `${Math.max(4, rect.left - 20)}px`;

  // Close on outside click. Defer a tick so the click that opened it doesn't
  // immediately close it via the document listener.
  setTimeout(() => {
    const onDocClick = (e) => {
      if (!dd.contains(e.target) && e.target !== anchor) {
        dd.remove();
        document.removeEventListener('click', onDocClick, true);
      }
    };
    document.addEventListener('click', onDocClick, true);
  }, 0);
}

function renderKey(key) {
  const li = document.createElement('li');
  li.className = 'item key extra';
  li.appendChild(renderKeyIcon(key.color, key.shape, 14));
  li.appendChild(labelEl(`${cap(key.color)} ${key.shape} key`));
  li.appendChild(statusEl_('orphan'));
  return li;
}

// --- small DOM helpers ---

function labelEl(text) {
  const el = document.createElement('span');
  el.className = 'label';
  el.textContent = text;
  return el;
}

function statusEl_(text) {
  const el = document.createElement('span');
  el.className = 'item-status';
  el.textContent = text;
  return el;
}

function emptyLi(text) {
  const li = document.createElement('li');
  li.className = 'empty';
  li.textContent = text;
  return li;
}

function cap(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function fmtTime(ts) {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}
