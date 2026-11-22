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
// Rule 23: a server error answers { error, message }; hand that to the panel instead of a bare "HTTP 500".
export async function getRunObservability() {
  const r = await fetch("/api/run-observability");
  const body = await r.json().catch(() => null);
  if (!r.ok && !body?.error) throw new Error(`HTTP ${r.status}`);
  return body;
}
export const revokeAgent = () => postJson("/api/revoke");
export const decodeToken = (token) => postJson("/api/decode", { token });
export const getTalkTrack = () => getJson("/api/talk");
