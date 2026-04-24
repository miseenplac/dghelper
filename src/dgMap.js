// DG map reader — Phase 1b.1 locator.
//
// Goal: find the RS3 Dungeoneering 8×8 map widget on screen and derive its
// grid geometry (origin + cell pitch). Read-only for now — no classification,
// no UI, no tracker integration. Just prove the locator produces stable
// {origin, pitch} across ticks so Phase 1b.2+ can build on it.
//
// ARCHITECTURE — beige-cluster auto-derivation
//
// Flow:
//   1. scanBeigeInRegion — sparse STEP=3 scan; classify each sample as
//      OPENED-room beige, ADJACENT-? room beige, or neither. Collect hits.
//   2. clusterHits — union-find on hit distance. Two hits in the same
//      cluster when their Euclidean distance ≤ MERGE_DIST. Each cluster
//      corresponds to one map cell's interior pixels.
//   3. derivePitch — pairwise centre-to-centre distances between clusters
//      on each axis. The minimum non-zero distance IS the pitch by
//      connectivity (adjacent cells are pitch apart; same-row/col cells
//      have dx=0 or dy=0; multi-cell gaps are integer multiples of pitch).
//   4. origin = top-leftmost cluster's (minX, minY). This may shift NW
//      over the course of a floor as exploration exposes cells that were
//      previously transparent — downstream code (Phase 1b.4 wiring) will
//      need to anchor on a floor-stable reference (ladder cell) rather
//      than this local origin, but the locator itself just reports what
//      it sees.
//
// Both beige states are cell-valid for locator purposes. At floor start
// we typically see 1 opened (base room) + 2-4 adjacent ?-rooms = 3-5
// clusters to work with. Strict R/G/B ranges per user-eyedrop data (the
// only currently-accepted source of palette truth — no intuition-based
// widening).
//
// Public API:
//   findDgMap({screen?, region?}) → { found, origin, pitch, ... }
//   isOpenedBeige(r, g, b), isAdjacentQBeige(r, g, b)
//   DG_MAP_PALETTE — reference RGBs (verbatim from user handoff)

import * as a1lib from 'alt1/base';

// ---- Palette reference ----------------------------------------------------
// All RGBs here are from user-eyedrop samples (via memoryerror or the
// plugin's Eyedrop button). Do not widen ranges on intuition — require
// additional eyedrop evidence. Only `isOpenedBeige` / `isAdjacentQBeige`
// are used in 1b.1; the rest is documentation for phases 1b.2+.
export const DG_MAP_PALETTE = Object.freeze({
  // Opened-room fill: bright beige core with darker edge/detail pixels.
  // The strict isOpenedBeige range below accepts the CORE only; edges fall
  // outside and form natural cluster separators between adjacent cells.
  openedCore:  [[140, 105, 52], [137, 102, 50], [123, 91, 45]],
  openedEdges: [[ 59,  40, 14], [105,  77, 36], [112, 82, 38]],

  // Unopened-but-adjacent (?) rooms: same hue family, noticeably dimmer.
  // Distinct from opened-core by R channel (≤100 vs ≥123).
  adjacentQ:   [[ 83,  60, 27], [100,  73, 35], [ 93, 68, 33]],

  // ? glyph drawn on adjacent-? rooms — brighter tan, not used by the
  // locator but referenced for 1b.2 cell classification.
  qGlyph:      [[170, 140, 82]],

  // Base ladder icon — unique per floor, marks the spawn cell. Distinctive
  // R ≈ G > B profile. Not used by the locator but will be by 1b.4 wiring
  // (ladder = floor-stable anchor for relative cell coordinates).
  ladder:      [[150, 145, 105], [138, 133, 96]],

  // Boss icon (dark red). B ≥ 13 distinguishes it from slot-1 player
  // triangles (B ≤ 5). May be partially occluded by triangles when
  // players stand in the boss room — detector must tolerate partial hits.
  boss:        [[ 88,  27, 18], [ 63,  20, 13], [ 39, 32, 17]],

  // Player triangle peaks, keyed by slot colour. Same hue families as the
  // name-outline palette in partyPanel.js but different exact RGBs, so
  // reuse classifySlotColor's HUE LOGIC in 1b.3 but NOT its thresholds
  // verbatim. Slot 5 (pale) is the desaturated case — mirror the pale
  // rule in partyPanel.js (r*4 >= g*3, g-b >= 8) to avoid beige collisions.
  triangles: {
    red:    [[135, 34,   0], [ 88, 27, 18], [ 63, 20, 13]],
    teal:   [[  0, 176, 171], [  0, 138, 134]],
    lime:   [[ 93, 170,   0], [ 73, 130,   0]],
    yellow: [[141, 151,   0], [123, 128,   0]],
    pale:   [[ 75,  92,  65], [ 51,  61,  46], [ 46,  53, 41]],
  },
});

// ---- Beige classification -------------------------------------------------
// Strict R/G/B ranges per user spec. Edge pixels (R 59-112 with G < 91 or
// R between opened/? ranges) fall outside both filters — this is the design,
// not a bug. Edges act as cluster separators.

export function isOpenedBeige(r, g, b) {
  return r >= 123 && r <= 140 &&
         g >=  91 && g <= 105 &&
         b >=  45 && b <=  52;
}

export function isAdjacentQBeige(r, g, b) {
  return r >=  83 && r <= 100 &&
         g >=  60 && g <=  73 &&
         b >=  27 && b <=  35;
}

