// Rule 27 on this lab's page: the shared panel under the run, in Mock (simulated) and Real (responses), never "logged".
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import React from "react";
import RunObs, { RUN_OBS_STREAMS } from "./RunObs.jsx";
import { setJsonView } from "./JsonPane.jsx";
import { mockRecord, realRecord } from "../run-observability/fixtures";

vi.mock("../lib/api.js", () => ({ getRunObservability: vi.fn() }));
import { getRunObservability } from "../lib/api.js";

beforeEach(() => { vi.clearAllMocks(); setJsonView("form"); });

describe("RunObs", () => {
  it("shows the empty state before a run and does not ask the server", () => {
    render(<RunObs attempt={0} mode="mock" />);
    expect(screen.getByTestId("ro-empty").textContent).toMatch(/Run the demo/);
    expect(getRunObservability).not.toHaveBeenCalled();
  });

  it("while the answer is pending it says so (no empty-state flash), and a no-record message is shown, not dropped", async () => {
    let release;
    getRunObservability.mockReturnValue(new Promise((r) => { release = r; }));
    render(<RunObs attempt={1} mode="real" />);
    expect(screen.getByTestId("ro-loading")).toBeTruthy();
    expect(screen.queryByTestId("ro-empty")).toBeNull();
    release({ record: null, message: "The last attempt began no step: nothing answered (the error is under Run). Nothing older is shown instead." });
    await waitFor(() => expect(screen.getByTestId("ro-none").textContent).toMatch(/began no step/));
  });

  it("Mock: every row is simulated, none is tagged logged, and the lab says where its decision lines live", async () => {
    getRunObservability.mockResolvedValue({ record: mockRecord });
    render(<RunObs attempt={1} mode="mock" />);
    await waitFor(() => expect(screen.getByTestId("ro-table")).toBeTruthy());
    expect(screen.getByTestId("ro-basis").textContent).toMatch(/^Simulated/);
    expect(document.querySelector('tr[data-origin="logged"]')).toBeNull();
    expect(document.querySelectorAll('[data-origin="simulated"].ro-chip').length).toBeGreaterThan(1);
    expect(screen.getByTestId("ro-streams").textContent).toMatch(/demo-logs-obo-lab/);
    expect(RUN_OBS_STREAMS.length).toBeGreaterThan(0);
  });

  it("Real: the record is shown under the Real label, and the Mock label refuses it (never a Mock run as a Real reply)", async () => {
    getRunObservability.mockResolvedValue({ record: realRecord });
    const { rerender } = render(<RunObs attempt={1} mode="real" />);
    await waitFor(() => expect(screen.getByTestId("ro-table")).toBeTruthy());
    expect(screen.queryByTestId("ro-mismatch")).toBeNull();
    rerender(<RunObs attempt={1} mode="mock" />);
    await waitFor(() => expect(screen.getByTestId("ro-mismatch")).toBeTruthy());
    expect(screen.queryByTestId("ro-table")).toBeNull();
  });

  it("long names stay inside the panel as text (no markup)", async () => {
    const LONG = "long-agent-name-".repeat(12);
    const long = { ...mockRecord, rows: mockRecord.rows.map((r, i) => (i === 0 ? { ...r, message: `RFC 8693 exchange: act ${LONG} <img src=x onerror=alert(1)>`, detail: { act: LONG } } : r)) };
    getRunObservability.mockResolvedValue({ record: long });
    const { container } = render(<RunObs attempt={1} mode="mock" />);
    await waitFor(() => expect(screen.getByTestId("ro-table")).toBeTruthy());
    expect(container.querySelector("img, script")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("a structured server error (Rule 23) and a network failure are shown, never blank", async () => {
    getRunObservability.mockResolvedValue({ error: "internal_error", message: "The run observability record could not be built." });
    const { unmount } = render(<RunObs attempt={1} mode="mock" />);
    await waitFor(() => expect(screen.getByTestId("ro-error").textContent).toMatch(/could not be built/));
    unmount();
    getRunObservability.mockRejectedValue(new Error("down"));
    render(<RunObs attempt={2} mode="mock" />);
    await waitFor(() => expect(screen.getByTestId("ro-error").textContent).toMatch(/Could not reach the server/));
  });

  it("a new attempt re-reads; a mode switch back to the empty state (attempt 0) clears the panel", async () => {
    getRunObservability.mockResolvedValue({ record: mockRecord });
    const { rerender } = render(<RunObs attempt={1} mode="mock" />);
    await waitFor(() => expect(screen.getByTestId("ro-table")).toBeTruthy());
    rerender(<RunObs attempt={2} mode="mock" />);
    await waitFor(() => expect(getRunObservability).toHaveBeenCalledTimes(2));
    rerender(<RunObs attempt={0} mode="real" />);
    expect(screen.getByTestId("ro-empty")).toBeTruthy();
    rerender(<RunObs attempt={1} mode="mock" />);
    await waitFor(() => expect(screen.getByTestId("ro-table")).toBeTruthy());
  });
});
