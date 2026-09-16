// Taking turns with the dancer.
//
// The whole page is one small state machine:
//
//   teaching  you play moves; the dancer mirrors each one as it lands
//   thinking  your phrase has gone to the model; the dancer waits
//   dancer    the dancer performs the turn the model answered with
//   done      both phrases are written out; you can go again
//   next      the optional experiment: play what you would really have done
//
// Nothing moves between these states on its own except the two that must —
// thinking ends when the answer arrives, and the dancer's turn ends when it has
// finished dancing. A pause is never read as the end of your turn.

import { Dancer } from "./dancer.js";
import { Player } from "./player.js";
import { setupInstrument, flashKey } from "./input.js";
import { renderStave, setPlayhead, describe } from "./score.js";
import {
  MOVES, MIN_PHRASE, OFFER_AFTER_MS,
  label, medianGap, spanOf, spansOf, toWire, fromWire, compare,
} from "./phrase.js";
import { logRequest } from "./log.js";

const $ = (id) => document.getElementById(id);

const state = {
  stage: "teaching",
  phrase: [],        // { at, move } — what you are playing, or played
  startedAt: null,   // the timestamp of your first move this turn
  answer: [],        // { at, move } — the dancer's turn
  read: null,        // the model's own note on your phrase
  myNext: [],        // the optional "what I would really have done"
  target: "phrase",  // which of the two the keys are currently filling
  error: null,
  canAnswer: null,   // null while we are still asking the server
  offered: false,    // has the hand-over button been highlighted yet
};

window.__state = state; // handy for poking around in the browser console

const dancer = new Dancer($("dancer"));
const player = new Player(dancer);
window.__dancer = dancer;

const test = { delayMs: 0, fail: false };

fetch("/api/status")
  .then((r) => r.json())
  .then((s) => {
    state.canAnswer = Boolean(s.dancerCanAnswer);
    $("dev-setup").textContent = s.dancerCanAnswer
      ? `The local server is calling ${s.model}.`
      : "The local server has no model token, so no request is being made.";
  })
  .catch(() => {
    state.canAnswer = false;
    $("dev-setup").textContent = "No local server answered, so no request is being made.";
  })
  .finally(render);

// The instrument is live only while it is your turn to play.
const live = () => state.stage === "teaching" || state.stage === "next";

// ---------- Your turn ----------

function onMove(move, t) {
  if (!live()) return;
  const list = state.target === "next" ? state.myNext : state.phrase;
  if (!list.length) state.startedAt = t;
  list.push({ at: Math.round(t - state.startedAt), move });

  flashKey($("pad"), move);
  // The dancer mirrors you straight away, at the speed you are playing.
  dancer.perform(move, "you", performance.now(), list.length > 1 ? medianGap(list) : 520);
  state.offered = false;
  render();
}

setupInstrument({ pad: $("pad"), onMove, isLive: live });

// ---------- Handing the turn over ----------

$("hand-over").addEventListener("click", () => {
  if (state.stage === "next") return finishNext();
  if (state.phrase.length < MIN_PHRASE) return;
  if (state.canAnswer) askDancer();
  else {
    // No model to ask. Your phrase is still a phrase: play it back.
    state.stage = "done";
    render();
    replay();
  }
});

$("replay").addEventListener("click", replay);
$("again").addEventListener("click", () => startOver({ keepNothing: true }));
$("start-over").addEventListener("click", () => startOver({ keepNothing: true }));

$("try-next").addEventListener("click", () => {
  state.stage = "next";
  state.target = "next";
  state.myNext = [];
  state.startedAt = null;
  state.offered = false;
  dancer.reset(performance.now());
  render();
});

function finishNext() {
  if (state.myNext.length < MIN_PHRASE) return;
  state.stage = "done";
  state.target = "phrase";
  render();
  player.start(state.myNext, "you", {
    onMove: () => render(),
    onDone: () => { dancer.reset(performance.now()); render(); },
  });
}

function startOver() {
  player.stop();
  Object.assign(state, {
    stage: "teaching", phrase: [], startedAt: null, answer: [],
    read: null, myNext: [], target: "phrase", error: null, offered: false,
  });
  dancer.reset(performance.now());
  render();
}

function replay() {
  if (!state.phrase.length) return;
  player.start(state.phrase, "you", {
    onMove: () => render(),
    onDone: () => { dancer.reset(performance.now()); render(); },
  });
  render();
}

