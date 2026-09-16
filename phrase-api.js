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
  return `The token in .env has ${bad.length} character${bad.length === 1 ? "" : "s"} `
    + `that cannot be sent in a request, out of ${token.length}: ${where}. `
    + `These are usually Cyrillic letters that look identical to Latin ones, picked up `
    + `when the token was copied. Copy it again with the Copy button at `
    + `https://replicate.com/account/api-tokens and write .env again.`;
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

export function createContinueHandler({ token, apiBase = "https://api.replicate.com", maxCalls = 300, log = () => {} } = {}) {
  let calls = 0;
  let lastCallAt = 0;

  return async function handleContinue(req, res) {
    const started = Date.now();
    const reply = (status, body) => {
      const ms = Date.now() - started;
      log(status === 200
        ? `ok    ${ms} ms   ${body.plan.moves.length} moves: ${body.plan.moves.map((m) => m.move).join(", ")}`
        : `FAILED ${status} after ${ms} ms — ${body.error}${body.setup ? ` (${body.setup})` : ""}`);
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ...body, serverMs: ms }));
    };

    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return reply(400, { ok: false, error: "The request body was not JSON." });
    }

    const phrase = body.phrase;
    const shapeOk = Array.isArray(phrase) && phrase.length >= 2 && phrase.length <= 24
      && phrase.every((m) => ALL_MOVES.includes(m?.move) && Number.isFinite(m?.after_ms));
    if (!shapeOk) return reply(400, { ok: false, error: "Send a phrase of 2 to 24 moves, each with a move name and a gap." });

    // Test switches from the "Development details" panel. They are labelled as
    // tests there, and they never dress themselves up as a model answer.
    if (body.test?.fail) {
      return reply(503, { ok: false, error: "Test failure switched on. The model was not called." });
    }
    const delay = Math.min(12000, Math.max(0, Number(body.test?.delayMs) || 0));
    if (delay) await sleep(delay);

    if (!token) {
      return reply(500, {
        ok: false,
        error: "This copy has no model configured, so the dancer cannot take its own turn.",
        setup: "Set REPLICATE_API_TOKEN in .env and restart the server — see the README.",
      });
    }
    const badToken = tokenProblem(token);
    if (badToken) {
      return reply(500, { ok: false, error: "The dancer cannot take its turn: the API token is not usable.", setup: badToken });
    }
    if (calls >= maxCalls) {
      return reply(429, {
        ok: false,
        error: `This server has reached its limit of ${maxCalls} model calls for one run.`,
        setup: "Restart the server to reset it; the limit is MAX_MODEL_CALLS in .env.",
      });
    }
    if (Date.now() - lastCallAt < 1000) {
      return reply(429, { ok: false, error: "That was very quick after the last turn; give it a second and ask again." });
    }
    calls++;
    lastCallAt = Date.now();

    const input = {
      system_prompt: SYSTEM_PROMPT,
      prompt: buildPrompt(phrase),
      max_tokens: 1024, // the schema allows 1 to 8192; a reply uses about 120
    };

    const modelStarted = Date.now();
    try {
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "wait=30" };
      let r = await fetch(`${apiBase}/v1/models/${MODEL}/predictions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ input }),
        signal: AbortSignal.timeout(40000),
      });
      let prediction = await r.json().catch(() => ({}));
      if (!r.ok) {
        const detail = prediction.detail || prediction.title || `HTTP ${r.status}`;
        return reply(502, { ok: false, error: `Replicate refused the request: ${detail}`, sent: { model: MODEL, input }, calls });
      }

      // Usually "Prefer: wait" returns the finished prediction. If not, check back a few times.
      while (["starting", "processing"].includes(prediction.status) && Date.now() - modelStarted < 38000) {
        await sleep(400);
        r = await fetch(prediction.urls.get, { headers: { Authorization: `Bearer ${token}` } });
        prediction = await r.json();
      }
      const modelMs = Date.now() - modelStarted;
      if (prediction.status !== "succeeded") {
        return reply(502, { ok: false, error: `The prediction ${prediction.status}: ${prediction.error || "no output"}`, sent: { model: MODEL, input }, modelMs, calls });
      }

      const raw = Array.isArray(prediction.output) ? prediction.output.join("") : String(prediction.output ?? "");
      const { plan, error } = parseTurn(raw);
      if (error) return reply(502, { ok: false, error, raw, sent: { model: MODEL, input }, modelMs, calls });

      reply(200, {
        ok: true,
        plan,
        raw,
        sent: { model: MODEL, input },
        modelMs,
        predictionId: prediction.id,
        replicateMetrics: prediction.metrics ?? null,
        calls,
      });
    } catch (err) {
      const why = err.name === "TimeoutError" ? "Replicate did not answer within 40 seconds." : `Could not reach Replicate (${err.message}).`;
      reply(502, { ok: false, error: why, sent: { model: MODEL, input }, calls });
    }
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
