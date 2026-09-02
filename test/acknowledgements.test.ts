import { describe, expect, it } from "vitest";
import {
  createJscpdAcknowledgementTracker,
  MAX_ACKNOWLEDGED_FINDINGS,
  parseJscpdAcknowledgements,
} from "../src/acknowledgements.js";

function finding(index: number) {
  return {
    fingerprint: index.toString(16).padStart(64, "0"),
    paths: [`src/${index}.ts`, "src/shared.ts"] as const,
  };
}

describe("branch-local changed-finding acknowledgements", () => {
  it("retains active findings, drops removed findings, and invalidates verified mutation paths", () => {
    const tracker = createJscpdAcknowledgementTracker();
    const first = finding(1);
    const second = finding(2);
    const revision = tracker.revision();

    expect(tracker.reconcile(revision, [first, second], [first, second])).toBe(true);
    expect(tracker.findings()).toEqual([first, second]);
    expect(tracker.reconcile(tracker.revision(), [second], [])).toBe(true);
    expect(tracker.findings()).toEqual([second]);
    expect(tracker.invalidatePaths(["src/unrelated.ts"])).toBe(false);
    expect(tracker.invalidatePaths(["src/shared.ts"])).toBe(true);
    expect(tracker.findings()).toEqual([]);
  });

  it("rejects stale reconciliation after active-branch restoration", () => {
    const tracker = createJscpdAcknowledgementTracker();
    const staleScope = tracker.scope();
    const staleRevision = tracker.revision();
    tracker.restore({ identityVersion: 1, findings: [finding(1)] });

    expect(tracker.scope()).toBeGreaterThan(staleScope);
    expect(tracker.reconcile(staleRevision, [finding(2)], [finding(2)])).toBe(false);
    expect(tracker.findings()).toEqual([finding(1)]);
  });

  it("prioritizes a surfaced active finding beyond the acknowledgement capacity boundary", () => {
    const tracker = createJscpdAcknowledgementTracker();
    const active = Array.from({ length: MAX_ACKNOWLEDGED_FINDINGS + 1 }, (_, index) =>
      finding(index + 1),
    );
    const surfaced = active.at(-1);
    if (!surfaced) throw new Error("expected surfaced fixture");

    expect(tracker.reconcile(tracker.revision(), active, [surfaced])).toBe(true);
    expect(tracker.findings()).toEqual([surfaced]);
  });

  it("keeps newly surfaced findings when retained active acknowledgements fill the capacity", () => {
    const tracker = createJscpdAcknowledgementTracker();
    const retained = Array.from({ length: MAX_ACKNOWLEDGED_FINDINGS }, (_, index) =>
      finding(index + 1),
    );
    tracker.restore({ identityVersion: 1, findings: retained });
    const surfaced = finding(MAX_ACKNOWLEDGED_FINDINGS + 1);

    expect(tracker.reconcile(tracker.revision(), [...retained, surfaced], [surfaced])).toBe(true);
    expect(tracker.findings()).toHaveLength(MAX_ACKNOWLEDGED_FINDINGS);
    expect(tracker.has(surfaced.fingerprint)).toBe(true);
  });

  it("strictly bounds and validates the persisted identity format", () => {
    expect(
      parseJscpdAcknowledgements({
        identityVersion: 1,
        findings: Array.from({ length: MAX_ACKNOWLEDGED_FINDINGS + 1 }, (_, index) =>
          finding(index),
        ),
      }),
    ).toBeUndefined();
    expect(
      parseJscpdAcknowledgements({
        identityVersion: 1,
        findings: [{ fingerprint: "a".repeat(64), paths: ["../outside.ts", "src/a.ts"] }],
      }),
    ).toBeUndefined();
  });
});
