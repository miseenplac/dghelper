// Party panel reader for the RS3 Dungeoneering Ring of Kinship interface.
//
// ARCHITECTURE — red-first detection with multi-slot BG verification
//
// Flow:
//   1. findAllRedClustersInScanRect — scan the right-side panel region
//      for red-classified pixels, bucket by Y, return clusters ranked
//      by hit count. Each cluster also carries its horizontal WIDTH
//      (max X minus min X of red pixels) — used as part of the filled-
//      slot gate. Under the tight red classifier (b ≤ 10), only name-
//      text red counts — the RoK icon and other off-red chrome are
//      rejected at classification time — so cluster width equates to
//      name width (~30-300 px depending on name length) and empty
//      slots produce zero-wide clusters (no red pixels at all).
//   2. For each cluster (strongest hits first):
//        a. Width gate — reject clusters narrower than 80 px. This
//           filters the persistent decoration icon on empty slot 1.
//        b. Multi-slot BG — require ≥ 4 of the 5 rows at anchor.y +
//           i * 22 to sit on panel-BG. World red rarely has 5 consecutive
//           rows of panel-BG at 22-px pitch; the real panel always does.
//   3. For the accepted anchor, each slot is "filled" iff its EXPECTED
//      colour (red/teal/lime/yellow/pale at index 0-4) AND near-black
//      letter interior are both present at the row. The near-black
//      check (< 12 on all channels) is the universal text-vs-decoration
//      discriminator — names have dark letter bodies; icons don't.
//   4. Optional: look for a button-text cluster (warm off-white) 80-250
//      px below the anchor and report its position as a diagnostic
//      confirmation signal. Not required for acceptance.
//
// The fixed slot-colour mapping (SLOT_COLOR_BY_INDEX) means we never
// need to classify what colour each slot IS — only check whether the
// expected colour for that position is present. This keeps detection
// immune to ambient same-hue world content and handles 1-letter names.
//
// Public API:
//   readPartyPanel({screen?}) → { found, origin, slots, ... }
//   classifySlotColor(r, g, b) → slot colour key or null
//   findAllRedClustersInScanRect(screenData, screen, topK?) → cluster[]
//   peekForPartyButton(screen) → button candidate[]
//   SLOT_COLOR_BY_INDEX, SLOT_COLOR_KEYS, PANEL_BG — exported constants
//
// All RGB values here come from user eyedrops via memoryerror. Do not
// prune or alter them on intuition.

import * as a1lib from 'alt1/base';
import * as OCR from 'alt1/ocr';
import font_chatbox_12pt from 'alt1/fonts/chatbox/12pt.js';

// ---- Palette --------------------------------------------------------------

// Panel row background — solid dark warm grey/brown behind slot content.
// Everything else in a slot row is "not this". Used for filled-empty
// detection (panel-BG ratio) and for rejecting off-panel anchor candidates.
export const PANEL_BG = [50, 46, 40];

// Warm off-white outline of the "Leave Party" / "Form Party" button text
// in its unhovered state. Distinctive from pure white (flag content,
// neutral UI chrome), from saturated UI colours, and from dim panel-BG.
// This is the PRIMARY ANCHOR for panel detection.
const BUTTON_TEXT_OUTLINE = [216, 205, 197];

// Canonical ordering of slot colour keys — enumeration helper, also
// doubles as public API for consumers who need to iterate slot colours
// without committing to slot-position semantics (use SLOT_COLOR_BY_INDEX
// for that). Reference peak RGBs per slot (documentation only):
//   red:    (210, 53, 0)      — Slot 1 (host / first joiner)
//   teal:   (18, 84, 80)      — Slot 2
//   lime:   (71, 125, 1)      — Slot 3
//   yellow: (141, 145, 1)     — Slot 4
//   pale:   (106, 130, 94)    — Slot 5 (noticeably desaturated)
export const SLOT_COLOR_KEYS = ['red', 'teal', 'lime', 'yellow', 'pale'];

// Fixed slot position → outline colour map. RS3 assigns slot colours by
// party-join position invariantly: first joiner / host is slot 1 (red),
// second joiner is slot 2 (teal), etc. Encoded here so detection code
// can check "is THIS slot's expected colour present" rather than
// classifying arbitrary colours that might land at a slot position.
export const SLOT_COLOR_BY_INDEX = Object.freeze([
  'red',    // Slot 1 — always the host / first joiner
  'teal',   // Slot 2
  'lime',   // Slot 3
  'yellow', // Slot 4
  'pale',   // Slot 5
]);

// ---- Geometry -------------------------------------------------------------

// Row pitch between consecutive slot rows (Y distance). Memoryerror-derived:
// filled slot 91:7 at Y=519, empty slot 91:9 at Y=563 → (563-519)/2 = 22px.
// Native RS pixel units at default UI scale; Alt1 captures at same scale.
const ROW_PITCH_PX = 22;
const SLOTS_PER_PANEL = 5;

// Horizontal half-width for per-slot colour-presence and interior
// checks. Wide enough that bimodal clusters (portrait on left + name
// text on right) don't cause the presence check to miss pixels on
// either side of the row's centroid.
const SLOT_CONTENT_HALF_W = 80;
const SLOT_CONTENT_HALF_H = 6;

// Horizontal strip half-width for panel-BG verification at a slot row.
const PANEL_BG_STRIP_HALF_W = 70;

// ---- Scan region ----------------------------------------------------------
// Both the button peek and the slot-1 search are bounded by this rectangle
// so we don't burn time on UI areas that never contain the panel (chat on
// the left, world centre, etc.). Right 40% of screen width × middle 70%
// of height covers every typical panel placement as a SAFE DEFAULT.
//
// When the user has calibrated the party panel's position (Calibration UI
// in the plugin window), the calibrated rectangle REPLACES this default —
// see resolveScanRect below. A tight user-defined region makes detection
// ~5-8× cheaper and eliminates false-positive matches against similarly-
// coloured UI elsewhere (inventory BG, action-bar icons, world pixels).
function panelScanRect(screen) {
  // Absolute-coord bounds. For full-RS bind / dims-only object: screen.x/y
  // are 0 (or absent → coerced to 0), so origins/widths/heights are
  // identical to the pre-Phase-7 math. For regional bind: screen.x/y carry
  // the bind's absolute origin and these fractions effectively place the
  // default rect inside the bind (this fallback is not reached on the
  // Phase 7 path because readPartyPanel always synthesizes an explicit
  // region — kept defensive for external callers).
  const sxLo = screen.x || 0;
  const syLo = screen.y || 0;
  return {
    x0: sxLo + Math.floor(screen.width * 0.60),
    x1: sxLo + screen.width - 1,
    y0: syLo + Math.floor(screen.height * 0.15),
    y1: syLo + Math.floor(screen.height * 0.85),
  };
}

/**
 * Resolve a scan rectangle. Returns the user-calibrated region (clamped
 * to screen bounds) if provided, else the default panelScanRect. Invalid
 * regions silently fall back to default.
 */
