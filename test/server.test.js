// These tests never touch Replicate. They point the server at a stand-in server
// on localhost, so we can check what happens on a good answer, a bad answer,
// a failure and a slow reply without spending anything.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createServer } from "../server.js";
import { parseTurn, buildPrompt } from "../phrase-api.js";

const TOKEN = "r8_test_token_not_real";

const PHRASE = [
  { move: "pulse", after_ms: 0 },
  { move: "step_left", after_ms: 420 },
  { move: "jump", after_ms: 400 },
  { move: "drop", after_ms: 430 },
];

// A stand-in for Replicate: replies in the same shape, with whatever we tell it to.
async function withServers(upstreamHandler, run, options = {}) {
  const upstream = http.createServer(upstreamHandler);
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const apiBase = `http://127.0.0.1:${upstream.address().port}`;
  const app = createServer({
    token: TOKEN, apiBase,
    limits: { perVisitor: 99, perHour: 99, totalPerRun: 99, cooldownMs: 0 },
    ...options,
  });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    await run(base, apiBase);
  } finally {
    app.close();
    upstream.close();
  }
}

const post = (base, body) =>
  fetch(`${base}/api/continue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const succeeds = (text, seen = {}) => async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  seen.body = JSON.parse(raw || "{}");
  seen.auth = req.headers.authorization;
  res.writeHead(200, { "Content-Type": "application/json" });
  // Replicate returns language-model output as an array of string pieces.
  res.end(JSON.stringify({ id: "pred_1", status: "succeeded", output: text.match(/.{1,7}/gs), metrics: { predict_time: 0.4 } }));
};

const GOOD = '{"read":"steady, then a jump","moves":[{"after_ms":420,"move":"spin"},{"after_ms":400,"move":"bounce"},{"after_ms":800,"move":"hold"}]}';

test("a good answer comes back as a turn the dancer can perform", async () => {
  const seen = {};
  await withServers(succeeds(GOOD, seen), async (base) => {
    const res = await post(base, { phrase: PHRASE });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.ok, true);
    assert.deepEqual(data.plan.moves, [
      { after_ms: 420, move: "spin" },
      { after_ms: 400, move: "bounce" },
      { after_ms: 800, move: "hold" },
    ]);
    assert.equal(data.plan.read, "steady, then a jump");
    // The prompt carries the moves and the gaps, and nothing else about them.
    assert.match(data.sent.input.prompt, /420 ms later: step_left/);
    assert.match(data.sent.input.prompt, /Gaps between their moves: 420, 400, 430 ms/);
    assert.equal(seen.auth, `Bearer ${TOKEN}`);           // the token goes upstream…
    assert.doesNotMatch(JSON.stringify(data), /r8_test/); // …and never back to the browser
  });
});

test("the prompt describes a phrase in moves and milliseconds only", () => {
  const prompt = buildPrompt(PHRASE);
  assert.match(prompt, /The person danced 4 moves over 1250 ms/);
  // No talk of pixels, of the figure, or of anything the model cannot know.
  assert.doesNotMatch(prompt, /pixel|hoodie|screen|video|audio/i);
});

test("an answer the dancer could not perform is refused, with the model's own words kept", async () => {
  const bad = '{"read":"x","moves":[{"after_ms":400,"move":"moonwalk"},{"after_ms":400,"move":"spin"}]}';
  await withServers(succeeds(bad), async (base) => {
    const res = await post(base, { phrase: PHRASE });
    const data = await res.json();
    assert.equal(res.status, 502);
    assert.match(data.error, /not one of the dancer's moves/);
    assert.equal(data.raw, bad);
  });
});

test("a reply with no JSON in it is reported rather than guessed at", () => {
  assert.match(parseTurn("I would dance a spin next!").error, /no JSON/);
  assert.match(parseTurn("{not json}").error, /not valid JSON/);
});

test("when Replicate refuses, the reason reaches the page", async () => {
  const refuses = (req, res) => {
    res.writeHead(402, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ detail: "Insufficient credit." }));
  };
  await withServers(refuses, async (base) => {
    const data = await (await post(base, { phrase: PHRASE })).json();
    assert.equal(data.ok, false);
    assert.match(data.error, /Insufficient credit/);
  });
});

test("a slow answer is waited for, and the wait is measured", async () => {
  let polls = 0;
  const slowly = async (req, res) => {
    // "Prefer: wait" did not finish in time, so the server has to poll back.
    const self = `http://${req.headers.host}/v1/predictions/p1`;
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.method === "POST") {
      return res.end(JSON.stringify({ id: "p1", status: "processing", urls: { get: self } }));
    }
    polls++;
    res.end(JSON.stringify(polls < 2
      ? { id: "p1", status: "processing", urls: { get: self } }
      : { id: "p1", status: "succeeded", output: [GOOD] }));
  };
  await withServers(slowly, async (base) => {
    const data = await (await post(base, { phrase: PHRASE })).json();
    assert.equal(data.ok, true);
    assert.ok(data.modelMs >= 400, "the polling wait is counted");
    assert.equal(polls, 2);
  });
});

test("the test switches delay an answer and stop one being asked for", async () => {
  let upstreamCalls = 0;
  await withServers(
    (req, res) => { upstreamCalls++; succeeds(GOOD)(req, res); },
    async (base) => {
      const started = Date.now();
      const slow = await (await post(base, { phrase: PHRASE, test: { delayMs: 300 } })).json();
      assert.equal(slow.ok, true);
      assert.ok(Date.now() - started >= 300);

      const failed = await post(base, { phrase: PHRASE, test: { fail: true } });
      assert.equal(failed.status, 503);
      assert.match((await failed.json()).error, /Test failure/);
      assert.equal(upstreamCalls, 1, "the test failure never reached Replicate");
    },
  );
});