// Ladder icon — khaki, R ≈ G > B. Drawn INSIDE the base (opened) cell
// and NOT classified as opened-beige. Without including it here, its
// pixels create a hole in the base cell's beige cluster, splitting it
// into sub-clusters whose within-cell gap (~12 px across the icon) gets
// read as the pitch. Including here means ladder pixels join their
// cell's cluster and don't cause the split.
export function isLadderKhaki(r, g, b) {
  return r >= 130 && r <= 160 &&
         g >= 125 && g <= 150 &&
         b >=  85 && b <= 115 &&
         Math.abs(r - g) <= 15 &&
         g > b + 15;
}

// "?" glyph drawn inside adjacent-unopened rooms — brighter tan, R > G > B.
// Same split-the-cluster risk as the ladder icon above; folding it into
// cell-content classification keeps `?`-rooms as single clusters.
//
// The `r - g >= 15` gate enforces a stronger orange tint than ladder
// highlights or antialiased beige edges — reference glyph `(170,140,82)`
// has r-g=30 with headroom, while ladder highlights like `(155,150,120)`
// have r-g=5 and get rejected. Without this gate, opened cells
// containing ladder / wall detail gradients get spuriously flagged with
// `?glyph` icons in classifyCellContents.
export function isQGlyph(r, g, b) {
  return r >= 155 && r <= 185 &&
         g >= 125 && g <= 155 &&
         b >=  70 && b <=  95 &&
         r - g >= 15;
}

/**
 * True if the pixel belongs to any cell-fill class (opened beige,
 * adjacent-? beige, ladder icon, or ?-glyph). Used by the locator's
 * clustering — we care that pixels "belong to a cell", not which
 * specific fill they are.
 *
 * Edge pixels (darker beige-browns, RGB e.g. (59,40,14)) are NOT in
 * any class here — they remain natural cluster separators between
 * adjacent cells.
 *
 * Type-specific classification (opened vs ?-room vs base) belongs to
 * Phase 1b.2, where a per-cluster breakdown of type proportions tells
 * us what's in each cell.
 */
export function isCellFill(r, g, b) {
  return isOpenedBeige(r, g, b) ||
         isAdjacentQBeige(r, g, b) ||
         isLadderKhaki(r, g, b) ||
         isQGlyph(r, g, b);
}

// ---- Triangle + boss-icon classifiers (Phase 1b.3) ------------------------
//
// Triangle RGBs come from DG_MAP_PALETTE.triangles (user-eyedrop data in
// the original handoff). These are DIFFERENT from the name-outline palette
// in partyPanel.js — they're the peak RGBs sampled from the down-pointing
// triangles drawn ON TOP of beige cells in the DG map widget.
//
// Key discriminator between slot 1 RED triangle and BOSS ICON (both red-
// family): B channel. Slot 1 triangle peak is (135, 34, 0) — B=0. Boss
// icon pixels are (88, 27, 18), (63, 20, 13), (39, 32, 17) — B ≥ 10.
// Classifying the peak core with B ≤ 5 keeps triangles separate even when
// they sit on top of a boss icon (partial occlusion case per handoff).
//
// Pale (slot 5) is the desaturation-hardest case. Reuses the same
// r*4 >= g*3 / g-b >= 8 family rule shape that partyPanel.js uses for
// slot-5 name outlines, re-tuned to the triangle RGBs (75, 92, 65),
// (51, 61, 46), (46, 53, 41).

/**
 * Classify a pixel as one of the 5 triangle slot colours, or null.
 * Boss icon pixels are deliberately NOT classified here — use isBossPixel
 * separately. If a pixel matches a boss RGB, classifyTrianglePixel returns
 * null; isBossPixel returns true.
 */
export function classifyTrianglePixel(r, g, b) {
  // Slot 1 red triangle — B ≤ 5 separates from boss icon (boss has
  // b≥10 on all three of its tiers).
  // Upper r bound was 155 (matching the original reference peak 135),
  // widened to 185 after a user's client rendered the triangle's bright
  // core at r≈174. Lower r bound widened from 120 to 100 after another
  // floor's rendering produced triangle tips at r≈111 — bright core
  // still matched (r=135 at the eyedropped core), but the dim tip fell
  // below the old 120 floor, shrinking per-cell matching pixel count
  // below TRIANGLE_MIN_PIXELS and causing "no red triangle in fresh DG
  // map read" misses. Still safely below any other slot's red-family
  // range (yellow triangle needs g≥120; orange isn't a DG triangle
  // colour; boss tops out at r=100 but is excluded by the b≥10 gate).
  if (r >= 100 && r <= 185 && g >= 20 && g <= 50 && b <= 5 && r > g * 2) {
    return 'red';
  }
  // Slot 2 teal — R very low, G high, B high, G ≈ B.
  if (r <= 15 && g >= 130 && g <= 190 && b >= 125 && b <= 180 &&
      Math.abs(g - b) <= 15) {
    return 'teal';
  }
  // Slot 3 lime — R mid, G high, B near 0. G > R to exclude yellows.
  if (r >= 60 && r <= 110 && g >= 115 && g <= 180 && b <= 5 && g > r) {
    return 'lime';
  }
  // Slot 4 yellow — R ≈ G both high, B near 0.
  if (r >= 115 && r <= 155 && g >= 120 && g <= 160 && b <= 5 &&
      Math.abs(r - g) <= 15) {
    return 'yellow';
  }
  // Slot 5 pale — desaturated G-dominant with tight family ratios.
  if (g >= r && r >= b && b >= 35 && g >= 50 && g <= 100 &&
      r >= 40 && r <= 85 && g - b >= 8 && r * 4 >= g * 3 && g - r <= 20) {
    return 'pale';
  }
  return null;
}

/**
 * True for the three sampled boss-icon RGB tiers ((88,27,18), (63,20,13),
 * (39,32,17)). All have B ≥ 10, which is what separates them from the
 * slot-1 triangle's B ≤ 5 peak core. Called AFTER classifyTrianglePixel
 * in per-cell classification so triangle pixels don't double-count.
 */
