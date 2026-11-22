// Rule 27: the run-observability record this lab builds, and the decision lines its server writes.
// Real mode runs against an in-process fake PingOne (an injected fetch): no live setting is read (STANDALONE_ENV names a scratch file) and nothing leaves the process.
import test, { before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { createApp } from '../src/app.js';
import { createMode } from '../src/mode.js';
import { realRun } from '../src/realPingOne.js';
import { assertRunObservability, classify, layerMatchers } from '../src/runObservability.js';
import { buildRunRecord, createRunLog } from '../src/runObs.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'obo-obs-'));
const savedEnvFile = process.env.STANDALONE_ENV;
before(() => { fs.writeFileSync(path.join(scratch, 'fake.env'), 'UNUSED_FAKE=1\n'); process.env.STANDALONE_ENV = path.join(scratch, 'fake.env'); });
after(() => { if (savedEnvFile === undefined) delete process.env.STANDALONE_ENV; else process.env.STANDALONE_ENV = savedEnvFile; fs.rmSync(scratch, { recursive: true, force: true }); });

const jwt = (claims) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const PERSON = jwt({ sub: 'person-sub-1234567890', scope: 'openid checking:read checking:write transfer:write' });
const REAL_ENV = { PINGONE_ENVIRONMENT_ID: 'env-fake', PINGONE_WORKER_CLIENT_ID: 'worker-fake', PINGONE_WORKER_CLIENT_SECRET: 'secret-fake', OBO_LAB_PERSON_TOKEN: PERSON, OBO_LAB_AUDIENCE: 'https://api.fabrikam.example', OBO_LAB_DOWNSTREAM: 'https://api.fabrikam.example/x' };
// A fake PingOne + downstream. `plan` overrides an answer: { actor, exchange, delegated, own } as [status, body].
const fakeFetch = (plan = {}) => async (url, init = {}) => {
  const u = String(url);
  const body = new URLSearchParams(String(init.body ?? ''));
  const answer = (pair) => { const [status, json] = pair; return { ok: status >= 200 && status < 300, status, json: async () => json }; };
  if (u.includes('/as/token')) {
    if (body.get('grant_type') === 'client_credentials') return answer(plan.actor ?? [200, { access_token: jwt({ sub: 'agent-client-9876543210' }) }]);
    return answer(plan.exchange ?? [200, { access_token: jwt({ sub: 'person-sub-1234567890', act: { sub: 'agent-client-9876543210', act: { sub: 'deeper-agent' } }, scope: 'checking:read transfer:write' }) }]);
  }
  const own = init.headers?.authorization === `Bearer ${PERSON}`; // the downstream: the person's own token is refused, the delegated one accepted
  return answer((own ? plan.own : plan.delegated) ?? [own ? 401 : 200, {}]);
};
const realOf = (plan, env = REAL_ENV) => (opts) => realRun({ ...opts, env, fetchFn: fakeFetch(plan) });

async function withLab(fn, { real = realOf(), mode = createMode({ env: REAL_ENV }), runLog, world } = {}) {
  const lines = [];
  const app = createApp({ mode, real, world, runLog: runLog ?? createRunLog({ write: (l) => lines.push(l) }), env: {} });
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, ws) => {
    const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', origin: base, ...(ws ? { 'x-obol-ws': ws } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  try { await fn({ call, lines }); } finally { await new Promise((r) => server.close(r)); }
}
const rec = async (call, ws) => (await call('GET', '/api/run-observability', undefined, ws)).body;
const mockMode = () => createMode({ forceMock: true });

test('mock: a permitted run gives simulated rows computed by the lab, and assertRunObservability passes', async () => {
  await withLab(async ({ call }) => {
    assert.equal((await call('POST', '/api/run')).status, 200);
    const { record: r } = await rec(call);
    assert.deepEqual(assertRunObservability(r), []);
    assert.equal(r.source, 'mock');
    assert.ok(r.rows.filter((x) => x.origin !== 'not-logged').every((x) => x.origin === 'simulated'), 'a mock row is never logged or a response');
    assert.deepEqual(r.coverage, { person: 'simulated', agent: 'simulated', authorize: 'not-logged', privilege: 'not-logged', gateway: 'not-logged', resource: 'simulated' });
    const sim = r.rows.filter((x) => x.origin === 'simulated');
    assert.deepEqual(sim.map((x) => `${x.layer}|${x.outcome}`), ['person|allowed', 'agent|allowed', 'agent|allowed', 'resource|allowed', 'resource|refused']);
    assert.match(sim[0].message, /signed the person's access token: sub user\.0042/);
    assert.match(sim[2].message, /one delegated token minted, sub user\.0042, act personal-agent/);
    assert.match(sim[3].message, /HTTP 200 to the delegated token/);
    assert.match(sim[4].message, /HTTP 401 to the person's own token: no act claim/);
    assert.deepEqual(r.summary, { allowed: 4, refused: 1, blocked: 0, info: 0, unverified: 0 });
    for (const l of ['authorize', 'privilege', 'gateway']) assert.ok(r.reasons[l]);
    assert.match(r.reasons.gateway, /no agent gateway/);
    const times = r.rows.filter((x) => x.at).map((x) => Date.parse(x.at));
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
  }, { mode: mockMode() });
});

test('mock: the rows show what the mock returned (a delegated token that lost its act claim says act none, and its refusal is a refused row)', async () => {
  const claims = { iss: 'https://mock-as.invalid', iat: 1, exp: 2 };
  const world = { state: { runs: [] }, reset() {}, revokeAgent() {}, run: async () => ({
    ok: true, inbound: { claims: { ...claims, sub: 'user.0042', client_id: 'web-banking' } }, actor: { claims: { ...claims, sub: 'personal-agent' } },
    delegated: { claims: { ...claims, sub: 'agent-as-sub', scope: 'checking:read' } },
    downstream: { delegatedStatus: 401, delegatedWhy: 'no act claim', inboundStatus: 401, inboundWhy: 'no act claim' },
  }) };
  await withLab(async ({ call }) => {
    await call('POST', '/api/run');
    const { record: r } = await rec(call);
    assert.deepEqual(assertRunObservability(r), []);
    assert.match(r.rows.find((x) => x.message.startsWith('RFC 8693')).message, /sub agent-as-sub, act none/);
    assert.deepEqual(r.rows.filter((x) => x.layer === 'resource').map((x) => x.outcome), ['refused', 'refused']);
  }, { mode: mockMode(), world });
});

test('mock: a revoked agent is a refusal at step 2; the person and resource layers say why they have no row', async () => {
  await withLab(async ({ call }) => {
    await call('POST', '/api/revoke');
    assert.equal((await call('POST', '/api/run')).body.ok, false);
    const { record: r } = await rec(call);
    assert.deepEqual(assertRunObservability(r), []);
    assert.deepEqual(r.rows.filter((x) => x.origin === 'simulated').map((x) => `${x.layer}|${x.outcome}`), ['agent|refused']);
    assert.match(r.rows.find((x) => x.origin === 'simulated').message, /invalid_client/);
    assert.equal(r.coverage.person, 'not-logged');
    assert.match(r.reasons.person, /before it signed the person's token/);
    assert.match(r.reasons.resource, /never called/);
    assert.equal(r.summary.refused, 1);
  }, { mode: mockMode() });
});

test('empty before a run; a second run replaces the first; workspaces and Reset keep runs apart', async () => {
  await withLab(async ({ call }) => {
    assert.deepEqual((await call('GET', '/api/run-observability')).body, { record: null, message: 'No run yet in Mock mode in this workspace: run the demo.' });
    await call('POST', '/api/revoke');
    await call('POST', '/api/run');
    await call('POST', '/api/reset', {});
    await call('POST', '/api/run');
    const { record: r } = await rec(call);
    assert.equal(r.summary.refused, 1, 'only the latest run, and Reset cleared the revoke');
    assert.equal(r.rows.filter((x) => x.origin === 'simulated').length, 5);
    assert.equal((await rec(call, 'ws-b')).record, null, 'another workspace has no run');
    await call('POST', '/api/reset', {});
    assert.equal((await rec(call)).record, null);
  }, { mode: mockMode() });
});

test('real (fake PingOne): rows are responses the lab received, never logged, and assertRunObservability passes', async () => {
  await withLab(async ({ call }) => {
    assert.equal((await call('POST', '/api/run')).status, 200);
    const { record: r } = await rec(call);
    assert.deepEqual(assertRunObservability(r), []);
    assert.equal(r.source, 'real');
    assert.ok(!r.rows.some((x) => x.origin === 'logged' || x.origin === 'simulated'));
    assert.deepEqual(r.coverage, { person: 'not-logged', agent: 'response', authorize: 'not-logged', privilege: 'not-logged', gateway: 'not-logged', resource: 'response' });
    assert.match(r.reasons.person, /does not sign anyone in/);
    const resp = r.rows.filter((x) => x.origin === 'response');
    assert.deepEqual(resp.map((x) => `${x.layer}|${x.outcome}`), ['agent|allowed', 'agent|allowed', 'resource|allowed', 'resource|refused']);
    for (const x of resp) assert.match(x.message, /not a log line/);
    assert.match(resp[1].message, /The delegated token names sub \S+ and act \S+/);
    assert.ok(!JSON.stringify(r).includes('deeper-agent'), 'only the top actor is shown, never the nested act chain');
    assert.deepEqual(r.summary, { allowed: 3, refused: 1, blocked: 0, info: 0, unverified: 0 });
  });
});

test('real: PingOne refusing the agent (invalid_client) is a refused response row, the run is a 502 JSON, and nothing older is shown', async () => {
  await withLab(async ({ call }) => {
    const bad = await call('POST', '/api/run');
    assert.equal(bad.status, 502);
    assert.equal(bad.body.error, 'real_unavailable');
    const { record: r } = await rec(call);
    assert.deepEqual(assertRunObservability(r), []);
    assert.deepEqual(r.rows.filter((x) => x.origin === 'response').map((x) => `${x.layer}|${x.outcome}`), ['agent|refused']);
    assert.match(r.rows.find((x) => x.origin === 'response').message, /HTTP 401: invalid_client/);
    assert.equal(r.coverage.resource, 'not-logged');
  }, { real: realOf({ actor: [401, { error: 'invalid_client', error_description: 'secret-fake rejected for worker-fake' }] }) });
});

test('real: a downstream 500 is information, never counted as passed; an attempt that began no step says so instead of showing an older run', async () => {
  await withLab(async ({ call }) => {
    await call('POST', '/api/run');
    const { record: r } = await rec(call);
    assert.deepEqual(assertRunObservability(r), []);
    assert.deepEqual(r.summary, { allowed: 2, refused: 0, blocked: 0, info: 2, unverified: 0 });
  }, { real: realOf({ delegated: [500, {}], own: [503, {}] }) });
  let n = 0;
  const flaky = (opts) => (n++ === 0 ? realOf()(opts) : Promise.reject(new Error('Real mode needs OBO_LAB_AUDIENCE and OBO_LAB_DOWNSTREAM in ~/Development/.env')));
  await withLab(async ({ call }) => {
    await call('POST', '/api/run');
    assert.ok((await rec(call)).record);
    assert.equal((await call('POST', '/api/run')).status, 502);
    const after = await rec(call);
    assert.equal(after.record, null);
    assert.match(after.message, /began no step/);
  }, { real: flaky });
});

test('the record follows the mode: a Mock run never comes back as a Real reply, both switch directions, GET /api/info unchanged', async () => {
  await withLab(async ({ call }) => {
    const info = (await call('GET', '/api/info')).body;
    assert.equal(info.source, 'real');
    assert.equal((await call('POST', '/api/mode', { source: 'mock' })).status, 200);
    await call('POST', '/api/run');
    assert.equal((await rec(call)).record.source, 'mock');
    assert.equal((await call('POST', '/api/mode', { source: 'real' })).status, 200);
    assert.deepEqual(await rec(call), { record: null, message: 'No run yet in Real mode in this workspace: run the demo.' }, 'the Mock run is not offered as a Real reply');
    await call('POST', '/api/run');
    assert.equal((await rec(call)).record.source, 'real');
    assert.equal((await call('POST', '/api/mode', { source: 'mock' })).status, 200);
    assert.equal((await rec(call)).record.source, 'mock');
    assert.equal((await call('POST', '/api/mode', { source: 'real' })).status, 200);
    const { epoch: _a, ...now } = (await call('GET', '/api/info')).body; // epoch counts the Mock runs; the rest is what it was
    const { epoch: _b, ...before } = info;
    assert.deepEqual(now, before, 'GET /api/info: source, realAvailable, realReason, version and banner are unchanged');
  });
});

test('the lab server writes one timestamped stdout line per decision: step, actor, result, run and mode; no token, no refusal word', async () => {
  await withLab(async ({ call, lines }) => {
    await call('POST', '/api/run');
    await call('POST', '/api/revoke');
    await call('POST', '/api/run');
    assert.equal(lines.length, 6);
    for (const l of lines) assert.match(l, /^\d{4}-\d\d-\d\dT[\d:.]+Z obo-lab decision step=[\w.:/@-]+ actor=[\w.:/@-]+ result=(passed|stopped|unclear) run=obo-\d+ mode=mock$/);
    assert.deepEqual(lines.map((l) => l.split(' ').slice(3, 6).join(' ')), [
      'step=person actor=user.0042 result=passed', 'step=agent-identity actor=personal-agent result=passed', 'step=exchange actor=personal-agent result=passed',
      'step=downstream-delegated actor=personal-agent result=passed', 'step=downstream-own actor=user.0042 result=stopped', 'step=agent-identity actor=personal-agent result=stopped',
    ]);
    assert.ok(lines.every((l) => !/eyJ|Bearer/i.test(l)));
    // The words a shared matcher reads as a decision are never in a line, and no product's matcher reads one.
    for (const l of lines) assert.ok(!/refused|denied|rejected|forbidden|failed|invalid|expired|mismatch|token|audience|scope|served/i.test(l), l);
    const products = [...new Set(layerMatchers.map((m) => m.product))];
    for (const l of lines) for (const product of products) assert.equal(classify({ product, message: l, at: Date.parse(l.split(' ')[0]), atExact: l.split(' ')[0] }), null, `${product}: ${l}`);
  }, { mode: mockMode() });
});

test('hostile and long names stay inert: a newline or key=value in a name cannot forge a second line, and rows keep the text', () => {
  const lines = [];
  const log = createRunLog({ write: (l) => lines.push(l) }).begin('w', 'mock');
  const nasty = `${'long-name-'.repeat(12)}\nFAKE decision step=x actor=admin result=passed run=other mode=real <img src=x onerror=alert(1)>`;
  log.record({ layer: 'agent', step: 'exchange', actor: nasty, outcome: 'allowed', product: 'lab mock exchanger', message: `RFC 8693 exchange: sub ${nasty.slice(0, 60)}`, detail: { sub: nasty } });
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes('\n') && !lines[0].includes(' step=x') && lines[0].length < 260);
  assert.match(lines[0], / actor=[\w.:/@-]{1,64} result=passed run=obo-\d+ mode=mock$/);
});

test('hostile and long names: the record built from them passes assertRunObservability and is not marked truncated', async () => {
  const log = createRunLog({ write: () => {} }).begin('w', 'mock');
  const LONG = 'a-very-long-agent-name-'.repeat(3);
  log.record({ layer: 'agent', step: 'exchange', actor: LONG, outcome: 'allowed', product: 'lab mock exchanger', message: `RFC 8693 exchange: one delegated token minted, sub user.0042, act ${LONG} <img src=x onerror=alert(1)>`, detail: { act: LONG } });
  const r = await buildRunRecord({ run: log.run });
  assert.deepEqual(assertRunObservability(r), []);
  assert.equal(r.truncated, false);
  assert.match(r.rows[0].message, /<img src=x onerror=alert\(1\)>/, 'kept as inert text; the panel renders it as text');
});

test('the run log keeps the latest attempt per mode and bounds the number of workspaces', () => {
  const log = createRunLog({ write: () => {} });
  const a = log.begin('w', 'mock'); a.record({ layer: 'agent', step: 'exchange', outcome: 'allowed', message: 'm' });
  const b = log.begin('w', 'mock');
  assert.equal(log.latest('w', 'mock'), b.run);
  assert.equal(log.latest('w', 'real'), null);
  for (let i = 0; i < 40; i += 1) log.begin(`ws-${i}`, 'real');
  assert.equal(log.latest('w', 'mock'), null, 'the oldest workspace was evicted');
  assert.ok(log.latest('ws-39', 'real'));
});

test('a failure building the record is logged (code and message only) and answered as JSON { error, message }', async () => {
  const err = mock.method(console, 'error', () => {});
  try {
    const runLog = createRunLog({ write: () => {} });
    const bad = runLog.begin('default', 'mock');
    bad.record({ layer: 'agent', step: 'exchange', outcome: 'allowed', product: 'p', message: 'm' });
    bad.run.events[0].at = 'not-a-time';
    await withLab(async ({ call }) => {
      const r = await call('GET', '/api/run-observability');
      assert.equal(r.status, 400);
      assert.equal(r.body.error, 'bad_window');
      assert.ok(r.body.message);
      bad.run.events[0].at = new Date().toISOString();
      Object.defineProperty(bad.run.events[0], 'detail', { get() { throw new Error('boom'); } });
      const r2 = await call('GET', '/api/run-observability');
      assert.equal(r2.status, 500);
      assert.deepEqual(r2.body, { error: 'internal_error', message: 'The run observability record could not be built.' });
      assert.equal(err.mock.callCount(), 2);
      assert.match(err.mock.calls[0].arguments[0], /run-observability failed: bad_window/);
    }, { mode: mockMode(), runLog });
  } finally { err.mock.restore(); }
});

test('this lab reads no logs: no server file names a reader, a socket or a run-observability setting, comments included', () => {
  const dir = new URL('../src/', import.meta.url);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js') && x !== 'runObservability.js')) { // the vendored core is checked by the pin test
    const src = fs.readFileSync(new URL(f, dir), 'utf8');
    assert.ok(!/runObservabilityReaders|ElasticsearchReader|DockerLogReader|readersFromEnv|RUN_OBS_|docker\.sock/.test(src), `${f} names a reader or a setting`);
  }
});
