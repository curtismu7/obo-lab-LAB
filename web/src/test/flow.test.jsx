import { test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import fs from "node:fs";
import path from "node:path";
import App, { FALLBACK_BANNER } from "../App.jsx";
import { runObo, requestModeSwitch, getInfo } from "../lib/api.js";
import { setJsonView } from "../components/JsonPane.jsx";

vi.mock("../lib/api.js", () => ({
  requestModeSwitch: vi.fn(async (source) => ({ source, realAvailable: false, realReason: "Set PINGONE_* in ~/Development/.env", banner: "B" })),
  getCatalog: vi.fn(async () => ({
    banner: "B", source: "mock",
    persona: { sub: "user.0042", clientId: "web-banking", inboundScope: "openid profile checking:read" },
    agent: { clientId: "personal-agent" }, exchanger: { clientId: "token-exchanger" },
    downstream: { aud: "https://api.downstream.invalid", acceptedScope: "checking:read transfer:write" },
    steps: 7,
  })),
  getInfo: vi.fn(async () => ({ source: "mock", realAvailable: false, realReason: "Set PINGONE_*", banner: "B" })),
  resetServer: vi.fn(async () => ({ ok: true })),
  runObo: vi.fn(),
  revokeAgent: vi.fn(async () => ({ ok: true })),
  decodeToken: vi.fn(),
}));

beforeEach(() => { window.location.hash = ""; setJsonView("form"); });

const GOOD_RUN = {
  ok: true, source: "mock",
  inbound: { claims: { sub: "user.0042", scope: "openid profile checking:read transfer:write" } },
  actor: { claims: { sub: "personal-agent" } },
  delegated: { claims: { sub: "user.0042", act: { sub: "personal-agent" }, scope: "checking:read transfer:write" } },
  downstream: { delegatedStatus: 200, inboundStatus: 401, inboundWhy: "no act claim: a token that is not delegated does not name an agent" },
  delta: { subSame: true, audSame: true, scopeNarrowed: true, actAdded: true },
  leak: false,
};

test("run renders the seven steps, the diff table, and the downstream refusal", async () => {
  runObo.mockResolvedValueOnce(GOOD_RUN);
  const user = userEvent.setup();
  render(<App />);
  await screen.findByTestId("banner");
  await user.click(screen.getByTestId("obo-run"));
  await waitFor(() => expect(screen.getByTestId("steps")).toBeTruthy());
  expect(screen.getByTestId("downstream-delegated")).toHaveTextContent("200");
  expect(screen.getByTestId("downstream-inbound")).toHaveTextContent("401");
  expect(screen.getByTestId("delta")).toBeTruthy();
});

test("rule 19: the mode select shows Mock; Real disabled with how-to when unconfigured", async () => {
  render(<App />);
  await screen.findByTestId("banner");
  const select = screen.getByTestId("mode-select");
  expect(select).toHaveValue("mock");
  expect(screen.getByRole("option", { name: "Real" })).toBeDisabled();
});

test("a refused run (revoked agent) shows the step and the reason", async () => {
  runObo.mockResolvedValueOnce({ ok: false, failedStep: 2, error: "the agent's client is revoked; step 2 (client credentials) is refused with invalid_client" });
  const user = userEvent.setup();
  render(<App />);
  await screen.findByTestId("banner");
  await user.click(screen.getByTestId("obo-run"));
  await waitFor(() => expect(screen.getByTestId("run-refused")).toBeTruthy());
  expect(screen.getByTestId("run-refused")).toHaveTextContent(/step 2/);
  expect(screen.getByTestId("run-refused")).toHaveTextContent(/invalid_client/);
});

test("fallback banner mentions simulation", async () => {
  expect(FALLBACK_BANNER).toMatch(/SIMULATED/i);
});

test("Wire tab: each token's claims go through the shared JsonPane (Form, then the exact JSON), no scroll cap", async () => {
  runObo.mockResolvedValueOnce(GOOD_RUN);
  const user = userEvent.setup();
  render(<App />);
  await screen.findByTestId("banner");
  await user.click(screen.getByTestId("obo-run"));
  await waitFor(() => expect(screen.getByTestId("steps")).toBeTruthy());
  await user.click(screen.getByRole("link", { name: "Wire" }));
  const panes = await screen.findAllByTestId("wire-json");
  expect(panes).toHaveLength(3);
  expect(panes[2]).toHaveTextContent("personal-agent");          // Form view: label + value per field
  expect(panes[2].tagName).toBe("DIV");
  await user.click(screen.getAllByRole("button", { name: "JSON" })[2]);
  const raw = screen.getAllByTestId("wire-json")[2];
  expect(raw.tagName).toBe("PRE");
  expect(raw).toHaveTextContent('"sub": "user.0042"');            // the JSON text
  expect(raw).toHaveTextContent('"scope": "checking:read transfer:write"');
  expect(raw.style.maxHeight).toBe("");
  expect(raw.style.overflow).toBe("");
});

test("Wire tab: a refused run names the tokens that were never minted instead of printing undefined", async () => {
  runObo.mockResolvedValueOnce({ ok: false, failedStep: 2, error: "the agent's client is revoked; step 2 (client credentials) is refused with invalid_client" });
  const user = userEvent.setup();
  render(<App />);
  await screen.findByTestId("banner");
  await user.click(screen.getByTestId("obo-run"));
  await waitFor(() => expect(screen.getByTestId("run-refused")).toBeTruthy());
  await user.click(screen.getByRole("link", { name: "Wire" }));
  await waitFor(() => expect(screen.getAllByText(/Not minted/)).toHaveLength(3));
  expect(screen.queryByTestId("wire-json")).toBeNull();
  expect(document.body).not.toHaveTextContent("undefined");
});

test("the live announcement is screen-reader only: it carries the shared sr-only class, which app.css defines", async () => {
  runObo.mockResolvedValueOnce(GOOD_RUN);
  const user = userEvent.setup();
  render(<App />);
  await screen.findByTestId("banner");
  await user.click(screen.getByTestId("obo-run"));
  const live = await screen.findByText(/^Run passed: downstream 200/);
  expect(live).toHaveAttribute("aria-live", "polite");
  expect(live).toHaveClass("sr-only");
  expect(live).not.toHaveClass("visually-hidden");
  const css = fs.readFileSync(path.join(process.cwd(), "src", "app.css"), "utf8");
  expect(css).toMatch(/\.sr-only\s*\{[^}]*clip:/);
});

test("the lab version from /api/info reaches the TopMenu version button, and stays after a mode switch", async () => {
  getInfo.mockResolvedValueOnce({ source: "mock", realAvailable: true, banner: "B", version: "9.8.7" });
  const user = userEvent.setup();
  render(<App />);
  await screen.findByTestId("banner");
  expect(await screen.findByTestId("version")).toHaveTextContent("9.8.7");
  requestModeSwitch.mockResolvedValueOnce({ source: "real", realAvailable: true, banner: "REAL B", version: "9.8.7" });
  await user.selectOptions(screen.getByTestId("mode-select"), "real");
  await waitFor(() => expect(screen.getByTestId("banner")).toHaveTextContent("REAL B"));
  expect(screen.getByTestId("version")).toHaveTextContent("9.8.7");
});