export function isBossPixel(r, g, b) {
  if (r >= 75 && r <= 100 && g >= 15 && g <= 35 && b >= 13 && b <= 22) return true;
  if (r >= 50 && r <= 75 && g >= 15 && g <= 30 && b >= 10 && b <= 18) return true;
  if (r >= 30 && r <= 55 && g >= 25 && g <= 40 && b >= 12 && b <= 22) return true;
  return false;
}

/**
 * Broader cell-content predicate — returns true if the pixel's colour falls
 * in any class that can appear INSIDE a rendered map cell: beige fills
 * (opened / adjacent-?), cell icons (ladder, ?-glyph, boss), or player
 * triangles overlaid on cells.
 *
 * Used by clusterHits' line-sampling gap check to decide whether a pixel
 * between two candidate-merge hits is "interior" (keep merging) or "border
 * gap" (split). Includes boss + triangle on top of the narrower isCellFill
 * set because icon/triangle pixels legitimately sit in a cell's interior —
 * excluding them would cause single cells containing an icon or player
 * marker to split along the icon's outline.
 */
function isInsideCell(r, g, b) {
  return isOpenedBeige(r, g, b) ||
         isAdjacentQBeige(r, g, b) ||
         isLadderKhaki(r, g, b) ||
         isQGlyph(r, g, b) ||
         isBossPixel(r, g, b) ||
         classifyTrianglePixel(r, g, b) !== null;
}

// Per-class thresholds for a cell to "contain" that feature. Calibrated
// against STEP=2 sampling across a pitch-sized cell (225 samples for
// pitch=30). Triangles are ~8-10 px across → ~13-20 samples; 5 is a
// safe floor with margin against anti-alias variance.
const TRIANGLE_MIN_PIXELS = 5;
const BOSS_MIN_PIXELS     = 5;
const LADDER_MIN_PIXELS   = 3;
const QGLYPH_MIN_PIXELS   = 3;
const CELL_FILL_MIN_PIXELS = 10; // sanity floor for cell-type classification
const CELL_SCAN_STEP = 2;

/**
 * Classify everything inside a single cell at a given grid position.
 * Samples a pitch-sized square centred on (cellCenterX, cellCenterY) at
 * CELL_SCAN_STEP density, counts hits per class, and returns a structured
 * summary.
 *
 * Returns:
 *   {
 *     triangles: Set<'red'|'teal'|'lime'|'yellow'|'pale'>,
 *     hasLadder: boolean,
 *     hasBoss:   boolean,
 *     hasQGlyph: boolean,
 *     type:      'opened' | 'q' | 'unexplored',
 *     counts:    { red, teal, lime, yellow, pale, opened, q, ladder,
 *                  qglyph, boss, total }  — diagnostic only
 *   }
 *
 * Triangle pixels are counted BEFORE boss / fill pixels so overlapping
 * triangles on a boss room get attributed correctly (each triangle's
 * peak pixels pull it out of the red-family ambiguity with the boss).
 */
export function classifyCellContents(screenData, cellCenterX, cellCenterY, pitch) {
  const half = Math.floor(pitch / 2);
  const xMin = Math.max(0, cellCenterX - half);
  const xMax = Math.min(screenData.width - 1, cellCenterX + half);
  const yMin = Math.max(0, cellCenterY - half);
  const yMax = Math.min(screenData.height - 1, cellCenterY + half);

  const counts = {
    opened: 0, q: 0, ladder: 0, qglyph: 0, boss: 0,
    red: 0, teal: 0, lime: 0, yellow: 0, pale: 0,
    total: 0,
  };

  // Track pixel centroid for each slot colour so consumers (notably
  // the overlay renderer) can anchor icons to the TRIANGLE'S actual
  // pixel position rather than the cell centre. Triangles don't sit
  // at a fixed spot in the cell — their location depends on where
  // the player is in the room — so icon placement must follow the
  // triangle, not assume a top-left anchor.
  const centroidSums = {
    red:    { x: 0, y: 0 },
    teal:   { x: 0, y: 0 },
    lime:   { x: 0, y: 0 },
    yellow: { x: 0, y: 0 },
    pale:   { x: 0, y: 0 },
  };

  for (let y = yMin; y <= yMax; y += CELL_SCAN_STEP) {
    for (let x = xMin; x <= xMax; x += CELL_SCAN_STEP) {
      const px = screenData.getPixel(x, y);
      if (!px) continue;
      counts.total++;
      const r = px[0], g = px[1], b = px[2];

      // Triangle pixels take precedence — they render ON TOP of fills
      // and boss icon. Classify first; continue to next pixel on hit so
      // each pixel counts in at most one bucket.
      const tri = classifyTrianglePixel(r, g, b);
      if (tri) {
        counts[tri]++;
        centroidSums[tri].x += x;
        centroidSums[tri].y += y;
        continue;
      }

      // Boss icon (only if not already a triangle pixel).
      if (isBossPixel(r, g, b)) { counts.boss++; continue; }

      // Cell fills (exclusive).
      if (isOpenedBeige(r, g, b))      counts.opened++;
      else if (isAdjacentQBeige(r, g, b)) counts.q++;
      else if (isLadderKhaki(r, g, b)) counts.ladder++;
      else if (isQGlyph(r, g, b))      counts.qglyph++;
    }
  }

  const triangles = new Set();
  const triangleCentroids = {};
  for (const color of ['red', 'teal', 'lime', 'yellow', 'pale']) {
    if (counts[color] >= TRIANGLE_MIN_PIXELS) {
      triangles.add(color);
      triangleCentroids[color] = {
        x: Math.round(centroidSums[color].x / counts[color]),
        y: Math.round(centroidSums[color].y / counts[color]),
      };
    }
  }

  const hasLadder = counts.ladder >= LADDER_MIN_PIXELS;
  const hasBoss   = counts.boss   >= BOSS_MIN_PIXELS;
  const hasQGlyph = counts.qglyph >= QGLYPH_MIN_PIXELS;

  // Cell type: dominant fill, with icon/triangle fallback. Beige-pixel
  // count is the primary signal, but under-detection — e.g. the red
  // triangle covers most of the cell's beige fill and drives the
  // opened-beige count below CELL_FILL_MIN_PIXELS — would otherwise
  // mis-label a real room as unexplored. Game mechanics guarantee
  // triangles/ladders/boss only render on OPENED cells and ?-glyphs
  // only on ?-rooms, so any of those hitting the min-pixels threshold
  // is sufficient to override the beige-based type decision.
  let type;
  if (counts.opened + counts.ladder >= CELL_FILL_MIN_PIXELS) type = 'opened';
  else if (counts.q + counts.qglyph >= CELL_FILL_MIN_PIXELS)  type = 'q';
  else if (triangles.size > 0 || hasLadder || hasBoss)        type = 'opened';
  else if (hasQGlyph)                                          type = 'q';
  else                                                         type = 'unexplored';

  return { triangles, triangleCentroids, hasLadder, hasBoss, hasQGlyph, type, counts };
}

