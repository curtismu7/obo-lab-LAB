// Real mode: your own PingOne tenant, owner-configured. Reads the shared ~/Development/.env:
//   PINGONE_ENVIRONMENT_ID, PINGONE_WORKER_CLIENT_ID (or PINGONE_WORKER_ID), PINGONE_WORKER_CLIENT_SECRET,
//   plus optional OBO_LAB_PERSON_TOKEN for the subject (otherwise Real mode refuses: agents never
//   sign a person in). Tokens stay server-side; the page only shows the caller's OWN tokens, and the
//   worker secret is write-only: masked as sha256/8, never returned.
// Wire (identical to AI-DEMO2's BFF):
//   1. POST /as/token client_credentials for the agent's actor token
//   2. POST /as/token grant_type=token-exchange subject_token=<person> actor_token=<agent>
//      requested_token_type=urn:ietf:params:oauth:token-type:access_token
//      audience=<OBO_LAB_AUDIENCE> scope=<OBO_LAB_SCOPE>
//   3. GET <OBO_LAB_DOWNSTREAM> with each token; the downstream must accept the delegated and refuse the subject's own.
import { loadSharedEnv } from './env.js';
import crypto from 'node:crypto';

const sha8 = (t) => (t ? `sha256 ${crypto.createHash('sha256').update(t).digest('hex').slice(0, 8)} (hash only)` : '-');

export function realConfigured(env = process.env) {
  const e = { ...env, ...loadSharedEnv() };
  return Boolean(e.PINGONE_ENVIRONMENT_ID && (e.PINGONE_WORKER_CLIENT_ID || e.PINGONE_WORKER_ID) && (e.PINGONE_WORKER_CLIENT_SECRET || e.PINGONE_WORKER_SECRET) && e.OBO_LAB_PERSON_TOKEN);
}

export const NO_REAL = 'Real mode is not configured. Set PINGONE_ENVIRONMENT_ID, the Worker app client id + secret, and OBO_LAB_PERSON_TOKEN (a real person access token from your own sign-in) in ~/Development/.env, plus OBO_LAB_AUDIENCE, OBO_LAB_SCOPE and OBO_LAB_DOWNSTREAM. Then restart the lab. Agents never sign a person in; the owner supplies the subject token.';

const form = (obj) => new URLSearchParams(obj).toString();
const decode = (t) => { try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8')); } catch { return null; } };

// `onAnswer` (optional) is told what PingOne or the downstream answered, step by step: the status, the OAuth error code and the decoded
// claims of a token the lab received. Never a token body, never the error text. The run-observability record is built from these.
async function tokenEndpoint(envId, body, key, { fetchFn = fetch, onAnswer, step } = {}) {
  const r = await fetchFn(`https://auth.pingone.com/${envId}/as/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(key).toString('base64')}` }, body: form(body),
  });
  const j = await r.json().catch(() => ({}));
  onAnswer?.({ step, status: r.status, error: j.error, claims: r.ok ? decode(j.access_token) : null });
  if (!r.ok) throw new Error(`PingOne token endpoint answered HTTP ${r.status}: ${j.error ?? ''} ${j.error_description ?? ''}`.trim());
  return j;
}

export async function realRun({ fetchFn = fetch, env = process.env, onAnswer } = {}) {
  const e = { ...env, ...loadSharedEnv() };
  const envId = e.PINGONE_ENVIRONMENT_ID;
  const clientId = e.PINGONE_WORKER_CLIENT_ID || e.PINGONE_WORKER_ID;
  const secret = e.PINGONE_WORKER_CLIENT_SECRET || e.PINGONE_WORKER_SECRET;
  const key = `${clientId}:${secret}`;
  const personToken = e.OBO_LAB_PERSON_TOKEN;
  const audience = e.OBO_LAB_AUDIENCE;
  const scope = e.OBO_LAB_SCOPE || 'checking:read transfer:write';
  const downstream = e.OBO_LAB_DOWNSTREAM;
  if (!audience || !downstream) throw new Error('Real mode needs OBO_LAB_AUDIENCE and OBO_LAB_DOWNSTREAM in ~/Development/.env');
  // step 2: agent identity (client credentials)
  const cc = await tokenEndpoint(envId, { grant_type: 'client_credentials', scope: e.OBO_LAB_AGENT_SCOPE || 'agent:identity' }, key, { fetchFn, onAnswer, step: 'actor' });
  // step 3: the exchange
  const xchg = await tokenEndpoint(envId, {
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: personToken, subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    actor_token: cc.access_token, actor_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    audience, scope,
  }, key, { fetchFn, onAnswer, step: 'exchange' });
  // step 5/6: the downstream accepts the delegated and refuses the person's own
  const call = async (token, step) => { const r = await fetchFn(downstream, { headers: { authorization: `Bearer ${token}` } }); onAnswer?.({ step, status: r.status }); return r.status; };
  const delegatedStatus = await call(xchg.access_token, 'downstream-delegated');
  const inboundStatus = await call(personToken, 'downstream-own');
  const d = decode(xchg.access_token) ?? {};
  const i = decode(personToken) ?? {};
  return {
    ok: true, real: true, at: new Date().toISOString(),
    inbound: { claims: i, sha: sha8(personToken) },
    actor: { claims: decode(cc.access_token) ?? {}, sha: sha8(cc.access_token) },
    delegated: { claims: d, sha: sha8(xchg.access_token) },
    downstream: { delegatedStatus, inboundStatus },
    delta: {
      subSame: d.sub === i.sub, audSame: JSON.stringify(d.aud) === JSON.stringify(i.aud),
      scopeNarrowed: String(d.scope ?? '').split(' ').every((s) => String(i.scope ?? '').includes(s)) && d.scope !== i.scope,
      actAdded: Boolean(d.act),
    },
    leak: false,
    tokensRedacted: true,
  };
}
