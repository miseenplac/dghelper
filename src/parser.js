// Parse RS3 Dungeoneering chat lines for key / door events.
//
// Messages of interest (timestamps stripped before matching):
//   Your party found a key: <Color> <shape> key           (system broadcast, no player)
//   Your party used a key:  <Color> <shape> key           (system broadcast, no player)
//   <Player Name>: Key required: <Color> <shape> key      (player-attributed door info)
//   <Player Name>: Door unlockable: <Color> <shape> door  (player-attributed door info)
//   You unlock the door.                                  (local-only, no color/shape)
//   You reforge the key and use it to unlock the door.    (local-only)
//
// parseChatLine accepts a { text, fragments } object (ChatBoxReader line
// shape) so door-info lines can extract the username via FRAGMENT COLOR
// rather than text-regex splitting. RS3's usernames render in the default
// (basic-white) system colour; clan titles and icons surrounding the name
// render in non-white colours. Filtering the fragments INSIDE the `[player]:`
// envelope by color — keep white, drop the rest — gives the exact username
// regardless of how many icons/titles decorate the name.
//
// Key found/used broadcasts have NO player attribution (they're universal
// party system messages), so those paths don't touch the fragment logic.
//
// Strategy: the universe of keys is small and fixed (wiki:
// https://runescape.wiki/w/Dungeoneering_keys). There are exactly
//   8 colours: blue, crimson, gold, green, orange, purple, silver, yellow
//   8 shapes : corner, crescent, diamond, pentagon, rectangle, shield,
//              triangle, wedge
// Alt1's chatbox OCR mangles characters fairly often (especially for party-
// broadcast lines), so rather than requiring the regex to capture the color
// and shape exactly, we capture ANY word-ish token and snap it to the
// closest canonical entry via Levenshtein distance. "Sliver", "Si1ver",
// "silvr" → silver. Tokens that are too garbled to resemble any real entry
// are rejected (event returns null), which is far better than creating
// phantom "c .ld crescent" tracker rows.

// Slot-colour classifier — imported so parseChatLine can annotate
// door-info events with the slot-colour of the username fragment
// when the local client renders Ring-of-Kinship chat names in slot
// colour. Emitted on events as `ev.slotColor`. Retained for future
// client-specific attribution paths; on THIS user's client usernames
// render white so ev.slotColor comes back null and self-attribution
// goes through aliasMap / partyRoster fuzzy match instead.
import { classifySlotColor } from './partyPanel.js';

export const KEY_COLORS = Object.freeze([
  'blue', 'crimson', 'gold', 'green', 'orange', 'purple', 'silver', 'yellow'
]);
export const KEY_SHAPES = Object.freeze([
  'corner', 'crescent', 'diamond', 'pentagon', 'rectangle', 'shield',
  'triangle', 'wedge'
]);

const RE_TIMESTAMP = /^\[\d{1,2}:\d{2}:\d{2}\]\s*/;

// Lenient: "found/used a key: <word> <word> key" — capture `\w+` instead of
// `[A-Za-z]+` so OCR noise like "B1ue" or "Si1ver" gets through to the
// normaliser. Keyword must appear anywhere on the line (not anchored).
const RE_FOUND = /found\s+a\s+key:\s+(\w+)\s+(\w+)\s+key/i;
const RE_USED  = /used\s+a\s+key:\s+(\w+)\s+(\w+)\s+key/i;

// Local-player door-unlock messages. Two known RS3 wordings:
//   "You reforge the key and use it to unlock the door."
//   "You unlock the door."
// Anchor "You unlock" at start-of-line (post-timestamp-strip) so it can't be
// triggered by stray occurrences inside other players' public chat.
const RE_LOCAL_UNLOCK = /(?:reforge the key and use it to unlock the door|^You unlock the door)/i;

// Door-info patterns. The skip-nudge in index.js can eat leading letters of
// the keyword itself (e.g. "Door unlockable:" reads as "r unlockable:"), so
// we anchor on the distinctive second word ("required:" / "unlockable:") and
// allow garbage in between the player and the keyword. The strong suffix
// "<word> <word> key|door" + canonical-list snap prevents false positives.
//
// Player name is extracted from fragment colors (see
// extractPlayerFromFragments), not from the regex — so these patterns only
// need to match the body text + capture the (color, shape) tokens.
const RE_REQ_ANY            = /required:\s+(\w+)\s+(\w+)\s+key/i;
const RE_UNLOCK_ANY         = /unlockable:\s+(\w+)\s+(\w+)\s+door/i;

