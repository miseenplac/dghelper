// Post-dungeon timer OCR.
//
// When a floor ends (detected via winterface auto-probe, manual probe,
// outfit-bonus line, or leave-party line), capture the RS client, find the
// end-dungeon interface (anchored on the gold "CONGRATULATIONS! YOU HAVE
// COMPLETED A DUNGEON!" bar), and OCR the HH:MM:SS timer at the bottom-left
// of the dialog.
//
// The dialog is at fixed pixel size at RS3's default UI scale; timer
// position is anchored off the peek-reported title position (peek-anchored,
// not centred-math, so it works across any client layout). The sweep
// tolerates ±40px of peek wobble.
//
// We try multiple fonts for the timer read; the first one that yields an
// HH:MM:SS-shaped result wins. Sanity gates in parseTimer reject obvious
// garbage (hh > 2, or all-identical digits like "33:33:33").

import * as a1lib from 'alt1/base';
import * as OCR from 'alt1/ocr';
import font_aa_8px from 'alt1/fonts/aa_8px.js';
import font_aa_8px_mono from 'alt1/fonts/aa_8px_mono.js';
import font_aa_10px_mono from 'alt1/fonts/aa_10px_mono.js';
import font_aa_12px_mono from 'alt1/fonts/aa_12px_mono.js';
import font_pixel_digits from 'alt1/fonts/pixel_8px_digits.js';

const FONTS = {
  aa_8px:        font_aa_8px,
  aa_8px_mono:   font_aa_8px_mono,
  aa_10px_mono:  font_aa_10px_mono,
  aa_12px_mono:  font_aa_12px_mono,
  pixel_8px_digits: font_pixel_digits,
};

// Gold of the "CONGRATULATIONS" title. Live eyedrops from the user's actual
// end-dungeon banner show a muted brown-gold gradient (not the saturated
// yellow-gold of the reference screenshot) — OCR was failing to find the
// anchor because the palette was too saturated. Sampled values go first so
// findReadLine picks them over the fallback saturated variants below.
const ANCHOR_COLORS = [
  [182, 145,  94], // eyedrop, dark letter edge
  [176, 139,  89], // eyedrop, dark letter interior
  [240, 190, 121], // eyedrop, brighter letter center
  [239, 201,   0], // original reference guess
  [255, 223,   0],
  [255, 214,  40],
];

// Timer rendering uses RS3's default UI white. Timer digits are small so
// anti-aliasing softens edges; include several near-white variants.
const TIMER_COLORS = [
  [255, 255, 255],
  [240, 240, 240],
  [220, 220, 220],
  [200, 200, 200],
];

// Winterface is a fixed-size dialog at RS3's default UI scale (100%). The
// title is horizontally centred in the dialog and sits ~40px below the
// dialog top. We anchor the timer scan off the peek-reported title position
// (peek.x = title centre X, peek.y = mean title Y):
//   dialogLeft ≈ peek.x − WINTERFACE_W/2
//   dialogTop  ≈ peek.y − TITLE_Y_OFFSET
//
// Anchoring off peek — rather than assuming the dialog is centred in the
// captureHoldFullRs-returned image — makes this robust across client
// layouts: full-screen, windowed, ultrawide, or setups with HUD overlays /
// sidebars that offset the effective game view. The peek does wobble
// 10-20px between captures (sparse grid hits different subsets of title
// pixels), but the widened scan range below absorbs it.
const WINTERFACE_W = 526;
const TITLE_Y_OFFSET = 40;

// Timer scan point relative to the dialog top-left. OCR-confirmed hit at
// rel(45, 321) using pixel_8px_digits font (screen 1922x1083). The X/Y
// scan sweep below radiates outward from this centre.
const TIMER_OFFSET = { dx: 45, dy: 321 };

// Font candidates to try for the timer OCR, in priority order.
// pixel_8px_digits is the empirical winner — the RS3 winterface timer is
// drawn in a crisp 8px pixel font that only this one matches cleanly.
const TIMER_FONT_ORDER = ['pixel_8px_digits', 'aa_8px_mono', 'aa_10px_mono', 'aa_12px_mono', 'aa_8px'];

