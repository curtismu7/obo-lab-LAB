// One Express app. /api = the OBO lab: the 7-step delegation run, the diff table facts, the downstream
// accept/refuse, the leak scan, agent revocation. Loopback Host check and same-origin writes everywhere.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { hostCheck, sameOriginWrites } from './safety.js';
import { createHealth, DEMO } from './health.js';
import { createWorld, personaOf, agentOf, exchangerOf, downstreamOf, jwtDecode } from './obo.js';
import { createMode, MODES } from './mode.js';
import { DIAGRAM_NAMES, loadDiagram } from './diagramData.js';
import { TALK_INTRO, TALK_OUTRO, talkLines } from './talkTrack.js';
import { realRun } from './realPingOne.js';
import { workspaceId } from './workspace.js';
import { RunObsError } from './runObservability.js';
import { buildRunRecord, createRunLog, guarded, mockEvents, realEvent } from './runObs.js';
import { shelfInfo } from './shelfLink.js';

const WEB_DIST = process.env.WEB_DIST || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
const bad = (res, message, status = 400) => res.status(status).json({ error: status === 404 ? 'not_found' : 'bad_request', message });
export const BANNER = (source) => source === 'real'
  ? 'REAL mode: every step runs against YOUR PingOne tenant with the owner\'s Worker credentials. Tokens are shown because you own the run; the model never receives one. The Worker secret is a hash only.'
  : 'MOCK mode. SIMULATED: in-process mock issuer, mock exchanger and mock downstream. No tenant, no outbound network. Tokens are mock and labelled.';

export function createApp({ health = createHealth(), mode = createMode(), world = createWorld(), env = process.env, runLog = createRunLog(), real = realRun } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(hostCheck);
  app.use(sameOriginWrites);
  app.use((_req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });

  const api = express.Router();
  api.use(express.json({ limit: '8kb' }));
  api.use('/health', health.router);
  api.get('/shelf', (_req, res) => { res.set('Cache-Control', 'no-store'); res.json(shelfInfo(env)); });

  api.get('/info', (_req, res) => { res.set('Cache-Control', 'no-store'); res.json({ ...mode.info(), version: DEMO.version || null, banner: BANNER(mode.source()), epoch: world.state.runs.length }); });
  // Rule 19: POST /api/mode with exactly {"source": "mock"|"real"}. Real unconfigured -> 409 with the how-to.
  api.post('/mode', (req, res) => {
    const b = req.body;
    if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).length !== 1 || !MODES.includes(b.source)) return bad(res, 'body must be exactly {"source": "mock" or "real"}');
    if (b.source === 'real' && mode.info().realAvailable !== true) return res.status(409).json({ error: 'conflict', message: mode.info().realReason });
    mode.set(b.source);
    return res.json({ ...mode.info(), version: DEMO.version || null, banner: BANNER(mode.source()) });
  });

  api.get('/diagram', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const name = DIAGRAM_NAMES.includes(req.query.name) ? req.query.name : DIAGRAM_NAMES[0];
    return res.json(loadDiagram(name));
  });
  api.get('/talk', (req, res) => res.json({ talkTrack: [{ id: 'intro', title: 'Say first', say: TALK_INTRO }, ...talkLines(), { id: 'outro', title: 'Close', say: TALK_OUTRO }] }));
  api.get('/catalog', (_req, res) => res.json({
    banner: BANNER(mode.source()), source: mode.source(),
    persona: personaOf(), agent: agentOf(), exchanger: exchangerOf(),
    downstream: downstreamOf(),
    workspaceId: 'default',
    steps: 7,
  }));

  // The run: 7 steps, mock engine or your real tenant. Every decision it makes is logged once (rule 27) and kept for /api/run-observability.
  api.post('/run', async (req, res) => {
    const source = mode.source();
    const ws = workspaceId(req);
    const log = runLog.begin(ws, source);
    let status = 200; let body;
    try {
      let run;
      if (source === 'real') run = await real({ onAnswer: (a) => guarded(() => log.record(realEvent(a))) });
      else {
        run = await world.run();
        let events = [];
        guarded(() => { events = mockEvents(run, agentOf().clientId); });
        for (const e of events) guarded(() => log.record(e));
      }
      if (run) run.workspaceId = ws;
      body = { banner: BANNER(source), source, ...run };
    } catch (e) {
      status = 502; body = { error: 'real_unavailable', message: e.message };
    }
    log.finish(); // before the answer is sent, so a reader that comes right after it sees this run, not "in progress"
    return res.status(status).json(body);
  });

  // Rule 27: what each layer logged for this workspace's latest run in the CURRENT mode. Mock rows are simulated, Real rows are replies
  // the lab received; this lab reads no product logs, so nothing is ever `logged`.
  api.get('/run-observability', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const source = mode.source();
    try {
      const { run, open } = runLog.latest(workspaceId(req), source);
      if (open) return res.json({ record: null, message: 'A run is in progress in this workspace: read the record again when it ends.' });
      if (!run) return res.json({ record: null, message: `No run yet in ${source === 'real' ? 'Real' : 'Mock'} mode in this workspace: run the demo.` });
      const record = await buildRunRecord({ run });
      return res.json(record ? { record } : { record: null, message: 'The last attempt began no step: nothing answered (the error is under Run). Nothing older is shown instead.' });
    } catch (e) {
      console.error(`[obo-lab] run-observability failed: ${String(e?.code || e?.name || 'Error').slice(0, 40)}: ${String(e?.message).replace(/[\r\n]+/g, ' ').slice(0, 200)}`);
      return e instanceof RunObsError ? res.status(e.status).json({ error: e.code, message: e.message }) : res.status(500).json({ error: 'internal_error', message: 'The run observability record could not be built.' });
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
  api.post('/reset', (req, res) => { world.reset(); runLog.reset(workspaceId(req)); return res.json({ ok: true }); });

  if (fs.existsSync(WEB_DIST)) app.use(express.static(WEB_DIST));
  app.get('/favicon.ico', (_req, res) => { res.set('Content-Type', 'image/svg+xml'); res.set('Cache-Control', 'public, max-age=86400'); res.send('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="%23186a8e"/><path d="M3 8h7M7 4l4 4-4 4" stroke="white" stroke-width="2" fill="none"/></svg>'); });
  app.use('/api', api);
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  return app;
}
