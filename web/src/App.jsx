import React, { useCallback, useEffect, useState } from "react";
import { getCatalog, getInfo, requestModeSwitch, resetServer, runObo, revokeAgent } from "./lib/api.js";
import ShelfLink from "./components/ShelfLink.jsx";
// Opened from Customer Agent LAB (UC16, UC-OBO and UC44 route here): strip + header Back only. This lab is one fixed OBO run with no
// scenario or vertical to preselect, so nothing else changes.
import ReturnLink from "./return-link/ReturnLink.jsx";
import RunTab from "./tabs/RunTab.jsx";
import TopMenu from "./top-menu/TopMenu.jsx";

export const TABS = [["run", "Run"], ["wire", "Wire"]];
export const FALLBACK_BANNER = "MOCK mode. SIMULATED: in-process mock issuer, mock exchanger and mock downstream. No tenant, no outbound network.";
const read = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* not remembered */ } };
const tabFromHash = () => { const id = window.location.hash.replace(/^#\/?/, "").split("?")[0]; return TABS.some(([t]) => t === id) ? id : "run"; };
const typing = (t) => !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);

export default function App() {
  const [catalog, setCatalog] = useState(null);
  const [info, setInfo] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [tab, setTab] = useState(tabFromHash);
  const [theme, setTheme] = useState(() => (["light", "dark"].includes(read("obol.theme", "")) ? read("obol.theme", "") : "system"));
  const [present, setPresent] = useState(() => read("obol.present", "0") === "1");
  const [run, setRun] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [announce, setAnnounce] = useState("");

  const loadAll = useCallback(async () => {
    const [c, i] = await Promise.all([getCatalog(), getInfo()]);
    setCatalog(c); setInfo(i);
  }, []);
  useEffect(() => { loadAll().catch((e) => setLoadError(e.message)); }, [loadAll]);
  useEffect(() => { const on = () => setTab(tabFromHash()); window.addEventListener("hashchange", on); return () => window.removeEventListener("hashchange", on); }, []);
  useEffect(() => { if (theme === "system") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => { if (present) document.documentElement.dataset.present = "1"; else delete document.documentElement.dataset.present; }, [present]);
  useEffect(() => {
    const on = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
      if (e.key === "p" || e.key === "P") setPresent((v) => { write("obol.present", v ? "0" : "1"); return !v; });
      else if (e.key === "Escape") setPresent((v) => { if (v) write("obol.present", "0"); return false; });
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  const onRun = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const r = await runObo();
      setRun(r);
      setAnnounce(r.ok ? `Run passed: downstream ${r.downstream.delegatedStatus} for the delegated token, ${r.downstream.inboundStatus} for your own.` : `Run refused at step ${r.failedStep}.`);
    } catch (e) { setError(e.message); }
    setBusy(false);
  }, []);

  const onMode = useCallback(async (next) => {
    try {
      const r = await requestModeSwitch(next);
      setInfo(r);
      setAnnounce(r.message ?? `Mode: ${r.source}.`);
      setRun(null);
      const c = await getCatalog(); setCatalog(c); // reload all data after a switch (rule 19)
    } catch (e) { setAnnounce(e.message); }
  }, []);

  const onRevoke = useCallback(async () => {
    await revokeAgent();
    setAnnounce("Agent client revoked. Run again to see the refusal at step 2.");
  }, []);

  const banner = info?.banner ?? FALLBACK_BANNER;

  if (loadError || !catalog) {
    return (
      <>
        <a className="skip" href="#main">Skip to content</a>
        <header><p className="banner">{FALLBACK_BANNER}</p></header>
        <main className="page" id="main" tabIndex={-1}>
          {loadError ? <p className="alert" role="alert">Could not reach the lab server: {loadError}</p> : <p className="muted" role="status">Loading the delegation lab...</p>}
        </main>
      </>
    );
  }

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header>
        <p className="banner" data-testid="banner">{banner}</p>
        <ReturnLink app="obo-lab" />
        <div className="head">
          <h1 className="head__title">OBO Delegation Inspector LAB</h1>
          <div className="head__tools">
            <ReturnLink app="obo-lab" variant="header" />
            <TopMenu
              mode={{ value: info?.source === "real" ? "real" : "mock", onChange: onMode, realAvailable: info ? info.realAvailable === true : null, realHint: info && info.realAvailable !== true ? info.realReason : undefined }}
              theme={{ value: theme === "system" ? "auto" : theme, onChange: (v) => { setTheme(v === "auto" ? "system" : v); write("obol.theme", v === "auto" ? "system" : v); } }}
              present={{ active: present, onToggle: () => setPresent((v) => { write("obol.present", v ? "0" : "1"); return !v; }) }}
              help={{ href: "https://github.com/curtismu7/obo-lab-LAB#readme" }}
              version={info?.version || null}
              onReset={async () => { await resetServer(); setRun(null); setAnnounce("Reset."); }}
            >
              <ShelfLink />
            </TopMenu>
          </div>
        </div>
        <nav aria-label="Tabs" className="tabs">
          {TABS.map(([id, label]) => <a key={id} href={`#/${id}`} aria-current={tab === id ? "page" : undefined} className="tab">{label}</a>)}
        </nav>
      </header>
      <main className="page" id="main" tabIndex={-1}>
        {tab === "run"
          ? <RunTab catalog={catalog} run={run} busy={busy} error={error} onRun={onRun} onRevoke={onRevoke} source={info?.source} />
          : <WireTab run={run} />}
      </main>
      <footer><p className="muted small">Delegation, not impersonation: sub stays the person, act names the agent, aud and scope narrow. Tokens are one input to enforcement — the act claim is what the downstream checks.</p></footer>
      <div aria-live="polite" className="visually-hidden">{announce}</div>
    </>
  );
}

function WireTab({ run }) {
  if (!run) return <p className="muted" role="status">Run once, then this tab shows every request/response shape.</p>;
  return (
    <section aria-label="Wire" className="stack">
      <h3>Token shapes (decoded)</h3>
      {[["Inbound (your token)", run.inbound?.claims], ["Actor (agent client credentials)", run.actor?.claims], ["Delegated (the exchange result)", run.delegated?.claims]].map(([label, claims]) => (
        <div key={label} className="card">
          <h4>{label}</h4>
          <pre className="wire" data-testid="wire-json">{JSON.stringify(claims, null, 2)}</pre>
        </div>
      ))}
    </section>
  );
}