function resolveScanRect(screen, region) {
  // Absolute-coord bounds for clamping. Full-RS bind / pre-bind dims
  // object: screen.x/y default to 0 → bounds are [0..screen.width-1] ×
  // [0..screen.height-1] (pre-Phase-7 behaviour). Regional bind:
  // screen.x/y are the bind origin → bounds are [screen.x..screen.x+
  // screen.width-1] × [screen.y..screen.y+screen.height-1], i.e. the
  // bound region in absolute coords. Pre-Phase-7 this used screen.width-1
  // / screen.height-1 directly, which silently clamped a calibrated
  // region to the wrong absolute bounds when a regional screen was
  // passed in.
  const sxLo = screen.x || 0;
  const syLo = screen.y || 0;
  const sxHi = sxLo + screen.width - 1;
  const syHi = syLo + screen.height - 1;
  if (region &&
      Number.isFinite(region.x) && Number.isFinite(region.y) &&
      Number.isFinite(region.w) && Number.isFinite(region.h) &&
      region.w > 0 && region.h > 0) {
    const x0 = Math.max(sxLo, Math.floor(region.x));
    const y0 = Math.max(syLo, Math.floor(region.y));
    const x1 = Math.min(sxHi, x0 + Math.floor(region.w));
    const y1 = Math.min(syHi, y0 + Math.floor(region.h));
    if (x1 > x0 && y1 > y0) return { x0, x1, y0, y1 };
  }
  return panelScanRect(screen);
}

// ---- Classification helpers ----------------------------------------------

function isPanelBackground(r, g, b) {
  // Tight tolerance used when we need to EXCLUDE panel-BG from being
  // mistaken for slot content.
  return Math.abs(r - PANEL_BG[0]) <= 8 &&
         Math.abs(g - PANEL_BG[1]) <= 8 &&
         Math.abs(b - PANEL_BG[2]) <= 8;
}

function isPanelBackgroundLoose(r, g, b) {
  // Wider tolerance (±18) used for row-verification checks where we want
  // to ask "is this shaded like the panel?" with room for rendering
  // variance across UI states (lobby vs in-dungeon, partial transparency).
  return Math.abs(r - PANEL_BG[0]) <= 18 &&
         Math.abs(g - PANEL_BG[1]) <= 18 &&
         Math.abs(b - PANEL_BG[2]) <= 18;
}

function isButtonTextOutline(r, g, b) {
  // ±30 per channel tolerance with a monotonic warm-tint guard
  // (r >= g >= b) so pure whites, cool-tinted greys, or blue-tinted
  // chrome don't match. The monotonic check (≥ not >) accepts anti-
  // aliased letter-interior pixels where the warm channel gap narrows
  // to zero. The wider ±30 envelope catches brighter rendering
  // variations on compact-panel UI — user-eyedropped button text sits
  // at (219, 207, 200) on one client, and the previous ±22 envelope
  // around reference (216, 205, 197) excluded enough anti-aliased
  // neighbours that "Leave Party" clusters fell below the per-bucket
  // hit floor entirely. ±30 keeps pure whites (r=g=b=255, differences
  // ≥ 39) out while admitting realistic button-text gradients.
  return Math.abs(r - BUTTON_TEXT_OUTLINE[0]) <= 30 &&
         Math.abs(g - BUTTON_TEXT_OUTLINE[1]) <= 30 &&
         Math.abs(b - BUTTON_TEXT_OUTLINE[2]) <= 30 &&
         r >= g && g >= b;
}

/**
 * Classify a pixel to one of 5 slot colour families, or null.
 * Hue-family rules (decreasing priority), each derived from user-provided
 * eyedrop samples and tuned against live-test false positives:
 *
 *   teal  — R low, G/B high and close
 *   pale  — desaturated G-dominant green (tight ratio gates vs lime)
 *   red   — R dominant, G/B low, B up to ~20
 *   lime  — G dominates R, B near 0
 *   yellow— R ≈ G, both high, B near 0
 */
export function classifySlotColor(r, g, b) {
  if (isPanelBackground(r, g, b)) return null;
  if (r < 15 && g < 15 && b < 15) return null;

  // Teal (slot 2)
  if (r <= 45 && g >= 55 && b >= 50 && Math.abs(g - b) <= 30) return 'teal';

  // Pale (slot 5) — tight gates to exclude pastel greens from world /
  // minimap. r/g ≥ 0.75 is the primary discriminator; g-b ≥ 8 rejects
  // near-neutrals.
  if (g >= r && r >= b && b >= 25 &&
      g - r <= 25 && r - b <= 15 && g >= 50 &&
      r <= b * 1.3 && g - b >= 8 &&
      r * 4 >= g * 3) {
    return 'pale';
  }

  // Red (slot 1). The tight b ≤ 10 gate (was ≤ 20) separates slot-1
  // name-text red — user-eyedropped at (192, 50, 2), b=2 — from the
  // Ring of Kinship icon's reddish anti-aliased edges sampled at
  // (193, 68, 19), b=19. The RoK icon sits immediately to the left
  // of slot-1's portrait; under the older b≤20 rule, icon edge pixels
  // joined slot-1's red cluster and dragged the centroid leftward off
  // the actual name X, which then placed the per-slot ±80 px colour
  // checks out of range for slots 2-5. Also, icon edges oscillate in
  // and out of classification tick-to-tick (anti-aliased g values
  // flirt with the 60 boundary), making the cluster's WIDTH unstable
  // for short names → the "name flickers on/off" symptom. Tightening
  // b handles both.
  if (r > 60 && g < 60 && b <= 10 && r > g && r > b * 2) return 'red';

  // Lime (slot 3)
  if (b <= 10 && g >= 70 && g > r * 1.3) return 'lime';

  // Yellow (slot 4)
  if (b <= 10 && r >= 100 && g >= 100 && Math.abs(r - g) <= 20) return 'yellow';

  return null;
}

/**
 * Check whether a slot row has NEAR-BLACK INTERIOR PIXELS. This is the
 * universal signature of rendered TEXT across all 5 slot colours —
 * every name (regardless of outline hue) renders its letter bodies in
 * near-black ((0, 0, 0) through ~(7, 7, 7)) per the user's eyedrop
 * samples. Panel-BG (50, 46, 40) is far brighter; decorative icons
 * that happen to share a slot's outline colour typically don't have
 * near-black fill regions.
 *
 * Pairing "expected outline colour present" (hasSlotColor) with this
 * near-black interior check eliminates the "persistent red decoration
 * keeps detection alive after leaving party" failure mode: the
 * decoration supplies the outline but lacks the text interior, so the
 * combined check correctly reports the slot as empty.
 */
