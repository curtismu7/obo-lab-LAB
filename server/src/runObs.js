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

// Names read from claims are shown only when they are strings: an object, a number or a function never prints as "[object Object]".
const idOf = (v) => (typeof v === 'string' && v ? v : undefined);
const nameOf = (v) => (typeof v === 'string' && v ? text(v, 60) : v === undefined || v === null || v === '' ? 'none' : 'not a string');
// The actor: its `sub` when it is a string; an act claim without one is still a claim ("present, no sub"), never "none".
const actOf = (act) => {
  if (act === undefined || act === null) return 'none';
  if (typeof act !== 'object' || Array.isArray(act)) return 'not a string';
  return act.sub === undefined || act.sub === null ? 'present, no sub' : nameOf(act.sub);
};

// An answer's outcome, the same rule in Mock and Real: 2xx is allowed; 401/403 and an OAuth decision error (access_denied,
// invalid_client, unauthorized_client, invalid_grant) are refused; everything else (a malformed request, a 5xx) is only information.
const DECISION_ERRORS = new Set(['access_denied', 'invalid_client', 'unauthorized_client', 'invalid_grant']);
const replyOutcome = (status, error) => (status >= 200 && status < 300 ? 'allowed'
  : status === 401 || status === 403 || (status === 400 && DECISION_ERRORS.has(error)) ? 'refused' : 'info');
const EXPECTED_REFUSED = ' The lab expects this call to be refused.';

// ---- Decisions -> events ---------------------------------------------------------------------------------------------------
// Mock: the facts of the run the mock returned. `agent` is the lab's own agent id (the cast), which a refused run does not carry.
export function mockEvents(run, agent) {
  const out = [];
  if (!run.ok) {
    out.push({ layer: 'agent', step: 'agent-identity', actor: agent, outcome: 'refused', product: 'lab mock issuer',
      message: `The mock issuer refused the agent's client credentials at step ${text(run.failedStep, 4)}: its client is revoked (invalid_client)`, detail: { step: run.failedStep, error: 'invalid_client' } });
    return out;
  }
  const d = run.delegated.claims;
  out.push({ layer: 'person', step: 'person', actor: idOf(run.inbound.claims.sub), outcome: 'allowed', product: 'lab mock issuer',
    message: `The mock issuer signed the person's access token: sub ${nameOf(run.inbound.claims.sub)}, client ${nameOf(run.inbound.claims.client_id)}`, detail: { sub: nameOf(run.inbound.claims.sub) } });
  out.push({ layer: 'agent', step: 'agent-identity', actor: agent, outcome: 'allowed', product: 'lab mock issuer',
    message: `The mock issuer gave the agent its own identity (client credentials): ${nameOf(run.actor.claims.sub)}`, detail: { agent: nameOf(run.actor.claims.sub) } });
  out.push({ layer: 'agent', step: 'exchange', actor: agent, outcome: 'allowed', product: 'lab mock exchanger',
    message: `RFC 8693 exchange: one delegated token minted, sub ${nameOf(d.sub)}, act ${actOf(d.act)}`, detail: { sub: nameOf(d.sub), act: actOf(d.act), scope: typeof d.scope === 'string' ? text(d.scope, 200) : null } });
  const { delegatedStatus, delegatedWhy, inboundStatus, inboundWhy } = run.downstream;
  out.push({ layer: 'resource', step: 'downstream-delegated', actor: agent, outcome: replyOutcome(delegatedStatus), product: 'lab mock downstream',
    message: `The mock downstream answered HTTP ${text(delegatedStatus, 4)} to the delegated token: ${text(delegatedWhy)}`, detail: { status: delegatedStatus } });
  const own = replyOutcome(inboundStatus);
  out.push({ layer: 'resource', step: 'downstream-own', actor: idOf(run.inbound.claims.sub), outcome: own, product: 'lab mock downstream',
    message: `The mock downstream answered HTTP ${text(inboundStatus, 4)} to the person's own token: ${text(inboundWhy)}${own === 'allowed' ? EXPECTED_REFUSED : ''}`,
    detail: { status: inboundStatus, expected: 'refused' } });
  return out;
}