test("a phrase the server cannot use is refused before any model call", async () => {
  let upstreamCalls = 0;
  await withServers((req, res) => { upstreamCalls++; succeeds(GOOD)(req, res); }, async (base) => {
    assert.equal((await post(base, { phrase: [] })).status, 400);
    assert.equal((await post(base, { phrase: [{ move: "pulse", after_ms: 0 }] })).status, 400);
    assert.equal((await post(base, { phrase: [{ move: "wiggle", after_ms: 0 }, { move: "pulse", after_ms: 4 }] })).status, 400);
    assert.equal((await post(base, { phrase: "nope" })).status, 400);
    assert.equal(upstreamCalls, 0);
  });
});

test("with no token the server says so plainly, and keeps the file names out of it", async () => {
  const app = createServer({ token: undefined });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.address().port}`;

  const status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.dancerCanAnswer, false);

  const body = await (await post(base, { phrase: PHRASE })).json();
  // The visitor-facing half names no files or variables; the developer half does.
  assert.match(body.error, /cannot take its own turn/);
  assert.doesNotMatch(body.error, /REPLICATE_API_TOKEN|\.env/);
  assert.match(body.setup, /REPLICATE_API_TOKEN/);
  app.close();
});

test("the server refuses to call the model more often than its own limit", async () => {
  await withServers(succeeds(GOOD), async (base) => {
    const first = await (await post(base, { phrase: PHRASE })).json();
    assert.equal(first.ok, true);
    const second = await post(base, { phrase: PHRASE });
    assert.equal(second.status, 429);
    assert.match((await second.json()).error, /reached its limit of model calls/);
  }, { limits: { perVisitor: 99, perHour: 99, totalPerRun: 1, cooldownMs: 0 } });
});

test("a visitor gets a small number of turns, and is told plainly when they run out", async () => {
  let upstreamCalls = 0;
  await withServers((req, res) => { upstreamCalls++; succeeds(GOOD)(req, res); }, async (base) => {
    for (let i = 0; i < 2; i++) {
      assert.equal((await post(base, { phrase: PHRASE })).status, 200, `turn ${i + 1}`);
    }
    const blocked = await post(base, { phrase: PHRASE });
    assert.equal(blocked.status, 429);
    const body = await blocked.json();
    assert.match(body.error, /taken your 2 turns/);
    assert.match(body.error, /teaching and replaying a phrase still work/);
    assert.equal(upstreamCalls, 2, "the refused turn never reached Replicate");
  }, { limits: { perVisitor: 2, perHour: 99, totalPerRun: 99, cooldownMs: 0 } });
});

test("a successful turn reports how many the visitor has left", async () => {
  await withServers(succeeds(GOOD), async (base) => {
    const first = await (await post(base, { phrase: PHRASE })).json();
    assert.equal(first.turnsLeft, 2);
    const second = await (await post(base, { phrase: PHRASE })).json();
    assert.equal(second.turnsLeft, 1);
  }, { limits: { perVisitor: 3, perHour: 99, totalPerRun: 99, cooldownMs: 0 } });
});

test("two handovers fired at once make one model call, not two", async () => {
  let upstreamCalls = 0;
  const slowUpstream = async (req, res) => {
    upstreamCalls++;
    await new Promise((r) => setTimeout(r, 250));   // still in flight when the twin arrives
    succeeds(GOOD)(req, res);
  };
  await withServers(slowUpstream, async (base) => {
    const [a, b] = await Promise.all([post(base, { phrase: PHRASE }), post(base, { phrase: PHRASE })]);
    const codes = [a.status, b.status].sort();
    assert.deepEqual(codes, [200, 409], "one answered, one refused as a duplicate");
    const dup = a.status === 409 ? a : b;
    assert.match((await dup.json()).error, /already being danced/);
    assert.equal(upstreamCalls, 1, "the duplicate never reached Replicate");
  }, { limits: { perVisitor: 99, perHour: 99, totalPerRun: 99, cooldownMs: 0 } });
});

test("a failed turn releases the visitor's lock instead of stranding them", async () => {
  let n = 0;
  const failsThenWorks = (req, res) => {
    if (++n === 1) { res.writeHead(500, { "Content-Type": "application/json" }); return res.end("{}"); }
    succeeds(GOOD)(req, res);
  };
  await withServers(failsThenWorks, async (base) => {
    assert.equal((await post(base, { phrase: PHRASE })).status, 502);
    // If the lock leaked, this would come back 409 rather than being answered.
    assert.equal((await post(base, { phrase: PHRASE })).status, 200);
  }, { limits: { perVisitor: 99, perHour: 99, totalPerRun: 99, cooldownMs: 0 } });
});

test("the kill switch stops calls without taking the rest of the page down", async () => {
  let upstreamCalls = 0;
  await withServers((req, res) => { upstreamCalls++; succeeds(GOOD)(req, res); }, async (base) => {
    const status = await (await fetch(`${base}/api/status`)).json();
    assert.equal(status.dancerCanAnswer, false, "the page is told up front, not at the wall");

    const res = await post(base, { phrase: PHRASE });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.match(body.error, /switched off for now/);
    assert.match(body.error, /Teaching and replaying a phrase still work/);
    assert.equal(upstreamCalls, 0, "nothing reached Replicate");

    // The interface itself is untouched.
    assert.equal((await fetch(`${base}/`)).status, 200);
  }, { enabled: () => false });
});
