// Dungeoneering key / door icon library.
//
// Procedural SVG renders — each of the 8 key shapes is a small path in a
// 16×16 viewBox, filled with the canonical chat-colour for the given key
// colour. Same rendering is used by the door list, the (future) plugin
// map canvas, and eventually the (future) Alt1 overlay on the actual DG
// map widget; renderKeyIcon returns an inline <svg> element the caller
// appends where it wants.
//
// Design notes:
//   • Shape silhouettes are simplified geometric approximations, not
//     attempts at faithful RS3 key sprite reproduction. At the 10-14 px
//     sizes we actually render (tight cell slots in the map canvas),
//     fidelity to in-game art is unrecoverable anyway; distinguishability
//     between the 8 shapes is the only thing that matters.
//   • Colour is the primary visual signal, shape the secondary. At 12 px
//     shape pairs like triangle/wedge and pentagon/shield are close;
//     colour disambiguates when shape doesn't.
//   • A thin dark stroke sits around every filled path so pale colours
//     (silver, gold) still register against the light-toned cells of the
//     RS3 DG map when we eventually overlay there. On the plugin's dark
//     UI the stroke is near-invisible but harmless.

// Canonical Dungeoneering key-colour palette — exactly the 8 colours
// listed in parser.js KEY_COLORS, no more. Hex values are approximate
// chat renderings and are only used for these icons; keep in sync with
// parser.js if either drifts.
export const KEY_COLOR_HEX = Object.freeze({
  blue:    '#1d7fdc',
  crimson: '#b31e1e',
  gold:    '#d9a017', // mid-gold; the gradient in getKeyIconSvgMarkup
                      // handles the actual rendering for `color==='gold'`
  green:   '#2a9d4f',
  orange:  '#f77f00',
  purple:  '#9b5de5',
  silver:  '#cbd5e1',
  yellow:  '#fff200', // pure lemon, not amber-tinted, keeps it visually
                      // distinct from gold even at small overlay sizes
});

// SVG path `d` attributes for each key shape, drawn inside a 16×16
// viewBox with a ~2 px margin so the stroke doesn't clip. Shapes are
// chosen to be visually distinct at small sizes:
//   corner   — L-shape with the angle at TOP-RIGHT, matching RS3's
//              in-game rendering (full top bar + right-side column)
//   crescent — sideways crescent with tips on the RIGHT edge, convex
//              curve bulging LEFT, opening on the right — classic ⊂
//              C-shape, matching the rotation the user wants vs. the
//              wiki's laid-down rendering
//   diamond  — rotated square, 4 points
//   pentagon — 5-sided with a flat-ish bottom (two bottom vertices)
//   rectangle— narrow horizontal bar, elongated
//   shield   — flat top, pointed bottom (mirror of pentagon)
//   triangle — equilateral apex-DOWN (matches in-game orientation)
//   wedge    — short rectangular base with a shallow dome on top
//              (flat bottom, short sides, curved arched top); approximates
//              the in-game silhouette where the top edges aren't sharply
//              defined and read as a curve at small sizes
export const KEY_SHAPE_PATHS = Object.freeze({
  corner:    'M 2 2 H 14 V 14 H 10 V 6 H 2 Z',
  crescent:  'M 14 2 C -2 2 -2 14 14 14 C 6 14 6 2 14 2 Z',
  diamond:   'M 8 2 L 14 8 L 8 14 L 2 8 Z',
  pentagon:  'M 8 2 L 14 7 L 11 14 L 5 14 L 2 7 Z',
  rectangle: 'M 2 5 H 14 V 11 H 2 Z',
  shield:    'M 3 2 H 13 V 8 L 8 14 L 3 8 Z',
  triangle:  'M 2 3 H 14 L 8 14 Z',
  wedge:     'M 2 14 L 2 11 A 6 6 0 0 1 14 11 L 14 14 Z',
});

// Ready-state halo colour — chartreuse / neon green, chosen to be
// visually distinct from every key fill colour (especially the muted
// green key #2a9d4f) while preserving the "green = ready" cultural
// convention. Stroke width 4.0 is the maximum safe width within the
// 16×16 viewBox (shapes are drawn in the 2-14 range, so stroke
// extension of 2 px reaches exactly the viewBox edges without clip).
// Visual recipe for the ready state (stacked bottom-to-top):
//   1. Rounded chartreuse backdrop at 55% opacity — a strong
//      "highlighted cell" wash that marks the whole icon area.
//   2. Chartreuse halo ring (this stroke) around the shape.
//   3. Solid filled body on top (same as pending).
// Pending icons render with the SAME filled body at full opacity but
// NO backdrop and NO halo — the body alone. Ready icons stand out
// by addition (backdrop + halo stacked on an identical body),
// not by dimming the pending alternative.
const READY_HALO_HEX = '#39ff14';
const READY_HALO_STROKE_WIDTH = 4;
const READY_BACKDROP_OPACITY = 0.55;

