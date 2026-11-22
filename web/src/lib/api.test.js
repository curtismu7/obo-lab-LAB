import { afterEach, describe, expect, it, vi } from "vitest";
import { getRunObservability } from "./api.js";

const answer = (status, body, json = true) => vi.stubGlobal("fetch", vi.fn(async () => ({ ok: status < 400, status, json: async () => { if (!json) throw new SyntaxError("not json"); return body; } })));
afterEach(() => vi.unstubAllGlobals());

describe("getRunObservability", () => {
  it("returns a run record, a no-record message and a structured server error as they are", async () => {
    answer(200, { record: { runId: "r" } });
    expect(await getRunObservability()).toEqual({ record: { runId: "r" } });
    answer(200, { record: null, message: "No run yet" });
    expect(await getRunObservability()).toEqual({ record: null, message: "No run yet" });
    answer(500, { error: "internal_error", message: "could not be built" });
    expect((await getRunObservability()).error).toBe("internal_error");
  });

  it("a 200 that is not a run record (an HTML page, a bare array, an object with neither field) is an error answer, never the empty state", async () => {
    for (const [body, json] of [[null, false], [[1], true], [{ hello: 1 }, true], ["<html>", true], [null, true]]) {
      answer(200, body, json);
      const b = await getRunObservability();
      expect(b.error).toBe("bad_answer");
      expect("record" in b).toBe(false);
    }
  });

  it("a failing status with no JSON body throws, so the panel says it could not reach the server", async () => {
    answer(502, null, false);
    await expect(getRunObservability()).rejects.toThrow("HTTP 502");
  });
});
