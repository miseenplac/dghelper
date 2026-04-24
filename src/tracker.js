// Stateful tracker for dungeoneering keys & doors.
//
// State model:
//   keysFound: Map<id, { color, shape, at }>
//     - keys the party has picked up that haven't been consumed yet
//
//   doorsPending: Map<id, { color, shape, history: [{ player, at }] }>
//     - doors observed via "Key required: X" info messages, newest player first
//     - per-player dedupe: if the same player re-infoes a door, their existing
//       entry is moved to the front (and its timestamp updated) instead of
//       appending a duplicate row.
//
//   On a "key used" event, the key+door with that id are both cleared.

import { render, dbg } from './ui.js';

function idOf(color, shape) { return `${color} ${shape}`; }

const state = {
  keysFound: new Map(),
  doorsPending: new Map()
};

// --- Key timing history ---------------------------------------------------
// Per-floor log of each key's found→used delta. Populated when a key enters
// keysFound (chat key-found event) and closed when the key leaves (chat
// key-used event or local-unlock heuristic). Each keysFound entry carries
// an opaque histId that ties it to its row here.
//
// Rotation: onFloorEnd snapshots currentFloor into previousFloor then
// clears currentFloor. The UI only shows previousFloor (the current floor
// is still in flight — partial rows would be misleading).
//
// Note: the `shape === '?'` fallback in match helpers below is kept as a
// defensive guard for a future partial-info event source (e.g. a keybag
// OCR path that knows colour but not shape). No current code produces
// shape-less events; chat parsing always yields both.
const keyHistory = { currentFloor: [], previousFloor: [] };
let _histSeq = 0;

function historyPushKey(color, shape, at) {
  const histId = ++_histSeq;
  keyHistory.currentFloor.push({ histId, color, shape, foundAt: at, usedAt: null });
  return histId;
}

function historyCloseKey(histId) {
  if (!histId) return;
  const entry = keyHistory.currentFloor.find(e => e.histId === histId);
  if (entry && !entry.usedAt) entry.usedAt = Date.now();
}

function historyRotate() {
  // Idempotent: only rotate if the current floor actually accumulated data.
  // This lets floor-end fire the rotation (populating previousFloor the
  // moment a floor closes, so the UI updates even if the user leaves the
  // dungeon and no new floor-start follows), and still handle the common
  // case where floor-reset fires later (from the next floor's banner) —
  // the second call finds currentFloor empty and correctly no-ops instead
  // of clobbering the snapshot we just captured.
  if (!keyHistory.currentFloor.length) return;
  keyHistory.previousFloor = keyHistory.currentFloor.slice();
  keyHistory.currentFloor = [];
}

export function getKeyHistory() {
  return {
    current:  keyHistory.currentFloor.slice(),
    previous: keyHistory.previousFloor.slice()
  };
}

function onKeyFound(color, shape, at) {
  const id = idOf(color, shape);
  if (!state.keysFound.has(id)) {
    const histId = historyPushKey(color, shape, at);
    state.keysFound.set(id, { color, shape, at, histId });
  }
}

