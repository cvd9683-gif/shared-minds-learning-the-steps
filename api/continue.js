// POST /api/continue — a Vercel Function.
//
// A thin wrapper around runTurn() in phrase-api.js, which is the same code the
// local development server uses. Everything specific to running on Vercel is in
// this file: reading the environment, finding the caller behind the proxy, and
// handing back a status and a JSON body.
//
// A note on the limiter below: on Vercel each function instance has its own
// memory, and instances come and go. These counters are real friction against
// ordinary over-use from one warm instance, and they are NOT a spending cap.
// The README says so at greater length, and points at the control that is one.

import { runTurn, visitorKey } from "../phrase-api.js";
import { createLimiter, callsEnabled } from "../limits.js";

const num = (name, fallback) => Number(process.env[name]) || fallback;

// Module scope, so it survives between invocations that land on the same warm
// instance and is rebuilt whenever a cold one starts.
const limiter = createLimiter({
  perVisitor: num("MAX_CALLS_PER_VISITOR", 8),
  windowMs: num("VISITOR_WINDOW_MINUTES", 60) * 60 * 1000,
  perHour: num("MAX_CALLS_PER_HOUR", 40),
  totalPerRun: num("MAX_MODEL_CALLS", 100),
  cooldownMs: Number(process.env.TURN_COOLDOWN_MS ?? 1500),
});

export default async function handler(request, response) {
  if (request.method !== "POST") {
    return response.status(405).json({ ok: false, error: "Use POST." });
  }

  // request.body is a getter that throws on malformed JSON.
  let body;
  try {
    body = request.body;
  } catch {
    return response.status(400).json({ ok: false, error: "The request body was not JSON." });
  }

  const result = await runTurn({
    body,
    visitor: visitorKey(request),
    token: process.env.REPLICATE_API_TOKEN?.trim(),
    apiBase: process.env.REPLICATE_API_BASE,
    limiter,
    enabled: () => callsEnabled(process.env.MODEL_CALLS_ENABLED),
    // Goes to the function log. It carries the outcome and the timing, never
    // the token and never the prompt.
    log: (line) => console.log(`[continue] ${line}`),
  });

  response.setHeader("Cache-Control", "no-store");
  response.status(result.status).json(result.body);
}
