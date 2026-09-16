// A tiny local server with no dependencies.
//   1. Serves the files in /public.
//   2. POST /api/continue sends a phrase someone danced to a model on Replicate,
//      and returns the turn it would dance back (see phrase-api.js).
// The Replicate token stays here, on your machine. The browser never sees it.

import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createContinueHandler, MODEL, tokenProblem } from "./phrase-api.js";
import { createLimiter, callsEnabled } from "./limits.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = path.join(PUBLIC, urlPath === "/" ? "index.html" : urlPath);
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, "text/plain", "Forbidden");
  try {
    const body = await readFile(file);
    send(res, 200, TYPES[path.extname(file)] || "application/octet-stream", body);
  } catch {
    send(res, 404, "text/plain", "Not found");
  }
}

function send(res, status, type, body) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

export function createServer(options = {}) {
  const limiter = options.limiter ?? createLimiter(options.limits);
  const enabled = options.enabled ?? (() => true);
  const handleContinue = createContinueHandler({ ...options, limiter, enabled });
  return http.createServer((req, res) => {
    const { pathname } = new URL(req.url, "http://x");
    // Lets the page know whether the dancer can take its own turn, without
    // revealing anything about the token itself.
    if (pathname === "/api/status") {
      // Only ever a yes/no and a model name. Nothing here is derived from the
      // token beyond whether one exists.
      return send(res, 200, "application/json", JSON.stringify({
        dancerCanAnswer: Boolean(options.token) && enabled(),
        model: MODEL,
      }));
    }
    if (pathname === "/api/continue") {
      return req.method === "POST" ? handleContinue(req, res) : send(res, 405, "text/plain", "Use POST");
    }
    if (req.method === "GET") return serveStatic(req, res);
    send(res, 405, "text/plain", "Method not allowed");
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.loadEnvFile(path.join(ROOT, ".env")); } catch { /* no .env yet */ }
  const port = Number(process.env.PORT) || 3000;

  // Locally, bind loopback so nobody else on the café wifi can spend the token.
  // A host like Render must reach the process through its own proxy, so there it
  // binds every interface. Render sets RENDER itself; HOST overrides both.
  const host = process.env.HOST || (process.env.RENDER ? "0.0.0.0" : "127.0.0.1");

  // A trailing newline from a paste is normal and harmless; trim it. Anything
  // else odd inside the token is reported rather than quietly repaired.
  const token = process.env.REPLICATE_API_TOKEN?.trim();

  const num = (name, fallback) => Number(process.env[name]) || fallback;
  const limits = {
    perVisitor: num("MAX_CALLS_PER_VISITOR", 8),
    windowMs: num("VISITOR_WINDOW_MINUTES", 60) * 60 * 1000,
    perHour: num("MAX_CALLS_PER_HOUR", 40),
    totalPerRun: num("MAX_MODEL_CALLS", 100),
    cooldownMs: Number(process.env.TURN_COOLDOWN_MS ?? 1500),
  };
  // Read fresh on every request, so flipping it and restarting is enough.
  const enabled = () => callsEnabled(process.env.MODEL_CALLS_ENABLED);

  const log = (line) => console.log(`[continue] ${line}`);
  createServer({ token, limits, enabled, apiBase: process.env.REPLICATE_API_BASE, log })
    .listen(port, host, () => {
      console.log(`Learning the Steps is listening on ${host}:${port}`);
      const problem = tokenProblem(token);
      if (problem) {
        console.log(`WARNING: ${problem}`);
      } else if (!token) {
        console.log("No REPLICATE_API_TOKEN: you can teach and replay phrases; the dancer cannot answer, and the page says so.");
      } else if (!enabled()) {
        console.log("MODEL_CALLS_ENABLED is off: no model calls will be made until it is turned back on.");
      } else {
        console.log(`The dancer will answer using ${MODEL} on Replicate.`);
        console.log(`Limits: ${limits.perVisitor} turns per visitor per ${limits.windowMs / 60000} min, `
          + `${limits.perHour}/hour overall, ${limits.totalPerRun} per run. All reset when the service restarts.`);
      }
    });
}