function onDoorInfo(color, shape, player, at, playerSignature, slotColor, cellCoords, cellPx, trianglePx) {
  const id = idOf(color, shape);
  let entry = state.doorsPending.get(id);
  if (!entry) {
    entry = { color, shape, history: [], cellCoords: null, cellPx: null, trianglePx: null };
    state.doorsPending.set(id, entry);
  }
  // First-info-wins for door location: the door's physical position in
  // the dungeon is set on the FIRST info event and doesn't move. Later
  // re-info events from different cells (e.g., user walks past the door
  // and info's it again) update only the history timestamp, never the
  // pinned cellCoords / cellPx. Prevents the overlay icon from jumping.
  //
  // cellPx locks the cell-CENTER screen pixel coordinates + pitch used
  // at info-time. Overlay positioning reads this directly, bypassing
  // anchor/origin math entirely — immune to pitch/origin drift between
  // detection runs, which was producing visibly-off icon placement when
  // the fresh-read pitch (used for cellCoords) differed from the frozen
  // anchor pitch (previously used for drawing).
  if (cellCoords && !entry.cellCoords) {
    entry.cellCoords = cellCoords;
    if (cellPx) entry.cellPx = cellPx;
    if (trianglePx) entry.trianglePx = trianglePx;
  }

  // Dedupe by signature when available (same player = same rendering signature
  // even if OCR produced different garbled text across the two lines). Falls
  // back to player-name dedupe for events without a signature.
  const dedupeKey = playerSignature || player;
  entry.history = entry.history.filter(h => (h.playerSignature || h.player) !== dedupeKey);
  // slotColor is the dungeoneering Ring-of-Kinship slot colour (red/teal/
  // lime/yellow/pale) extracted from the username fragment's colour.
  // Carried through on each history entry as diagnostic metadata.
  // On this user's client usernames render white so slotColor comes
  // back null for door-info events; attribution goes through the
  // aliasMap / partyRoster fuzzy-match path instead.
  //
  // cellCoords is kept per-history too (for diagnostic visibility into
  // WHERE each info happened), but the pinned door location the overlay
  // reads is entry.cellCoords (locked in above, first-info-wins).
  entry.history.unshift({ player, playerSignature, slotColor, cellCoords, at });
}

function onKeyUsed(color, shape) {
  const id = idOf(color, shape);
  const existing = state.keysFound.get(id);
  if (existing) historyCloseKey(existing.histId);
  state.keysFound.delete(id);
  state.doorsPending.delete(id);
}

// Local "You unlock the door." / "You reforge ... unlock the door." event has
// no colour/shape info. Disambiguation cascade:
//   1. Exactly one pending door with a matching collected key → clear it.
//      Highest-confidence signal.
//   2. Exactly one pending door total → clear it. Safe fallback.
//   3. Multiple pending doors, no key matches → clear the MOST RECENTLY
//      info'd door. Heuristic: players typically unlock the door they just
//      walked up to (i.e. the one they most recently saw info'd). Not perfect
//      but strictly better than leaving the list to pile up forever, since
//      party-broadcast lines ("Your party found a key: …") frequently OCR as
//      punctuation soup and never populate keysFound.
// Helper: find the keysFound entry whose (color, shape) matches the given
// door. Exact match wins; colour-only (shape = '?') fallback is reserved
// for a potential future partial-info event source (see header comment).
function findKeyForDoor(door) {
  const exactId = idOf(door.color, door.shape);
  if (state.keysFound.has(exactId)) return exactId;
  for (const [id, k] of state.keysFound.entries()) {
    if (k.color === door.color && k.shape === '?') return id;
  }
  return null;
}

function onKeyUsedLocal() {
  const pending = Array.from(state.doorsPending.entries());
  if (pending.length === 0) return;

  // 1) Exactly one door we have a key for.
  const withKey = pending.filter(([, door]) => findKeyForDoor(door) !== null);
  if (withKey.length === 1) {
    const [id, door] = withKey[0];
    const keyId = findKeyForDoor(door);
    state.doorsPending.delete(id);
    if (keyId) {
      const k = state.keysFound.get(keyId);
      if (k) historyCloseKey(k.histId);
      state.keysFound.delete(keyId);
    }
    if (dbg) dbg('info', 'local unlock: cleared matched door ' + id);
    return;
  }

  // 2) Only one door pending overall.
  if (pending.length === 1) {
    const [id, door] = pending[0];
    const keyId = findKeyForDoor(door);
    state.doorsPending.delete(id);
    if (keyId) {
      const k = state.keysFound.get(keyId);
      if (k) historyCloseKey(k.histId);
      state.keysFound.delete(keyId);
    }
    if (dbg) dbg('info', 'local unlock: cleared only pending door ' + id);
    return;
  }

  // 3) Heuristic fallback: most-recently-info'd door.
  let newestId = null;
  let newestAt = -Infinity;
  let newestDoor = null;
  for (const [id, entry] of pending) {
    const at = entry.history[0] && entry.history[0].at;
    if (typeof at === 'number' && at > newestAt) {
      newestAt = at;
      newestId = id;
      newestDoor = entry;
    }
  }
  if (newestId && newestDoor) {
    const keyId = findKeyForDoor(newestDoor);
    state.doorsPending.delete(newestId);
    if (keyId) {
      const k = state.keysFound.get(keyId);
      if (k) historyCloseKey(k.histId);
      state.keysFound.delete(keyId);
    }
    if (dbg) dbg('info', 'local unlock: fallback cleared newest door ' + newestId);
  }
}

