// Who may ask the model for a turn, and how often.
//
// This is what stands between a public link and someone's Replicate balance.
// It holds everything in memory on purpose — there is no database here — which
// means every counter below resets when the process restarts. Read the limits
// section of the README before trusting any of it as a spending cap.
//
// No DOM, no network, no timers: the clock is injected, so it is all testable.

export const OFF = new Set(["0", "false", "off", "no"]);

// `enabled` is read per request, so flipping the environment variable and
// restarting takes effect immediately without touching the code.
export function callsEnabled(value) {
  if (value === undefined || value === null || value === "") return true;
  return !OFF.has(String(value).trim().toLowerCase());
}

export function createLimiter({
  perVisitor = 8,                  // turns one visitor may take per window
  windowMs = 60 * 60 * 1000,       // the window that applies to
  perHour = 40,                    // ceiling across everyone, rolling
  totalPerRun = 100,               // hard stop for this process
  cooldownMs = 1500,               // quiet time between one visitor's turns
  now = () => Date.now(),
} = {}) {
  const visitors = new Map();      // key -> { times: number[], inFlight: boolean }
  let everyone = [];               // timestamps of every call this process made
  let total = 0;

  const fresh = (times, t) => times.filter((x) => t - x < windowMs);

  function entry(key, t) {
    let v = visitors.get(key);
    if (!v) { v = { times: [], inFlight: false }; visitors.set(key, v); }
    v.times = fresh(v.times, t);
    return v;
  }

  // Drop visitors we are no longer counting anything for, so a long-running
  // service does not grow a map entry per person who ever visited.
  function sweep(t) {
    for (const [key, v] of visitors) {
      if (!v.inFlight && fresh(v.times, t).length === 0) visitors.delete(key);
    }
    everyone = everyone.filter((x) => t - x < 60 * 60 * 1000);
  }

  return {
    // Returns { ok: true } or { ok: false, status, error } with a sentence a
    // visitor can actually act on.
    check(key) {
      const t = now();
      sweep(t);
      const v = entry(key, t);

      if (v.inFlight) {
        return { ok: false, status: 409, error: "That turn is already being danced — give it a moment." };
      }
      const last = v.times.at(-1);
      if (last !== undefined && t - last < cooldownMs) {
        return { ok: false, status: 429, error: "One turn at a time, please — try again in a second." };
      }
      if (v.times.length >= perVisitor) {
        const mins = Math.max(1, Math.ceil((windowMs - (t - v.times[0])) / 60000));
        return {
          ok: false,
          status: 429,
          error: `You have taken your ${perVisitor} turns for now. More in about ${mins} ${mins === 1 ? "minute" : "minutes"} — teaching and replaying a phrase still work.`,
        };
      }
      if (everyone.filter((x) => t - x < 60 * 60 * 1000).length >= perHour) {
        return { ok: false, status: 429, error: "This demo has answered a lot of phrases in the last hour. Try again later — teaching and replaying still work." };
      }
      if (total >= totalPerRun) {
        return { ok: false, status: 429, error: "This demo has reached its limit of model calls. Teaching and replaying a phrase still work." };
      }
      return { ok: true };
    },

    // Call immediately before the model request goes out.
    began(key) {
      const t = now();
      const v = entry(key, t);
      v.inFlight = true;
      v.times.push(t);
      everyone.push(t);
      total++;
    },

    // Call in a `finally`, whatever the outcome.
    ended(key) {
      const v = visitors.get(key);
      if (v) v.inFlight = false;
    },

    turnsLeft(key) {
      const t = now();
      const v = visitors.get(key);
      const used = v ? fresh(v.times, t).length : 0;
      return Math.max(0, perVisitor - used);
    },

    snapshot() {
      const t = now();
      return {
        total,
        totalPerRun,
        lastHour: everyone.filter((x) => t - x < 60 * 60 * 1000).length,
        perHour,
        visitorsTracked: visitors.size,
      };
    },
  };
}
