import { test, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import App, { FALLBACK_BANNER } from "../App.jsx";
import { runObo, requestModeSwitch } from "../lib/api.js";

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