/**
 * Classify all cells in a 15×15 window around the given origin (±7 cells
 * from origin on each axis). Origin is treated as col/row (0,0) — the
 * top-left of the LOCATOR's top-left detected cluster, NOT necessarily
 * the 8×8 grid's true (0,0). Per-cell keys are `"col,row"` strings where
 * col/row are signed offsets from origin (e.g., "1,0" = one cell east,
 * "0,-1" = one cell north).
 *
 * Only cells with detected content (type !== 'unexplored' OR any triangle/
 * icon/glyph) are included in the returned map — "unexplored" cells just
 * show world pixels through the transparent overlay and aren't interesting
 * to the map widget.
 *
 * Returns: { [colRowKey]: { col, row, ...classifyCellContents result } }
 */
export function classifyAllCells(screenData, origin, pitch, range = 7, region = null) {
  const cells = {};
  const half = Math.floor(pitch / 2);
  // Region clamp (optional). When a calibrated region is provided,
  // cells whose centres fall outside it are skipped — prevents world
  // pixels outside the calibrated map box from producing false cell
  // classifications. The ±range scan window can easily extend past
  // the 8×8 widget when origin sits near the widget edge.
  const rx0 = region ? Math.max(0, Math.floor(region.x)) : 0;
  const ry0 = region ? Math.max(0, Math.floor(region.y)) : 0;
  const rx1 = region
    ? Math.min(screenData.width  - 1, rx0 + Math.floor(region.w))
    : screenData.width  - 1;
  const ry1 = region
    ? Math.min(screenData.height - 1, ry0 + Math.floor(region.h))
    : screenData.height - 1;
  for (let row = -range; row <= range; row++) {
    for (let col = -range; col <= range; col++) {
      const cx = origin.x + col * pitch + half;
      const cy = origin.y + row * pitch + half;
      if (cx < rx0 + half || cy < ry0 + half) continue;
      if (cx > rx1 - half || cy > ry1 - half) continue;
      if (cx < half || cy < half) continue;
      if (cx >= screenData.width - half || cy >= screenData.height - half) continue;
      const cell = classifyCellContents(screenData, cx, cy, pitch);
      // Only include cells with actual map-widget content (opened or q).
      // By game mechanics, triangles and boss/ladder/qglyph icons ONLY
      // render on cells with beige fill — they can't appear on unexplored
      // cells where the overlay is fully transparent. Any triangle/icon
      // hit on an unexplored cell is therefore a world-pixel false
      // positive.
      if (cell.type !== 'unexplored') {
        cells[`${col},${row}`] = { col, row, ...cell };
      }
    }
  }
  return cells;
}

// ---- Scan region defaults -------------------------------------------------
// User confirmed: "left side is more common". UNKNOWN-state scan starts on
// the left half; if it misses, the caller (runDgMapRead) retries on full
// screen. LOCKED-state uses a narrow region passed explicitly — caller
// computes it from last-known origin/pitch.

function defaultLeftRegion(screen) {
  return {
    x: 0,
    y: Math.floor(screen.height * 0.10),
    w: Math.floor(screen.width  * 0.50),
    h: Math.floor(screen.height * 0.80),
  };
}

// ---- Pixel scan -----------------------------------------------------------
// STEP = 3 samples every 3 px on each axis. For expected cell pitch ~25-40
// px, that's ~8×8 = 64 samples per cell interior — plenty for clustering
// while keeping scan cost bounded.
//
// Returns a flat array of { x, y, type } where type is 'opened' or 'q'.

const SCAN_STEP = 3;

