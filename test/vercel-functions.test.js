// The two files in api/ are what Vercel actually runs. These tests call them the
// way Vercel does — a request object with `method`, `headers` and a parsed
// `body`, and a response object with `status()`, `json()` and `setHeader()` —
// so the adapter layer is covered without deploying anything.
//
// Nothing here reaches Replicate: REPLICATE_API_BASE points at a stand-in on
// localhost, exactly as the other server tests do.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const GOOD = '{"read":"steady","moves":[{"after_ms":420,"move":"spin"},{"after_ms":400,"move":"hold"}]}';

const PHRASE = [
  { move: "pulse", after_ms: 0 },
  { move: "step_left", after_ms: 420 },
  { move: "jump", after_ms: 400 },
];

// Vercel's request: helpers on top of IncomingMessage. Ours only uses these.
const req = ({ method = "POST", body = { phrase: PHRASE }, ip = "203.0.113.7" } = {}) => ({
  method,
  headers: { "x-forwarded-for": `${ip}, 70.41.3.18` },
  get body() { return body; },
});

// Vercel's response: status() chains, json() ends it.
function res() {
  const out = { code: null, payload: null, headers: {} };
  return {
    out,
    setHeader(k, v) { out.headers[k] = v; return this; },
    status(c) { out.code = c; return this; },
    json(p) { out.payload = p; return this; },
  };
}

// Load a fresh copy of the module so its module-scope limiter is rebuilt and
// the current environment is read again.
let n = 0;
const load = (path) => import(`${path}?copy=${++n}`);

async function withUpstream(handler, run) {
  const up = http.createServer(handler);
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  process.env.REPLICATE_API_BASE = `http://127.0.0.1:${up.address().port}`;
  try { await run(); } finally { up.close(); delete process.env.REPLICATE_API_BASE; }
}

const succeeds = (text) => (request, response) => {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ id: "p1", status: "succeeded", output: [text] }));
};

test("/api/status tells the page whether the dancer can answer, and nothing else", async () => {
  delete process.env.REPLICATE_API_TOKEN;
  delete process.env.MODEL_CALLS_ENABLED;
  let handler = (await load("../api/status.js")).default;
  let r = res();
  handler(req({ method: "GET" }), r);
  assert.equal(r.out.code, 200);
  assert.equal(r.out.payload.dancerCanAnswer, false);
  assert.deepEqual(Object.keys(r.out.payload).sort(), ["dancerCanAnswer", "model"]);

  process.env.REPLICATE_API_TOKEN = "r8_not_a_real_token_0000000000000000000";
  handler = (await load("../api/status.js")).default;
  r = res();
  handler(req({ method: "GET" }), r);
  assert.equal(r.out.payload.dancerCanAnswer, true);

  // The stop switch reaches the page up front, not only at the wall.
  process.env.MODEL_CALLS_ENABLED = "false";
  handler = (await load("../api/status.js")).default;
  r = res();
  handler(req({ method: "GET" }), r);
  assert.equal(r.out.payload.dancerCanAnswer, false);

  // Whatever happens, the token itself is never in the answer.
  assert.doesNotMatch(JSON.stringify(r.out.payload), /r8_/);
  delete process.env.MODEL_CALLS_ENABLED;
});

test("/api/continue answers a phrase, and never echoes the token", async () => {
  process.env.REPLICATE_API_TOKEN = "r8_not_a_real_token_0000000000000000000";
  process.env.MAX_CALLS_PER_VISITOR = "8";
  await withUpstream(succeeds(GOOD), async () => {
    const handler = (await load("../api/continue.js")).default;
    const r = res();
    await handler(req(), r);
    assert.equal(r.out.code, 200);
    assert.equal(r.out.payload.ok, true);
    assert.deepEqual(r.out.payload.plan.moves.map((m) => m.move), ["spin", "hold"]);
    assert.equal(r.out.headers["Cache-Control"], "no-store");
    assert.doesNotMatch(JSON.stringify(r.out.payload), /r8_not_a_real_token/);
  });
});

test("/api/continue refuses anything but POST", async () => {
  const handler = (await load("../api/continue.js")).default;
  const r = res();
  await handler(req({ method: "GET" }), r);
  assert.equal(r.out.code, 405);
});

test("/api/continue reports a body that is not JSON rather than throwing", async () => {
  const handler = (await load("../api/continue.js")).default;
  const r = res();
  const bad = { method: "POST", headers: {}, get body() { throw new SyntaxError("bad json"); } };
  await handler(bad, r);
  assert.equal(r.out.code, 400);
  assert.match(r.out.payload.error, /was not JSON/);
});

test("/api/continue counts turns per caller, using the address behind the proxy", async () => {
  process.env.REPLICATE_API_TOKEN = "r8_not_a_real_token_0000000000000000000";
  process.env.MAX_CALLS_PER_VISITOR = "2";
  process.env.TURN_COOLDOWN_MS = "0";   // the quiet time between turns is tested elsewhere
  let upstreamCalls = 0;
  await withUpstream((rq, rs) => { upstreamCalls++; succeeds(GOOD)(rq, rs); }, async () => {
    const handler = (await load("../api/continue.js")).default;
    for (let i = 0; i < 2; i++) {
      const r = res();
      await handler(req({ ip: "198.51.100.4" }), r);
      assert.equal(r.out.code, 200, `turn ${i + 1}`);
    }
    const blocked = res();
    await handler(req({ ip: "198.51.100.4" }), blocked);
    assert.equal(blocked.out.code, 429);
    assert.match(blocked.out.payload.error, /taken your 2 turns/);

    // A different address is counted separately.
    const other = res();
    await handler(req({ ip: "198.51.100.9" }), other);
    assert.equal(other.out.code, 200);
    assert.equal(upstreamCalls, 3, "only the refused turn never reached Replicate");
  });
  delete process.env.MAX_CALLS_PER_VISITOR;
  delete process.env.TURN_COOLDOWN_MS;
});

