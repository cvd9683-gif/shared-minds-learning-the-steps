// The instrument: five moves, from the keyboard or from the buttons on screen.
//
// Space and the arrow keys are taken over whenever the instrument is live, so an
// arrow never scrolls the page mid-phrase. When it is not live — while the model
// is thinking, or while the dancer is taking its turn — the keys are left alone.

import { KEY_TO_MOVE, MOVES, TAUGHT_MOVES } from "./phrase.js";

const isTyping = (node) =>
  node?.closest?.("textarea, [contenteditable=true]") ||
  (node?.matches?.("input") && /^(text|search|email|password|number|url|tel)$/.test(node.type));

// onMove(move, timeStamp) for every press or click.
// isLive() decides whether the instrument is currently accepting moves.
export function setupInstrument({ pad, onMove, isLive }) {
  // ---- The buttons ----
  for (const move of TAUGHT_MOVES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `key k-${move}`;
    btn.dataset.move = move;
    // The shortcut and the name read as one label: "↑ Jump", not "jump" with the
    // key in small grey type underneath it.
    btn.innerHTML = `<span class="glyph"></span><span class="name"></span>`;
    btn.querySelector(".glyph").textContent = MOVES[move].glyph;
    btn.querySelector(".name").textContent = MOVES[move].cap;
    const spoken = MOVES[move].key === "Space" ? "space bar" : MOVES[move].key.replace("Arrow", "") + " arrow";
    btn.setAttribute("aria-label", `${MOVES[move].cap} — ${spoken} — ${MOVES[move].hint}`);
    btn.title = MOVES[move].hint;
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      if (!isLive()) return;
      onMove(move, performance.now());
    });
    // A button must not also fire from the space bar while it holds focus.
    btn.addEventListener("keydown", (e) => { if (e.code === "Space" || e.code === "Enter") e.preventDefault(); });
    pad.append(btn);
  }

  // ---- The keyboard ----
  window.addEventListener("keydown", (e) => {
    const move = KEY_TO_MOVE[e.code];
    if (!move || isTyping(e.target)) return;
    if (!isLive()) return;      // let the page scroll normally between turns
    e.preventDefault();         // no scrolling, no page-jump, while playing
    if (e.repeat) return;       // a held key is one move, not forty
    e.target.closest?.("button, summary")?.blur?.();
    onMove(move, e.timeStamp || performance.now());
  }, { passive: false });
}

// Light a key up for a moment, whether it was pressed or clicked.
const flashTimers = new WeakMap();
export function flashKey(pad, move) {
  const btn = pad.querySelector(`[data-move="${move}"]`);
  if (!btn) return;
  clearTimeout(flashTimers.get(btn));
  btn.classList.add("is-hit");
  flashTimers.set(btn, setTimeout(() => btn.classList.remove("is-hit"), 120));
}