function hasNearBlackInterior(screenData, centreX, centreY, minCount, x0, y0) {
  // (centreX, centreY) are absolute screen coords. With Phase 7 regional
  // bind, screenData spans only [x0..x0+screenData.width) × [y0..y0+
  // screenData.height) in absolute coords. Clamp absolute-coord bounds
  // accordingly, then subtract (x0, y0) at getPixel to index the buffer.
  if (minCount === undefined) minCount = 3;
  const xMin = Math.max(x0, centreX - SLOT_CONTENT_HALF_W);
  const xMax = Math.min(x0 + screenData.width - 1, centreX + SLOT_CONTENT_HALF_W);
  const yMin = Math.max(y0, centreY - SLOT_CONTENT_HALF_H);
  const yMax = Math.min(y0 + screenData.height - 1, centreY + SLOT_CONTENT_HALF_H);
  let count = 0;
  for (let y = yMin; y <= yMax; y++) {
    for (let x = xMin; x <= xMax; x++) {
      const px = screenData.getPixel(x - x0, y - y0);
      if (!px) continue;
      if (px[0] < 12 && px[1] < 12 && px[2] < 12) {
        count++;
        if (count >= minCount) return true;
      }
    }
  }
  return false;
}

/**
 * Check whether the EXPECTED colour is present at a given row centre,
 * scanning a wider X range than earlier versions (±SLOT_CONTENT_HALF_W).
 * The wider scan handles bimodal clusters — where, e.g., portrait red
 * pixels sit on the left of the row and name red pixels on the right —
 * by looking wide enough to catch both groups regardless of which one
 * the peek's weighted centroid landed between.
 */
function hasSlotColor(screenData, centreX, centreY, expectedColor, minCount, x0, y0) {
  // Absolute→local translation pattern — see hasNearBlackInterior.
  if (minCount === undefined) minCount = 3;
  const xMin = Math.max(x0, centreX - SLOT_CONTENT_HALF_W);
  const xMax = Math.min(x0 + screenData.width - 1, centreX + SLOT_CONTENT_HALF_W);
  const yMin = Math.max(y0, centreY - SLOT_CONTENT_HALF_H);
  const yMax = Math.min(y0 + screenData.height - 1, centreY + SLOT_CONTENT_HALF_H);
  let count = 0;
  for (let y = yMin; y <= yMax; y++) {
    for (let x = xMin; x <= xMax; x++) {
      const px = screenData.getPixel(x - x0, y - y0);
      if (!px) continue;
      if (classifySlotColor(px[0], px[1], px[2]) === expectedColor) {
        count++;
        if (count >= minCount) return true;
      }
    }
  }
  return false;
}

/**
 * Verify that a slot row sits on actual panel-BG by sampling a horizontal
 * strip (±PANEL_BG_STRIP_HALF_W px wide, 3 vertical rows thick) and
 * requiring a majority of samples to match panel-BG (loose tolerance).
 *
 * Returns { verified, bgRatio } where bgRatio is 0-1. Threshold 0.35:
 * real slot rows clear 50-70 % BG easily; unrelated UI rows typically
 * fall well under 35 %.
 */
function verifyPanelBgAtDetailed(screenData, absX, absY, x0, y0) {
  let bgHits = 0, total = 0;
  for (let dx = -PANEL_BG_STRIP_HALF_W; dx <= PANEL_BG_STRIP_HALF_W; dx += 4) {
    for (let dy = -1; dy <= 1; dy++) {
      const x = absX + dx;
      const y = absY + dy;
      // Bounds check in absolute coords — buffer spans [x0..x0+w) × [y0..y0+h).
      if (x < x0 || y < y0 || x >= x0 + screenData.width || y >= y0 + screenData.height) continue;
      const px = screenData.getPixel(x - x0, y - y0);
      if (!px) continue;
      total++;
      if (isPanelBackgroundLoose(px[0], px[1], px[2])) bgHits++;
    }
  }
  const bgRatio = total > 0 ? (bgHits / total) : 0;
  return { verified: bgRatio >= 0.35, bgRatio };
}

// ---- Primary detection path: "Leave Party" button anchor ---------------
// USER-FACING REQUIREMENT: the plugin detects slots only from the
// STANDALONE Ring-of-Kinship party interface (opened via right-clicking
// the Ring of Kinship accessory → Party). The compact/embedded party
// UI that some clients render inline is NOT supported. This is a
// deliberate design constraint — the standalone interface has stable
// structure across all client layouts while the embedded version
// fragments unpredictably with surrounding UI chrome.
//
// Anchor signal: the "Leave Party" (or "Form Party") button text at
// the bottom of the slot area. Warm off-white pixel cluster ~11-13
// characters wide, produced by peekForPartyButton. Detection scans
// UPWARD from the button for slot-coloured pixel rows and sequence-
// matches them against SLOT_COLOR_BY_INDEX.
//
// Why NOT the older approaches:
//   - panel-BG anchor: collides with inventory / action-bar BG on
//     many layouts, producing false positives 300+ px away from the
//     real panel.
//   - near-black text interior: some clients render slot names in
//     their slot colour directly (no near-black letter bodies), so
//     the "universal text signature" assumption doesn't hold.
//   - slot-1 red cluster width: oscillates above/below a fixed
//     threshold tick-to-tick for short names due to anti-aliased
//     edge-pixel classification flicker, causing the "name flickers"
//     symptom.
//
// The button anchor is robust because:
//   - peekForPartyButton's warm-off-white rule has wide tolerance —
//     not at any classifier boundary, doesn't anti-alias-flicker.
//   - The button's on-screen text width (~70+ px for "Leave Party")
//     is enough to distinguish it from narrower labels like "Change"
//     (~6 char) and "Reset" (~5 char).
//   - Slot row positions are derived from slot COLOUR presence above
//     the button — no reliance on BG or near-black.
//   - Row pitch is self-calibrated from detected row gaps, so UI
//     scale differences across clients don't break detection.

// Previously a hit-count filter excluded short-label buttons ("Change" /
// "Reset") here. Dropped — compact-panel UI renders "Leave Party" with
// similar hit counts to those short labels (~5 hits per Y bucket), so
// any cutoff that rejects Change also rejects Leave Party on this
// layout. Instead we iterate ALL peek candidates and let the structural
// checks below (red topmost + valid slot-colour sequence at expected
// offsets) filter false positives. Short-label buttons won't have a
// red slot-1 row at the right offset above them, so they get rejected
// on the structural side without a size gate.

// Vertical range to search above the button for slot rows. The
// closest slot (slot 5) sits just above the button after a small
// padding; the farthest (slot 1) is 4 slot-pitches above that, so
// 20-220 px comfortably covers any realistic pitch 20-30.
const SLOT_SCAN_MIN_OFFSET = 20;
const SLOT_SCAN_MAX_OFFSET = 220;

// Horizontal half-width to scan around button.x for slot colour. Slot
// text (the name) is often left-aligned inside the panel while the
// button is centred, so the X centres can differ by ~50 px. ±100
// covers that drift.
const SLOT_SCAN_HALF_W = 100;

// Scan step for per-pixel slot-colour classification. Dense enough to
// catch even short names reliably.
const SLOT_SCAN_STEP = 2;

