// Writing a phrase down so it can be read and compared.
//
// Each phrase is a stave: a line with a mark on it for every move, placed by
// when it happened rather than evenly, so the rhythm is visible as spacing.
// Two staves drawn at the same scale can be read against each other.

import { label, spanOf, gapsOf } from "./phrase.js";

// Build (or update) one stave inside `host`.
//   events  [{ at, move }]
//   scale   ms covered by the full width of the widest stave on screen
//   opts.who      "you" | "dancer" — which colour it is drawn in
//   opts.playedTo index of the last move danced so far, or null
export function renderStave(host, events, scale, opts = {}) {
  host.replaceChildren();
  host.dataset.who = opts.who ?? "you";
  if (!events.length) {
    const empty = document.createElement("p");
    empty.className = "stave-empty";
    empty.textContent = opts.empty ?? "nothing yet";
    host.append(empty);
    return;
  }

  const track = document.createElement("div");
  track.className = "track";
  // The stave only takes the share of the width its own phrase occupies, so a
  // shorter answer is visibly shorter.
  track.style.width = `${Math.max(8, (spanOf(events) / scale) * 100)}%`;

  const line = document.createElement("i");
  line.className = "track-line";
  track.append(line);

  const gaps = gapsOf(events);
  const span = spanOf(events);

  events.forEach((e, i) => {
    const mark = document.createElement("span");
    // Names alternate between two heights so close-together moves stay readable.
    mark.className = `mark m-${e.move}${i % 2 ? " low" : ""}`;
    mark.style.left = `${(e.at / span) * 100}%`;
    if (opts.playedTo != null && i <= opts.playedTo) mark.classList.add("danced");

    const tick = document.createElement("i");
    tick.className = "tick";
    const name = document.createElement("b");
    name.textContent = label(e.move);
    mark.append(tick, name);

    // The gap before this move, in milliseconds: the rhythm, written out. On the
    // first mark that is the wait before the phrase began — how long the dancer
    // left before answering.
    const before = i > 0 ? gaps[i - 1] : e.at;
    if (before > 0) {
      const gap = document.createElement("u");
      gap.textContent = `${Math.round(before)}`;
      mark.append(gap);
    }
    track.append(mark);
  });

  host.append(track);
}

// A moving line showing where the dancer has got to while a phrase plays.
export function setPlayhead(host, fraction) {
  const track = host.querySelector(".track");
  if (!track) return;
  track.style.setProperty("--playhead", fraction == null ? "-1" : String(fraction));
  track.classList.toggle("is-playing", fraction != null);
}

// The plain-words version, for screen readers and for anyone who would rather
// read a sentence than a diagram.
export function describe(events) {
  if (!events.length) return "nothing yet";
  const gaps = gapsOf(events);
  return events
    .map((e, i) => (i === 0 ? label(e.move) : `${gaps[i - 1]} ms later, ${label(e.move)}`))
    .join("; ");
}
