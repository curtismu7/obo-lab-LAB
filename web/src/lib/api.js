// Same origin only: every URL is a path.
export async function getJson(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
export async function postJson(path, body = {}) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message || `HTTP ${r.status}`);
  return data;
}
export const getCatalog = () => getJson("/api/catalog");
export const getInfo = () => getJson("/api/info");
// Rule 19: switch the runtime mode. Real unconfigured -> 409 with the server's how-to message.
export const requestModeSwitch = (source) => postJson("/api/mode", { source });
export const resetServer = () => postJson("/api/reset");
export const runObo = () => postJson("/api/run");
// Rule 23: a server error answers { error, message }; hand that to the panel instead of a bare "HTTP 500". An answer that is neither a
// run record nor a structured error (a 200 with an HTML page, say) is an error too, never the "Run the demo" empty state.
export async function getRunObservability() {
  const r = await fetch("/api/run-observability");
  const body = await r.json().catch(() => null);
  const object = body && typeof body === "object" && !Array.isArray(body);
  if (object && (body.error || (r.ok && "record" in body))) return body;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return { error: "bad_answer", message: "The server answered something that is not a run record." };
}
export const revokeAgent = () => postJson("/api/revoke");
export const decodeToken = (token) => postJson("/api/decode", { token });
export const getTalkTrack = () => getJson("/api/talk");
