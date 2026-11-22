// Rule 27 on this lab's page: the shared panel under the run. Mock rows are simulated; Real rows are replies the lab received
// (PingOne's token endpoint, the downstream). This lab reads no product logs, so no row is ever tagged logged.
import React, { useEffect, useState } from "react";
import RunObservability from "../run-observability/RunObservability.jsx";
import { getRunObservability } from "../lib/api.js";

export const RUN_OBS_STREAMS = [
  { product: "This lab (its decision lines)", lives: "container stdout: one `obo-lab decision` line per decision (step, actor, result, run, mode), never a token", streams: "a collector that tails the container can ship them to demo-logs-obo-lab and on to a SIEM; this lab does not set that up" },
  { product: "PingOne (token endpoint)", lives: "the PingOne audit activity API (SaaS); this lab does not read it", streams: "not shipped by this lab" },
  { product: "The downstream API", lives: "wherever the owner's downstream writes its own logs; this lab does not read them", streams: "not shipped by this lab" },
];

// attempt: how many times the page has run in this mode (0 = none yet, so the empty state). Only a run attempt reads the record.
export default function RunObs({ attempt, mode }) {
  // null = nothing asked yet; { pending } = a fetch is in flight (the previous record stays on screen); { record, message } = answered.
  const [state, setState] = useState(null);
  useEffect(() => {
    let live = true;
    if (!attempt) { setState(null); return undefined; }
    setState((s) => ({ ...(s || {}), pending: true }));
    getRunObservability().then(
      (b) => { if (live) setState(b && "record" in b ? { record: b.record, message: b.message } : { record: b }); },
      () => { if (live) setState({ record: { error: "unreachable", message: "Could not reach the server." } }); },
    );
    return () => { live = false; };
  }, [attempt, mode]);
  const note = (testId, text) => <section className="card ro" data-testid={testId}><h2>What each layer logged for this run</h2><p className="ro-muted">{text}</p></section>;
  if (attempt && (!state || (state.pending && !state.record))) return note("ro-loading", "Collecting this run's record...");
  if (attempt && state && !state.record && state.message) return note("ro-none", state.message);
  return (
    <div className="card">
      <RunObservability record={attempt && state ? state.record : null} source={mode} streams={RUN_OBS_STREAMS} />
      <p className="muted small" data-testid="ro-lane-note">Agent is the token endpoint that issued and exchanged the tokens; Resource server is the downstream API the lab calls with each token. This lab has no Authorize, Privilege or gateway step.</p>
    </div>
  );
}