function scanBeigeInRegion(screenData, region) {
  const hits = [];
  const xMax = Math.min(screenData.width  - 1, region.x + region.w);
  const yMax = Math.min(screenData.height - 1, region.y + region.h);
  for (let y = region.y; y < yMax; y += SCAN_STEP) {
    for (let x = region.x; x < xMax; x += SCAN_STEP) {
      const px = screenData.getPixel(x, y);
      if (!px) continue;
      const r = px[0], g = px[1], b = px[2];
      // Accept ANY in-cell content type: beige fills (opened / ?-room),
      // ladder icon, ?-glyph, BOSS icon, AND player TRIANGLES. Without
      // triangles in this set, a triangle rendered on top of a cell's
      // beige fill punches a ~12 px hole in the cluster — adjacent beige
      // pixels on each side of the triangle form two sub-clusters, and
      // the gap between them gets mis-read as the pitch (pitch=14 in a
      // map with real pitch=40). Per the game's mechanics (triangles/
      // icons render ONLY on opened/? cells), including them here is
      // safe: they can't produce false clusters in world areas because
      // world pixels wouldn't aggregate into cell-shaped regions anyway.
      if (isOpenedBeige(r, g, b))      hits.push({ x, y, type: 'opened' });
      else if (isAdjacentQBeige(r, g, b)) hits.push({ x, y, type: 'q' });
      else if (isLadderKhaki(r, g, b)) hits.push({ x, y, type: 'ladder' });
      else if (isQGlyph(r, g, b))      hits.push({ x, y, type: 'qglyph' });
      else if (isBossPixel(r, g, b))   hits.push({ x, y, type: 'boss' });
      else if (classifyTrianglePixel(r, g, b)) hits.push({ x, y, type: 'triangle' });
    }
  }
  return hits;
}

// ---- Clustering -----------------------------------------------------------
// Union-find on hit proximity PLUS a line-sampling gap check, so adjacent
// cells whose inter-cell dark border is thin enough to fit within MERGE_DIST
// still don't merge into one cluster.
//
// Proximity stage: MERGE_DIST = 5 selects candidate pairs.
//   - Within a cell, STEP=3 samples can be up to 3√2 ≈ 4.24 px apart
//     diagonally → must be ≤ MERGE_DIST.
//   - Across a 2-3 px dark edge between adjacent cells, nearest samples
//     are typically ≥ 6 px apart → > MERGE_DIST. On clients with thinner
//     borders this assumption breaks — hits in adjacent cells land within
//     MERGE_DIST of each other and the pre-gap-check version wrongly
//     fused them into one cluster spanning 2-3 cells. The gap stage below
//     covers that case.
//
// Gap stage (for each candidate pair passing proximity): sample 3 interior
// points on the line between the two hits, at t = 1/4, 2/4, 3/4. Count how
// many fall on isInsideCell. Majority-inside (≥ 2/3) → merge; majority-
// outside → the segment crosses a dark border, skip the merge.
// - Narrow in-cell features (icon outlines ~1 px wide): at most 1 of the
//   3 samples hits the outline, so 2+ stay inside → merge. Single cells
//   with icons stay intact.
// - Inter-cell borders (2-3 px wide): 2+ samples land on the border →
//   outside majority → no merge. Cells stay separate.
//
// Complexity: O(n log n) sort + O(n·k) pair-scan where k is local density;
// the gap check adds ≤ 3 pixel reads per pair that passes proximity. Total
// cost stays well under a millisecond for realistic scans.

const MERGE_DIST = 5;
const MIN_CLUSTER_HITS = 5; // below this, hit is probably a noise pixel

/**
 * Line-sampling border detector. Returns true when the segment connecting
 * (x1,y1)→(x2,y2) likely crosses a cell border — i.e., fewer than half the
 * interior samples fall on an inside-cell pixel class.
 *
 * Defensive fallbacks: when screenData is absent or every sample read
 * fails (out-of-bounds, getPixel returned null), returns false (= no gap)
 * so clustering falls back to pure proximity behaviour. This keeps the
 * function safe for callers that don't have screen data handy.
 */
function hasGapBetween(screenData, x1, y1, x2, y2) {
  if (!screenData) return false;
  const dx = x2 - x1;
  const dy = y2 - y1;
  let inside = 0;
  let checked = 0;
  // t = 1/4, 2/4, 3/4 — interior samples only. Endpoints are already
  // classified as inside-cell (that's why they're in `hits`).
  for (let i = 1; i <= 3; i++) {
    const t = i / 4;
    const sx = Math.round(x1 + dx * t);
    const sy = Math.round(y1 + dy * t);
    if (sx < 0 || sy < 0 || sx >= screenData.width || sy >= screenData.height) continue;
    const px = screenData.getPixel(sx, sy);
    if (!px) continue;
    checked++;
    if (isInsideCell(px[0], px[1], px[2])) inside++;
  }
  // No valid samples → no evidence of a gap. Default to merging so we
  // don't over-split on classifier noise.
  if (checked === 0) return false;
  // Strict majority outside = gap (2+ of 3, or 2 of 2).
  return inside * 2 < checked;
}