// Real: one answer the lab received (see realRun's onAnswer).
const NOT_A_LOG = 'This is a reply the lab received, not a log line.';
const REAL_STEP = {
  actor: { layer: 'agent', product: 'PingOne token endpoint', what: "the agent's client-credentials request" },
  exchange: { layer: 'agent', product: 'PingOne token endpoint', what: 'the RFC 8693 token exchange' },
  'downstream-delegated': { layer: 'resource', product: 'downstream reply', what: 'the delegated token' },
  'downstream-own': { layer: 'resource', product: 'downstream reply', what: "the person's own token" },
};
export function realEvent(a) {
  const s = REAL_STEP[a.step];
  const who = s.layer === 'agent' ? 'PingOne' : 'The downstream';
  if (a.status === null) {
    return { layer: s.layer, step: a.step, outcome: 'info', result: 'no-reply', product: s.product, detail: {},
      message: `${who} gave no reply to ${s.what}: the call did not complete, so there is nothing to show. ${NOT_A_LOG}` };
  }
  let outcome; let message; let claims = null;
  if (s.layer === 'agent') {
    outcome = replyOutcome(a.status, typeof a.error === 'string' ? a.error : undefined);
    message = `PingOne answered ${s.what}: HTTP ${a.status}${typeof a.error === 'string' ? `: ${lineValue(a.error, 40)}` : ''}.`;
    if (a.step === 'exchange' && outcome === 'allowed') {
      claims = a.claims && typeof a.claims === 'object' && !Array.isArray(a.claims) ? a.claims : null;
      message += claims ? ` The delegated token names sub ${nameOf(claims.sub)} and act ${actOf(claims.act)}.` : ' Its token could not be read as a JWT, so no sub or act is shown.';
    }
  } else if (a.redirected) {
    outcome = 'info';
    message = `The downstream answered HTTP ${a.status} to ${s.what} after a redirect, so the answer may come from another page and is not read as a decision.`;
  } else if (a.status >= 200 && a.status < 300 && !a.parsed) {
    outcome = 'info';
    message = `The downstream answered HTTP ${a.status} to ${s.what}, but its body could not be read as JSON, so it is not read as a decision.`;
  } else if (a.status >= 200 && a.status < 300 && a.bodyError) {
    outcome = 'refused';
    message = `The downstream answered HTTP ${a.status} to ${s.what} with an error in its body.`;
  } else {
    outcome = replyOutcome(a.status);
    message = `The downstream answered HTTP ${a.status} to ${s.what}.`;
  }
  if (a.step === 'downstream-own' && outcome === 'allowed') message += EXPECTED_REFUSED;
  const sub = idOf(claims?.sub); const act = idOf(claims?.act?.sub);
  return { layer: s.layer, step: a.step, actor: act, outcome, product: s.product, message: `${message} ${NOT_A_LOG}`,
    detail: { status: a.status, ...(a.step === 'downstream-own' ? { expected: 'refused' } : {}),
      ...(claims ? { sub: nameOf(claims.sub), act: actOf(claims.act), scope: typeof claims.scope === 'string' ? text(claims.scope, 200) : null } : {}) },
    who: sub || act ? { sub, actor: act } : undefined };
}

// ---- The run log -----------------------------------------------------------------------------------------------------------------
// Per workspace and per mode, the latest FINISHED run only (so a Mock run can never come back as a Real reply, and an older run is never
// shown for an attempt that began nothing). A run that is still in flight is kept apart (`open`), so a second reader is told so instead of
// being shown nothing, and its workspace is never evicted. Each event is stamped ONCE, written as ONE stdout line and kept for the record.
export function createRunLog({ write = (line) => process.stdout.write(`${line}\n`), clock = Date.now } = {}) {
  const workspaces = new Map();
  let seq = 0;
  const slot = (ws) => {
    if (!workspaces.has(ws)) {
      workspaces.set(ws, { mock: null, real: null, open: new Set() });
      if (workspaces.size > MAX_WORKSPACES) for (const [k, v] of workspaces) if (k !== ws && v.open.size === 0) { workspaces.delete(k); break; }
    }
    return workspaces.get(ws);
  };
  return {
    // Start an attempt in this mode. `record(event)` stamps, logs and keeps one event; `finish()` makes it the mode's latest run.
    begin(ws, source) {
      const s = slot(ws);
      const run = { id: `obo-${clock()}-${++seq}`, source, events: [] };
      s.open.add(run);
      return {
        run,
        record(e) {
          const at = new Date(clock()).toISOString();
          const event = { ...e, at };
          run.events.push(event);
          write(`${at} ${SERVICE} decision step=${lineValue(e.step)} actor=${lineValue(e.actor)} result=${e.result || RESULT[e.outcome]} run=${lineValue(run.id)} mode=${source}`);
          return event;
        },
        finish() { s.open.delete(run); s[source] = run; },
      };
    },
    // { run: the latest finished run in this mode or null, open: a run in this mode is still in flight }
    latest(ws, source) {
      const s = workspaces.get(ws);
      return { run: s?.[source] ?? null, open: s ? [...s.open].some((r) => r.source === source) : false };
    },
    reset: (ws) => { workspaces.delete(ws); },
  };
}

// Recording a decision must never fail a run that has already happened: the failure goes to stderr (code and message only) and the run goes on.
export function guarded(fn) {
  try { fn(); } catch (e) {
    console.error(`[${SERVICE}] decision log failed: ${String(e?.code || e?.name || 'Error').slice(0, 40)}: ${String(e?.message).replace(/[\r\n]+/g, ' ').slice(0, 200)}`);
  }
}

// ---- The record ------------------------------------------------------------------------------------------------------------------
const WHY = {
  person: { mock: "The mock refused the agent at step 2, before it signed the person's token, so it computed no person event.",
    real: "This lab does not sign anyone in: the person's token is the owner's own, supplied in the settings, so this run has no sign-in event. PingOne sign-in is in the PingOne audit activity API, which this panel does not read yet." },
  agent: { mock: 'The mock computed no agent event on this run.', real: 'PingOne gave no answer to the agent steps on this run.' },
  authorize: { mock: 'This lab does not call PingOne Authorize: the downstream checks the token itself, shown under Resource server.', real: 'This lab does not call PingOne Authorize, so there is no Authorize decision to show.' },
  privilege: { mock: 'This lab has no Privilege policy, AI Guard or approval step.', real: 'This lab has no Privilege policy, AI Guard or approval step.' },
  gateway: { mock: 'This lab has no agent gateway: it calls the downstream API directly, shown under Resource server.', real: 'This lab has no agent gateway: it calls the downstream API directly, shown under Resource server.' },
  resource: { mock: 'The run stopped at step 2, so the downstream was never called.', real: 'The downstream was not called on this run: an earlier PingOne step was refused or got no reply.' },
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
