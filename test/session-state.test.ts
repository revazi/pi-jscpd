import { describe, expect, it } from "vitest";
import type { JscpdCapabilityService } from "../src/capability.js";
import type { JscpdConfigService } from "../src/config.js";
import {
  JSCPD_SESSION_STATE_TYPE,
  JSCPD_SESSION_STATE_VERSION,
  restoreJscpdSessionState,
  snapshotJscpdSessionState,
} from "../src/session-state.js";
import { createJscpdSessionModeService, createJscpdStatusService } from "../src/status.js";

const availableCapability = {
  status: "available",
  executable: "jscpd",
  version: "5.1.1",
  major: 5,
} as const;

function customEntry(id: string, data: unknown) {
  return {
    type: "custom",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    customType: JSCPD_SESSION_STATE_TYPE,
    data,
  };
}

function state(modeOverride: "enabled" | "disabled" | null, lastCheck: unknown) {
  return { version: JSCPD_SESSION_STATE_VERSION, modeOverride, lastCheck };
}

function services() {
  const mode = createJscpdSessionModeService();
  mode.restore(true);
  const capability = {
    async probe() {
      return availableCapability;
    },
    invalidate() {},
    dispose() {},
  } satisfies JscpdCapabilityService;
  const current = {
    config: { enabled: true, timeoutMs: 30_000, maxFindings: 10 },
    sources: ["defaults"] as const,
    diagnostics: [],
    trusted: true,
  };
  const config = {
    async load() {
      return current;
    },
    current() {
      return current;
    },
  } satisfies JscpdConfigService;
  return { mode, status: createJscpdStatusService(capability, config, mode) };
}

describe("jscpd session state", () => {
  it("snapshots only the mode override and bounded last-check summary", () => {
    const { mode, status } = services();
    mode.disable();
    status.record({
      status: "failed",
      reason: "scan-timed-out",
      message: "private child output must not persist",
    });

    expect(snapshotJscpdSessionState(mode, status)).toEqual(
      state("disabled", { state: "failed", reason: "scan-timed-out" }),
    );
  });

  it("restores the latest snapshot from the supplied active branch only", () => {
    const branchA = [
      customEntry("a", state("disabled", { state: "clean" })),
      { type: "message", id: "message-a" },
    ];
    const branchB = [customEntry("b", state("enabled", { state: "findings", clones: 2 }))];

    expect(restoreJscpdSessionState(branchA)).toEqual(state("disabled", { state: "clean" }));
    expect(restoreJscpdSessionState(branchB)).toEqual(
      state("enabled", { state: "findings", clones: 2 }),
    );
    expect(restoreJscpdSessionState([])).toBeUndefined();
  });

  it.each([
    state("disabled", { state: "findings", clones: 1_001 }),
    state("disabled", { state: "failed", reason: "unknown" }),
    state("disabled", { state: "clean", extra: true }),
    { version: 2, modeOverride: "disabled", lastCheck: { state: "clean" } },
    { version: 1, modeOverride: "automatic", lastCheck: { state: "clean" } },
  ])("rejects malformed or stale latest snapshots without reviving older state", (latest) => {
    const older = customEntry("older", state("disabled", { state: "clean" }));

    expect(restoreJscpdSessionState([older, customEntry("latest", latest)])).toBeUndefined();
  });

  it("ignores unrelated custom entries", () => {
    expect(
      restoreJscpdSessionState([
        {
          type: "custom",
          customType: "another-extension",
          data: state("disabled", { state: "clean" }),
        },
      ]),
    ).toBeUndefined();
  });
});