// Y-bucket size for slot-row density. Text is ~8-12 px tall; a 4-px
// bucket puts each letter across 3 buckets, plenty for merging.
const SLOT_Y_BUCKET = 4;

// Minimum per-colour hits in a Y-bucket to count as a slot row. 3
// accommodates compact-panel / short-name cases (e.g., "Aar i" with
// narrow letters produces ~10 red hits total spread over 3 Y-buckets
// = ~3 per bucket). Still above single-pixel noise. Bumping below 3
// risks false positives from anti-alias specks on random UI.
const SLOT_MIN_COLOR_HITS = 3;

// Merge adjacent same-colour buckets within this bucket-count gap —
// text spans multiple Y-buckets and should be merged to one row. 2
// allows a 1-bucket gap (anti-alias dip) without fusing across the
// inter-row dark panel-BG gap (which is 3-5 buckets).
const SLOT_Y_MERGE_GAP = 2;

/**
 * Scan for slot-coloured pixel rows in a vertical band above a button.
 * Each Y-bucket is classified by its DOMINANT slot colour (the slot
 * colour with the most hits in that bucket, if any colour exceeds
 * SLOT_MIN_COLOR_HITS).
 *
 * When `region` is provided (user-calibrated scan area), the scan
 * range is CLAMPED to it. This prevents false positives from red/teal/
 * lime/yellow/pale pixels in the game world or adjacent UI chrome that
 * sit above the calibrated panel — without clamping, a red close-X on
 * the panel frame (just above calibration y0) or a red monster in the
 * game world above the panel would be mis-detected as "slot 1 red."
 *
 * Returns [{ y, color, count, centerX }, ...] sorted top-to-bottom.
 * Adjacent same-colour buckets are merged into a single row.
 */
function scanSlotColorRowsAboveButton(screenData, button, region, x0, y0) {
  // Clamp Y range to calibrated region when available — scan must not
  // reach outside the panel the user told us to look in. Lower-bound
  // defaults (when no region is supplied) are the bind region's top-
  // left in absolute coords (x0, y0); upper-bound defaults are
  // (x0 + screenData.width - 1, y0 + screenData.height - 1).
  const regionYMin = (region && Number.isFinite(region.y)) ? Math.max(y0, Math.floor(region.y)) : y0;
  const regionYMax = (region && Number.isFinite(region.y) && Number.isFinite(region.h))
    ? Math.min(y0 + screenData.height - 1, Math.floor(region.y) + Math.floor(region.h))
    : y0 + screenData.height - 1;
  const yStart = Math.max(regionYMin, button.y - SLOT_SCAN_MAX_OFFSET);
  const yEnd = Math.min(regionYMax, Math.max(y0, button.y - SLOT_SCAN_MIN_OFFSET));
  // Same clamping on X so the horizontal search doesn't leak sideways
  // out of the calibration box either.
  const regionXMin = (region && Number.isFinite(region.x)) ? Math.max(x0, Math.floor(region.x)) : x0;
  const regionXMax = (region && Number.isFinite(region.x) && Number.isFinite(region.w))
    ? Math.min(x0 + screenData.width - 1, Math.floor(region.x) + Math.floor(region.w))
    : x0 + screenData.width - 1;
  const xStart = Math.max(regionXMin, button.x - SLOT_SCAN_HALF_W);
  const xEnd = Math.min(regionXMax, button.x + SLOT_SCAN_HALF_W);

  // Bucket hits by Y, accumulating per-colour counts and X-sum for centroid.
  // sumX accumulates ABSOLUTE X (the x in the loop is absolute) so the
  // emitted centerX downstream stays in absolute coords as before.
  const byY = new Map();
  for (let y = yStart; y <= yEnd; y += SLOT_SCAN_STEP) {
    for (let x = xStart; x <= xEnd; x += SLOT_SCAN_STEP) {
      const px = screenData.getPixel(x - x0, y - y0);
      if (!px) continue;
      const c = classifySlotColor(px[0], px[1], px[2]);
      if (!c) continue;
      const yb = Math.floor(y / SLOT_Y_BUCKET);
      let info = byY.get(yb);
      if (!info) {
        info = {
          yb,
          counts: { red: 0, teal: 0, lime: 0, yellow: 0, pale: 0 },
          sumX: 0,
          total: 0,
        };
        byY.set(yb, info);
      }
      info.counts[c]++;
      info.sumX += x;
      info.total++;
    }
  }

  // Classify each bucket by dominant colour (if any colour exceeds threshold).
  const candidates = [];
  for (const info of byY.values()) {
    let bestColor = null;
    let bestCount = 0;
    for (const color of SLOT_COLOR_KEYS) {
      if (info.counts[color] > bestCount) {
        bestCount = info.counts[color];
        bestColor = color;
      }
    }
    if (bestCount >= SLOT_MIN_COLOR_HITS) {
      candidates.push({
        yb: info.yb,
        color: bestColor,
        count: bestCount,
        sumX: info.sumX,
        totalHits: info.total,
      });
    }
  }
  candidates.sort((a, b) => a.yb - b.yb);

  // Merge adjacent same-colour buckets into single rows.
  const merged = [];
  for (const c of candidates) {
    const last = merged[merged.length - 1];
    if (last && last.color === c.color && c.yb - last.lastYb <= SLOT_Y_MERGE_GAP) {
      last.lastYb = c.yb;
      last.count += c.count;
      last.sumX += c.sumX;
      last.totalHits += c.totalHits;
    } else {
      merged.push({
        firstYb: c.yb,
        lastYb: c.yb,
        color: c.color,
        count: c.count,
        sumX: c.sumX,
        totalHits: c.totalHits,
      });
    }
  }

  return merged.map(m => ({
    y: Math.round((m.firstYb + m.lastYb + 1) / 2 * SLOT_Y_BUCKET),
    color: m.color,
    count: m.count,
    centerX: Math.round(m.sumX / m.totalHits),
  }));
}

// ---- Name OCR (Stage 0 probe) --------------------------------------------
//
// The RoK slot names render in two components:
//   - SLOT-COLOUR OUTLINE (red/teal/lime/yellow/pale) around each letter
//   - NEAR-BLACK LETTER INTERIOR (R, G, B all < ~12 per hasNearBlackInterior)
//
// OCR.findReadLine against a NEAR-BLACK palette captures the letter bodies
// without needing per-slot colour switching — the interior is visually
// identical across all 5 slot colours. Three-font parallel probe because
// we don't yet know which Alt1 built-in font matches the RoK text rendering
// on this client; the debug dump lets the user see which font reads cleanly
// and narrow the plan for Stage 1+.
// Font confirmed to match RoK panel text rendering on this client
// (probed 2026-04-23): chatbox_12pt reads teammate slot names cleanly
// ("Iz Nobeard" teal, "ntrepid" lime). aa_*_mono variants were rejected
// — monospaced, produced only degenerate glyph matches. chatbox_10pt
// and chatbox_14pt were also tested and read poorly vs 12pt.
//
// The user's OWN slot (slot 1 red, in this user's case) does NOT read
// through OCR on this client — a clan title icon splits the name into
// "Aar [icon] i" regions with too little contiguous text for any font
// to recognise. Elimination handles self-slot detection for that case:
// when partyRoster[1+] match teammate slots, the unmatched slot is the
// user by definition.

