// POST /api/continue
// The browser sends the phrase a person just danced — a list of moves and the
// gap in milliseconds before each. This asks a language model on Replicate to
// carry the phrase on: what it would dance next, and when. It checks the answer
// is something the dancer can actually perform before sending it back.

import { ALL_MOVES, MOVES, checkContinuation } from "./public/js/phrase.js";

export const MODEL = "anthropic/claude-4.5-haiku";

// An HTTP header value can only hold printable ASCII. A token that has picked up
// a curly quote, a line break or a look-alike letter from a bad copy fails here
// rather than deep inside fetch().
//
// It reports *every* bad character, not just the first. Cyrillic look-alikes come
// in groups, and fixing them one restart at a time is no way to spend an evening.
// Returns a plain sentence, or null if the token is usable.
export function tokenProblem(token) {
  if (!token) return null;
  const bad = [...token]
    .map((c, i) => ({ at: i + 1, code: c.codePointAt(0) }))
    .filter(({ code }) => code < 33 || code > 126);
  if (!bad.length) return null;

  const where = bad
    .map(({ at, code }) => `position ${at} (U+${code.toString(16).toUpperCase().padStart(4, "0")})`)
    .join(", ");
  return `REPLICATE_API_TOKEN has ${bad.length} character${bad.length === 1 ? "" : "s"} `
    + `that cannot be sent in a request, out of ${token.length}: ${where}. `
    + `These are usually Cyrillic letters that look identical to Latin ones, picked up `
    + `when the token was copied. Copy it again with the Copy button at `
    + `https://replicate.com/account/api-tokens and set it again — in .env locally, or in `
    + `your host's environment variables.`;
}

// Read the token the one way, everywhere: trimmed, because a trailing newline
// from a paste is an ordinary accident.
export function readToken(env = process.env) {
  return env.REPLICATE_API_TOKEN?.trim() || "";
}

// Can the dancer actually take a turn with this token?
//
// /api/status and /api/continue used to disagree about this: status asked only
// whether a token existed, while a turn also checked whether it could be put in
// a request. A token with a look-alike letter in it therefore reported the
// dancer as available and then failed at the button. One definition, used by
// both, is the fix.
export function tokenUsable(token) {
  return Boolean(token) && tokenProblem(token) === null;
}

const VOCABULARY = ALL_MOVES.map((m) => `${m} (${MOVES[m].hint})`).join(", ");

const SYSTEM_PROMPT = `You are a dancer taking turns with a person.
The person dances a short phrase. You are given it as a list of moves with the gap in milliseconds before each one. You never see or hear anything else: no video, no audio, only these moves and these numbers.
Answer with the phrase you would dance next, as your own turn. It should answer theirs: carry their rhythm on, or break it deliberately, but stay in conversation with it.
Moves you can use: ${VOCABULARY}.
Reply with JSON only. No prose, no code fences. Shape:
{"read": "<at most 8 words on what you noticed in their phrase>", "moves": [{"after_ms": <integer>, "move": "<move>"}]}
Rules: after_ms is the gap before that move. The first one is counted from the end of the person's phrase. Every after_ms must be between 60 and 4000. Give between 2 and 10 moves.
Take your turn at a speed related to theirs. Do not simply copy their phrase back move for move.`;

export function buildPrompt(phrase) {
  const lines = phrase.map((m, i) =>
    i === 0 ? `  ${m.move}` : `  ${m.after_ms} ms later: ${m.move}`);
  const gaps = phrase.slice(1).map((m) => m.after_ms);
  const total = gaps.reduce((a, b) => a + b, 0);
  return [
    `The person danced ${phrase.length} moves over ${total} ms:`,
    ...lines,
    gaps.length ? `Gaps between their moves: ${gaps.join(", ")} ms.` : "",
    "Now dance your turn.",
  ].filter(Boolean).join("\n");
}

