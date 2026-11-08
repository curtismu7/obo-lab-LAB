import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

const call = async (app, method, path, body, extraHeaders = {}) => {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}`, ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  } finally { await new Promise((r) => server.close(r)); }
};
import { createMode } from '../src/mode.js';
const mk = () => createApp({ mode: createMode({ forceMock: true }) });

test('health returns demo-health/1 ready', async () => {
  const r = await call(mk(), 'GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.schema, 'demo-health/1');
  assert.equal(r.json.state, 'ready');
});

test('catalog describes the persona, agent, exchanger and downstream', async () => {
  const r = await call(mk(), 'GET', '/api/catalog');
  assert.equal(r.status, 200);
  assert.equal(r.json.persona.sub, 'user.0042');
  assert.equal(r.json.agent.clientId, 'personal-agent');
  assert.equal(r.json.workspaceId, 'default');
  assert.equal(r.json.steps, 7);
});

test('run: seven steps behave as written in mock', async () => {
  const r = await call(mk(), 'POST', '/api/run');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.source, 'mock');
  assert.equal(r.json.downstream.delegatedStatus, 200);
  assert.equal(r.json.downstream.inboundStatus, 401);
  assert.equal(r.json.delta.actAdded, true);
  assert.equal(r.json.leak, false);
});

test('decode returns claims for a mock token and refuses junk', async () => {
  const app = mk();
  const run = (await call(app, 'POST', '/api/run')).json;
  const ok = await call(app, 'POST', '/api/decode', { token: run.delegated.token });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.claims.act.sub, 'personal-agent');
  assert.equal((await call(app, 'POST', '/api/decode', { token: 'junk' })).status, 400);
});

test('revoke then run: step 2 refused', async () => {
  const app = mk();
  await call(app, 'POST', '/api/revoke');
  const r = await call(app, 'POST', '/api/run');
  assert.equal(r.json.ok, false);
  assert.equal(r.json.failedStep, 2);
});

test('rule 19: default mock, real 409 with the how-to, switch back works, body shape enforced', async () => {
  const app = mk();
  const info = (await call(app, 'GET', '/api/info')).json;
  assert.equal(info.source, 'mock');
  assert.equal(info.realAvailable, false);
  assert.match(info.realReason, /PINGONE/);
  const up = await call(app, 'POST', '/api/mode', { source: 'real' });
  assert.equal(up.status, 409);
  const back = await call(app, 'POST', '/api/mode', { source: 'mock' });
  assert.equal(back.status, 200);
  assert.equal((await call(app, 'POST', '/api/mode', { source: 'live' })).status, 400);
  assert.equal((await call(app, 'POST', '/api/mode', { source: 'real', x: 1 })).status, 400);
});

test('cross-origin write is refused', async () => {
  const r = await call(mk(), 'POST', '/api/run', {}, { origin: 'http://evil.invalid' });
  assert.equal(r.status, 403);
});

test('GET /api/shelf answers the shelf URL (null when unconfigured)', async () => {
  const r = await call(createApp({ mode: createMode({ forceMock: true }), env: {} }), 'GET', '/api/shelf');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json), ['shelfUrl']);
  assert.equal(r.json.shelfUrl, null);
});

test('GET /api/shelf returns SHELF_URL (slash trimmed) with no web build; POST is not 200', async () => {
  const app = () => createApp({ mode: createMode({ forceMock: true }), env: { SHELF_URL: 'https://shelf.example:8443/', HOME: '/nonexistent' } });
  const r = await call(app(), 'GET', '/api/shelf');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { shelfUrl: 'https://shelf.example:8443' });
  assert.notEqual((await call(app(), 'POST', '/api/shelf', {})).status, 200);
});
