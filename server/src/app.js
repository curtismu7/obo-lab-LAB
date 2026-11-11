// One Express app. /api = the OBO lab: the 7-step delegation run, the diff table facts, the downstream
// accept/refuse, the leak scan, agent revocation. Loopback Host check and same-origin writes everywhere.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { hostCheck, sameOriginWrites } from './safety.js';
import { createHealth } from './health.js';
import { createWorld, personaOf, agentOf, exchangerOf, downstreamOf, jwtDecode } from './obo.js';
import { createMode, MODES } from './mode.js';
import { DIAGRAM_NAMES, loadDiagram } from './diagramData.js';
import { realRun } from './realPingOne.js';
import { workspaceId } from './workspace.js';
import { shelfInfo } from './shelfLink.js';

const WEB_DIST = process.env.WEB_DIST || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
const bad = (res, message, status = 400) => res.status(status).json({ error: status === 404 ? 'not_found' : 'bad_request', message });
export const BANNER = (source) => source === 'real'
  ? 'REAL mode: every step runs against YOUR PingOne tenant with the owner\'s Worker credentials. Tokens are shown because you own the run; the model never receives one. The Worker secret is a hash only.'
  : 'MOCK mode. SIMULATED: in-process mock issuer, mock exchanger and mock downstream. No tenant, no outbound network. Tokens are mock and labelled.';

export function createApp({ health = createHealth(), mode = createMode(), world = createWorld(), env = process.env } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(hostCheck);
  app.use(sameOriginWrites);
  app.use((_req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });

  const api = express.Router();
  api.use(express.json({ limit: '8kb' }));
  api.use('/health', health.router);
  api.get('/shelf', (_req, res) => { res.set('Cache-Control', 'no-store'); res.json(shelfInfo(env)); });

  api.get('/info', (_req, res) => { res.set('Cache-Control', 'no-store'); res.json({ ...mode.info(), version: health.DEMO.version || null, banner: BANNER(mode.source()), epoch: world.state.runs.length }); });
  // Rule 19: POST /api/mode with exactly {"source": "mock"|"real"}. Real unconfigured -> 409 with the how-to.
  api.post('/mode', (req, res) => {
    const b = req.body;
    if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).length !== 1 || !MODES.includes(b.source)) return bad(res, 'body must be exactly {"source": "mock" or "real"}');
    if (b.source === 'real' && mode.info().realAvailable !== true) return res.status(409).json({ error: 'conflict', message: mode.info().realReason });
    mode.set(b.source);
    return res.json({ ...mode.info(), banner: BANNER(mode.source()) });
  });

  api.get('/diagram', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const name = DIAGRAM_NAMES.includes(req.query.name) ? req.query.name : DIAGRAM_NAMES[0];
    return res.json(loadDiagram(name));
  });
  api.get('/catalog', (_req, res) => res.json({
    banner: BANNER(mode.source()), source: mode.source(),
    persona: personaOf(), agent: agentOf(), exchanger: exchangerOf(),
    downstream: downstreamOf(),
    workspaceId: 'default',
    steps: 7,
  }));

  // The run: 7 steps, mock engine or your real tenant.
  api.post('/run', async (req, res) => {
    try {
      const run = mode.source() === 'real' ? await realRun() : await world.run();
      if (run) run.workspaceId = workspaceId(req);
      return res.json({ banner: BANNER(mode.source()), source: mode.source(), ...run });
    } catch (e) {
      return res.status(502).json({ error: 'real_unavailable', message: e.message });
    }
  });

  // Decode any token the page holds (mock tokens decode; real ones too - they are the caller's own).
  api.post('/decode', (req, res) => {
    const t = String(req.body?.token ?? '');
    const claims = jwtDecode(t);
    if (!claims) return bad(res, 'not a decodable JWT');
    return res.json({ claims });
  });

  // Revocation: revoke the agent's client, then the next mock run fails at step 2 (invalid_client).
  api.post('/revoke', (_req, res) => {
    world.revokeAgent();
    return res.json({ ok: true, note: 'agent client revoked: the next run refuses step 2 with invalid_client' });
  });
  api.post('/reset', (_req, res) => { world.reset(); return res.json({ ok: true }); });

  if (fs.existsSync(WEB_DIST)) app.use(express.static(WEB_DIST));
  app.get('/favicon.ico', (_req, res) => { res.set('Content-Type', 'image/svg+xml'); res.set('Cache-Control', 'public, max-age=86400'); res.send('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="%23186a8e"/><path d="M3 8h7M7 4l4 4-4 4" stroke="white" stroke-width="2" fill="none"/></svg>'); });
  app.use('/api', api);
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  return app;
}
