// Rule 27: this lab's side of the shared run-observability panel. Pure functions around the vendored core (runObservability.js, never
// edited here): the decisions one run made, the one stdout line each leaves, and the record built from them.
//
// This lab reads no product logs, so it vendors the core only. Mock: every row is `simulated` and comes from what the lab's own mock
// returned on this run. Real: every row is a `response`, an answer the lab received from PingOne's token endpoint or from the downstream;
// nothing is ever shown as `logged`. A layer this lab has no event for says why (`not-logged`) instead of inventing one.
import { createRunObservability, LAYERS } from './runObservability.js';

const SERVICE = 'obo-lab';
const MAX_WORKSPACES = 20;
// A value that goes INTO a stdout line: only these characters survive, so a name cannot add a second key=value or a second line.
const lineValue = (v, n = 64) => String(v ?? '').replace(/[^A-Za-z0-9._:/@-]+/g, '_').slice(0, n) || '-';
const text = (v, n = 120) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, n);
const RESULT = { allowed: 'passed', refused: 'stopped', blocked: 'stopped', info: 'unclear' };

// ---- Decisions -> events ---------------------------------------------------------------------------------------------------
// Mock: the facts of the run the mock returned. `agent` is the lab's own agent id (the cast), which a refused run does not carry.
export function mockEvents(run, agent) {
  const out = [];
  if (!run.ok) {
    out.push({ layer: 'agent', step: 'agent-identity', actor: agent, outcome: 'refused', product: 'lab mock issuer',
      message: `The mock issuer refused the agent's client credentials at step ${run.failedStep}: its client is revoked (invalid_client)`, detail: { step: run.failedStep, error: 'invalid_client' } });
    return out;
  }
  const d = run.delegated.claims;
  out.push({ layer: 'person', step: 'person', actor: run.inbound.claims.sub, outcome: 'allowed', product: 'lab mock issuer',
    message: `The mock issuer signed the person's access token: sub ${text(run.inbound.claims.sub, 60)}, client ${text(run.inbound.claims.client_id, 60)}`, detail: { sub: run.inbound.claims.sub } });
  out.push({ layer: 'agent', step: 'agent-identity', actor: agent, outcome: 'allowed', product: 'lab mock issuer',
    message: `The mock issuer gave the agent its own identity (client credentials): ${text(run.actor.claims.sub, 60)}`, detail: { agent: run.actor.claims.sub } });
  out.push({ layer: 'agent', step: 'exchange', actor: agent, outcome: 'allowed', product: 'lab mock exchanger',
    message: `RFC 8693 exchange: one delegated token minted, sub ${text(d.sub, 60)}, act ${text(d.act?.sub ?? 'none', 60)}`, detail: { sub: d.sub, act: d.act?.sub ?? null, scope: d.scope } });
  const { delegatedStatus, delegatedWhy, inboundStatus, inboundWhy } = run.downstream;
  out.push({ layer: 'resource', step: 'downstream-delegated', actor: agent, outcome: delegatedStatus === 200 ? 'allowed' : 'refused', product: 'lab mock downstream',
    message: `The mock downstream answered HTTP ${delegatedStatus} to the delegated token: ${text(delegatedWhy)}`, detail: { status: delegatedStatus } });
  out.push({ layer: 'resource', step: 'downstream-own', actor: run.inbound.claims.sub, outcome: inboundStatus === 200 ? 'allowed' : 'refused', product: 'lab mock downstream',
    message: `The mock downstream answered HTTP ${inboundStatus} to the person's own token: ${text(inboundWhy)}`, detail: { status: inboundStatus } });
  return out;
}

// Real: one answer the lab received (see realRun's onAnswer). A 2xx is allowed, 400/401/403 is refused, anything else is information.
const replyOutcome = (status) => (status >= 200 && status < 300 ? 'allowed' : [400, 401, 403].includes(status) ? 'refused' : 'info');
const NOT_A_LOG = 'This is a reply the lab received, not a log line.';
const REAL_STEP = {
  actor: { layer: 'agent', product: 'PingOne token endpoint', what: "the agent's client-credentials request" },
  exchange: { layer: 'agent', product: 'PingOne token endpoint', what: 'the RFC 8693 token exchange' },
  'downstream-delegated': { layer: 'resource', product: 'downstream reply', what: 'the delegated token' },
  'downstream-own': { layer: 'resource', product: 'downstream reply', what: "the person's own token" },
};
export function realEvent(a) {
  const s = REAL_STEP[a.step];
  const outcome = replyOutcome(a.status);
  const code = a.error ? `: ${lineValue(a.error, 40)}` : '';
  let message = `PingOne answered ${s.what}: HTTP ${a.status}${code}. ${NOT_A_LOG}`;
  if (s.layer === 'resource') message = `The downstream answered HTTP ${a.status} to ${s.what}. ${NOT_A_LOG}`;
  const c = a.step === 'exchange' && outcome === 'allowed' ? a.claims : null;
  if (c) message = `PingOne answered the RFC 8693 token exchange: HTTP ${a.status}. The delegated token names sub ${text(c.sub, 60)} and act ${text(c.act?.sub ?? 'none', 60)}. ${NOT_A_LOG}`;
  return { layer: s.layer, step: a.step, actor: c ? c.act?.sub : undefined, outcome, product: s.product, message,
    detail: { status: a.status, ...(c ? { sub: c.sub, act: c.act?.sub ?? null, scope: c.scope } : {}) }, who: c ? { sub: c.sub, actor: c.act?.sub } : undefined };
}