// Returns { plan } or { error }. Never trusts the model's text blindly.
export function parseTurn(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { error: "The model's reply had no JSON in it." };
  let data;
  try { data = JSON.parse(match[0]); } catch { return { error: "The model's reply was not valid JSON." }; }
  const { moves, error } = checkContinuation(data);
  if (error) return { error };
  const read = typeof data.read === "string" ? data.read.slice(0, 90) : "";
  return { plan: { read, moves } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Who is asking. Behind Render's proxy the socket address is the proxy's, so the
// first hop of x-forwarded-for is the nearest thing to a visitor we have. It is
// not an identity — see the limits section of the README.
export function visitorKey(req) {
  const fwd = req.headers["x-forwarded-for"];
  const first = typeof fwd === "string" ? fwd.split(",")[0].trim() : "";
  return first || req.socket?.remoteAddress || "unknown";
}

// Our own ceiling on one turn. It has to sit comfortably under whatever the host
// allows a request to run for, so that a slow answer produces the honest message
// below rather than the platform killing the function and returning an opaque
// gateway error with nothing in it a visitor can read.
export const TURN_TIMEOUT_MS = 30_000;
const REPLICATE_WAIT_SECONDS = 25;

// The whole of a turn, with no HTTP in it.
//
// Give it a parsed body and a string for who is asking; get back a status and a
// body to send. The local development server and the deployed function are both
// thin wrappers around this, so there is one copy of the logic and one set of
// tests for it.
export async function runTurn({
  body,
  visitor = "unknown",
  token,
  apiBase = "https://api.replicate.com",
  limiter,
  enabled = () => true,
  log = () => {},
}) {
  const started = Date.now();
  const done = (status, payload) => {
    const ms = Date.now() - started;
    log(status === 200
      ? `ok    ${ms} ms   ${payload.plan.moves.length} moves: ${payload.plan.moves.map((m) => m.move).join(", ")}`
      : `FAILED ${status} after ${ms} ms — ${payload.error}${payload.setup ? ` (${payload.setup})` : ""}`);
    return { status, body: { ...payload, serverMs: ms } };
  };

  const phrase = body?.phrase;
  const shapeOk = Array.isArray(phrase) && phrase.length >= 2 && phrase.length <= 24
    && phrase.every((m) => ALL_MOVES.includes(m?.move) && Number.isFinite(m?.after_ms));
  if (!shapeOk) {
    return done(400, { ok: false, error: "Send a phrase of 2 to 24 moves, each with a move name and a gap." });
  }

  // Test switches from the "Development details" panel. They are labelled as
  // tests there, and they never dress themselves up as a model answer.
  if (body.test?.fail) {
    return done(503, { ok: false, error: "Test failure switched on. The model was not called." });
  }
  const delay = Math.min(12000, Math.max(0, Number(body.test?.delayMs) || 0));
  if (delay) await sleep(delay);

  if (!token) {
    return done(500, {
      ok: false,
      error: "This copy has no model configured, so the dancer cannot take its own turn.",
      setup: "Set REPLICATE_API_TOKEN in the environment and restart — see the README.",
    });
  }
  const badToken = tokenProblem(token);
  if (badToken) {
    return done(500, { ok: false, error: "The dancer cannot take its turn: the API token is not usable.", setup: badToken });
  }

  // The switch is read per request, so turning it off stops the very next one.
  if (!enabled()) {
    return done(503, {
      ok: false,
      error: "The dancer's own turn is switched off for now. Teaching and replaying a phrase still work.",
      setup: "MODEL_CALLS_ENABLED is set to off on the server.",
    });
  }

  const verdict = limiter.check(visitor);
  if (!verdict.ok) return done(verdict.status, { ok: false, error: verdict.error });
  limiter.began(visitor);

  const input = {
    system_prompt: SYSTEM_PROMPT,
    prompt: buildPrompt(phrase),
    max_tokens: 1024, // the schema allows 1 to 8192; a reply uses about 120
  };
  const sent = { model: MODEL, input };

  const modelStarted = Date.now();
  try {
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: `wait=${REPLICATE_WAIT_SECONDS}`,
    };
    let r = await fetch(`${apiBase}/v1/models/${MODEL}/predictions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ input }),
      signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
    });
    let prediction = await r.json().catch(() => ({}));
    if (!r.ok) {
      const detail = prediction.detail || prediction.title || `HTTP ${r.status}`;
      return done(502, { ok: false, error: `Replicate refused the request: ${detail}`, sent, calls: limiter.snapshot().total });
    }

    // Usually "Prefer: wait" returns the finished prediction. If not, check back
    // until our own deadline, leaving room to answer before it is reached.
    const deadline = modelStarted + TURN_TIMEOUT_MS - 3000;
    while (["starting", "processing"].includes(prediction.status) && Date.now() < deadline) {
      await sleep(400);
      r = await fetch(prediction.urls.get, { headers: { Authorization: `Bearer ${token}` } });
      prediction = await r.json();
    }
    const modelMs = Date.now() - modelStarted;
    if (["starting", "processing"].includes(prediction.status)) {
      return done(504, {
        ok: false,
        error: `The model was still thinking after ${Math.round(TURN_TIMEOUT_MS / 1000)} seconds, so the turn was given up on. Your phrase is still here.`,
        sent, modelMs, calls: limiter.snapshot().total,
      });
    }
    if (prediction.status !== "succeeded") {
      return done(502, { ok: false, error: `The prediction ${prediction.status}: ${prediction.error || "no output"}`, sent, modelMs, calls: limiter.snapshot().total });
    }

    const raw = Array.isArray(prediction.output) ? prediction.output.join("") : String(prediction.output ?? "");
    const { plan, error } = parseTurn(raw);
    if (error) return done(502, { ok: false, error, raw, sent, modelMs, calls: limiter.snapshot().total });

    return done(200, {
      ok: true,
      plan,
      raw,
      sent,
      modelMs,
      predictionId: prediction.id,
      replicateMetrics: prediction.metrics ?? null,
      calls: limiter.snapshot().total,
      turnsLeft: limiter.turnsLeft(visitor),
    });
  } catch (err) {
    const why = err.name === "TimeoutError" || err.name === "AbortError"
      ? `Replicate did not answer within ${Math.round(TURN_TIMEOUT_MS / 1000)} seconds. Your phrase is still here.`
      : `Could not reach Replicate (${err.message}).`;
    return done(502, { ok: false, error: why, sent, calls: limiter.snapshot().total });
  } finally {
    // However this ended, the visitor's in-flight lock has to come off, or one
    // failed turn would shut them out until the process restarts.
    limiter.ended(visitor);
  }
}

// The Node http adapter: used by the local development server and by the tests.
export function createContinueHandler(options = {}) {
  return async function handleContinue(req, res) {
    const send = (status, payload) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(payload));
    };

    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return send(400, { ok: false, error: "The request body was not JSON." });
    }
    const result = await runTurn({ ...options, body, visitor: visitorKey(req) });
    send(result.status, result.body);
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 20000) { reject(new Error("too large")); req.destroy(); }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
