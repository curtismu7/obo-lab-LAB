import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import React from "react";
import App from "../App.jsx";

// The header shows this lab's own Verified / In progress mark, read from the same /api/shelf call the Shelf link makes (through the lab-proxy
// that call reaches the shelf, whose payload lists every demo with its mark). The lab's own /api/shelf has no demos, so there is no mark then.
vi.mock("../lib/api.js", () => ({
  requestModeSwitch: vi.fn(async (source) => ({ source, realAvailable: false, realReason: "Set PINGONE_*", banner: "B" })),
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

const mark = (status, label, extra = {}) => ({ status, label, note: "", updatedAt: "2026-11-15", source: "shipped", ...extra });
const realFetch = globalThis.fetch;
function withShelf(payload) {
  globalThis.fetch = (url, init) => (url === "/api/shelf" ? Promise.resolve(new Response(JSON.stringify(payload))) : realFetch(url, init));
}
afterEach(() => { globalThis.fetch = realFetch; });

describe("verification mark in the header", () => {
  it("shows this lab's own mark beside the Shelf link, and no other lab's", async () => {
    withShelf({ shelfUrl: "http://shelf.example", demos: [{ id: "other-lab", verification: mark("in-progress", "In progress") }, { id: "obo-lab", verification: mark("verified", "Verified", { note: "Run, revoke, rerun on the mock" }) }] });
    render(<App />);
    const bar = within(await screen.findByTestId("top-menu"));
    expect(await bar.findByText("Verified")).toBeInTheDocument();
    expect(bar.getByRole("link", { name: "Shelf" })).toBeInTheDocument();
    expect(bar.queryByText("In progress")).toBeNull();
    expect(document.querySelectorAll(".verify")).toHaveLength(1);
    expect(bar.getByText("Verified").closest(".verify")).toHaveAttribute("title", expect.stringContaining("Run, revoke, rerun on the mock"));
  });

  it("shows nothing when the lab is opened on its own port (its /api/shelf has no demos) or the shelf has no mark for it", async () => {
    for (const payload of [{ shelfUrl: "http://shelf.example" }, { shelfUrl: "http://shelf.example", demos: [{ id: "obo-lab", verification: null }] }, { shelfUrl: "http://shelf.example", demos: [{ id: "obo-lab", verification: mark("none", "") }] }]) {
      withShelf(payload);
      const { unmount } = render(<App />);
      const bar = within(await screen.findByTestId("top-menu"));
      expect(await bar.findByRole("link", { name: "Shelf" })).toBeInTheDocument(); // the shelf answered, and still no badge
      expect(document.querySelector(".verify")).toBeNull();
      unmount();
    }
  });
});
