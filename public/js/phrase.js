// Phrases: the moves, recording one, and checking a continuation.
// No DOM, no timers, no network — everything here is tested directly.
//
// A phrase is a list of { at, move }, where `at` is milliseconds from the first
// move of that phrase. The gaps between them are the rhythm, and they are kept
// exactly as they were played: a pause inside a phrase is part of the phrase.

// The five a person can play, then the three only the dancer reaches for.
// `glyph` is the key as it is printed, `cap` the move name printed beside it:
// the shortcut and the name are one label, not a name with a note underneath.
export const MOVES = {
  pulse:      { label: "beat",       cap: "Beat",       hint: "on the spot",         key: "Space",      glyph: "Space" },
  step_left:  { label: "step left",  cap: "Step left",  hint: "travels left",        key: "ArrowLeft",  glyph: "←" },
  step_right: { label: "step right", cap: "Step right", hint: "travels right",       key: "ArrowRight", glyph: "→" },
  jump:       { label: "jump",       cap: "Jump",       hint: "leaves the floor",    key: "ArrowUp",    glyph: "↑" },
  drop:       { label: "drop low",   cap: "Drop low",   hint: "down into the floor", key: "ArrowDown",  glyph: "↓" },
  spin:       { label: "spin",       hint: "all the way round" },
  bounce:     { label: "bounce",     hint: "twice, quickly" },
  hold:       { label: "hold",       hint: "stay in the shape" },
};

export const TAUGHT_MOVES = ["pulse", "step_left", "step_right", "jump", "drop"];
export const ALL_MOVES = Object.keys(MOVES);
export const KEY_TO_MOVE = Object.fromEntries(
  TAUGHT_MOVES.map((m) => [MOVES[m].key, m]),
);

export const MIN_PHRASE = 3;      // fewer than this is not yet a phrase
export const OFFER_AFTER_MS = 1600; // a pause this long offers the handover — it never takes it

export const label = (move) => MOVES[move]?.label ?? move;

// ---- Reading a phrase ----

export function gapsOf(events) {
  return events.slice(1).map((e, i) => Math.round(e.at - events[i].at));
}

export function medianGap(events) {
  const g = gapsOf(events);
  if (!g.length) return 500;
  const s = [...g].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
}

// How long a phrase occupies, with one typical gap of room after the last move
// so the final move has somewhere to land.
export function spanOf(events) {
  if (!events.length) return 0;
  return events.at(-1).at + medianGap(events);
}

// How long each move has before the next one starts. The last move is given a
// typical gap, so it is danced at the speed of the phrase and not cut short.
export function spansOf(events) {
  const typical = medianGap(events);
  return events.map((e, i) => (i < events.length - 1 ? events[i + 1].at - e.at : typical));
}

// ---- Sending and receiving ----

// What the model is told: the move, and how long after the previous one it came.
export function toWire(events) {
  return events.map((e, i) => ({
    move: e.move,
    after_ms: i === 0 ? 0 : Math.round(e.at - events[i - 1].at),
  }));
}

// Turn a continuation the model sent into events on the same clock as a phrase.
// `after_ms` on the first move is counted from the end of what the person played.
export function fromWire(moves) {
  const out = [];
  let at = 0;
  for (const m of moves) {
    at += m.after_ms;
    out.push({ at, move: m.move });
  }
  return out;
}

// Never trust the model's shape. Returns { moves } or { error }.
export function checkContinuation(data) {
  if (!data || !Array.isArray(data.moves)) return { error: "The reply had no list of moves in it." };
  if (data.moves.length < 2 || data.moves.length > 10) {
    return { error: `A continuation needs 2 to 10 moves; this one had ${data.moves.length}.` };
  }
  const moves = [];
  for (const m of data.moves) {
    const after = Math.round(Number(m?.after_ms));
    if (!Number.isFinite(after) || after < 60 || after > 4000) {
      return { error: `${JSON.stringify(m?.after_ms)} is not a gap the dancer can use (60 to 4000 ms).` };
    }
    if (!ALL_MOVES.includes(m.move)) return { error: `"${m.move}" is not one of the dancer's moves.` };
    moves.push({ after_ms: after, move: m.move });
  }
  return { moves };
}

// ---- Putting two phrases side by side ----

// What the model proposed against what the person actually played next. This is
// a description, not a score: the model was never told what they intended.
export function compare(guess, actual) {
  const sameLength = guess.length === actual.length;
  let sameMoves = 0;
  for (let i = 0; i < Math.min(guess.length, actual.length); i++) {
    if (guess[i].move === actual[i].move) sameMoves++;
  }
  const g = medianGap(guess);
  const a = medianGap(actual);
  return {
    sameMoves,
    of: Math.min(guess.length, actual.length),
    sameLength,
    guessGap: g,
    actualGap: a,
    // Positive: the model's continuation was slower than what the person played.
    gapDiff: g - a,
  };
}