test("a visitor is asked to wait a moment between turns", async () => {
  process.env.REPLICATE_API_TOKEN = "r8_not_a_real_token_0000000000000000000";
  process.env.TURN_COOLDOWN_MS = "5000";
  await withUpstream(succeeds(GOOD), async () => {
    const handler = (await load("../api/continue.js")).default;
    const first = res();
    await handler(req({ ip: "192.0.2.10" }), first);
    assert.equal(first.out.code, 200);

    const tooSoon = res();
    await handler(req({ ip: "192.0.2.10" }), tooSoon);
    assert.equal(tooSoon.out.code, 429);
    assert.match(tooSoon.out.payload.error, /One turn at a time/);
  });
  delete process.env.TURN_COOLDOWN_MS;
});

test("two handovers arriving together make one model call on a single instance", async () => {
  process.env.REPLICATE_API_TOKEN = "r8_not_a_real_token_0000000000000000000";
  let upstreamCalls = 0;
  const slow = async (rq, rs) => {
    upstreamCalls++;
    await new Promise((r) => setTimeout(r, 200));
    succeeds(GOOD)(rq, rs);
  };
  await withUpstream(slow, async () => {
    const handler = (await load("../api/continue.js")).default;
    const a = res(), b = res();
    await Promise.all([handler(req(), a), handler(req(), b)]);
    assert.deepEqual([a.out.code, b.out.code].sort(), [200, 409]);
    assert.equal(upstreamCalls, 1, "the duplicate never reached Replicate");
  });
});

test("the stop switch is honoured by the deployed function too", async () => {
  process.env.REPLICATE_API_TOKEN = "r8_not_a_real_token_0000000000000000000";
  process.env.MODEL_CALLS_ENABLED = "off";
  let upstreamCalls = 0;
  await withUpstream((rq, rs) => { upstreamCalls++; succeeds(GOOD)(rq, rs); }, async () => {
    const handler = (await load("../api/continue.js")).default;
    const r = res();
    await handler(req(), r);
    assert.equal(r.out.code, 503);
    assert.match(r.out.payload.error, /switched off for now/);
    assert.equal(upstreamCalls, 0);
  });
  delete process.env.MODEL_CALLS_ENABLED;
});

test("status and a turn agree about whether the token is usable", async () => {
  // The bug this pins down: /api/status reported the dancer as available while a
  // turn refused the same token, so the page invited people to press a button
  // that could not work. Each token below is run through both endpoints and the
  // two answers have to match.
  const cases = [
    { what: "a clean token", token: "r8_" + "a".repeat(37), usable: true },
    { what: "no token at all", token: undefined, usable: false },
    { what: "an empty token", token: "", usable: false },
    { what: "only whitespace", token: "   \n", usable: false },
    // The real failure: Cyrillic М and В, identical on screen to Latin M and B.
    { what: "a Cyrillic look-alike inside", token: "r8_abcdefghijМlmnopqrstuvwxyz012345678", usable: false },
    { what: "an interior newline", token: "r8_abcdefghij\nlmnopqrstuvwxyz012345678", usable: false },
    { what: "a zero-width space", token: "r8_abcdefghij​lmnopqrstuvwxyz012345678", usable: false },
  ];

  for (const c of cases) {
    if (c.token === undefined) delete process.env.REPLICATE_API_TOKEN;
    else process.env.REPLICATE_API_TOKEN = c.token;

    const status = (await load("../api/status.js")).default;
    const sr = res();
    status(req({ method: "GET" }), sr);

    const turn = (await load("../api/continue.js")).default;
    const tr = res();
    await turn(req(), tr);
    // A usable token gets past the token check; an unusable one is refused there.
    const turnAcceptedToken = tr.out.code !== 500;

    assert.equal(sr.out.payload.dancerCanAnswer, c.usable, `status, for ${c.what}`);
    assert.equal(turnAcceptedToken, c.usable, `the turn, for ${c.what}`);
    assert.equal(
      sr.out.payload.dancerCanAnswer, turnAcceptedToken,
      `status and the turn must agree about ${c.what}`,
    );
    // Whatever went wrong, no part of the value comes back out.
    if (c.token) assert.doesNotMatch(JSON.stringify([sr.out.payload, tr.out.payload]), /r8_abcdefghij/);
  }
  delete process.env.REPLICATE_API_TOKEN;
});

test("an unusable token is named by position and codepoint, never by its characters", async () => {
  process.env.REPLICATE_API_TOKEN = "r8_abcdefghijМlmnopВqrstuvwxyz0123456";
  const turn = (await load("../api/continue.js")).default;
  const r = res();
  await turn(req(), r);
  assert.equal(r.out.code, 500);
  assert.match(r.out.payload.error, /token is not usable/);
  assert.match(r.out.payload.setup, /2 characters/);
  assert.match(r.out.payload.setup, /position 14 \(U\+041C\)/);
  assert.match(r.out.payload.setup, /position 20 \(U\+0412\)/);
  // It no longer claims the value lives in .env, which is wrong on a host.
  assert.match(r.out.payload.setup, /REPLICATE_API_TOKEN/);
  assert.doesNotMatch(r.out.payload.setup, /abcdefghij/);
  delete process.env.REPLICATE_API_TOKEN;
});
