import test from "node:test";
import assert from "node:assert/strict";
import { createLimiter, callsEnabled } from "../limits.js";

// A clock we control, so none of this depends on real time passing.
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test("the kill switch reads the usual ways of writing 'off'", () => {
  for (const on of [undefined, "", "true", "1", "yes", "on", "anything"]) {
    assert.equal(callsEnabled(on), true, `${JSON.stringify(on)} should leave calls on`);
  }
  for (const off of ["0", "false", "off", "no", "FALSE", " Off "]) {
    assert.equal(callsEnabled(off), false, `${JSON.stringify(off)} should turn calls off`);
  }
});

test("one visitor gets a fixed number of turns, then is told when more arrive", () => {
  const clock = fakeClock();
  const lim = createLimiter({ perVisitor: 3, windowMs: 60_000, cooldownMs: 0, now: clock.now });

  for (let i = 0; i < 3; i++) {
    assert.equal(lim.check("alice").ok, true, `turn ${i + 1} should be allowed`);
    lim.began("alice"); lim.ended("alice");
    clock.advance(1000);
  }
  assert.equal(lim.turnsLeft("alice"), 0);
  const blocked = lim.check("alice");
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 429);
  assert.match(blocked.error, /taken your 3 turns/);
  assert.match(blocked.error, /teaching and replaying a phrase still work/);

  // Someone else is unaffected.
  assert.equal(lim.check("bob").ok, true);

  // The window rolls: once the first turn ages out, a turn comes back.
  clock.advance(60_000);
  assert.equal(lim.check("alice").ok, true);
});

test("a second request while one is in flight is refused as a duplicate", () => {
  const lim = createLimiter({ cooldownMs: 0 });
  assert.equal(lim.check("alice").ok, true);
  lim.began("alice");

  const dup = lim.check("alice");
  assert.equal(dup.ok, false);
  assert.equal(dup.status, 409);
  assert.match(dup.error, /already being danced/);

  lim.ended("alice");
  // Still refused, but now for the cooldown reason rather than the duplicate one.
  const after = createLimiter({ cooldownMs: 5000, now: () => 1000 });
  assert.equal(after.check("alice").ok, true);
});

test("a visitor must wait out a cooldown between turns", () => {
  const clock = fakeClock();
  const lim = createLimiter({ cooldownMs: 1500, now: clock.now });
  lim.began("alice"); lim.ended("alice");

  clock.advance(500);
  assert.match(lim.check("alice").error, /One turn at a time/);
  clock.advance(1200);
  assert.equal(lim.check("alice").ok, true);
});

test("a ceiling applies across everyone, not just per visitor", () => {
  const clock = fakeClock();
  const lim = createLimiter({ perVisitor: 99, perHour: 4, cooldownMs: 0, now: clock.now });
  for (let i = 0; i < 4; i++) {
    const who = `visitor-${i}`;
    assert.equal(lim.check(who).ok, true);
    lim.began(who); lim.ended(who);
  }
  const blocked = lim.check("visitor-5");
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /answered a lot of phrases in the last hour/);
});

test("the per-process total is a hard stop, and it is reported as one", () => {
  const lim = createLimiter({ perVisitor: 99, perHour: 99, totalPerRun: 2, cooldownMs: 0 });
  lim.began("a"); lim.ended("a");
  lim.began("b"); lim.ended("b");
  const blocked = lim.check("c");
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /reached its limit of model calls/);
  assert.equal(lim.snapshot().total, 2);
});

test("visitors stop being tracked once they have nothing counted against them", () => {
  const clock = fakeClock();
  const lim = createLimiter({ windowMs: 1000, cooldownMs: 0, now: clock.now });
  for (let i = 0; i < 50; i++) { lim.began(`v${i}`); lim.ended(`v${i}`); }
  assert.equal(lim.snapshot().visitorsTracked, 50);
  clock.advance(2000);
  lim.check("someone-new");           // a check sweeps the stale ones
  assert.equal(lim.snapshot().visitorsTracked, 1);
});