// Suffix-anchored fallbacks. RS3's chat reader can mangle the preamble of a
// line badly — in party dungeons, custom clan titles, icons, and coloured
// username rendering all interact with our palette and produce nonsense like
// `!e: Gold crescent door` where "Door unlockable:" has collapsed into
// "!e:". The BODY of these lines ("Gold crescent door" / "Gold crescent key")
// always renders in a single pure broadcast colour (gold) so it survives OCR
// intact. These regexes pick that body out no matter what precedes it.
//
// For door suffixes this is authoritative: every DGN line ending in
// "<color> <shape> door" is a door-info. Key suffixes are ambiguous (could be
// `found a key`, `used a key`, or `Key required:`), so callers must
// disambiguate using an action keyword heuristic — see tryFallbackFromSuffix.
const RE_DOOR_SUFFIX = /\b(\w+)\s+(\w+)\s+door\b/i;
const RE_KEY_SUFFIX  = /\b(\w+)\s+(\w+)\s+key\b/i;

// Floor lifecycle markers.
//   START: the "Floor N" banner that renders BELOW "Welcome to Daemonheim".
//     RS3 paints "Floor" in default off-white and the number in broadcast
//     purple [91,26,145]. This white-word + purple-digit pair is unique to
//     the Daemonheim floor banner, and using fragment COLOURS (rather than
//     the Welcome text regex) makes detection robust against OCR mangling
//     of the banner glyphs. See parseFloorBanner.
//   END (outfit): `Your warped gorajan trailblazer outfit boosts your base
//     floor experience by N%.` — Dungeoneering reward line. Outfit variants
//     (e.g. "Blazing trailblazer") will need their own matcher — extend
//     this regex when new ones show up.
//   END (leave-party): `You leave the party.` — authoritative run-end. Always
//     closes whatever floor is open, regardless of whether outfit bonus /
//     winterface already fired.
const RE_FLOOR_END   = /boosts\s+your\s+base\s+floor\s+experience/i;
const RE_LEAVE_PARTY = /^You\s+leave\s+the\s+party\b/i;

const BROADCAST_PURPLE = [91, 26, 145];

function isNearWhite(color) {
  if (!Array.isArray(color) || color.length < 3) return false;
  const [r, g, b] = color;
  if (r < 200 || g < 200 || b < 200) return false;
  return Math.max(r, g, b) - Math.min(r, g, b) <= 40;
}

function isColorAt(color, ref, tol = 20) {
  if (!Array.isArray(color) || color.length < 3) return false;
  return Math.abs(color[0] - ref[0]) <= tol &&
         Math.abs(color[1] - ref[1]) <= tol &&
         Math.abs(color[2] - ref[2]) <= tol;
}

/**
 * Detect the "Floor N" banner line via its two-colour signature. Looking at
 * live OCR dumps, the banner font is rendered in a way that Alt1's OCR
 * frequently mangles to the point where the digits "51" come back as e.g.
 * "-ull)" and "Floor" as "-!oo.le,.". So we CAN'T rely on text matching —
 * only the colour pair survives intact. Required:
 *   - at least one near-white fragment with alpha/digit content
 *   - at least one broadcast-purple [91,26,145] fragment with alpha/digit content
 *   - total alphanumeric content across both ≤30 chars (excludes long
 *     player-chat lines where a clan title happens to be purple and body is
 *     white; the floor banner is very short by comparison)
 *
 * Returns `{ floorNumber }` on match — floorNumber is the parsed integer if
 * the purple fragment contained a readable digit, else null. (Floor-start
 * still fires either way; the number is informational.) Returns null when
 * the signature doesn't match.
 *
 * Outfit-end is single-colour purple (no white body), so the "white present"
 * check naturally excludes it. The caller also matches outfit-end first via
 * text regex, belt-and-braces.
 */
function detectFloorBanner(fragments) {
  if (!Array.isArray(fragments) || fragments.length < 2) return null;
  let hasWhite = false;
  let hasPurple = false;
  let floorNum = null;
  let whiteAlnum = 0;
  let purpleAlnum = 0;

  for (const f of fragments) {
    if (!f || !f.color || typeof f.text !== 'string') continue;
    const alnum = f.text.match(/[A-Za-z0-9]/g);
    if (!alnum || !alnum.length) continue;

    if (isNearWhite(f.color)) {
      hasWhite = true;
      whiteAlnum += alnum.length;
    } else if (isColorAt(f.color, BROADCAST_PURPLE, 20)) {
      hasPurple = true;
      purpleAlnum += alnum.length;
      if (floorNum === null) {
        const m = f.text.match(/\d+/);
        if (m) floorNum = parseInt(m[0], 10);
      }
    }
  }

  if (!hasWhite || !hasPurple) return null;
  if (whiteAlnum + purpleAlnum > 30) return null;
  return { floorNumber: floorNum };
}