/**
 * Single source of truth for key-icon SVG markup — used by both the
 * DOM renderer (renderKeyIcon) and the overlay rasteriser so any
 * visual tweak (gradient, stroke, new shape) changes both render
 * targets atomically.
 *
 * Returns a complete <svg> string including width/height attrs, a
 * <title> for accessibility, an optional <defs> block for the gold
 * metallic gradient, and a <path> (or fallback <circle> for the '?'
 * placeholder). Callers can either parseFromString this via DOMParser
 * (UI) or feed it to an offscreen <img> + <canvas> (overlay).
 *
 * Gold is special-cased with a 3-stop linear gradient (bright highlight
 * at top → mid gold → dark at bottom) to simulate a metallic shine and
 * keep it unambiguously distinct from the flat yellow fill at 14-16 px.
 *
 * When `ready === true`, an outer chartreuse halo stroke is drawn
 * BELOW the filled shape so only the outer portion shows as a ring
 * around the icon — signals "you have this key, door is openable".
 * The halo stroke is 2.5 px wide in 16×16 viewBox coords (~1.25 px of
 * visible ring at 16 px render size). The default dark-stroked body
 * renders on top, preserving the icon's normal look inside the ring.
 */
export function getKeyIconSvgMarkup(color, shape, size = 14, ready = false) {
  const hex = KEY_COLOR_HEX[color] || '#888';
  const path = KEY_SHAPE_PATHS[shape];
  const label = (shape && shape !== '?')
    ? `${color} ${shape}${ready ? ' (key ready)' : ''}`
    : `${color} (unknown shape)${ready ? ' (key ready)' : ''}`;

  let defs = '';
  let fillAttr = hex;
  if (color === 'gold') {
    defs =
      '<defs>' +
      '<linearGradient id="dkt-gold-grad" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#ffe285"/>' +
      '<stop offset="50%" stop-color="#d9a017"/>' +
      '<stop offset="100%" stop-color="#8a5e00"/>' +
      '</linearGradient>' +
      '</defs>';
    fillAttr = 'url(#dkt-gold-grad)';
  }

  // Ready backdrop — drawn first (bottom of stack), a rounded
  // chartreuse rectangle filling the whole viewBox at 30% opacity.
  // Acts as a "highlighted cell" wash behind the icon. Skipped
  // when !ready (pending icons keep a transparent background so
  // the map shows through).
  let backdrop = '';
  if (ready) {
    backdrop = `<rect x="0" y="0" width="16" height="16" rx="3" ` +
      `fill="${READY_HALO_HEX}" fill-opacity="${READY_BACKDROP_OPACITY}"/>`;
  }

  // Ready halo — drawn ABOVE the backdrop but below the body, as a
  // thick chartreuse stroke with no fill. Body on top covers the
  // inner half of the halo stroke, leaving only the outer half
  // visible as a bright ring around the shape. Skipped when !ready.
  let halo = '';
  if (ready) {
    halo = path
      ? `<path d="${path}" fill="none" stroke="${READY_HALO_HEX}" ` +
        `stroke-width="${READY_HALO_STROKE_WIDTH}" stroke-linejoin="round"/>`
      : `<circle cx="8" cy="8" r="5.5" fill="none" stroke="${READY_HALO_HEX}" ` +
        `stroke-width="${READY_HALO_STROKE_WIDTH}"/>`;
  }

  // Body — solid fill (gradient for gold, flat hex for others) + thin
  // dark outline. Identical for ready AND pending. Ready distinction
  // comes from the BACKDROP + HALO layers stacked underneath, not
  // from dimming the body.
  const body = path
    ? `<path d="${path}" fill="${fillAttr}" stroke="rgba(0,0,0,0.55)" ` +
      `stroke-width="0.7" stroke-linejoin="round"/>`
    : `<circle cx="8" cy="8" r="5.5" fill="${fillAttr}" ` +
      `stroke="rgba(0,0,0,0.55)" stroke-width="0.7"/>`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" ` +
    `width="${size}" height="${size}" class="key-icon" aria-label="${label}">` +
    defs +
    `<title>${label}</title>` +
    backdrop +
    halo +
    body +
    `</svg>`
  );
}

/**
 * Render a key/door icon DOM element for the UI. Parses the markup
 * from getKeyIconSvgMarkup via DOMParser so both render paths use
 * identical SVG (gold gradient, etc.).
 */
export function renderKeyIcon(color, shape, size = 14, ready = false) {
  const markup = getKeyIconSvgMarkup(color, shape, size, ready);
  const parser = new DOMParser();
  const doc = parser.parseFromString(markup, 'image/svg+xml');
  return doc.documentElement;
}