function onFloorEnd() {
  // Fires when a floor closes (winterface auto-probe / manual probe /
  // outfit-bonus fallback / leave-party). Rotates the key history so the
  // Previous Floor Keys panel reflects the just-finished floor, AND wipes
  // unmatched keys / pending doors — those belong to the floor that just
  // ended; anything still orphan at this point isn't coming back.
  historyRotate();
  const had = state.keysFound.size > 0 || state.doorsPending.size > 0;
  state.keysFound.clear();
  state.doorsPending.clear();
  if (had && dbg) dbg('info', 'floor closed: cleared tracker state');
  return true; // always re-render
}

function onFloorReset() {
  // Fires when a new floor starts. Same behaviour as floor-end — rotate is
  // idempotent, so double-calling is safe. Exists as a distinct dispatch
  // type so mid-dungeon plugin starts (where floor-end never fired) still
  // catch the partial state through floor-reset.
  return onFloorEnd();
}

export const tracker = {
  handleEvent(ev) {
    const at = ev.at || Date.now();
    if (ev.type === 'key-found')            onKeyFound(ev.color, ev.shape, at);
    else if (ev.type === 'door-info')       onDoorInfo(ev.color, ev.shape, ev.player, at, ev.playerSignature, ev.slotColor, ev.cellCoords, ev.cellPx, ev.trianglePx);
    else if (ev.type === 'key-used')        onKeyUsed(ev.color, ev.shape);
    else if (ev.type === 'key-used-local')  onKeyUsedLocal();
    else if (ev.type === 'floor-end')       { if (!onFloorEnd())           return; }
    else if (ev.type === 'floor-reset')     { if (!onFloorReset())         return; }
    else return;
    render(getSnapshot());
  },

  reset() {
    state.keysFound.clear();
    state.doorsPending.clear();
    render(getSnapshot());
  },

  getSnapshot
};

// Does the party have a key that could open this door? Exact (colour+shape)
// match is strongest; colour-only match is the defensive fallback (see
// header comment on shape='?').
function hasKeyFor(color, shape) {
  if (state.keysFound.has(idOf(color, shape))) return true;
  for (const k of state.keysFound.values()) {
    if (k.color === color && (k.shape === '?' || shape === '?')) return true;
  }
  return false;
}

// Is a given key redundant with a pending door (already requested by an info)?
function isKeyMatchedToDoor(key) {
  if (state.doorsPending.has(idOf(key.color, key.shape))) return true;
  if (key.shape === '?') {
    // Shape-unknown key (defensive fallback): match any pending door of
    // the same colour.
    for (const d of state.doorsPending.values()) {
      if (d.color === key.color) return true;
    }
  }
  return false;
}

function getSnapshot() {
  // Doors: each includes match status + ordered history (newest first)
  // + door-level cellCoords (pinned at first-info, immutable) + cellPx
  // (the screen-pixel location of the cell's centre + pitch at info-
  // time, used directly by the Alt1 overlay renderer to bypass all
  // subsequent pitch/origin recomputation).
  const doors = Array.from(state.doorsPending.values()).map(d => ({
    id: idOf(d.color, d.shape),
    color: d.color,
    shape: d.shape,
    haveKey: hasKeyFor(d.color, d.shape),
    cellCoords: d.cellCoords || null,
    cellPx: d.cellPx || null,
    trianglePx: d.trianglePx || null,
    history: d.history.slice() // copy
  }));

  // Unmatched keys: collected but no door has requested them yet.
  const extraKeys = Array.from(state.keysFound.values())
    .filter(k => !isKeyMatchedToDoor(k))
    .map(k => ({
      id: idOf(k.color, k.shape),
      color: k.color,
      shape: k.shape
    }));

  // Sort stable: doors missing-key first (things you can't open are most useful to see)
  doors.sort((a, b) => Number(a.haveKey) - Number(b.haveKey));

  return { doors, extraKeys };
}