function stripTimestamp(text) {
  return text.replace(RE_TIMESTAMP, '');
}

// --- Fuzzy matching ---------------------------------------------------------

// Standard Levenshtein edit distance (iterative, O(n*m) time, O(m) space).
// Short strings only (≤10 chars), so no practical perf concern.
function levenshtein(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let prevDiag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      if (a.charCodeAt(i - 1) === b.charCodeAt(j - 1)) {
        prev[j] = prevDiag;
      } else {
        prev[j] = Math.min(prevDiag, prev[j - 1], prev[j]) + 1;
      }
      prevDiag = tmp;
    }
  }
  return prev[b.length];
}

// Snap `word` to the closest canonical entry in `list`. Returns the canonical
// form on match, or null if every entry is too far away. Acceptance: edit
// distance ≤ min(2, ceil(canonicalLen * 0.45)). That's 1 edit for 3-char
// words (none here), 2 edits for 4-char ("blue", "gold"), 2 edits for 5-char
// ("green", "wedge"), 3 edits for 7+ ("crimson", "diamond", "pentagon") —
// scaled so longer words tolerate more mangling proportionally.
function closestCanonical(word, list) {
  if (!word) return null;
  const lower = String(word).toLowerCase();
  if (list.includes(lower)) return lower;
  let best = null;
  let bestDist = Infinity;
  for (const c of list) {
    const d = levenshtein(lower, c);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  if (!best) return null;
  const threshold = Math.max(1, Math.ceil(best.length * 0.45));
  return bestDist <= threshold ? best : null;
}

// Normalise a raw (color, shape) pair captured from OCR to the canonical
// Dungeoneering vocabulary. Returns { color, shape, fuzzy } or null if either
// token is too garbled to snap.
function normalizeKey(rawColor, rawShape) {
  const color = closestCanonical(rawColor, KEY_COLORS);
  const shape = closestCanonical(rawShape, KEY_SHAPES);
  if (!color || !shape) return null;
  const fuzzy = color !== String(rawColor).toLowerCase() ||
                shape !== String(rawShape).toLowerCase();
  return { color, shape, fuzzy };
}

// --- Fragment-color helpers -------------------------------------------------

// Near-white predicate (all channels high, low RGB spread). Retained as a
// diagnostic-flavoured helper — not a hard gate on name extraction anymore,
// because RS3 party/clan chat colour styles render names in other colours
// (e.g. pale blue) that our OCR palette maps to non-white entries.
function isDefaultWhite(color) {
  if (!Array.isArray(color) || color.length !== 3) return false;
  const [r, g, b] = color;
  if (r < 200 || g < 200 || b < 200) return false;
  return Math.max(r, g, b) - Math.min(r, g, b) <= 40;
}

// Broadcast-gold body colour (RS3 "Your party ..." / "Door unlockable:" text).
// We reject these fragments when harvesting a username — they're body text,
// not name text, even when a colon appears inside them.
const BROADCAST_GOLD = [255, 223, 0];
const SKIP_PLACEHOLDER = '\u00B7';

function colorClose(a, b, tol) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  return Math.abs(a[0] - b[0]) <= tol &&
         Math.abs(a[1] - b[1]) <= tol &&
         Math.abs(a[2] - b[2]) <= tol;
}

// Strip body-text keywords that leaked into the extracted name when the OCR
// dropped the envelope colon between "<Player>:" and the body. Without this,
// door-info lines display as "Aar i key Requred" or "Aar i Door unlockable"
// because the first `:` scanned was the one inside the body keyword, not the
// one closing the player name.
//
// Multiple patterns, all mangled-tolerant — production OCR on short dungeon
// dialogue eats leading consonants of "Key"/"Door" and turns internal
// letters into periods or spaces. We strip from the EARLIEST match onwards.
function stripBodyTail(name) {
  if (typeof name !== 'string') return name;
  let earliest = name.length;
  const patterns = [
    // Canonical keyword phrases (strict — pre-mangling variants)
    /\s*\b(?:key\s*requir\w*|door\s*unlock\w*)\b/i,
    // Context words with leading letter mangled off: "ey re" (Key re),
    // "ky re" (K y re), "oor un" (D oor un), "dor un" (D dor un)
    /\s*\b\w{0,2}(?:y|k)\s+re\b/i,
    /\s*\b\w{0,3}(?:oor|dor)\s+un\b/i,
    // Mangled body keywords themselves — "uire", "uired", "quired",
    // "ockable", "ockab", "nlock" (OCR dropped first consonants).
    /\s*\b\w*(?:uired?|quired|ockable|ockab|nlock)\w*\b/i,
    // Internal period followed by a letter — "re .uired", ". uired".
    // RS3 usernames don't contain periods; a period mid-name is almost
    // always body-text mangling.
    /\s*\.\s*\w/,
  ];
  for (const p of patterns) {
    const m = name.match(p);
    if (m && m.index < earliest) earliest = m.index;
  }
  return name.substring(0, earliest).trim();
}

