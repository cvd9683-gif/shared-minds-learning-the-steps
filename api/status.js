// GET /api/status — a Vercel Function.
//
// The page asks this on load to find out whether the dancer can take its own
// turn. It answers with a yes or no and the model's name, and nothing else:
// the token is read here, on the server, and never leaves it. Whether a token
// exists is the only thing derived from it.

import { MODEL, readToken, tokenUsable } from "../phrase-api.js";
import { callsEnabled } from "../limits.js";

export default function handler(request, response) {
  // The same question a turn asks, asked the same way — a token that cannot be
  // put in a request is reported as unavailable here rather than at the button.
  const canAnswer = tokenUsable(readToken(process.env))
    && callsEnabled(process.env.MODEL_CALLS_ENABLED);

  response.setHeader("Cache-Control", "no-store");
  response.status(200).json({ dancerCanAnswer: canAnswer, model: MODEL });
}
