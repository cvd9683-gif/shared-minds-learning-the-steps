// GET /api/status — a Vercel Function.
//
// The page asks this on load to find out whether the dancer can take its own
// turn. It answers with a yes or no and the model's name, and nothing else:
// the token is read here, on the server, and never leaves it. Whether a token
// exists is the only thing derived from it.

import { MODEL } from "../phrase-api.js";
import { callsEnabled } from "../limits.js";

export default function handler(request, response) {
  const hasToken = Boolean(process.env.REPLICATE_API_TOKEN?.trim());
  response.setHeader("Cache-Control", "no-store");
  response.status(200).json({
    dancerCanAnswer: hasToken && callsEnabled(process.env.MODEL_CALLS_ENABLED),
    model: MODEL,
  });
}