function clusterHits(hits, screenData) {
  const n = hits.length;
  if (n === 0) return [];

  // Union-find with path compression + union by rank.
  const parent = new Array(n);
  const rank = new Array(n);
  for (let i = 0; i < n; i++) { parent[i] = i; rank[i] = 0; }
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (i, j) => {
    const ri = find(i), rj = find(j);
    if (ri === rj) return;
    if (rank[ri] < rank[rj]) parent[ri] = rj;
    else if (rank[ri] > rank[rj]) parent[rj] = ri;
    else { parent[rj] = ri; rank[ri]++; }
  };

  // Sort by x, break ties by y — enables early exit when x-distance
  // exceeds MERGE_DIST.
  const order = new Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => (hits[a].x - hits[b].x) || (hits[a].y - hits[b].y));

  const maxSq = MERGE_DIST * MERGE_DIST;
  for (let ii = 0; ii < n; ii++) {
    const i = order[ii];
    const hi = hits[i];
    for (let jj = ii + 1; jj < n; jj++) {
      const j = order[jj];
      const hj = hits[j];
      const dx = hj.x - hi.x;
      if (dx > MERGE_DIST) break; // sorted — no further hit within range
      const dy = hj.y - hi.y;
      if (dx * dx + dy * dy <= maxSq) {
        // Proximity test passed. Gate the union behind a border check —
        // otherwise adjacent-cell hits on thin-border layouts merge into
        // one cluster.
        if (!hasGapBetween(screenData, hi.x, hi.y, hj.x, hj.y)) {
          union(i, j);
        }
      }
    }
  }

  // Group by root.
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let g = groups.get(r);
    if (!g) { g = []; groups.set(r, g); }
    g.push(hits[i]);
  }

  // Build cluster metadata + filter noise-size groups.
  const clusters = [];
  for (const pts of groups.values()) {
    if (pts.length < MIN_CLUSTER_HITS) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    // Count cell-type-associated hits. Ladder pixels only appear inside
    // opened (base) cells; ?-glyph pixels only appear inside adjacent-?
    // cells. Bundle them with their parent cell type for classification.
    let openedLike = 0; // 'opened' + 'ladder'
    let qLike = 0;      // 'q' + 'qglyph'
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
      if (p.type === 'opened' || p.type === 'ladder') openedLike++;
      else if (p.type === 'q' || p.type === 'qglyph') qLike++;
    }
    clusters.push({
      count: pts.length,
      minX, minY, maxX, maxY,
      centerX: Math.round((minX + maxX) / 2),
      centerY: Math.round((minY + maxY) / 2),
      width: maxX - minX,
      height: maxY - minY,
      // Cell state hint for 1b.2: predominant pixel type. Mixed clusters
      // are diagnostically interesting but expected now that ladder/glyph
      // hits mix with their parent cell's background — a base cell legit
      // has opened + ladder mixed, a ?-cell has q + qglyph mixed.
      type: openedLike >= qLike ? 'opened' : 'q',
      mixed: openedLike > 0 && qLike > 0,
    });
  }
  return clusters;
}

// ---- Pitch derivation -----------------------------------------------------
// Collect all pairwise centre-to-centre distances along each axis. The
// MINIMUM non-zero distance is the pitch: adjacent cells are pitch apart;
// same-column pairs have dx ≈ 0; multi-cell pairs have dx ∈ {2·pitch,
// 3·pitch, ...}. Connectivity in a real dungeon guarantees at least one
// adjacent pair exists (a floor with disconnected rooms is impossible).
//
// "Non-zero" here means > 2 px — same-column cells can have centres that
// differ by 1-2 px due to sampling / clustering quantisation, which must
// NOT be read as a valid pitch.
//
// Support count lets the caller judge confidence: with 2 clusters we have
// support ≈ 1 (brittle); with 5+ clusters support ≈ 10+ (robust).

// Minimum plausible cell pitch at any reasonable UI scale. Real RS3 map
// cells are ≥ 20 px even at compact UI scales; in practice they're
// 25-40 px. Distances below 20 are WITHIN-cell sub-cluster splits —
// artifacts of the clustering pass when the fill classifier doesn't
// cover every pixel inside a cell (e.g., thin anti-aliased icon-outline
// gaps that neither opened-beige, adjacent-Q-beige, ladder-khaki, nor
// ?-glyph classifiers catch).
const MIN_PLAUSIBLE_PITCH = 20;

function derivePitch(clusters, jitterTolerance = 2) {
  if (clusters.length < 2) return null;

  const nonZero = [];
  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      const dx = Math.abs(clusters[i].centerX - clusters[j].centerX);
      const dy = Math.abs(clusters[i].centerY - clusters[j].centerY);
      if (dx > jitterTolerance) nonZero.push(dx);
      if (dy > jitterTolerance) nonZero.push(dy);
    }
  }
  if (!nonZero.length) return null;

  // Drop sub-cluster distances — they'd give a false pitch far below the
  // real cell-to-cell spacing. 20 px is comfortably below any RS3 UI
  // cell size but above typical within-cell split gaps (10-15 px across
  // icon holes).
  const plausible = nonZero.filter(d => d >= MIN_PLAUSIBLE_PITCH);
  if (!plausible.length) return null;

  // Modal-distance selection: group distances into ±jitterTolerance bins.
  // In a real grid, adjacent-cell pairs outnumber multi-cell pairs so
  // the bucket with the most members is USUALLY the real pitch — but
  // floor layouts with sparse connectivity can produce more 2×-pitch
  // pairs than adjacent ones, which would select 2×pitch as the winner.
  // The bbox ceiling below catches that case.
  const bucketSize = jitterTolerance * 2 + 1;
  const buckets = new Map();
  for (const d of plausible) {
    const key = Math.round(d / bucketSize);
    const entry = buckets.get(key);
    if (entry) { entry.values.push(d); entry.count++; }
    else buckets.set(key, { values: [d], count: 1 });
  }

  const allModes = [];
  for (const entry of buckets.values()) {
    const sorted = [...entry.values].sort((a, b) => a - b);
    allModes.push({
      median: sorted[Math.floor(sorted.length / 2)],
      count: entry.count,
    });
  }
  if (!allModes.length) return null;

  // --- Bbox-derived pitch ceiling ---
  // One cluster ≈ one cell's interior, so its bbox gives a direct upper
  // bound on pitch. Over-merging can inflate one axis of the bbox (two
  // cells fused vertically → tall-skinny cluster) but the OTHER axis
  // stays cell-sized. Using min(w, h) per cluster and taking the median
  // across clusters produces a robust "one cell interior" estimate even
  // when some clusters are misshapen.
  //
  // Pitch = interior + 2×edge; edge width is ≤ ~5 px at normal UI scales.
  // The 1.8× multiplier + 12 px absolute margin accepts realistic reads
  // (bbox=24 → ceiling 55, real pitch ~30 passes comfortably) while
  // still rejecting obvious 2×/3× mode inflations (bbox=24 rejects a
  // derived pitch of 80). Loosened from 1.6×+10 so borderline reads
  // don't squeak through by accident, without admitting clearly-too-big
  // modes. Tune if clients at very high UI scales start being rejected.
  const bboxMinDims = clusters
    .map(c => Math.min(c.width, c.height))
    .sort((a, b) => a - b);
  const medMinDim = bboxMinDims[Math.floor(bboxMinDims.length / 2)];
  const maxPitchFromBbox = medMinDim * 1.8 + 12;

  // Select best mode from the ceiling-filtered pool. When EVERY mode
  // exceeds the ceiling, the bbox evidence says no mode could represent
  // a real pitch — the read is fundamentally inconsistent (typically
  // happens early in a floor when only a few icon-sized fragments are
  // classified and the only surviving pairwise distances are random
  // icon-to-icon separations). Return null so findDgMap treats it as
  // a clean 'no-pitch' miss rather than falling back to an unfiltered
  // pool that just picks the highest-count garbage mode.
  // Selection rule within the pool: highest count, tiebreak to smaller
  // median (prefer real pitch over a coincidentally-tied multi-cell
  // mode on exact count ties).
  const viablePool = allModes.filter(m => m.median <= maxPitchFromBbox);
  if (!viablePool.length) return null;
  viablePool.sort((a, b) => b.count - a.count || a.median - b.median);
  const best = viablePool[0];

  // Diagnostic top-3 spans ALL modes (viable + rejected-by-ceiling) so
  // the debug log can show which modes got filtered out and why a smaller
  // ceiling-compliant mode may have won over a higher-count rejected one.
  // Separate sort since viablePool has been mutated in-place for best-pick.
  const topModesDiag = allModes
    .slice()
    .sort((a, b) => b.count - a.count || a.median - b.median)
    .slice(0, 3);

  return {
    pitch: best.median,
    support: best.count,
    totalPairs: nonZero.length,
    plausibleCount: plausible.length,
    topModes: topModesDiag,
    // Expose the bbox bound + cluster evidence that produced it so
    // runDgMapRead's debug log can include them and tell the operator
    // WHY the selected mode won (e.g., "top-count mode 80 rejected by
    // ceiling 48 derived from medMinDim=24").
    maxPitchFromBbox: Math.round(maxPitchFromBbox),
    medMinDim,
  };
}