// A fragment is "timestamp-soup" when its text is only digits and
// colon/semicolon/period/space/brackets, with no letters. OCR-mangled
// timestamps frequently look like `"12: ;9: ;1"` so the textual content
// rather than the colour has to decide it — the colour bucket drifts.
function isTimestampSoup(text) {
  if (typeof text !== 'string' || !text) return true;
  if (!/[A-Za-z]/.test(text)) return true;
  return false;
}

// RS3 timestamp + body-keyword colour ("[HH:MM:SS]" and "Key required:" /
// "Door unlockable:" all render in the same soft blue).
const TIMESTAMP_BLUE = [127, 169, 255];

/**
 * Harvest the username from a chat line by fragment COLOUR, matching the
 * natural RS3 rendering:
 *
 *   [blue timestamp] [white name] [clan-title colour] [blue body keyword] [body]
 *
 * Walk left-to-right and:
 *   - skip blue fragments (timestamp OR body keyword) — stop when we hit the
 *     blue BODY keyword ("Key required:" / "Door unlockable:"), since that
 *     marks the envelope boundary; a bare timestamp blue just gets skipped.
 *   - skip the grey `·` placeholder inserted by skipUnknownBadge.
 *   - skip broadcast-gold body fragments (party system messages).
 *   - skip non-white clan-title colours silently — the title is decoration,
 *     the user's real name is the WHITE part.
 *   - collect white / near-white fragments with at least one alphanumeric
 *     char as name material.
 *
 * Earlier versions walked until the first `:` anywhere in the line, but the
 * timestamp fragment "02:33:04" contains colons too — that triggered an
 * early false envelope match and dropped the name entirely. Keying off
 * colour (not punctuation) sidesteps that.
 */
function extractPlayerFromFragments(fragments) {
  if (!Array.isArray(fragments) || !fragments.length) return null;
  const nameParts = [];
  // Tracks whether we've already collected any username text. Used to
  // distinguish "placeholder mid-name" (legitimate: icon between name
  // words like Aari·the Iceborn) from "placeholder before any name"
  // (illegitimate: skipUnknownBadge ate the whole username, and any
  // subsequent fragments are clan title / body, not name).
  let collectedName = false;

  for (const f of fragments) {
    if (!f || typeof f.text !== 'string' || !f.text || !Array.isArray(f.color)) continue;

    // Some fragments carry an inline "[HH:MM:SS]" prefix — strip it.
    const text = f.text.replace(/^\s*\[\d+:\d+:\d+\]\s*/, '');
    if (!text.trim()) continue;

    // Skip-placeholder handling — crucial for correctness.
    //   • Mid-name (collectedName=true): icon between name words, keep
    //     walking to collect the second half of the name.
    //   • Before any name (collectedName=false): skipUnknownBadge ate
    //     the username itself. Bail — any subsequent slot-coloured or
    //     white fragment is the clan title (wrong for attribution) or
    //     body text.
    if (text.trim() === SKIP_PLACEHOLDER) {
      if (!collectedName) break;
      continue;
    }

    // Blue fragment: timestamp OR body keyword. The timestamp content is
    // digits+colons only; the body keyword contains letters ("Key required:"
    // or OCR-mangled variants like "Key re .uired:"). Any letter-bearing
    // blue fragment terminates the name accumulation unconditionally —
    // avoids a prior-regex bug where OCR-split "requir" → "re .uired"
    // slipped past the `key\s*requir` test and let "Key re .uired" leak
    // into the extracted name.
    if (colorClose(f.color, TIMESTAMP_BLUE, 15)) {
      if (/[A-Za-z]/.test(text)) break;
      continue;
    }

    // Broadcast-gold (party system messages) — not user chat.
    if (colorClose(f.color, BROADCAST_GOLD, 30)) continue;

    // Name material sources (in priority order, but both collected):
    //   (a) WHITE / near-white fragments — the default RS3 chat-name
    //       rendering (system / public / FC chat).
    //   (b) SLOT-COLOURED fragments — dungeoneering Ring-of-Kinship
    //       party chat renders each player's name in their slot colour
    //       (red/teal/lime/yellow/pale). Previously these were lumped
    //       with "clan title / decoration" and skipped, which is why
    //       door-info events in dungeons came back with player='?'.
    // Clan-title or unrelated-decoration colours (non-white, non-slot-
    // matching) still get skipped below.
    if (/[A-Za-z0-9]/.test(text)) {
      if (isDefaultWhite(f.color)) {
        nameParts.push(text);
        collectedName = true;
      } else if (classifySlotColor(f.color[0], f.color[1], f.color[2])) {
        nameParts.push(text);
        collectedName = true;
      }
      // else: clan title / decoration colour, skip silently.
    }
  }

  if (!nameParts.length) return null;
  let name = nameParts.join('').replace(/\s+/g, ' ').trim();
  name = name.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
  name = stripBodyTail(name);
  if (!name || !/[A-Za-z]/.test(name)) return null;
  return name;
}

