import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JscpdProcess } from "../src/effect/services.js";
import { JscpdProcessLive } from "../src/process.js";

const PROCESS_FIXTURE = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const [mode, marker] = process.argv.slice(2);
if (mode === "tree") {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
  writeFileSync(marker, String(child.pid));
  setInterval(() => {}, 1_000);
} else if (mode === "output") {
  process.stdout.write("x".repeat(10_000));
} else if (mode === "ignore-term") {
  writeFileSync(marker, String(process.pid));
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
}
`;

let root: string;
let executable: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-jscpd-effect-process-"));
  executable = join(root, "process-fixture.mjs");
  await writeFile(executable, PROCESS_FIXTURE, { mode: 0o700 });
  await chmod(executable, 0o700);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("Effect process resource ownership", () => {
  it("returns output-limit failures through the typed channel", async () => {
    const program = Effect.flatMap(JscpdProcess, (service) =>
      service.run({
        stage: "scan",
        executable: process.execPath,
        args: [executable, "output", join(root, "unused")],
        cwd: root,
        timeoutMs: 1_000,
        maxOutputBytes: 64,
      }),
    ).pipe(Effect.provide(JscpdProcessLive));

    const exit = await Effect.runPromiseExit(program);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(Option.isSome(failure) ? failure.value._tag : undefined).toBe("JscpdLimitExceeded");
    }
  });

  it("returns a typed timeout only after forced process finalization", async () => {
    const marker = join(root, "timed-out-pid");
    const program = Effect.flatMap(JscpdProcess, (service) =>
      service.run({
        stage: "probe",
        executable: process.execPath,
        args: [executable, "ignore-term", marker],
        cwd: root,
        timeoutMs: 500,
        maxOutputBytes: 1_024,
        terminationGraceMs: 20,
        forceSettleMs: 100,
      }),
    ).pipe(Effect.provide(JscpdProcessLive));

    const exit = await Effect.runPromiseExit(program);
    const pid = Number(await readFile(marker, "utf8"));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(Option.isSome(failure) ? failure.value._tag : undefined).toBe(
        "JscpdOperationTimedOut",
      );
    }
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("interrupts a fiber only after its acquired process tree is finalized", async () => {
    const marker = join(root, "descendant-pid");
    const controller = new AbortController();
    const program = Effect.flatMap(JscpdProcess, (service) =>
      service.run({
        stage: "scan",
        executable: process.execPath,
        args: [executable, "tree", marker],
        cwd: root,
        timeoutMs: 5_000,
        maxOutputBytes: 1_024,
        terminationGraceMs: 20,
        forceSettleMs: 100,
      }),
    ).pipe(Effect.provide(JscpdProcessLive));
    const running = Effect.runPromiseExit(program, { signal: controller.signal });
    let descendantPid = 0;
    await vi.waitFor(async () => {
      descendantPid = Number(await readFile(marker, "utf8"));
      expect(descendantPid).toBeGreaterThan(0);
    });

    controller.abort();
    const exit = await running;

    expect(Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause)).toBe(true);
    await vi.waitFor(() => expect(() => process.kill(descendantPid, 0)).toThrow());
  });
});