// Per-slot text palettes. Names render in pure slot colour on this user's
// client (no near-black interior) — confirmed by eyedrops 2026-04-23:
//   slot 1 red  letter = rgb(153, 39, 0)
//   slot 2 teal letter = rgb(12, 75, 72)
// Each palette combines the reference peak (from SLOT_COLOR_KEYS comments),
// the user-eyedropped mid-tone, the chat-palette observed variants, and a
// darker edge variant — gives findReadLine multiple colour anchors per
// slot so anti-aliased letter strokes match across their full brightness
// range. Lime/yellow/pale use the documented reference peaks + a darker
// variant each, awaiting eyedrops if OCR garbles those slots later.
const SLOT_TEXT_PALETTES = {
  // Red letter cores (b≤2) + anti-alias mid-tones to dark-brown panel bg
  // (~[50, 46, 40]). Without the mid-tones, letter EDGES stay unmatched —
  // findReadLine sees disconnected pixel islands instead of letter shapes
  // and fails to recognise glyphs at all. Mid-tones span ~75%/50%/25%
  // along the gradient from letter-core to panel-bg.
  red:    [[210, 53, 0], [203, 52, 1], [192, 50, 2], [180, 45, 0], [153, 39, 0], [130, 34, 0],
           [125, 41, 10], [100, 45, 20], [ 75, 42, 25]],
  teal:   [[ 18, 84, 80], [  0, 137, 133], [  0, 176, 171], [ 12, 75, 72], [  0,  65,  60]],
  lime:   [[ 71, 125,  1], [ 52,  92,  1], [ 93, 170,   0], [ 45,  80,   0]],
  yellow: [[141, 145,  1], [123, 128,  0], [120, 125,   0], [100, 105,   0]],
  pale:   [[106, 130, 94], [ 85, 105, 75], [ 75,  92,  65]],
};

/**
 * OCR a single slot's name. Runs findReadLine against each candidate font
 * in parallel using the SLOT-SPECIFIC colour palette; returns all non-empty
 * reads as { font, text } tuples for the debug probe. Empty array when no
 * font produced a match. Called ONLY on the winning detection's filled
 * slots (not per-candidate during the detectByBgText search loop — that
 * would be ~3x wasted OCR work).
 *
 * `slotColor` is the canonical slot-colour key ('red' | 'teal' | 'lime' |
 * 'yellow' | 'pale') — selects the matching palette. Unknown colour → no
 * palette → empty result.
 */
/**
 * OCR a single slot's name using chatbox_12pt + slot-specific palette.
 * Returns the cleaned text string on success, `null` when findReadLine
 * fails or the result cleans to empty (very common for the local
 * user's slot when a clan title icon splits their name). The null
 * case is handled by the caller's elimination logic — see
 * detectSelfSlotFromPanel in index.js.
 *
 * Cleaning: the chatbox_12pt font happily matches anti-aliased edge
 * pixels as runs of `'` `.` `"` glyphs, producing output like
 * `"'''''''ironbergy''''''"` or `"Iz''.'Nobeard"`. Legitimate names
 * almost never contain consecutive 2+ of those characters, so we:
 *   - strip leading/trailing runs of `'` `.` `"` and whitespace
 *   - collapse interior runs of 2+ of the same set to a single space
 *   - normalise whitespace
 * A single `'` or `.` is preserved (e.g., "D'arby", "St. John").
 */