// ---- Public read entry point ---------------------------------------------

/**
 * Find the DG map widget on screen. Returns:
 *   { found: true, origin, pitch, cellSize, clusters, support, totalPairs,
 *     region, hitCount }
 *   { found: false, reason, ... }
 *
 * Options:
 *   screen  — optional pre-captured ImgRef (for capture reuse across probes)
 *   region  — optional { x, y, w, h } scan area. Defaults to left-half of
 *             screen. Caller (runDgMapRead) passes explicit regions for
 *             LOCKED-state narrow scans and UNKNOWN-state full-screen fallback.
 *
 * origin = top-leftmost cluster's (minX, minY). See header — this is a LOCAL
 * origin (may shift NW as exploration progresses), not the full 8×8 grid's
 * top-left. Sufficient for 1b.1 logging; 1b.4 will use ladder anchor instead.
 */
export function findDgMap({ screen: providedScreen, region, classifyCells = false } = {}) {
  if (!window.alt1) return { found: false, reason: 'not-in-alt1' };

  let screen = providedScreen;
  if (!screen) {
    try { screen = a1lib.captureHoldFullRs(); }
    catch (_) { return { found: false, reason: 'capture-threw' }; }
    if (!screen) return { found: false, reason: 'capture-null' };
  }

  let screenData;
  try { screenData = screen.toData(0, 0, screen.width, screen.height); }
  catch (_) { return { found: false, reason: 'toData-threw' }; }

  const scanRegion = region || defaultLeftRegion(screen);

  // Bounds sanity — defensive against bogus region args.
  if (scanRegion.w <= 0 || scanRegion.h <= 0) {
    return { found: false, reason: 'empty-region', region: scanRegion };
  }

  const hits = scanBeigeInRegion(screenData, scanRegion);
  if (hits.length < MIN_CLUSTER_HITS * 2) {
    return {
      found: false,
      reason: 'no-beige-cells',
      hitCount: hits.length,
      region: scanRegion,
    };
  }

  const clusters = clusterHits(hits, screenData);
  if (clusters.length < 2) {
    return {
      found: false,
      reason: 'insufficient-clusters',
      clusters: clusters.length,
      hitCount: hits.length,
      region: scanRegion,
    };
  }

  const pitchInfo = derivePitch(clusters);
  // derivePitch enforces MIN_PLAUSIBLE_PITCH internally — a null result
  // here means either too few clusters or all pairwise distances were
  // sub-cluster noise. Either way, not a valid read.
  if (!pitchInfo) {
    return {
      found: false,
      reason: 'no-pitch',
      clusters: clusters.length,
      hitCount: hits.length,
      region: scanRegion,
      // Sample cluster positions so the caller can log a diagnostic —
      // helps determine whether clustering is over-splitting (many small
      // clusters), world-pixel false positives (clusters far from the
      // expected map area), or genuinely no pitch to derive.
      clusterSample: clusters.slice(0, 8).map(c => ({
        x: c.centerX, y: c.centerY, count: c.count,
        w: c.width, h: c.height,
      })),
    };
  }

  // Origin = top-leftmost cluster. Tiebreak: prefer smaller Y, then smaller X.
  let topLeft = clusters[0];
  for (const c of clusters) {
    if (c.minY < topLeft.minY ||
        (c.minY === topLeft.minY && c.minX < topLeft.minX)) {
      topLeft = c;
    }
  }

  // Cell size estimate from the top-leftmost cluster's bbox. This may
  // undersample the true cell dimensions (the cluster only covers the
  // interior that survived classification), but it's useful as a
  // diagnostic stability signal — should be close to pitch minus the
  // edge width.
  const cellSize = { w: topLeft.width, h: topLeft.height };

  // Origin = top-left corner of cell (0, 0) in SCREEN coords. The
  // topLeft cluster's minX/minY is the leftmost/topmost BEIGE-classified
  // pixel INSIDE that cell (the wall strip between cells isn't in the
  // cluster), so we shift by an estimated wall-width to get the actual
  // cell corner. Downstream consumers — classifyAllCells' scan grid,
  // solo-pin's cellCoords derivation, and the overlay's pixel
  // positioning — all use this corrected origin, so the scan rows/cols
  // align with the visible cell boundaries rather than sitting ~wall
  // pixels offset. Without this shift, a triangle drawn at the top of
  // its cell gets classified into the scan row for the cell ABOVE
  // (since that row's scan area extends downward into this cell's top).
  //
  // Estimation: half of (pitch − median cluster interior width). For
  // over-merged clusters this can go negative or produce weird values,
  // so clamp to a 1-5 px safe range — typical RS3 wall strip is 2-3.
  const clusterMinDim = Math.min(topLeft.width, topLeft.height);
  const rawEdge = Math.floor((pitchInfo.pitch - clusterMinDim) / 2);
  const edgeAdjust = Math.max(1, Math.min(5, rawEdge));
  const origin = {
    x: topLeft.minX - edgeAdjust,
    y: topLeft.minY - edgeAdjust,
  };
  const result = {
    found: true,
    origin,
    pitch: pitchInfo.pitch,
    cellSize,
    clusters: clusters.length,
    support: pitchInfo.support,
    totalPairs: pitchInfo.totalPairs,
    hitCount: hits.length,
    region: scanRegion,
  };

  // Optional cell classification pass (Phase 1b.3). Opt-in because the
  // locator-only path doesn't need per-cell detail and the extra sampling
  // costs O(range²) cells × O(pitch²/step²) pixels each. When enabled,
  // `result.cells` is a sparse map keyed on "col,row" offset strings
  // (signed, relative to origin).
  if (classifyCells) {
    // Pass scanRegion so classifyAllCells can clamp its ±7-cell scan to
    // the calibrated area — without this, cells outside the widget get
    // classified from world pixels.
    result.cells = classifyAllCells(screenData, origin, pitchInfo.pitch, 7, scanRegion);
  }
  return result;
}

