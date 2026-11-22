# obo-lab — OBO Delegation Inspector LAB (catalog OBO provisional, Demo tier)

Seven steps of on-behalf-of delegation: the person's token and the agent's client-credentials token go into an RFC 8693 exchange; one delegated token comes out with sub kept, act added, aud and scope narrowed. The downstream accepts the delegated token and refuses the person's own. Revoking the agent's client fails the next run at step 2.

Follow the rulebook at `~/Development/STANDALONE-RULES.md`.

## Real and Mock (rule 19)

- **Mock** (default when Real is not configured): in-process mock issuer (HS256 fixture key), mock exchanger and mock downstream. Every token is mock and labelled. Fully offline.
- **Real**: the run executes against YOUR PingOne tenant — client credentials for the agent, then the token exchange, then the real downstream. Credentials come from the shared `~/Development/.env` (owner-set: `PINGONE_ENVIRONMENT_ID`, Worker app id + secret, `OBO_LAB_PERSON_TOKEN` from the owner's own sign-in, `OBO_LAB_AUDIENCE`, `OBO_LAB_SCOPE`, `OBO_LAB_DOWNSTREAM`). Agents never sign a person in. The Worker secret is write-only: the page shows a sha256/8 hash, never the value. Token bodies stay server-side in Real mode (claims + hash only).
- The header toggle POSTs `/api/mode {source}`; default source is Real if configured else Mock; Real unconfigured answers 409 with the how-to.

## Non-negotiables

- Loopback bind only (`OBOL_BIND` opt-in; Docker publishes `127.0.0.1:` only), Host check, same-origin writes.
- Mock mode: zero outbound (netguard, self-test at boot). Real mode: exactly the configured PingOne + downstream calls.
- No identifiers from other projects. The mock world uses `.invalid` hosts only.
- The delegated token's sub is ALWAYS the person; a test and a mutation pin this (swapping sub to the agent fails the suite).
- Node 26 only.

## Module map

- `server/src/obo.js` — the mock world: personas, the exchange, the downstream rules, revocation.
- `server/src/jwt.js` — HS256 fixture signer/verifier (aud, act, scope checks).
- `server/src/realPingOne.js` — the Real-mode tenant client (owner-configured).
- `server/src/app.js` — `/api/run`, `/api/decode`, `/api/revoke`, `/api/mode`, `/api/catalog`.
- `server/src/steps.js` + `talkTrack.js` — the step data; the page and the generated talk track read the same source.
- `server/src/runObs.js` + vendored `server/src/runObservability.js` — rule 27: the decisions of a run (Mock simulated, Real `response`), the one stdout line each leaves, the record. Reads no logs: core only, no readers file, no `RUN_OBS_*`, no Docker socket. `web/src/run-observability/` and `scripts/run-observability-checkPin.mjs` are vendored: never hand-edit, change the canonical `shared/run-observability/` and re-vendor.
- `web/src/tabs/RunTab.jsx` — the one screen: run, steps, diff table, revoke.

## Verify before claiming done

```bash
npm ci && npm test && npm run doctor && npm run mutation-check && npm run build -w web
```

Then drive the real page (port 7560): run, read the diff table, revoke, run again for the step-2 refusal, flip Mock/Real.
