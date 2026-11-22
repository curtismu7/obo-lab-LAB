# OBO Delegation Inspector LAB

Tier: Demo
Repo: https://github.com/curtismu7/obo-lab-LAB
Catalog: D111

An AI agent acts for a signed-in person, but it must never hold that person's token, and every downstream call has to say who the person is and which agent acted. Run the seven steps: sign-in token → agent identity (client credentials) → RFC 8693 exchange → delegated token → downstream accepts it → downstream refuses the person's own token → no token reached the model.

## What is simulated

**Everything here is SIMULATED.** In Mock mode: in-process mock issuer (HS256 fixture key), mock exchanger and mock downstream; every token is mock and labelled. **Real mode: nothing is simulated** — it runs against your own PingOne tenant, but token bodies stay on the server (claims and sha256/8 hashes only) and the Worker secret is never displayed.

**Everything here is SIMULATED in Mock mode** — the banner on every page says so.

## Run from a clone

```bash
npm ci
npm test          # server (node --test) + web (vitest) + repo checks
npm run doctor    # preflight: ports, hosts, netguard, the mock run behaves as written, revocation works
npm start         # http://localhost:7560
./scripts/run.sh  # same, checks the port first
```

Endpoints: `GET /api/health`, `GET /api/catalog`, `POST /api/run`, `POST /api/decode`, `POST /api/revoke`, `POST /api/reset`, `POST /api/mode`, `GET /api/info`, `GET /api/run-observability`.

## What each layer logged for the run (rule 27)

Under the run the page shows the shared run-observability panel: the decisions of the latest run in time order over six layers, each row tagged with where it came from. **Mock:** `simulated`, computed by the lab's own mock on this run. **Real:** `response`, an answer this lab received from PingOne's token endpoint (client credentials, the RFC 8693 exchange) or from the downstream API, never `logged`. This lab reads no product logs (no Elasticsearch, no Docker socket, no `RUN_OBS_*` setting), so nothing is ever tagged `logged`. Time on a row is when the lab recorded it (Mock rows are computed in one call, so they share a millisecond or two).

| Layer | What it shows here |
|---|---|
| Person | Mock: the mock issuer signed the person's token (`sub`). Real: `not-logged`, because the lab signs nobody in (the person's token is the owner's own) and PingOne sign-in is in the PingOne audit activity API, which the panel does not read yet |
| Agent (OBO) | the agent's identity (client credentials) and the exchange: which `sub` and which actor (`act.sub`, the top actor only) the delegated token names; a revoked agent is a refused row (`invalid_client`) |
| Authorize | `not-logged`: this lab does not call PingOne Authorize |
| Privilege | `not-logged`: this lab has no Privilege policy, AI Guard or approval step |
| Agent gateway | `not-logged`: this lab calls the downstream directly |
| Resource server | the downstream API's answer to the delegated token (accepted) and to the person's own token (refused, no `act`; if the downstream accepts it the row stays allowed and says the lab expected a refusal). In Real a 2xx is allowed only when its body reads as JSON without an error and was not redirected; a 200 with an error body is refused; an unreadable body, a redirect, a 5xx or no reply is information |

Each decision also leaves one stdout line from the lab's own server: `<iso> obo-lab decision step=<step> actor=<who> result=passed|stopped|unclear run=<id> mode=<mock|real>`, never a token. Where the logs live and where they can stream: the lab's decision lines are in the container stdout and a collector that tails the container can ship them to `demo-logs-obo-lab` and on to a SIEM (this lab does not set that up); PingOne's own events are in the PingOne audit activity API and the downstream's in whatever the owner's downstream writes (neither is read here). Not logged today: Authorize, Privilege, the agent gateway, PingOne sign-in, and any line the products themselves wrote. The panel files are vendored byte for byte from the shared `shared/run-observability/` (sha256 pin; `scripts/run-observability.pin.test.mjs`): change them there, never here.

## Settings file

Real mode reads the ONE shared settings file `~/Development/.env` (never a per-app file):
`PINGONE_ENVIRONMENT_ID`, Worker app client id + secret, `OBO_LAB_PERSON_TOKEN` (a real person access token from your own sign-in — agents never sign a person in), `OBO_LAB_AUDIENCE`, `OBO_LAB_SCOPE`, `OBO_LAB_DOWNSTREAM`, optional `OBO_LAB_AGENT_SCOPE`. See `.env.example`.

## Ports, and what to do if the port is taken

Default 7560, allowed range 7560-7569.

```bash
lsof -iTCP:7560 -sTCP:LISTEN -n -P
PORT=<other port> npm start
```

## Mock and Real modes (rule 19)

A visible Mock / Real toggle sits in the header of every page; pressed = current mode, switching needs no restart. Real unconfigured: the Real button is disabled with a how-to tooltip and `POST /api/mode {source:"real"}` answers 409. Default source is Real if configured, else Mock. Switching reloads all data.

## Health, doctor and reset

## Postman collection

`postman/obo-lab.postman_collection.json` runs the OBO story without the UI: the run endpoint (inbound token, actor, delegated token, downstream call, delta and leak analysis in one answer), the decode negative, and revoke. It needs no environment — the issuer, exchanger and downstream are in-process labelled mocks and the lab has no live mode.

```
node ../../shared/postman/generator.mjs --spec postman/spec.json            # regenerate (never hand-edit the output)
npx newman run postman/obo-lab.postman_collection.json
```

`GET /api/health` returns `demo-health/1`. `npm run doctor` runs the same checks plus the mock run and a revocation proof. `npm run reset` clears runs and revocation.

## Docker

```bash
HOST_PORT=7560 docker compose up --build -d
```

OrbStack only. Read-only container, cap-dropped, loopback publish only.

## Tests

```bash
npm test                    # server + web + repo checks
npm run content-pack       # rebuild content-pack.json from the step data
npm run mutation-check      # 7 mutants; every one must be killed
```

The suite pins: sub stays the person (impersonation mutant is killed), act is added, scope narrows, the downstream refuses a token without act, signature verification, revocation, and the toggle (409 + switch directions). `docs/architecture.md`, `docs/safety.md`, `docs/references.md` and `docs/talk-track.md` carry the details; `docs/shelf-entry.json` is the shelf registration (catalog O1, provisional).

## Troubleshooting

- **Port taken.** `PORT=<other port in 7560-7569> npm start`.
- **Real button disabled.** Set the `PINGONE_*` + `OBO_LAB_*` variables in `~/Development/.env` and restart.
- **Real run answers 502.** The tenant said no; the message carries the PingOne error verbatim (check the Worker app's grants and the exchange audience).

## Ownership

Owned by the shelf-consolidation session (owner said go 2026-11-03). Ports 7560-7569. Catalog id OBO is provisional until the owner assigns a real one.
