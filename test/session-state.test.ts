import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { createJscpdAcknowledgementTracker } from "../src/acknowledgements.js";
import type { JscpdCapabilityService } from "../src/capability.js";
import { MAX_CHANGED_FILES } from "../src/changed-files.js";
import type { JscpdConfigService } from "../src/config.js";
import {
  JSCPD_SESSION_STATE_TYPE,
  JSCPD_SESSION_STATE_VERSION,
  restoreJscpdSessionState,
  snapshotJscpdSessionState,
} from "../src/session-state.js";
import { createJscpdSessionModeService, createJscpdStatusService } from "../src/status.js";
import { createChangedFilesTestDriver as createJscpdChangedFileTracker } from "./support/changed-files.js";

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

function state(
  modeOverride: "enabled" | "disabled" | null,
  lastCheck: unknown,
  changedFiles: unknown = [],
  acknowledgements: unknown = { identityVersion: 1, findings: [] },
) {
  return {
    version: JSCPD_SESSION_STATE_VERSION,
    modeOverride,
    lastCheck,
    changedFiles,
    acknowledgements,
  };
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
    loadEffect: () => Effect.succeed(current),
    current() {
      return current;
    },
  } satisfies JscpdConfigService;
  return { mode, status: createJscpdStatusService(capability, config, mode) };
}

describe("jscpd session state", () => {
  it("snapshots only bounded branch-local state", async () => {
    const { mode, status } = services();
    const changedFiles = createJscpdChangedFileTracker();
    await changedFiles.start(process.cwd(), ["src/z.ts", "src/a.ts"]);
    mode.disable();
    status.record({
      status: "failed",
      reason: "scan-timed-out",
      message: "private child output must not persist",
    });

    const snapshot = snapshotJscpdSessionState(
      mode,
      status,
      changedFiles,
      createJscpdAcknowledgementTracker(),
    );
    expect(snapshot).toEqual(
      state("disabled", { state: "failed", reason: "scan-timed-out" }, ["src/a.ts", "src/z.ts"]),
    );
    expect(Object.isFrozen(snapshot.changedFiles)).toBe(true);
  });

  it("restores the latest snapshot from the supplied active branch only", () => {
    const branchA = [
      customEntry("a", state("disabled", { state: "clean" }, ["src/a.ts"])),
      { type: "message", id: "message-a" },
    ];
    const branchB = [
      customEntry("b", state("enabled", { state: "findings", clones: 2 }, ["src/b.ts"])),
    ];

    expect(restoreJscpdSessionState(branchA)).toEqual(
      state("disabled", { state: "clean" }, ["src/a.ts"]),
    );
    expect(restoreJscpdSessionState(branchB)).toEqual(
      state("enabled", { state: "findings", clones: 2 }, ["src/b.ts"]),
    );
    expect(restoreJscpdSessionState([])).toBeUndefined();
  });

  it("migrates version 1 and 2 snapshots without dropping prior state", () => {
    const versionOne = {
      version: 1,
      modeOverride: "disabled",
      lastCheck: { state: "findings", clones: 3 },
    };
    const versionTwo = {
      version: 2,
      modeOverride: "enabled",
      lastCheck: { state: "clean" },
      changedFiles: ["src/a.ts"],
    };

    expect(restoreJscpdSessionState([customEntry("v1", versionOne)])).toEqual(
      state("disabled", { state: "findings", clones: 3 }, []),
    );
    expect(restoreJscpdSessionState([customEntry("v2", versionTwo)])).toEqual(
      state("enabled", { state: "clean" }, ["src/a.ts"]),
    );
  });

  it("keeps opaque acknowledgements bounded and active-branch scoped", () => {
    const fingerprint = "a".repeat(64);
    const acknowledged = {
      identityVersion: 1,
      findings: [{ fingerprint, paths: ["src/a.ts", "src/b.ts"] }],
    };
    const branchA = [customEntry("a", state(null, { state: "clean" }, ["src/a.ts"], acknowledged))];
    const branchB = [customEntry("b", state(null, { state: "clean" }, ["src/b.ts"]))];

    expect(restoreJscpdSessionState(branchA)?.acknowledgements).toEqual(acknowledged);
    expect(restoreJscpdSessionState(branchB)?.acknowledgements.findings).toEqual([]);
  });

  it.each([
    state("disabled", { state: "findings", clones: 1_001 }),
    state("disabled", { state: "failed", reason: "unknown" }),
    state("disabled", { state: "clean", extra: true }),
    state("disabled", { state: "clean" }, ["../outside.ts"]),
    state("disabled", { state: "clean" }, ["src/a.ts", "src/a.ts"]),
    state("disabled", { state: "clean" }, [], { identityVersion: 2, findings: [] }),
    state("disabled", { state: "clean" }, [], {
      identityVersion: 1,
      findings: [{ fingerprint: "short", paths: ["src/a.ts", "src/b.ts"] }],
    }),
    state(
      "disabled",
      { state: "clean" },
      Array.from({ length: MAX_CHANGED_FILES + 1 }, (_, index) => `src/${index}.ts`),
    ),
    { version: 1, modeOverride: "automatic", lastCheck: { state: "clean" } },
    {
      version: 1,
      modeOverride: "disabled",
      lastCheck: { state: "clean" },
      changedFiles: [],
    },
    { version: 2, modeOverride: "automatic", lastCheck: { state: "clean" }, changedFiles: [] },
    { version: 3, modeOverride: "disabled", lastCheck: { state: "clean" }, changedFiles: [] },
    {
      version: 4,
      modeOverride: "disabled",
      lastCheck: { state: "clean" },
      changedFiles: [],
      acknowledgements: { identityVersion: 1, findings: [] },
    },
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