function ocrSlotName(screenData, centerX, slotY, slotColor, x0, y0) {
  const palette = SLOT_TEXT_PALETTES[slotColor];
  if (!palette || !palette.length) return null;
  try {
    // OCR.findReadLine operates in local-buffer coords (its bounds-check
    // and pixel index both use buf.width — see node_modules/alt1/src/
    // ocr/index.ts:256, 264). Translate centerX/slotY from absolute to
    // local so OCR sees a self-consistent local frame.
    const res = OCR.findReadLine(screenData, font_chatbox_12pt, palette, centerX - x0, slotY - y0);
    if (res && typeof res.text === 'string') {
      const cleaned = res.text
        .replace(/^[\s.'"]+|[\s.'"]+$/g, '')
        .replace(/[.'"]{2,}/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (cleaned) return cleaned;
    }
  } catch (_) { /* OOB / no match — silent */ }
  return null;
}

/**
 * Primary detection: anchor on a "Leave Party"-shaped button cluster
 * and sequence-match slot-colour rows above against SLOT_COLOR_BY_INDEX.
 *
 * Returns the standard result shape (see readPartyPanel docstring).
 * `origin.pitch` reflects the self-calibrated pitch measured from the
 * gaps between detected rows (defaults to ROW_PITCH_PX for solo).
 */
function detectByBgText(screenData, screen, region, x0, y0) {
  // x0, y0 = bind region's top-left in absolute screen coords. Threaded
  // through to helpers for absolute→local translation. peekForPartyButton
  // is local-coord-clean internally (does its own toData(x0, y0, w, h)
  // and iterates the resulting buffer in local coords) so it doesn't
  // need the threading.
  const buttons = peekForPartyButton(screen, region);
  if (!buttons.length) {
    return { found: false, reason: 'bg-text:no-buttons', detectionMethod: 'bg-text' };
  }

  // Iterate ALL peek candidates. Short labels like "Change"/"Reset"
  // will be rejected below by structural checks (no red-topmost slot
  // sequence above them), so no size filter needed. Compact-panel UI
  // renders even "Leave Party" at small hit counts (~5/bucket), making
  // any hit-based filter brittle; structural verify is stricter.
  let best = null;
  const tried = [];
  for (const btn of buttons) {
    const rows = scanSlotColorRowsAboveButton(screenData, btn, region, x0, y0);
    const tryInfo = {
      bx: btn.x, by: btn.y, bhits: btn.hits,
      rowsFound: rows.length,
      firstColor: rows[0] ? rows[0].color : null,
    };

    // The topmost detected row must be RED — that's the slot 1 host
    // signature. Any other top colour means this button isn't anchored
    // to a party-panel slot list (could be e.g. "Invite Player" above
    // an unrelated UI with teal/lime/yellow text).
    if (!rows.length || rows[0].color !== 'red') {
      tryInfo.reason = 'no-red-topmost';
      tried.push(tryInfo);
      continue;
    }

    const slot1Y = rows[0].y;
    const centerX = rows[0].centerX;

    // Self-calibrate pitch from consecutive row gaps when we have ≥2
    // rows (multi-person party). Solo falls back to ROW_PITCH_PX.
    // Median instead of mean → robust to one outlier gap (e.g., a
    // mid-slot empty row widening a measured gap).
    let pitch = ROW_PITCH_PX;
    if (rows.length >= 2) {
      const gaps = [];
      for (let i = 1; i < rows.length; i++) gaps.push(rows[i].y - rows[i - 1].y);
      gaps.sort((a, b) => a - b);
      const median = gaps[Math.floor(gaps.length / 2)];
      // Accept only if median is in a plausible pitch range. Outside
      // this range is likely due to detected rows spanning multiple
      // slots (e.g., gap = 2 * real pitch because slot 2 is empty).
      if (median >= 18 && median <= 32) pitch = median;
    }

    // Map each detected row to its slot index via expected Y. Mismatch
    // (detected row falls at slot i's expected Y but has the WRONG
    // colour) is a strong signal that this anchor is wrong — disqualify.
    const slots = [];
    let colorMatches = 0;
    let badPositions = 0;
    const pitchTolerance = Math.max(4, Math.floor(pitch / 3));
    for (let i = 0; i < SLOTS_PER_PANEL; i++) {
      const expected = SLOT_COLOR_BY_INDEX[i];
      const expectedY = slot1Y + i * pitch;
      let nearest = null;
      let nearestDist = Infinity;
      for (const r of rows) {
        const d = Math.abs(r.y - expectedY);
        if (d < nearestDist) { nearest = r; nearestDist = d; }
      }
      if (nearest && nearestDist <= pitchTolerance) {
        if (nearest.color === expected) {
          slots.push({ index: i, filled: true, color: expected });
          colorMatches++;
        } else {
          slots.push({ index: i, filled: false, color: expected });
          badPositions++;
        }
      } else {
        slots.push({ index: i, filled: false, color: expected });
      }
    }

    tryInfo.colorMatches = colorMatches;
    tryInfo.badPositions = badPositions;
    tryInfo.pitch = pitch;
    tried.push(tryInfo);

    if (badPositions > 0) continue;
    if (colorMatches < 1) continue;

    if (!best ||
        colorMatches > best.colorMatches ||
        (colorMatches === best.colorMatches && btn.hits > best.button.hits)) {
      best = { slot1Y, centerX, pitch, slots, colorMatches, button: btn, rows };
    }
  }

  if (!best) {
    return {
      found: false,
      reason: 'bg-text:no-valid-anchor',
      buttonCount: buttons.length,
      tried,
      detectionMethod: 'bg-text',
    };
  }

  // ---- Name OCR pass (Stage 0 probe) -----------------------------------
  // Run per-slot name OCR on the winning candidate only. Attaches
  // `nameOcrTries` to each filled slot so debug logging in index.js can
  // dump the results. Non-filled slots are skipped (nothing to read).
  //
  // Uses each slot's detected row centerX as the text anchor when
  // available, falling back to the candidate's overall centerX. Per-
  // slot centerX is more accurate because bimodal rows (portrait left,
  // name right) would pull the overall centroid off the name text.
  for (let i = 0; i < best.slots.length; i++) {
    const s = best.slots[i];
    if (!s.filled) continue;
    const slotY = best.slot1Y + i * best.pitch;
    const row = best.rows.find(r => Math.abs(r.y - slotY) <= Math.max(4, Math.floor(best.pitch / 3)));
    const cx = row ? row.centerX : best.centerX;
    s.name = ocrSlotName(screenData, cx, slotY, s.color, x0, y0);
  }

  return {
    found: true,
    origin: { x: best.centerX, y: best.slot1Y, pitch: best.pitch },
    // Reuse legacy field names so index.js debug-log format doesn't
    // need to branch on detection method.
    anchorHits: best.rows[0].count,
    anchorColor: 'red',
    anchorBgRatio: 100,
    anchorMultiSlot: 5,
    buttonY: best.button.y,
    buttonHits: best.button.hits,
    peekCandidates: buttons.length,
    candidatesTried: tried.length,
    slots: best.slots,
    detectionMethod: 'bg-text',
    pitchDetected: best.pitch,
    rowsDetected: best.rows.length,
  };
}

// ---- Diagnostic: all red clusters in the scan region ---------------------

/**
 * Scan the full panel-scan rectangle for red pixels and return the
 * top-K clusters by hit count. Purely diagnostic — called only when
 * detection fails, to surface where red pixels actually live so we can
 * tell whether (a) Aari's slot 1 is outside the expected button offset,
 * (b) the red isn't being classified at all, or (c) the panel simply
 * isn't visible.
 */
export function findAllRedClustersInScanRect(screenData, screen, topK = 8, region = null, bindX0 = 0, bindY0 = 0) {
  if (!screen) return [];
  // Scan-rect bounds (absolute screen coords) — what region the iteration
  // should cover.
  const { x0, y0, x1, y1 } = resolveScanRect(screen, region);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return [];

  const Y_BUCKET = 5;
  const buckets = new Map();
  const STEP = 2;

  // bindX0/bindY0 are the bind region's top-left in absolute coords. For
  // full-RS bind both are 0 (translation is identity). For Phase 7
  // regional bind, subtract from absolute (x, y) at getPixel to index
  // the smaller buffer. Centroid sums (sumX, sumY) accumulate ABSOLUTE
  // coords so cluster.x/y stay in absolute screen space — output
  // contract unchanged.
  for (let y = y0; y < y1; y += STEP) {
    for (let x = x0; x < x1; x += STEP) {
      const px = screenData.getPixel(x - bindX0, y - bindY0);
      if (!px) continue;
      if (classifySlotColor(px[0], px[1], px[2]) !== 'red') continue;
      const b = Math.floor(y / Y_BUCKET);
      let info = buckets.get(b);
      if (!info) {
        info = { count: 0, sumX: 0, sumY: 0, minX: Infinity, maxX: -Infinity };
        buckets.set(b, info);
      }
      info.count++;
      info.sumX += x;
      info.sumY += y;
      if (x < info.minX) info.minX = x;
      if (x > info.maxX) info.maxX = x;
    }
  }

  const clusters = [];
  for (const info of buckets.values()) {
    if (info.count < 3) continue;
    clusters.push({
      x: Math.round(info.sumX / info.count),
      y: Math.round(info.sumY / info.count),
      hits: info.count,
      // Horizontal span of the red cluster — critical for distinguishing
      // the slot-1-filled state (red icon at left + red name at right =
      // wide cluster) from the slot-1-empty state (red icon alone =
      // narrow cluster). The persistent decoration icon in slot 1 is
      // the reason raw hit-count and near-black-interior checks aren't
      // enough on their own.
      width: info.maxX - info.minX,
    });
  }
  clusters.sort((a, b) => b.hits - a.hits);
  return clusters.slice(0, topK);
}

// ---- Button peek ----------------------------------------------------------

/**
 * Scan the right-side UI region for horizontally-clustered warm-off-white
 * text pixels. Each passing cluster is a candidate BUTTON location —
 * primarily the "Leave Party" / "Form Party" text below the slot rows,
 * though other labels ("Change", "Reset") may also pass if their text
 * is long enough. The caller filters non-party-button candidates by
 * checking whether slot 1 red exists at the expected offset above.
 *
 * Returns a list of { x, y, hits } sorted TOP-TO-BOTTOM. Empty list if
 * nothing qualifies.
 */
export function peekForPartyButton(screen, region = null) {
  if (!screen) return [];

  const { x0, x1, y0, y1 } = resolveScanRect(screen, region);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return [];

  let data;
  try { data = screen.toData(x0, y0, w, h); }
  catch (_) { return []; }

  // Bucket hits by Y (5-px buckets). Button text is ~8-12 px tall; we
  // sample at STEP=3 which gives ~3-4 hits per character. A button with
  // 10 characters produces ~30-40 hits.
  const Y_BUCKET = 5;
  const hitsByY = new Map();
  const STEP = 3;

  for (let y = 0; y < h; y += STEP) {
    for (let x = 0; x < w; x += STEP) {
      const px = data.getPixel(x, y);
      if (!px) continue;
      if (!isButtonTextOutline(px[0], px[1], px[2])) continue;

      const absX = x0 + x;
      const absY = y0 + y;
      const bucket = Math.floor(absY / Y_BUCKET);
      let info = hitsByY.get(bucket);
      if (!info) {
        info = { count: 0, sumX: 0, sumY: 0 };
        hitsByY.set(bucket, info);
      }
      info.count++;
      info.sumX += absX;
      info.sumY += absY;
    }
  }

  // Promote buckets with ≥ 3 hits to candidates. Thin text on compact
  // panels produces as few as 3-4 core pixels per Y bucket; setting a
  // higher floor here filters legit candidates. False positives from
  // 3-pixel noise clusters are handled downstream: detectByBgText
  // rejects candidates that don't have a valid slot-colour sequence
  // above them, so size-filtering isn't the last line of defence.
  const raw = [];
  for (const [, info] of hitsByY) {
    if (info.count < 3) continue;
    raw.push({
      y: Math.round(info.sumY / info.count),
      x: Math.round(info.sumX / info.count),
      hits: info.count,
    });
  }
  raw.sort((a, b) => a.y - b.y);

  // Merge adjacent Y-buckets — button text can span 2 buckets, and the
  // peek's weighted centroid would otherwise produce two candidates for
  // the same button.
  const merged = [];
  for (const r of raw) {
    const prev = merged[merged.length - 1];
    if (prev && r.y - prev.y < 7) {
      const total = prev.hits + r.hits;
      prev.x = Math.round((prev.x * prev.hits + r.x * r.hits) / total);
      prev.y = Math.round((prev.y * prev.hits + r.y * r.hits) / total);
      prev.hits = total;
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

// ---- Public read entry point ---------------------------------------------

/**
 * Read the party panel. Returns:
 *   { found: true, origin, slots: [...], buttonY, anchorHits, ... }  on success
 *   { found: false, reason, ... }                                     on failure
 *
 * Slots shape (always length 5):
 *   [{ index, filled, color }, ...]
 * `color` is always the expected colour for that slot index (red, teal,
 * lime, yellow, pale). `filled` is true iff that colour is present at
 * the slot's row.
 *
 * Dispatches to two detection paths:
 *   1. detectByBgText — new primary path, anchored on panel-BG column +
 *      topmost near-black text. Robust to slot-1 red cluster width
 *      flicker that caused the old path to drop the panel tick-to-tick.
 *   2. detectByRedCluster — legacy fallback. Retained so we don't
 *      regress in edge cases the new path hasn't been battle-tested on
 *      yet. Can be removed once the new path is proven in production.
 * Result carries `detectionMethod: 'bg-text' | 'red-cluster'` so debug
 * logs can show which path succeeded.
 */
export function readPartyPanel({ screen: providedScreen, region } = {}) {
  if (!window.alt1) return { found: false, reason: 'not-in-alt1' };

  let screen = providedScreen;
  let effectiveRegion = region;
  if (!screen) {
    // Phase 7 Target 1: regional bind. Resolve scan rect against full-RS
    // dims FIRST (alt1.rsWidth/rsHeight — constant, no bind needed), then
    // captureHold only that region. Drops pixel-data per fire from ~100%
    // of screen to ~28% (default panelScanRect = right 40% × middle 70%).
    // bindRegion cost is region-proportional (Phase 5/6 finding) so this
    // is a real CPU win.
    const dims = { width: alt1.rsWidth, height: alt1.rsHeight };
    const rect = resolveScanRect(dims, region);
    const w = rect.x1 - rect.x0;
    const h = rect.y1 - rect.y0;
    try { screen = a1lib.captureHold(rect.x0, rect.y0, w, h); }
    catch (_) { return { found: false, reason: 'capture-threw' }; }
    if (!screen) return { found: false, reason: 'capture-null' };
    // Synthesize an explicit region so downstream helpers don't fall
    // back to panelScanRect(screen) — that fraction math would compute
    // sub-fractions of the regional bind's width/height, not full-RS.
    if (!effectiveRegion) {
      effectiveRegion = { x: rect.x0, y: rect.y0, w, h };
    }
  }

  let screenData;
  // toData uses absolute coords (subtracts bind's x/y internally — see
  // node_modules/alt1/src/base/imgref.ts:31). Calling with screen.x/y
  // returns the full bound region. Works identically for full-RS bind
  // (screen.x=screen.y=0) and regional bind (screen.x/y = rect origin).
  try { screenData = screen.toData(screen.x, screen.y, screen.width, screen.height); }
  catch (_) { return { found: false, reason: 'toData-threw' }; }

  // Bind offset for absolute→local coord translation in the helpers.
  // Full-RS bind: x0=y0=0, translation is identity, all math unchanged.
  // Regional bind: x0/y0 = rect origin, helpers subtract from absolute
  // coords to index into the smaller buffer correctly.
  const x0 = screen.x;
  const y0 = screen.y;

  // Primary path (user-calibrated region if provided, else default scan rect).
  const primary = detectByBgText(screenData, screen, effectiveRegion, x0, y0);
  if (primary.found) return primary;

  // Fallback to legacy red-cluster detection.
  const fallback = detectByRedCluster(screenData, screen, effectiveRegion, x0, y0);
  if (fallback.found) {
    fallback.detectionMethod = 'red-cluster';
    fallback.primaryReason = primary.reason;
    return fallback;
  }

  // Both failed — return primary's miss with fallback reason for diagnostics.
  return {
    ...primary,
    fallbackReason: fallback.reason,
    fallbackCandidatesTriedCount: fallback.candidatesTriedCount,
    fallbackCandidatesTried: fallback.candidatesTried,
    fallbackRedClusters: fallback.redClusters,
    peekCandidates: fallback.peekCandidates,
    candidatesTriedCount: fallback.candidatesTriedCount,
    candidatesTried: fallback.candidatesTried,
    redClusters: fallback.redClusters,
  };
}

function detectByRedCluster(screenData, screen, region, x0, y0) {
  // x0, y0 = bind region's top-left in absolute screen coords. Threaded
  // to helpers for absolute→local translation (full-RS bind: 0/0 →
  // identity; regional bind: rect origin).
  // Stage 1: find all red clusters in the scan region, ranked by hit count.
  // The strongest cluster is our primary slot-1 candidate.
  const redClusters = findAllRedClustersInScanRect(screenData, screen, 12, region, x0, y0);
  if (!redClusters.length) {
    return { found: false, reason: 'no-red' };
  }

  // Minimum horizontal span of the slot-1 red cluster. With the tight
  // red classifier (b ≤ 10), the RoK icon no longer contributes pixels
  // to the cluster, so cluster width is NAME-TEXT-ONLY rather than
  // icon+name combined. Short names ("Aari" ≈ 30-40 px wide) fell
  // below the old 80 px gate and got rejected as cluster-too-narrow
  // even when legitimately filled. 30 accepts realistic short names
  // while staying above empty-slot width (now zero since icon doesn't
  // classify at all). The compensating cluster-level
  // hasNearBlackInterior gate below rejects world-red false positives
  // that the wider 80 gate used to filter implicitly.
  const MIN_SLOT1_CLUSTER_WIDTH = 30;

  // Stage 2: for each red cluster (strongest first), verify that a panel
  // sits below it by checking 5 rows of panel-BG at 22-px pitch. Real
  // panels score 5/5; world red / random UI rarely scores 4+.
  const candidatesTried = [];
  for (const cluster of redClusters) {
    // Width gate — with the tight red classifier, slot 1 is "filled"
    // iff there's name-text red; the icon contributes nothing. 30 px
    // accepts short names; empty slots produce zero-wide clusters
    // (no red pixels at all under the tight rule).
    if (cluster.width < MIN_SLOT1_CLUSTER_WIDTH) {
      candidatesTried.push({
        x: cluster.x, y: cluster.y, hits: cluster.hits,
        width: cluster.width,
        multiSlot: 0, bgRatio: 0,
        reason: 'cluster-too-narrow',
      });
      continue;
    }

    // Cluster-level near-black gate. Supplements the lowered width
    // threshold: a real slot-1 name row has near-black letter
    // interiors at the cluster's Y; random world-red objects (attack
    // cursors, red UI chrome elsewhere) don't. Before the classifier
    // tightening, the 80 px width gate filtered these implicitly.
    // Checking here instead of per-slot keeps the expensive multi-slot
    // BG verify from running on obvious non-panel clusters.
    if (!hasNearBlackInterior(screenData, cluster.x, cluster.y, undefined, x0, y0)) {
      candidatesTried.push({
        x: cluster.x, y: cluster.y, hits: cluster.hits,
        width: cluster.width,
        multiSlot: 0, bgRatio: 0,
        reason: 'no-text-at-cluster',
      });
      continue;
    }

    let multiSlot = 0;
    let anchorBgRatio = 0;
    for (let i = 0; i < SLOTS_PER_PANEL; i++) {
      const rowY = cluster.y + i * ROW_PITCH_PX;
      // Bounds check in absolute Y — buffer spans [y0..y0+h).
      if (rowY >= y0 + screenData.height - 2) break;
      const check = verifyPanelBgAtDetailed(screenData, cluster.x, rowY, x0, y0);
      if (check.verified) multiSlot++;
      if (i === 0) anchorBgRatio = check.bgRatio;
    }

    candidatesTried.push({
      x: cluster.x, y: cluster.y, hits: cluster.hits,
      width: cluster.width,
      bgRatio: Math.round(anchorBgRatio * 100),
      multiSlot,
      accepted: multiSlot >= 4,
    });

    if (multiSlot < 4) continue;

    // Stage 3: check each slot for its expected colour AND text interior.
    // A slot is filled only if both are present — the outline colour
    // alone isn't enough (persistent decorations in empty slots may
    // match a slot's outline colour but have no letter-body interior).
    const slots = [];
    for (let i = 0; i < SLOTS_PER_PANEL; i++) {
      const expected = SLOT_COLOR_BY_INDEX[i];
      const slotY = cluster.y + i * ROW_PITCH_PX;
      // Bounds check in absolute Y — buffer spans [y0..y0+h).
      if (slotY >= y0 + screenData.height - 2) {
        slots.push({ index: i, filled: false, color: expected });
        continue;
      }
      // Client-agnostic filled check. Two client renderings coexist:
      //   (a) Slot-colour OUTLINE around letters + near-black letter INTERIOR.
      //       Requires both colour + near-black together to count.
      //   (b) Slot-colour TEXT (no near-black interior). Requires dense slot
      //       colour presence (≥10 hits) to distinguish a name from a
      //       decoration icon that would only contribute a few colour pixels.
      const filled =
        hasSlotColor(screenData, cluster.x, slotY, expected, 10, x0, y0) ||
        (hasSlotColor(screenData, cluster.x, slotY, expected, undefined, x0, y0) &&
         hasNearBlackInterior(screenData, cluster.x, slotY, undefined, x0, y0));
      slots.push({ index: i, filled, color: expected });
    }

    // If no slot survived the outline+interior check, this red cluster
    // corresponds to decoration or stale chrome, not a real party. Skip
    // to the next candidate.
    if (!slots.some(s => s.filled)) {
      candidatesTried[candidatesTried.length - 1].accepted = false;
      candidatesTried[candidatesTried.length - 1].reason = 'zero-filled-after-interior';
      continue;
    }

    // Optional: find a button below the anchor as a secondary confirmation
    // signal. Not required for acceptance — many layouts / states render
    // the button text in shades my classifier doesn't pick up — but when
    // present it's useful diagnostic data. Pass the calibrated region
    // through so the button search stays bounded to the same area.
    const buttons = peekForPartyButton(screen, region);
    let matchingButton = null;
    for (const b of buttons) {
      if (b.y > cluster.y + 80 && b.y < cluster.y + 250) {
        matchingButton = b;
        break;
      }
    }

    return {
      found: true,
      origin: { x: cluster.x, y: cluster.y, pitch: ROW_PITCH_PX },
      anchorHits: cluster.hits,
      anchorColor: 'red',
      anchorBgRatio: Math.round(anchorBgRatio * 100),
      anchorMultiSlot: multiSlot,
      buttonY: matchingButton ? matchingButton.y : null,
      buttonHits: matchingButton ? matchingButton.hits : 0,
      peekCandidates: redClusters.length,
      candidatesTried: candidatesTried.length,
      slots,
    };
  }

  // No red cluster passed the panel-BG verification.
  return {
    found: false,
    reason: 'no-valid-red',
    peekCandidates: redClusters.length,
    candidatesTried,
    candidatesTriedCount: candidatesTried.length,
    redClusters,
  };
}
