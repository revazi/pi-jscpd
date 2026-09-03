import { describe, expect, it } from "vitest";
import type { JscpdCloneSnapshot } from "../src/clone-identity.js";
import type { JscpdClonePair, JscpdCompletedResult } from "../src/types.js";
import { createJscpdVerificationService, withJscpdVerification } from "../src/verification.js";

function clone(path: string): JscpdClonePair {
  return {
    format: "typescript",
    lines: 4,
    tokens: 16,
    occurrences: [
      {
        path: `${path}-a.ts`,
        start: { line: 1, column: 0, offset: 0 },
        end: { line: 4, column: 0, offset: 16 },
      },
      {
        path: `${path}-b.ts`,
        start: { line: 10, column: 0, offset: 20 },
        end: { line: 13, column: 0, offset: 36 },
      },
    ],
  };
}

function snapshot(...fingerprints: string[]): JscpdCloneSnapshot {
  return {
    status: "accepted",
    groups: fingerprints.map((fingerprint) => ({ clone: clone(fingerprint), fingerprint })),
    omittedGroups: 0,
  };
}

const completed: JscpdCompletedResult = {
  status: "completed",
  outcome: "clean",
  message: "scan clean",
  terminalMessage: "terminal clean",
  summary: {
    clones: 0,
    duplicatedLines: 0,
    duplicatedTokens: 0,
    lines: 20,
    tokens: 80,
    sources: 2,
    percentage: 0,
    percentageTokens: 0,
  },
  findings: [],
  omittedFindings: 0,
};

describe("ephemeral refactor verification", () => {
  it("classifies removed, remaining, and newly created groups across matching scans", () => {
    const service = createJscpdVerificationService();

    const first = service.compareAndRemember("project", '["."]', snapshot("kept"));
    const second = service.compareAndRemember("project", '["."]', snapshot("kept", "created"));
    const third = service.compareAndRemember("project", '["."]', snapshot("created"));

    expect(first).toEqual({
      state: "checkpoint",
      scope: "project",
      groups: 1,
      message:
        "Verification checkpoint recorded with 1 duplicate block. After ordinary edits and relevant tests, rerun the same /jscpd scan to compare the result.",
    });
    expect(second).toMatchObject({
      state: "compared",
      removed: 0,
      remaining: 1,
      created: 1,
      ambiguous: 0,
    });
    expect(second.message).toContain("0 removed, 1 remaining, 1 newly created");
    expect(third).toMatchObject({
      state: "compared",
      removed: 1,
      remaining: 1,
      created: 0,
      ambiguous: 0,
    });
  });

  it("starts a new checkpoint when the explicit scan scope changes", () => {
    const service = createJscpdVerificationService();
    service.compareAndRemember("project", '["src"]', snapshot("one"));

    const changedScope = service.compareAndRemember("project", '["test"]', snapshot("two"));
    const matchingScope = service.compareAndRemember("project", '["test"]', snapshot("two"));

    expect(changedScope).toMatchObject({ state: "checkpoint", groups: 1 });
    expect(matchingScope).toMatchObject({
      state: "compared",
      removed: 0,
      remaining: 1,
      created: 0,
    });
  });

  it("keeps accepted checkpoints across partial attempts and clears them on reset", () => {
    const service = createJscpdVerificationService();
    service.compareAndRemember("changed", ".", snapshot("one"));
    const unavailable = service.compareAndRemember("changed", ".", {
      status: "partial",
      groups: [{ clone: clone("unknown"), issue: "read-failed" }],
      omittedGroups: 0,
    });
    const compared = service.compareAndRemember("changed", ".", snapshot("one"));

    expect(unavailable).toEqual({
      state: "unavailable",
      scope: "changed",
      reason: "identity-partial",
      message:
        "Verification comparison is unavailable because complete content identities could not be derived; the current scan result remains advisory.",
    });
    expect(compared).toMatchObject({ state: "compared", remaining: 1 });

    service.reset();
    expect(service.compareAndRemember("changed", ".", snapshot())).toMatchObject({
      state: "checkpoint",
      groups: 0,
    });
  });

  it("discards stale completion after a lifecycle reset without replacing current state", () => {
    const service = createJscpdVerificationService();
    const staleScope = service.scope();
    service.reset();

    const stale = service.compareAndRemember("project", '["."]', snapshot("old"), staleScope);
    const current = service.compareAndRemember("project", '["."]', snapshot("current"));

    expect(stale).toMatchObject({
      state: "unavailable",
      reason: "lifecycle-changed",
    });
    expect(current).toMatchObject({ state: "checkpoint", groups: 1 });
  });

  it("adds structured verification to both model and terminal messages", () => {
    const service = createJscpdVerificationService();
    const verification = service.compareAndRemember("project", '["."]', snapshot());

    const result = withJscpdVerification(completed, verification);

    expect(result.verification).toBe(verification);
    expect(result.message).toBe(`scan clean\n${verification.message}`);
    expect(result.terminalMessage).toBe(`terminal clean\n${verification.message}`);
    expect(Object.isFrozen(result)).toBe(true);
  });
});
