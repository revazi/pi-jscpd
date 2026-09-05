import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error The executable certification script intentionally has no published type surface.
import * as certification from "../scripts/package-certify.mjs";

const {
  isolatedEnvironment,
  isolatedPiArguments,
  processIsRunning,
  skillPiArguments,
  terminateProcess,
} = certification;
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("packed-artifact certification helpers", () => {
  it("builds an isolated Pi environment and disables discovered resources", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-jscpd-certification-test-"));
    temporaryRoots.push(root);
    const binDirectory = join(root, "bin");
    const environment = isolatedEnvironment(
      root,
      { binDirectory, scanLog: join(root, "log") },
      {
        JSCPD_CERTIFY_TEST: "yes",
      },
    );

    expect(environment.PI_CODING_AGENT_DIR).toBe(join(root, "agent"));
    expect(environment.HOME).toBe(join(root, "home"));
    expect(environment.TMPDIR).toBe(join(root, "tmp"));
    expect(environment.PI_OFFLINE).toBe("1");
    expect(environment.JSCPD_CERTIFY_TEST).toBe("yes");
    expect(environment.PATH.startsWith(binDirectory)).toBe(true);
    expect(existsSync(environment.PI_CODING_AGENT_DIR)).toBe(true);
    expect(existsSync(environment.TMPDIR)).toBe(true);

    expect(isolatedPiArguments("/artifact")).toEqual([
      "--no-session",
      "--offline",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-builtin-tools",
      "--tools",
      "jscpd_run",
      "--no-approve",
      "-e",
      "/artifact",
    ]);
    expect(skillPiArguments("/artifact")).toEqual(
      isolatedPiArguments("/artifact").filter((argument: string) => argument !== "--no-skills"),
    );
  });

  it("detects and terminates a certification-owned child process", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    try {
      expect(child.pid).toBeTypeOf("number");
      expect(processIsRunning(child.pid)).toBe(true);
      terminateProcess(child.pid);
      await new Promise((resolve) => child.once("exit", resolve));
      expect(processIsRunning(child.pid)).toBe(false);
    } finally {
      if (child.pid && processIsRunning(child.pid)) process.kill(child.pid, "SIGKILL");
    }
  });
});