/**
 * Walk the fragment list the same way extractPlayerFromFragments does,
 * but return the SLOT COLOUR of the username fragment (if any) rather
 * than the name text. Returns one of 'red' | 'teal' | 'lime' | 'yellow'
 * | 'pale', or null if the username wasn't slot-coloured (e.g., non-
 * dungeoneering chat, system broadcasts, or the line lacked a readable
 * username fragment).
 *
 * Stops walking at the blue body-keyword fragment ("Key required:" /
 * "Door unlockable:") so body-text colours downstream (broadcast gold,
 * key-name colours) can never be mis-read as a slot colour.
 *
 * Used by parseChatLine to annotate door-info events with the slot
 * colour of the info'ing player (emitted on the event as
 * `ev.slotColor`). Currently informational only — the attribution
 * path is via signature / fuzzy match. Retained as a hook for a
 * future per-slot attribution UI if a need arises.
 */
function extractSlotColorFromFragments(fragments) {
  if (!Array.isArray(fragments) || !fragments.length) return null;
  for (const f of fragments) {
    if (!f || typeof f.text !== 'string' || !Array.isArray(f.color)) continue;
    const text = f.text.replace(/^\s*\[\d+:\d+:\d+\]\s*/, '');
    if (!text.trim()) continue;

    // Placeholder as the FIRST substantial fragment means the username
    // itself was consumed by skipUnknownBadge (unknown colour / icon).
    // BAIL — don't trust any subsequent slot-coloured fragment as the
    // username, because it's really a clan title whose decoration
    // colour can coincidentally match a slot colour (e.g., "the Top
    // Secret Santa" in red-ish would resolve to slot-1 red and mis-
    // attribute a slot-4 yellow player's door-info to the host).
    if (text.trim() === SKIP_PLACEHOLDER) return null;

    // Timestamp-blue: skip bare timestamps, break on body keyword
    // (same logic as extractPlayerFromFragments so we stop BEFORE
    // entering the body text region).
    if (colorClose(f.color, TIMESTAMP_BLUE, 15)) {
      if (/[A-Za-z]/.test(text)) return null; // hit body before any name
      continue;
    }
    if (colorClose(f.color, BROADCAST_GOLD, 30)) continue;

    // First substantial text-bearing fragment — this IS the username.
    // Return its slot-colour classification (null if it's default-white
    // public chat or some non-slot shade). Do NOT keep walking to later
    // fragments: that's how we used to mis-read clan titles as slot
    // usernames.
    if (/[A-Za-z0-9]/.test(text)) {
      return classifySlotColor(f.color[0], f.color[1], f.color[2]);
    }
  }
  return null;
}

/**
 * Text-only fallback for username extraction. Takes everything before the
 * FIRST `:` in the line body (post-timestamp-strip) and cleans obvious
 * decorations:
 *   - skip-placeholder middle-dots (·) that the forward-nudge inserted for
 *     unknown clan icons
 *   - leading/trailing whitespace and stray punctuation
 *
 * This fires when fragment-color extraction returns null (fragments missing
 * or none matched `isDefaultWhite`). Produces a best-effort name that may
 * include surrounding title text — still far better than "?" when the door
 * UI is trying to show "who info'd this".
 */
function extractPlayerFromText(text) {
  if (typeof text !== 'string') return null;
  // Skip a leading mangled timestamp — OCR sometimes returns it without a
  // closing bracket (e.g. `[12: ;9: ;1`) so RE_TIMESTAMP doesn't strip it.
  // Discard any leading non-alpha run up to the first letter; that collapses
  // `[12: ;9: ;1· . ` down to just the name-ish content.
  const firstAlpha = text.search(/[A-Za-z]/);
  if (firstAlpha < 0) return null;
  const scan = text.slice(firstAlpha);
  // Envelope is everything before the first `:` separating the speaker from
  // the body. Door-info bodies contain their own colons ("Door unlockable:")
  // so we can't greedy-match the last colon — first wins.
  const colonIdx = scan.indexOf(':');
  if (colonIdx <= 0) return null;
  let name = scan.slice(0, colonIdx);
  name = name.replace(/\u00B7/g, ' ');
  name = name.replace(/\s+/g, ' ').replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '').trim();
  name = stripBodyTail(name);
  return (name && /[A-Za-z]/.test(name)) ? name : null;
}

