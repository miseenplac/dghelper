// Alt1 overlay rendering for key/door icons on the RS3 DG map widget.
//
// Pipeline:
//   1. preRenderIcon(color, shape, size) — async, rasterises the SVG
//      path from keyIcon.js to an ImageData buffer, then encodes via
//      a1lib.encodeImageString to the BGRA-base64 format alt1 wants.
//      Cached by `${color}-${shape}-${size}` so repeat calls are free.
//   2. drawKeyOverlay(x, y, color, shape, ...) — looks up the cached
//      string and calls alt1.overLayImage. Must be called every tick
//      while the icon should be visible; Alt1 overlays time out.
//
// Why encodeImageString and not plain PNG base64: alt1.overLayImage
// expects the raw pixel buffer format defined in alt1/base — each
// pixel serialised as four bytes BGRA, then btoa'd. Passing a
// data:image/png;base64,... URL does NOT work here; it would silently
// render garbage.

import { encodeImageString } from 'alt1/base';
import { getKeyIconSvgMarkup } from './keyIcon.js';

const iconCache = new Map();

// Cache-key builder. `ready` splits the cache so both variants can
// coexist; callers that don't know/care about ready state default to
// the "need-key" (unhaloed) variant, preserving legacy behaviour.
function cacheKey(color, shape, size, ready) {
  return `${color}-${shape}-${size}-${ready ? 'ready' : 'need'}`;
}

/**
 * Render one (color, shape, ready) combo to a canvas at `size`×`size` px,
 * then encode the resulting RGBA pixels into alt1's BGRA-base64 format.
 * Returns a Promise<string> — resolves with the encoded image string
 * ready to pass to alt1.overLayImage.
 *
 * Uses an offscreen Image element to rasterise the SVG through the
 * browser's native SVG renderer, then getImageData on a canvas to
 * extract pixels. Stroke width and color fill come from keyIcon.js's
 * KEY_SHAPE_PATHS / KEY_COLOR_HEX so this module stays in sync with
 * whatever the UI shows. `ready=true` adds the chartreuse halo ring.
 */
function rasterIcon(color, shape, size, ready) {
  // Reuses getKeyIconSvgMarkup so the overlay rasterisation picks up
  // whatever the UI renders — gradients, strokes, halo ring — without
  // duplicate logic in this module.
  const svgStr = getKeyIconSvgMarkup(color, shape, size, ready);

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, size, size);
      const imageData = ctx.getImageData(0, 0, size, size);
      try {
        const encoded = encodeImageString(imageData);
        resolve(encoded);
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = () => reject(new Error(`SVG load failed: ${color} ${shape}${ready ? ' ready' : ''}`));
    // Data URL keeps the SVG same-origin and avoids any Blob lifecycle
    // issues in CEF. encodeURIComponent handles the # in colour hex.
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgStr);
  });
}

/**
 * Pre-render an icon and store in the cache. Typically called at plugin
 * startup for every (color, shape, ready) combination. Returns the
 * cached encoded string after rasterisation completes.
 */
export async function preRenderIcon(color, shape, size = 16, ready = false) {
  const key = cacheKey(color, shape, size, ready);
  if (iconCache.has(key)) return iconCache.get(key);
  const encoded = await rasterIcon(color, shape, size, ready);
  iconCache.set(key, encoded);
  return encoded;
}

/**
 * Synchronous cache lookup. Returns the encoded string, or null if the
 * icon hasn't been pre-rendered yet. Used on the tick-loop hot path.
 */
export function getCachedIcon(color, shape, size = 16, ready = false) {
  return iconCache.get(cacheKey(color, shape, size, ready)) || null;
}

/**
 * Draw a pre-rendered key icon as an Alt1 overlay centered at screen
 * coords (x, y). `ready=true` selects the chartreuse-halo variant to
 * signal "user has the matching key for this info'd door". Returns a
 * short status string:
 *   'ok'              — overlay call succeeded
 *   'no-alt1-api'     — window.alt1 / overLayImage missing
 *   'not-prerendered' — icon wasn't in the cache (call preRenderIcon)
 *   'threw: <msg>'    — overLayImage itself threw
 *
 * alt1 positions the image with its TOP-LEFT at (x, y); we offset by
 * -size/2 so callers can pass the desired CENTER point.
 */
export function drawKeyOverlay(x, y, color, shape, size = 16, duration = 800, ready = false) {
  if (!window.alt1 || typeof alt1.overLayImage !== 'function') return 'no-alt1-api';
  const encoded = getCachedIcon(color, shape, size, ready);
  if (!encoded) return 'not-prerendered';
  try {
    const left = Math.round(x - size / 2);
    const top = Math.round(y - size / 2);
    alt1.overLayImage(left, top, encoded, size, duration);
    return 'ok';
  } catch (e) {
    return 'threw: ' + (e && e.message ? e.message : e);
  }
}
