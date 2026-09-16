import test from "node:test";
import assert from "node:assert/strict";
import {
  MOVES, TAUGHT_MOVES, ALL_MOVES, KEY_TO_MOVE,
  gapsOf, medianGap, spanOf, spansOf, toWire, fromWire, checkContinuation, compare,
} from "../public/js/phrase.js";

const phrase = (...pairs) => pairs.map(([at, move]) => ({ at, move }));

test("every move has a readable name, and the five playable ones have a key", () => {
  for (const m of ALL_MOVES) assert.equal(typeof MOVES[m].label, "string");
  assert.deepEqual(TAUGHT_MOVES, ["pulse", "step_left", "step_right", "jump", "drop"]);
  assert.deepEqual(KEY_TO_MOVE, {
    Space: "pulse", ArrowLeft: "step_left", ArrowRight: "step_right",
    ArrowUp: "jump", ArrowDown: "drop",
  });
  // The dancer reaches for three the keyboard cannot play.
  assert.deepEqual(ALL_MOVES.filter((m) => !TAUGHT_MOVES.includes(m)), ["spin", "bounce", "hold"]);
});

test("a phrase keeps the rhythm it was played in, pause and all", () => {
  // A deliberate rest in the middle: 400, 400, 1500, 400.
  const p = phrase([0, "pulse"], [400, "step_left"], [800, "pulse"], [2300, "jump"], [2700, "drop"]);
  assert.deepEqual(gapsOf(p), [400, 400, 1500, 400]);
  assert.equal(medianGap(p), 400);           // the long rest does not become the tempo
  assert.equal(spanOf(p), 2700 + 400);       // one typical gap of room after the last move
  // Each move gets the time until the next one, so the rest is danced as a rest.
  assert.deepEqual(spansOf(p), [400, 400, 1500, 400, 400]);
});

test("a phrase goes out as moves and gaps, and a continuation comes back on the clock", () => {
  const p = phrase([0, "pulse"], [430, "jump"], [900, "drop"]);
  assert.deepEqual(toWire(p), [
    { move: "pulse", after_ms: 0 },
    { move: "jump", after_ms: 430 },
    { move: "drop", after_ms: 470 },
  ]);
  assert.deepEqual(fromWire([{ after_ms: 500, move: "spin" }, { after_ms: 300, move: "bounce" }]), [
    { at: 500, move: "spin" },
    { at: 800, move: "bounce" },
  ]);
});

test("a continuation is checked before the dancer is allowed to perform it", () => {
  const good = { moves: [{ after_ms: 400, move: "spin" }, { after_ms: 300, move: "hold" }] };
  assert.deepEqual(checkContinuation(good).moves, good.moves);

  assert.match(checkContinuation({}).error, /no list of moves/);
  assert.match(checkContinuation({ moves: [{ after_ms: 400, move: "spin" }] }).error, /2 to 10/);
  assert.match(
    checkContinuation({ moves: [{ after_ms: 400, move: "spin" }, { after_ms: 9000, move: "hold" }] }).error,
    /60 to 4000/,
  );
  assert.match(
    checkContinuation({ moves: [{ after_ms: 400, move: "moonwalk" }, { after_ms: 300, move: "hold" }] }).error,
    /not one of the dancer's moves/,
  );
});

test("comparing two phrases describes them and scores nothing", () => {
  const guess = phrase([0, "pulse"], [500, "spin"], [1000, "jump"]);
  const mine = phrase([0, "pulse"], [400, "drop"], [800, "jump"]);
  const c = compare(guess, mine);
  assert.equal(c.of, 3);
  assert.equal(c.sameMoves, 2);          // pulse and jump match; spin against drop does not
  assert.equal(c.sameLength, true);
  assert.equal(c.gapDiff, 100);          // the model's turn was 100 ms slower per move
});