// ---------- The dancer's turn ----------

// One turn in flight at a time. The button is hidden while the model is thinking,
// so this should be unreachable — but a paid API call is not something to leave
// resting on that assumption.
let asking = false;

async function askDancer() {
  if (asking) return;
  asking = true;
  try {
    await requestTurn();
  } finally {
    asking = false;
  }
}

async function requestTurn() {
  state.stage = "thinking";
  state.error = null;
  state.answer = [];
  render();

  const sentAt = performance.now();
  const payload = { phrase: toWire(state.phrase), test: { ...test } };
  const request = { id: nextId++, sentAt, doneAt: null, error: null, response: null, payload };

  try {
    const res = await fetch("/api/continue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({ ok: false, error: `The server replied with ${res.status}.` }));
    request.response = data;
    if (!data.ok) request.error = data.error || `The server replied with ${res.status}.`;
  } catch (err) {
    request.error = `Could not reach the local server (${err.message}). Is it still running?`;
  }
  request.doneAt = performance.now();
  request.beatsSent = payload.phrase.length;
  logRequest($("log"), request);

  if (request.error) {
    state.error = request.error;
    state.stage = "done";
    render();
    return;
  }

  state.answer = fromWire(request.response.plan.moves);
  state.read = request.response.plan.read || null;
  state.stage = "dancer";
  render();

  // A beat of air before it starts, so the handover reads as a handover.
  setTimeout(() => {
    if (state.stage !== "dancer") return;
    player.start(state.answer, "dancer", {
      onMove: () => render(),
      onDone: () => {
        state.stage = "done";
        dancer.reset(performance.now());
        render();
      },
    });
  }, 420);
}

let nextId = 1;

// ---------- Test switches (in "Development details") ----------

$("test-delay").addEventListener("change", (e) => { test.delayMs = e.target.checked ? 4000 : 0; });
$("test-fail").addEventListener("change", (e) => { test.fail = e.target.checked; });

// ---------- Drawing the page ----------

// "Both turns" is only true once there are two. Until then the heading names the
// one phrase that exists.
function heading(s) {
  if (s.stage === "dancer") return "The dancer's phrase";
  if (s.stage === "next") return "What you would do next";
  if (s.stage === "done" && s.answer.length) return "Both turns";
  return "Your phrase";
}

function render() {
  const s = state;
  document.body.dataset.stage = s.stage;

  // The two (or three) written phrases, all at one scale so they can be read
  // against each other.
  const scale = Math.max(
    spanOf(s.phrase), spanOf(s.answer), spanOf(s.myNext), 1,
  );
  const playingWhich = player.playing ? s.target : null;
  renderStave($("stave-you"), s.phrase, scale, {
    who: "you",
    empty: "press a key, or click a move",
  });
  $("stave-you").setAttribute("aria-label", `You played: ${describe(s.phrase)}`);

  $("row-dancer").hidden = !(s.answer.length || s.stage === "thinking");
  renderStave($("stave-dancer"), s.answer, scale, {
    who: "dancer",
    empty: "thinking about your phrase…",
  });
  $("dancer-read").textContent = s.read ? `the dancer noticed: ${s.read}` : "";

  $("row-next").hidden = !(s.myNext.length || s.stage === "next");
  renderStave($("stave-next"), s.myNext, scale, {
    who: "you",
    empty: "play what you would really have done",
  });
  $("compare-note").innerHTML = comparisonText();

  $("turn-title").textContent = heading(s);
  $("turn-note").textContent = turnNote();
  // While yours is the only phrase on screen the h2 above already names it; the
  // row labels appear when there is a second one to tell it apart from.
  const several = Boolean(s.answer.length || s.myNext.length || s.stage === "thinking");
  $("label-you").hidden = !several;
  const dancersTurn = s.stage === "dancer" || s.stage === "thinking";
  $("whose-turn-word").textContent = dancersTurn ? "The dancer's turn" : "Your turn";
  $("whose-turn").dataset.who = dancersTurn ? "dancer" : "you";

  const last = dancer.current;
  $("move-name").textContent = last ? label(last.move) : "waiting";
  $("move-who").textContent = last ? (last.who === "dancer" ? "the dancer's choice" : "yours") : "";
  $("move-who").classList.toggle("is-dancer", last?.who === "dancer");

  renderActions();
  renderStatus();
}

function turnNote() {
  const s = state;
  if (s.stage === "teaching") return s.phrase.length ? "A pause is part of the phrase." : "";
  if (s.stage === "thinking") return "Gone to the model, exactly as you played it.";
  if (s.stage === "dancer") return "Its own moves, at its own timing.";
  if (s.stage === "next") return "Play what you would really have danced next.";
  if (s.error) return "";
  return s.answer.length ? "Read the two against each other, then go again." : "";
}

function comparisonText() {
  const s = state;
  if (s.stage !== "done" || !s.myNext.length || !s.answer.length) return "";
  const c = compare(s.answer, s.myNext);
  const shared = `${c.sameMoves} of the first ${c.of} ${c.sameMoves === 1 ? "move is" : "moves are"} the same`;
  const pace = Math.abs(c.gapDiff) < 60
    ? "at about the same speed"
    : c.gapDiff > 0
      ? `${c.gapDiff} ms slower per move than yours`
      : `${-c.gapDiff} ms faster per move than yours`;
  return `<b>The model proposed a continuation; it did not know what you intended.</b> `
    + `Its turn was ${pace}, and ${shared}. Neither phrase is the right answer — there was nothing to be right about.`;
}

function renderActions() {
  const s = state;
  const playing = s.stage === "next" ? s.myNext : s.phrase;
  const enough = playing.length >= MIN_PHRASE;
  const hand = $("hand-over");

  // How far in, in words, next to the keys that are making it.
  const n = playing.length;
  $("progress").textContent = !live() || !n
    ? ""
    : `${n} ${n === 1 ? "move" : "moves"} played${enough ? "" : ` — ${MIN_PHRASE - n} more to hand over`}`;

  const showHand = s.stage === "teaching" || s.stage === "next";
  hand.hidden = !showHand;
  if (s.stage === "next") {
    hand.disabled = !enough;
    hand.textContent = "Put it beside the dancer's";
  } else {
    // With no model the button stays, named for what it would do, and says
    // plainly why it cannot. Renaming it would hide the missing half.
    hand.disabled = !enough || s.canAnswer === false;
    hand.textContent = "Dancer's turn";
  }
  hand.classList.toggle("is-offered", s.offered && !hand.disabled);

  // Without a model, playing your own phrase back is the thing that does work,
  // so it is offered as soon as there is a phrase rather than only afterwards.
  const replayNow = s.canAnswer === false && s.stage === "teaching" && enough;
  $("replay").hidden = !(replayNow || (s.stage === "done" && s.phrase.length));
  $("again").hidden = !(s.stage === "done");
  $("try-next").hidden = !(s.stage === "done" && s.answer.length && !s.myNext.length);
  $("start-over").hidden = !(s.phrase.length && s.stage !== "done");

  // Compact, and next to the button it is about.
  $("ai-note").hidden = !(s.canAnswer === false && showHand);
}

function renderStatus() {
  const s = state;
  let text = null, lamp = "";
  if (s.error) { text = `${s.error} Your phrase is still here — play it back, or teach another.`; lamp = "error"; }
  else if (s.stage === "thinking") { text = "Thinking about your phrase…"; lamp = "dancer"; }
  else if (s.stage === "dancer") { text = "The dancer is taking its turn."; lamp = "dancer on"; }
  else if (player.playing) { text = "Playing your phrase back."; lamp = "on"; }

  // Anything else is already visible: whose turn it is, and how many moves in.
  $("status-line").hidden = text === null;
  if (text === null) return;
  if ($("status").textContent !== text) $("status").textContent = text;
  $("lamp").className = `lamp ${lamp}`;
  $("status-line").classList.toggle("is-error", Boolean(s.error));
}

// ---------- Frame loop ----------

let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min(64, now - lastFrame);
  lastFrame = now;

  player.tick(now);

  // A pause while you are teaching *offers* the hand-over. It never takes it.
  if (live()) {
    const list = state.target === "next" ? state.myNext : state.phrase;
    const enough = list.length >= MIN_PHRASE;
    const lastAt = list.length ? state.startedAt + list.at(-1).at : null;
    const resting = lastAt !== null && now - lastAt > OFFER_AFTER_MS;
    if (enough && resting && !state.offered) { state.offered = true; render(); }
  }

  // Sweep a marker along whichever phrase is being danced.
  const p = player.progress(now);
  setPlayhead($("stave-you"), state.stage === "dancer" ? null : p);
  setPlayhead($("stave-dancer"), state.stage === "dancer" ? p : null);

  dancer.update(dt, now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
render();
