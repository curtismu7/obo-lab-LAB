// The run: 7 steps down the left, the diff table when it lands, revoke + run again to show the refusal.
import RunObs from "../components/RunObs.jsx";

function Delta({ run }) {
  const d = run.delta ?? {};
  const rows = [
    ["sub", "kept — the person, not the agent", d.subSame],
    ["act", "added — names the agent", d.actAdded],
    ["aud", "narrowed to the one downstream", d.audSame],
    ["scope", "narrowed to what the task needs", d.scopeNarrowed],
  ];
  return (
    <table className="bakeoff" data-testid="delta">
      <thead><tr><th scope="col">Claim</th><th scope="col">What changed</th><th scope="col">As written?</th></tr></thead>
      <tbody>
        {rows.map(([k, what, ok]) => (
          <tr key={k}><th scope="row">{k}</th><td>{what}</td><td data-state={ok ? "ok" : "bad"}>{ok ? "yes" : "NO"}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

export default function RunTab({ catalog, run, busy, error, onRun, onRevoke, source, attempt }) {
  return (
    <section aria-label="Run the delegation" className="stack">
      <div className="head__tools">
        <button type="button" className="btn primary" onClick={onRun} disabled={busy} data-testid="obo-run">Run the 7-step delegation</button>
        <button type="button" className="btn" onClick={onRevoke} data-testid="obo-revoke">Revoke the agent's client</button>
        <span className="muted small">source: {source ?? "…"}</span>
      </div>
      {error ? <p className="alert" role="alert">{error}</p> : null}
      {run && !run.ok ? (
        <p className="alert" role="alert" data-testid="run-refused">Run refused at step {run.failedStep}: {run.error}</p>
      ) : null}
      {run?.ok ? (
        <>
          <ol className="steps" data-testid="steps">
            <li>Your token: {run.inbound?.claims?.sub ?? "—"} · scope {run.inbound?.claims?.scope ?? "—"}</li>
            <li>Agent identity: {run.actor?.claims?.sub ?? "—"} (client credentials)</li>
            <li>Exchange: subject = your token, actor = the agent token (RFC 8693)</li>
            <li>Delegated token minted{run.delegated?.claims?.act ? ` — act: ${run.delegated.claims.act.sub}` : ""}</li>
            <li>Downstream on the delegated token: <strong data-testid="downstream-delegated">{run.downstream?.delegatedStatus ?? "—"}</strong></li>
            <li>Downstream on your own token: <strong data-testid="downstream-inbound">{run.downstream?.inboundStatus ?? "—"}</strong> ({run.downstream?.inboundWhy ?? "refused: no act claim"})</li>
            <li>Leak scan: {run.leak ? "TOKEN FOUND" : "no token in anything a model would see"}</li>
          </ol>
          <Delta run={run} />
          {run.tokensRedacted ? <p className="muted small">Real mode: token bodies stay on the server; only claims and sha256/8 hashes are shown.</p> : null}
        </>
      ) : <p className="muted" role="status">Run once to see the whole chain, then revoke the agent and run again for the refusal.</p>}
      <RunObs attempt={attempt} mode={source} />
      <p className="muted small">{catalog?.downstream ? `Downstream accepts aud ${catalog.downstream.aud} with scope "${catalog.downstream.acceptedScope}" and requires act.` : ""}</p>
    </section>
  );
}