/**
 * Dedicated triangle-colour centroid scan — fallback locator for the
 * solo-pin / self-pin path when `findDgMap` fails at event time but the
 * player's triangle is still visible inside the calibrated region. Skips
 * all clustering and pitch derivation; just scans pixels and averages
 * those matching the requested slot colour.
 *
 * Returns `{ x, y, count }` with the centroid of the requested-colour
 * triangle pixels, or `null` if fewer than TRIANGLE_MIN_PIXELS (5) hits
 * are found.
 *
 * `color` is one of 'red' | 'teal' | 'lime' | 'yellow' | 'pale' —
 * matches the classifyTrianglePixel output domain. Defaults to 'red'
 * for back-compat with the solo-pin path (where 'red' = self by the
 * solo-party elimination rule).
 *
 * Why this works as a fallback: `findDgMap` most often fails because
 * `derivePitch` rejects the cluster set (sparse reads, dim-rendered
 * floors, transient occlusion of cell fills). But the player triangle
 * renders as a saturated sprite regardless of those conditions. A
 * direct pixel scan keeps finding it even when grid derivation can't
 * complete. False-positive protection comes from classifyTrianglePixel's
 * per-colour tight rules — the red b≤5 gate separates the red triangle
 * from boss icons (b≥10), etc.
 *
 * `region` is required — we will not scan the whole screen. Scoping to
 * the user-calibrated dgMap region keeps this cheap and rules out any
 * world-coloured pixels sitting outside the widget.
 */
export function findTrianglePx({ screen: providedScreen, region, color = 'red' } = {}) {
  if (!window.alt1) return null;
  if (!region) return null;

  let screen = providedScreen;
  if (!screen) {
    try { screen = a1lib.captureHoldFullRs(); }
    catch (_) { return null; }
    if (!screen) return null;
  }

  let screenData;
  try { screenData = screen.toData(0, 0, screen.width, screen.height); }
  catch (_) { return null; }

  const x0 = Math.max(0, Math.floor(region.x));
  const y0 = Math.max(0, Math.floor(region.y));
  const xMax = Math.min(screenData.width - 1, x0 + Math.floor(region.w));
  const yMax = Math.min(screenData.height - 1, y0 + Math.floor(region.h));

  // STEP=2 matches classifyCellContents's sampling density, so expected
  // hit counts are comparable (triangle ≈ 5-10 hits in practice).
  // TRIANGLE_MIN_PIXELS floor stays consistent with the per-cell check.
  const STEP = 2;
  let sumX = 0, sumY = 0, count = 0;
  for (let y = y0; y < yMax; y += STEP) {
    for (let x = x0; x < xMax; x += STEP) {
      const px = screenData.getPixel(x, y);
      if (!px) continue;
      if (classifyTrianglePixel(px[0], px[1], px[2]) === color) {
        sumX += x;
        sumY += y;
        count++;
      }
    }
  }

  if (count < TRIANGLE_MIN_PIXELS) return null;
  return {
    x: Math.round(sumX / count),
    y: Math.round(sumY / count),
    count,
  };
}