/**
 * Cheap pixel-level peek for the winterface title banner. Samples a sparse
 * grid of pixels across the screen-centre middle-top region (where the
 * title always lands regardless of client resolution) and reports whether
 * enough anchor-coloured pixels exist to plausibly be the title text.
 *
 * Returns null if no title detected. On hit, returns a position hint:
 *   { x, y, hits } — median-x / mean-y of matching pixels, and the hit
 *   count. The silence probe hands that hint to findReadLine so OCR
 *   starts close to the actual title text instead of a hardcoded point
 *   (which wins back the reliability we lose by supporting any client
 *   resolution).
 *
 * The winterface dialog is ~526×351px, centred in the RS client. Title
 * sits ~30–50px from the top of the dialog. Across 720p → 4K that puts
 * the title somewhere between ~15% and ~55% of client height. The scan
 * band covers that whole range — still ~6000 samples total at step=6,
 * sub-millisecond, much cheaper than an OCR pass.
 *
 * Minimum-hits threshold rejects stray single-pixel matches from
 * unrelated UI chrome (money pouch, cabbage inventory icons, etc.). A
 * real title is a horizontal row of text, producing many matches.
 */
export function peekForWinterface(screen) {
  if (!screen) return null;
  const cx = Math.floor(screen.width / 2);
  const y0 = Math.max(0, Math.floor(screen.height * 0.15));
  const y1 = Math.min(screen.height - 1, Math.floor(screen.height * 0.55));
  const x0 = Math.max(0, cx - 260);
  const x1 = Math.min(screen.width - 1, cx + 260);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return null;

  let data;
  try { data = screen.toData(x0, y0, w, h); }
  catch (_) { return null; }

  const TOL = 32;
  const xStep = 6, yStep = 6;
  const MIN_HITS = 5;
  const xsHit = [];
  let sumY = 0, hits = 0;

  for (let y = 0; y < h; y += yStep) {
    for (let x = 0; x < w; x += xStep) {
      const px = data.getPixel(x, y);
      if (!px) continue;
      for (const ac of ANCHOR_COLORS) {
        if (Math.abs(px[0] - ac[0]) <= TOL &&
            Math.abs(px[1] - ac[1]) <= TOL &&
            Math.abs(px[2] - ac[2]) <= TOL) {
          xsHit.push(x);
          sumY += y;
          hits++;
          break;
        }
      }
    }
  }

  if (hits < MIN_HITS) return null;
  xsHit.sort((a, b) => a - b);
  const midX = xsHit[Math.floor(xsHit.length / 2)];
  const meanY = Math.floor(sumY / hits);
  return { x: x0 + midX, y: y0 + meanY, hits };
}

function parseTimer(text) {
  if (!text) return null;
  // Separator is any non-digit run — pixel_8px_digits has no `:` glyph and
  // returns `"00 04 27"` with spaces, while other fonts give `"00:04:27"`.
  const m = text.trim().match(/(\d{2})\D+(\d{2})\D+(\d{2})/);
  if (!m) return null;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const ss = parseInt(m[3], 10);
  if (mm >= 60 || ss >= 60) return null;
  // Sanity gate 1: No RS3 Dungeoneering floor runs longer than ~30 minutes
  // on any reasonable complexity / size. Values with hh > 2 are OCR garbage
  // — typically a fallback font misreading an adjacent UI element as
  // repeating digits (seen in the wild: "33:33:33" from aa_8px_mono
  // latching onto the clock icon's diagonal strokes).
  if (hh > 2) return null;
  // Sanity gate 2: All-identical-digit timestamps ("11:11:11", "33:33:33"
  // etc.) are classic OCR pattern-match artifacts, not real timers.
  // Including "00:00:00" — a completed floor is never zero seconds.
  if (m[1] === m[2] && m[2] === m[3]) return null;
  return {
    time: `${m[1]}:${m[2]}:${m[3]}`,
    timeSeconds: hh * 3600 + mm * 60 + ss,
  };
}

/**
 * Capture the end-dungeon interface timer. Returns:
 *   { ok: true,  time: "00:01:51", timeSeconds: 111, anchor: {x,y,w,h} }
 *   { ok: false, error: <string>, tries?: [...] }
 *
 * `tries` contains the raw OCR attempts (font → text) so a missed read is
 * debuggable — paste it back and tune offsets / add colour variants.
 */