/**
 * Composite fingerprint of the name-region rendering on a door-info line.
 * Same player → same fragments → same signature across the whole session
 * (chat font + palette are deterministic). Different players render with
 * different widths, fragment/placeholder counts, or colour sets, so their
 * signatures differ even when their garbled OCR text happens to coincide.
 *
 * Encodes:
 *   w  — pixel width from first name fragment xstart to last name fragment xend
 *   n  — fragment count in the name region
 *   p  — number of skip-placeholder (·) fragments (icon count proxy)
 *   t  — concatenated raw text, trimmed (stable per player even if garbled)
 *   c  — sorted-unique colour tuples seen in the name region
 *
 * Returns the signature string, or null if the fragments don't contain a
 * recognisable <name>/<body-keyword> structure (e.g. party broadcasts).
 * The alias map in index.js uses this as its lookup key.
 */
function computePlayerSignature(fragments) {
  if (!Array.isArray(fragments) || !fragments.length) return null;
  const nameFrags = [];
  let reachedBody = false;

  for (const f of fragments) {
    if (!f || typeof f.text !== 'string' || !Array.isArray(f.color)) continue;
    const text = f.text.replace(/^\s*\[\d+:\d+:\d+\]\s*/, '');
    if (!text.trim()) continue;

    if (colorClose(f.color, TIMESTAMP_BLUE, 15)) {
      if (/key\s*requir|door\s*unlock/i.test(text)) { reachedBody = true; break; }
      continue;
    }
    if (colorClose(f.color, BROADCAST_GOLD, 30)) return null;

    nameFrags.push(f);
  }

  if (!reachedBody || !nameFrags.length) return null;

  let minX = Infinity, maxX = -Infinity;
  let placeholders = 0;
  const texts = [];
  const colors = new Set();
  for (const f of nameFrags) {
    if (typeof f.xstart === 'number') minX = Math.min(minX, f.xstart);
    if (typeof f.xend === 'number')   maxX = Math.max(maxX, f.xend);
    if (f.text.trim() === SKIP_PLACEHOLDER) placeholders++;
    texts.push(f.text);
    if (Array.isArray(f.color)) colors.add(f.color.join(','));
  }
  const width = (isFinite(minX) && isFinite(maxX)) ? (maxX - minX) : 0;
  const text = texts.join('').replace(/\s+/g, ' ').trim();
  const colorKey = Array.from(colors).sort().join('/');
  return `w:${width}|n:${nameFrags.length}|p:${placeholders}|t:${text}|c:${colorKey}`;
}

// --- Public parse entry point ----------------------------------------------

/**
 * Parse a single chat line.
 *
 * Accepts either:
 *   - a ChatBoxReader line object `{ text, fragments }` — fragment colors
 *     are used to extract the username on door-info lines (preferred path)
 *   - a plain string — door-info lines will come back with player='?' since
 *     we can't do colour-based extraction without fragments
 *
 * Returns one of:
 *   { type: 'key-found', color, shape, fuzzy? }
 *   { type: 'key-used',  color, shape, fuzzy? }
 *   { type: 'door-info', color, shape, player, fuzzy? }
 *   { type: 'key-used-local' }
 * or null if no match.
 *
 * `fuzzy: true` is set when at least one of (color, shape) was snapped from a
 * non-canonical raw token — useful for debug logging to see when the fuzzy
 * matcher is doing heavy lifting.
 */
