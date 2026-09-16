// The optional record of what fetch() actually did: what went out, what came
// back, and how long it took. Kept out of the performance view on purpose.

export function logRequest(list, request) {
  const li = document.createElement("li");
  const roundTrip = Math.round(request.doneAt - request.sentAt);
  const res = request.response ?? {};

  const head = document.createElement("p");
  head.className = "line";
  head.append(
    span(`#${request.id}`),
    span(`${request.beatsSent} moves sent`),
    span(`${roundTrip} ms round trip`, request.error ? "bad" : "good"),
  );
  if (res.modelMs) head.append(span(`${res.modelMs} ms of that inside Replicate`));
  if (res.plan) head.append(span(`${res.plan.moves.length} moves answered`));
  if (request.error) head.append(span(request.error, "bad"));
  if (res.setup) head.append(span(res.setup, "bad"));
  li.append(head);

  const detail = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "request and response";
  detail.append(summary, pre("POST /api/continue", request.payload), pre("response", trimResponse(res)));
  if (res.raw) detail.append(pre("the model's own words", res.raw));
  li.append(detail);

  list.prepend(li);
  while (list.children.length > 12) list.lastElementChild.remove();
}

function span(text, cls = "") {
  const el = document.createElement("span");
  el.className = cls;
  el.textContent = text;
  return el;
}

function pre(label, value) {
  const wrap = document.createElement("div");
  const p = document.createElement("p");
  p.className = "pre-label";
  p.textContent = label;
  const el = document.createElement("pre");
  el.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 1);
  wrap.append(p, el);
  return wrap;
}

// The prompt is long; show it, but not twice.
function trimResponse(res) {
  const { sent, ...rest } = res;
  return { ...rest, sent: sent ? { model: sent.model, prompt: sent.input.prompt } : undefined };
}