export function captureEndDungeonTimer({ verbose = false, screen: providedScreen, calibratedAnchor } = {}) {
  if (!window.alt1) return { ok: false, error: 'not-in-alt1' };

  // Reuse the caller's screen capture when provided (auto-probe path — it
  // already has a screen in hand from its cheap peek pass). Falls back to
  // capturing fresh for manual-button callers.
  let screen = providedScreen;
  if (!screen) {
    try { screen = a1lib.captureHoldFullRs(); }
    catch (e) { return { ok: false, error: 'capture-threw: ' + (e && e.message) }; }
    if (!screen) return { ok: false, error: 'capture-failed' };
  }

  // Stage 1: detect the winterface via pixel peek. The CONGRATULATIONS title
  // is drawn in RS3's large UI title font (~20-30px) — no built-in Alt1 font
  // matches it, so glyph OCR is impossible. The peek's coloured-pixel count
  // is an unambiguous presence signal on its own: a solid row of title text
  // produces dozens of hits, while quest / bank / quiet-chat windows produce
  // few or none.
  //
  // When the caller provides a `calibratedAnchor` (set by the user via
  // Settings → Calibration → Winterface), we still run the peek as a
  // PRESENCE CHECK (is the dialog currently open?) but replace the
  // anchor COORDS with the calibrated ones. Stable anchor eliminates
  // the 10-20 px peek wobble that widened the timer scan range, so
  // timer OCR lands cleaner and slightly faster.
  const peek = peekForWinterface(screen);
  if (!peek) {
    return { ok: false, error: 'no-anchor-pixels' };
  }
  const anchorX = calibratedAnchor ? calibratedAnchor.x : peek.x;
  const anchorY = calibratedAnchor ? calibratedAnchor.y : peek.y;
  const anchor = {
    x: anchorX,
    y: anchorY,
    hits: peek.hits,
    source: calibratedAnchor ? 'calibrated' : 'peek',
  };

  // findReadLine needs ImageData, not an ImgRef. Materialise the full-screen
  // buffer once for the timer stage.
  let screenData;
  try { screenData = screen.toData(0, 0, screen.width, screen.height); }
  catch (e) { return { ok: false, error: 'toData-threw: ' + (e && e.message) }; }

  if (verbose) console.log('[dkt/timer]', anchor.source, 'anchor \u2192 hits', peek.hits, '@', anchorX, anchorY);

  // --- Stage 2: OCR timer via grid sweep anchored off peek position ---
  // Dialog origin computed from the (calibrated or peek-derived) anchor:
  //   dialogLeft = anchor.x − half-dialog-width (title is centred in dialog)
  //   dialogTop  = anchor.y − TITLE_Y_OFFSET    (title sits ~40px below top)
  // Then TIMER_OFFSET (45, 321) gives the expected timer position inside
  // the dialog, and the X/Y scan ranges sweep around it. Calibrated anchors
  // don't need the wobble tolerance (user-captured from a real peek) but
  // we keep the sweep for robustness in both modes.
  const dialogLeft = anchorX - Math.floor(WINTERFACE_W / 2);
  const dialogTop  = anchorY - TITLE_Y_OFFSET;
  const X_SCAN = [45, 40, 50, 35, 55, 30, 60, 25, 65, 20, 70, 15, 75, 10, 80, 5, 85];
  const Y_SCAN = [321, 313, 329, 305, 337, 297, 345, 289, 353, 281, 361];

  const timerTries = [];
  for (const yRel of Y_SCAN) {
    for (const xRel of X_SCAN) {
      const tCx = dialogLeft + xRel;
      const tCy = dialogTop  + yRel;
      for (const fontName of TIMER_FONT_ORDER) {
        const font = FONTS[fontName];
        if (!font) continue;
        try {
          const res = OCR.findReadLine(screenData, font, TIMER_COLORS, tCx, tCy);
          const text = (res && res.text) || '';
          if (text) timerTries.push({ font: fontName, xRel, yRel, text });
          const parsed = parseTimer(text);
          if (parsed) {
            if (verbose) console.log('[dkt/timer] parsed via', fontName, 'at', xRel, yRel, '→', parsed);
            return {
              ok: true,
              time: parsed.time,
              timeSeconds: parsed.timeSeconds,
              anchor,
              font: fontName,
              hitAt: { xRel, yRel },
            };
          }
        } catch (_) { /* silent — out-of-bounds throws are common */ }
      }
    }
  }

  return {
    ok: false,
    error: 'timer-ocr-failed',
    anchor,
    timerTries,
    offset: { ...TIMER_OFFSET },
    scanRect: {
      x: dialogLeft + Math.min(...X_SCAN),
      y: dialogTop  + Math.min(...Y_SCAN),
      w: Math.max(...X_SCAN) - Math.min(...X_SCAN),
      h: Math.max(...Y_SCAN) - Math.min(...Y_SCAN),
    },
  };
}