export function parseChatLine(lineOrText) {
  const text = typeof lineOrText === 'string'
    ? lineOrText
    : (lineOrText && typeof lineOrText.text === 'string' ? lineOrText.text : '');
  const fragments = typeof lineOrText === 'string'
    ? null
    : (lineOrText && Array.isArray(lineOrText.fragments) ? lineOrText.fragments : null);
  if (!text) return null;
  // Normalise separators. RS3 broadcast lines can OCR-render spaces as commas
  // (the body font's tiny space glyph gets matched to a comma shape) — we've
  // seen `Your party found a key:,Blue pentagon,key` come back from a clean
  // read. Regexes use `\s+` between tokens, so rewriting `,` → ` ` lets the
  // same patterns match both clean and OCR-mangled spacing. Dungeoneering
  // key/door lines never contain legitimate commas, so this is safe.
  const stripped = stripTimestamp(text).trim().replace(/,/g, ' ');

  // Floor lifecycle markers — precede key/door matching because they're
  // simple substring hits and we don't want a stray "key" in a broadcast
  // body to shadow the floor event. `reason` distinguishes the two end
  // sources so index.js can route them differently (outfit = fallback,
  // leave-party = absolute).
  if (RE_LEAVE_PARTY.test(stripped)) return { type: 'floor-end', reason: 'leave-party' };
  if (RE_FLOOR_END.test(stripped))   return { type: 'floor-end', reason: 'outfit' };
  const banner = detectFloorBanner(fragments);
  if (banner) return { type: 'floor-start', floorNumber: banner.floorNumber };

  let m;
  // Party-broadcast events — no player attribution (system message).
  if ((m = stripped.match(RE_FOUND))) {
    const n = normalizeKey(m[1], m[2]);
    if (n) return { type: 'key-found', color: n.color, shape: n.shape, fuzzy: n.fuzzy };
  }
  if ((m = stripped.match(RE_USED))) {
    const n = normalizeKey(m[1], m[2]);
    if (n) return { type: 'key-used', color: n.color, shape: n.shape, fuzzy: n.fuzzy };
  }
  // Local unlock message — no color/shape data.
  if (RE_LOCAL_UNLOCK.test(stripped)) {
    return { type: 'key-used-local' };
  }
  // Door-info — player extracted from fragment colours. `?` if fragments
  // missing (legacy string-only callers, or OCR dropped the name entirely).
  if ((m = stripped.match(RE_REQ_ANY))) {
    const n = normalizeKey(m[1], m[2]);
    if (n) {
      const player = resolvePlayer(fragments, stripped);
      const playerSignature = computePlayerSignature(fragments);
      const slotColor = extractSlotColorFromFragments(fragments);
      return { type: 'door-info', player, playerSignature, slotColor, color: n.color, shape: n.shape, fuzzy: n.fuzzy };
    }
  }
  if ((m = stripped.match(RE_UNLOCK_ANY))) {
    const n = normalizeKey(m[1], m[2]);
    if (n) {
      const player = resolvePlayer(fragments, stripped);
      const playerSignature = computePlayerSignature(fragments);
      const slotColor = extractSlotColorFromFragments(fragments);
      return { type: 'door-info', player, playerSignature, slotColor, color: n.color, shape: n.shape, fuzzy: n.fuzzy };
    }
  }

  // Strict preambles all missed. Try suffix-only fallback — see RE_DOOR_SUFFIX
  // comment above for why the body suffix is a reliable authority when the
  // preamble is garbled.
  const fb = tryFallbackFromSuffix(stripped, fragments);
  if (fb) return fb;

  return null;
}

// Shared player resolver: color-based first (clean case), then text-before-`:`
// (robust against OCR that mis-buckets the username's colour into a non-white
// palette entry), then `?`. A final `looksLikeBodyText` gate rejects results
// that contain body-keyword fingerprints — catches cases where OCR garbled
// the real name to soup AND the body text leaked through the fallback path
// (e.g. "Key re .uired" slipping out of extractPlayerFromText).
function resolvePlayer(fragments, stripped) {
  const name = extractPlayerFromFragments(fragments) ||
               extractPlayerFromText(stripped);
  if (!name) return '?';
  if (looksLikeBodyText(name)) return '?';
  return name;
}

// True when an extracted "name" is actually body text. Catches literal body
// keywords plus their OCR-split/mangled variants — production OCR eats
// leading consonants ("Key" → "ey", "Door" → "oor") and turns internal
// letters into periods ("required" → "re .uired", "unlock" → "un .ock").
function looksLikeBodyText(name) {
  if (typeof name !== 'string') return false;
  // Too-short remnants — typically what's left after stripBodyTail chops
  // the body keyword off the end of a mangled line ("ey re .uired" → "ey"
  // after stripping ".uired"; or "r unloc ." → "r" after stripping
  // "unloc"). Real RS3 usernames aren't ≤ 2 characters. Flagging these
  // as body-text prevents them from slipping through as the player field.
  if (name.trim().length < 3) return true;
  // Canonical strict keywords
  if (/\b(?:requir|unlock)\w*/i.test(name)) return true;
  // Mangled keyword bodies (first consonants dropped)
  if (/\b\w*(?:uired?|quired|ockable|ockab|nlock)\w*\b/i.test(name)) return true;
  // Mangled context: "Key re" / "Door un" with leading letter(s) garbled
  if (/\b\w{0,2}(?:y|k)\s+re\b/i.test(name)) return true;
  if (/\b\w{0,3}(?:oor|dor)\s+un\b/i.test(name)) return true;
  // Internal period — RS3 usernames don't contain `.` mid-text, so an
  // internal period is a very strong OCR-body-mangling signal.
  if (/\S\.\S/.test(name)) return true;
  return false;
}

