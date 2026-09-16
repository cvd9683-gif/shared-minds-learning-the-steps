// Playing a phrase back: walking a list of { at, move } and handing each one to
// the dancer at the right moment, in the rhythm it was recorded in.
//
// The dancer is also told when the *next* move is due, so it can lean toward it
// rather than waiting to be surprised by it.

import { spansOf } from "./phrase.js";

export class Player {
  constructor(dancer) {
    this.dancer = dancer;
    this.run = null;
  }

  get playing() { return this.run !== null; }

  // events: [{ at, move }] with `at` in ms from the start of the phrase.
  // onMove(index) fires as each move is danced; onDone() after the last one has
  // had its full span to finish.
  start(events, who, { onMove, onDone } = {}) {
    this.stop();
    if (!events.length) { onDone?.(); return; }
    const spans = spansOf(events);
    this.run = {
      events, spans, who, onMove, onDone,
      startedAt: performance.now(),
      next: 0,
      endsAt: performance.now() + events.at(-1).at + spans.at(-1),
    };
  }

  stop() {
    this.run = null;
  }

  // Called once per frame from the page's own loop.
  tick(now) {
    const r = this.run;
    if (!r) return;

    while (r.next < r.events.length && now >= r.startedAt + r.events[r.next].at) {
      const i = r.next++;
      this.dancer.perform(r.events[i].move, r.who, now, r.spans[i]);
      r.onMove?.(i);
    }
    // Lean toward whatever is coming next.
    const upcoming = r.events[r.next];
    this.dancer.expect(upcoming ? r.startedAt + upcoming.at : null);

    if (r.next >= r.events.length && now >= r.endsAt) {
      const done = r.onDone;
      this.run = null;
      this.dancer.expect(null);
      done?.();
    }
  }

  // How far through, 0 to 1 — used to sweep a marker across the written phrase.
  progress(now) {
    const r = this.run;
    if (!r) return null;
    return Math.max(0, Math.min(1, (now - r.startedAt) / (r.endsAt - r.startedAt)));
  }
}