// ---- The run log -----------------------------------------------------------------------------------------------------------------
// Per workspace and per mode, the latest attempt only (so a Mock run can never come back as a Real reply, and an older run is never
// shown for an attempt that began nothing). Each event is stamped ONCE, written as ONE stdout line and kept for the record.
export function createRunLog({ write = (line) => process.stdout.write(`${line}\n`), clock = Date.now } = {}) {
  const workspaces = new Map();
  const slot = (ws) => {
    if (!workspaces.has(ws)) {
      workspaces.set(ws, {});
      if (workspaces.size > MAX_WORKSPACES) workspaces.delete(workspaces.keys().next().value);
    }
    return workspaces.get(ws);
  };
  return {
    // Start an attempt in this mode: it replaces the mode's previous run. `record(event)` stamps, logs and keeps one event.
    begin(ws, source) {
      const run = { id: `obo-${clock()}`, source, events: [] };
      slot(ws)[source] = run;
      return {
        run,
        record(e) {
          const at = new Date(clock()).toISOString();
          const event = { ...e, at };
          run.events.push(event);
          write(`${at} ${SERVICE} decision step=${lineValue(e.step)} actor=${lineValue(e.actor)} result=${RESULT[e.outcome]} run=${lineValue(run.id)} mode=${source}`);
          return event;
        },
      };
    },
    latest: (ws, source) => workspaces.get(ws)?.[source] ?? null,
    reset: (ws) => { workspaces.delete(ws); },
  };
}

// ---- The record ------------------------------------------------------------------------------------------------------------------
const WHY = {
  person: { mock: "The mock refused the agent at step 2, before it signed the person's token, so it computed no person event.",
    real: "This lab does not sign anyone in: the person's token is the owner's own, supplied in the settings, so this run has no sign-in event. PingOne sign-in is in the PingOne audit activity API, which this panel does not read yet." },
  agent: { mock: 'The mock computed no agent event on this run.', real: 'PingOne gave no answer to the agent steps on this run.' },
  authorize: { mock: 'This lab does not call PingOne Authorize: the downstream checks the token itself, shown under Resource server.', real: 'This lab does not call PingOne Authorize, so there is no Authorize decision to show.' },
  privilege: { mock: 'This lab has no Privilege policy, AI Guard or approval step.', real: 'This lab has no Privilege policy, AI Guard or approval step.' },
  gateway: { mock: 'This lab has no agent gateway: it calls the downstream API directly, shown under Resource server.', real: 'This lab has no agent gateway: it calls the downstream API directly, shown under Resource server.' },
  resource: { mock: "The run stopped at step 2, so the downstream was never called.", real: 'The downstream was not reached on this run: an earlier step got no answer or was refused.' },
};

export async function buildRunRecord({ run, clock = Date.now }) {
  if (!run || !run.events.length) return null;
  const { source, events } = run;
  const layers = LAYERS.map((layer) => {
    const rows = events.filter((e) => e.layer === layer).map((e) => ({ at: e.at, product: e.product, outcome: e.outcome, message: e.message, detail: e.detail }));
    return { layer, products: [], reason: WHY[layer][source], ...(source === 'mock' ? { simulated: rows } : { responses: rows }) };
  });
  const who = events.find((e) => e.who)?.who ?? {};
  return createRunObservability({ clock }).collectRun({
    runId: run.id, startedAt: events[0].at, endedAt: events[events.length - 1].at, source, layers,
    // Real only: the ids PingOne issued (sub, act) are shortened so a presenter can still correlate them; Mock names stay readable.
    ...(source === 'real' ? { correlation: { sub: who.sub, actClientId: who.actor } } : {}),
  });
}