// Try to recover an event from just the line's body suffix. Called after
// every strict regex has missed — only fires when the CANONICAL
// "<color> <shape> (key|door)" tail snaps cleanly to the Dungeoneering
// vocabulary, so false positives from unrelated chat are rare (someone would
// have to type exactly e.g. "gold crescent door" in public chat).
function tryFallbackFromSuffix(stripped, fragments) {
  // Door suffix is authoritative — every DGN "<X> <Y> door" line is a door-
  // info. No action-keyword check needed.
  const md = stripped.match(RE_DOOR_SUFFIX);
  if (md) {
    const n = normalizeKey(md[1], md[2]);
    if (n) {
      return {
        type: 'door-info',
        player: resolvePlayer(fragments, stripped),
        playerSignature: computePlayerSignature(fragments),
        slotColor: extractSlotColorFromFragments(fragments),
        color: n.color,
        shape: n.shape,
        fuzzy: true,   // fallback path is inherently fuzzy — tag as such
      };
    }
  }
  // Key suffix needs action-keyword disambiguation:
  //   `foun` / `party` anywhere → party found broadcast  (key-found)
  //   `use` + `party`           → party used broadcast   (key-used)
  //   `requir`                  → Key required door-info
  //
  // When OCR has mangled the preamble so badly that NO action keyword is
  // readable (we've seen lines where "Key required: Yellow diamond key" comes
  // back as `[1' .5 ':05· . -- .c-· . e·e .· - !: Yellow diamond key` —
  // "required" is entirely lost), fall through to a default of door-info.
  // Rationale: for a chat reader that's already lost the preamble, the more
  // common and more user-visible failure is missing a door. A phantom door
  // from a mis-classified party broadcast is user-clearable via Reset; a
  // silently-dropped door-info is invisible.
  const mk = stripped.match(RE_KEY_SUFFIX);
  if (mk) {
    const n = normalizeKey(mk[1], mk[2]);
    if (n) {
      const sawParty = /\bparty|\byour\b/i.test(stripped);
      const sawFound = /\bfoun/i.test(stripped);
      const sawUsed  = /\bused?\b/i.test(stripped);
      const sawReq   = /requir/i.test(stripped);

      if (sawFound || (sawParty && !sawUsed && !sawReq)) {
        return { type: 'key-found', color: n.color, shape: n.shape, fuzzy: true };
      }
      if (sawUsed) {
        return { type: 'key-used', color: n.color, shape: n.shape, fuzzy: true };
      }
      // sawReq OR no keyword at all → door-info (Key required).
      return {
        type: 'door-info',
        player: resolvePlayer(fragments, stripped),
        playerSignature: computePlayerSignature(fragments),
        slotColor: extractSlotColorFromFragments(fragments),
        color: n.color, shape: n.shape, fuzzy: true,
      };
    }
  }
  return null;
}

/**
 * Snap a raw OCR'd player name to the closest entry in the party roster
 * via substring/prefix match, then Levenshtein edit distance (length-scaled
 * threshold). Returns the full roster name on a confident match; otherwise
 * returns the raw value unchanged so downstream (the learned-alias layer,
 * or the UI's manual-attribution step) can take over.
 *
 * Raw inputs with <2 alnum chars (e.g. "| -" — OCR glyph-recognition failed
 * completely) bypass fuzzy matching entirely since there's nothing to match
 * on. Those flow straight to the alias/manual layer.
 */
export function resolvePlayerName(raw, roster) {
  if (raw === '?' || !Array.isArray(roster) || !roster.length) return raw || '?';
  const normRaw = String(raw || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normRaw.length < 2) return raw || '?';

  for (const p of roster) {
    if (typeof p !== 'string' || !p.trim()) continue;
    const normP = p.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!normP) continue;
    if (normP.startsWith(normRaw) || normP.includes(normRaw)) return p;
  }
  let best = null;
  let bestDist = Infinity;
  for (const p of roster) {
    if (typeof p !== 'string' || !p.trim()) continue;
    const normP = p.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!normP) continue;
    const d = levenshtein(normRaw, normP);
    if (d < bestDist) { best = p; bestDist = d; }
  }
  if (!best) return raw || '?';
  const normBest = best.toLowerCase().replace(/[^a-z0-9]/g, '');
  const threshold = Math.max(2, Math.floor(normBest.length * 0.45));
  return bestDist <= threshold ? best : (raw || '?');
}

