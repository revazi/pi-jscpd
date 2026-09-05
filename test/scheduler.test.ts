import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { JscpdAutomaticScanContext } from "../src/scheduler.js";
import {
  commandFromPromise,
  createScheduledCommandTestDriver as createJscpdScheduledExecutor,
  type TestCommandExecute,
} from "./support/command.js";
import { createSchedulerTestDriver as createJscpdScanScheduler } from "./support/scheduler.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitForSnapshot(
  scheduler: ReturnType<typeof createJscpdScanScheduler>,
  automatic: "idle" | "pending" | "active",
) {
  await vi.waitFor(() => expect(scheduler.snapshot().automatic).toBe(automatic));
}

describe("automatic scan scheduler", () => {
  it("coalesces a burst of changed signals into one latest-generation request", async () => {
    const scheduler = createJscpdScanScheduler();
    const release = deferred();
    const contexts: JscpdAutomaticScanContext[] = [];

    expect(scheduler.requestAutomatic(async () => "attempted")).toBe(false);
    expect(scheduler.markChanged()).toBe(1);
    expect(scheduler.markChanged()).toBe(2);
    expect(scheduler.markChanged()).toBe(3);
    expect(
      scheduler.requestAutomatic(async (context) => {
        contexts.push(context);
        await release.promise;
        return "attempted";
      }),
    ).toBe(true);
    expect(scheduler.requestAutomatic(async () => "attempted")).toBe(false);
    expect(scheduler.snapshot()).toMatchObject({
      changedGeneration: 3,
      attemptedGeneration: 0,
      automatic: "pending",
      closed: false,
    });

    await waitForSnapshot(scheduler, "active");
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.generation).toBe(3);
    expect(contexts[0]?.isCurrent()).toBe(true);
    release.resolve();
    await waitForSnapshot(scheduler, "idle");
    expect(scheduler.snapshot().attemptedGeneration).toBe(3);
    expect(scheduler.requestAutomatic(async () => "attempted")).toBe(false);
  });

  it("invalidates result side effects when a newer mutation arrives", async () => {
    const scheduler = createJscpdScanScheduler();
    const release = deferred();
    let context: JscpdAutomaticScanContext | undefined;

    scheduler.markChanged();
    scheduler.requestAutomatic(async (current) => {
      context = current;
      await release.promise;
      return "deferred";
    });
    await waitForSnapshot(scheduler, "active");
    expect(context?.isCurrent()).toBe(true);

    scheduler.markChanged();
    expect(context?.isCurrent()).toBe(false);
    release.resolve();
    await waitForSnapshot(scheduler, "idle");
    expect(scheduler.snapshot().attemptedGeneration).toBe(0);
  });

  it("replaces a not-yet-started request with the latest changed generation", async () => {
    const scheduler = createJscpdScanScheduler();
    const first = vi.fn(async (_context: JscpdAutomaticScanContext) => "attempted" as const);
    const second = vi.fn(async (_context: JscpdAutomaticScanContext) => "attempted" as const);

    scheduler.markChanged();
    expect(scheduler.requestAutomatic(first)).toBe(true);
    scheduler.markChanged();
    expect(scheduler.requestAutomatic(second)).toBe(true);

    await waitForSnapshot(scheduler, "idle");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    expect(second.mock.calls[0]?.[0]).toMatchObject({ generation: 2 });
    expect(scheduler.snapshot().attemptedGeneration).toBe(2);
  });

  it("bounds automatic work to one active and one coalesced pending generation", async () => {
    const scheduler = createJscpdScanScheduler();
    const first = deferred();
    const second = deferred();
    const generations: number[] = [];

    scheduler.markChanged();
    scheduler.requestAutomatic(async ({ generation }) => {
      generations.push(generation);
      await first.promise;
      return "attempted";
    });
    await waitForSnapshot(scheduler, "active");

    scheduler.markChanged();
    scheduler.markChanged();
    expect(
      scheduler.requestAutomatic(async ({ generation }) => {
        generations.push(generation);
        await second.promise;
        return "attempted";
      }),
    ).toBe(true);
    expect(scheduler.requestAutomatic(async () => "attempted")).toBe(false);
    expect(scheduler.snapshot().automatic).toBe("active");

    first.resolve();
    await vi.waitFor(() => expect(generations).toEqual([1, 3]));
    expect(scheduler.snapshot()).toMatchObject({ automatic: "active", attemptedGeneration: 1 });
    second.resolve();
    await waitForSnapshot(scheduler, "idle");
    expect(scheduler.snapshot().attemptedGeneration).toBe(3);
  });

  it("cancels only automatic ownership and leaves its generation retryable", async () => {
    const scheduler = createJscpdScanScheduler();
    const signals: AbortSignal[] = [];
    const retry = deferred();

    scheduler.markChanged();
    scheduler.requestAutomatic(
      ({ signal }) =>
        new Promise<"attempted">((resolve) => {
          signals.push(signal);
          signal.addEventListener("abort", () => resolve("attempted"), { once: true });
        }),
    );
    await waitForSnapshot(scheduler, "active");

    scheduler.cancelAutomatic();
    await waitForSnapshot(scheduler, "idle");
    expect(signals[0]?.aborted).toBe(true);
    expect(scheduler.snapshot().attemptedGeneration).toBe(0);

    expect(
      scheduler.requestAutomatic(async () => {
        await retry.promise;
        return "attempted";
      }),
    ).toBe(true);
    await waitForSnapshot(scheduler, "active");
    retry.resolve();
    await waitForSnapshot(scheduler, "idle");
    expect(scheduler.snapshot().attemptedGeneration).toBe(1);
  });

  it("lets explicit callers supersede automatic work without sharing their cancellation", async () => {
    const scheduler = createJscpdScanScheduler();
    const automaticAborted = deferred();
    const explicitOne = deferred();
    const explicitTwo = deferred();
    const calls: string[] = [];

    scheduler.markChanged();
    scheduler.requestAutomatic(
      ({ signal }) =>
        new Promise<"attempted">((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              calls.push("automatic-aborted");
              automaticAborted.resolve();
              resolve("attempted");
            },
            { once: true },
          );
        }),
    );
    await waitForSnapshot(scheduler, "active");

    const firstRun = scheduler.runExplicit(async () => {
      calls.push("explicit-one");
      await explicitOne.promise;
      return 1;
    });
    const secondRun = scheduler.runExplicit(async () => {
      calls.push("explicit-two");
      await explicitTwo.promise;
      return 2;
    });
    await automaticAborted.promise;
    expect(calls).toEqual(["automatic-aborted", "explicit-one", "explicit-two"]);

    explicitTwo.resolve();
    await expect(secondRun).resolves.toEqual({ status: "completed", value: 2 });
    let firstSettled = false;
    void firstRun.then(() => {
      firstSettled = true;
    });
    await Promise.resolve();
    expect(firstSettled).toBe(false);
    explicitOne.resolve();
    await expect(firstRun).resolves.toEqual({ status: "completed", value: 1 });
    expect(scheduler.snapshot().attemptedGeneration).toBe(0);
  });

  it("discards a stale completion after reset and runs only the replacement scope", async () => {
    const scheduler = createJscpdScanScheduler();
    const stale = deferred();
    const replacement = deferred();
    const generations: number[] = [];

    scheduler.markChanged();
    scheduler.requestAutomatic(async ({ generation }) => {
      generations.push(generation);
      await stale.promise;
      return "attempted";
    });
    await waitForSnapshot(scheduler, "active");

    scheduler.reset();
    scheduler.markChanged();
    scheduler.requestAutomatic(async ({ generation }) => {
      generations.push(generation);
      await replacement.promise;
      return "attempted";
    });
    stale.resolve();
    await vi.waitFor(() => expect(generations).toEqual([1, 1]));
    expect(scheduler.snapshot().attemptedGeneration).toBe(0);
    replacement.resolve();
    await waitForSnapshot(scheduler, "idle");
    expect(scheduler.snapshot().attemptedGeneration).toBe(1);
  });

  it("leaves a deferred completion retryable without creating a second active job", async () => {
    const scheduler = createJscpdScanScheduler();
    const deferredRun = vi.fn(async () => "deferred" as const);
    const attemptedRun = vi.fn(async () => "attempted" as const);

    scheduler.markChanged();
    expect(scheduler.requestAutomatic(deferredRun)).toBe(true);
    await waitForSnapshot(scheduler, "idle");
    expect(scheduler.snapshot().attemptedGeneration).toBe(0);
    expect(scheduler.requestAutomatic(attemptedRun)).toBe(true);
    await waitForSnapshot(scheduler, "idle");
    expect(attemptedRun).toHaveBeenCalledOnce();
    expect(scheduler.snapshot().attemptedGeneration).toBe(1);
  });

  it("records one terminal task failure without retrying an unchanged generation", async () => {
    const scheduler = createJscpdScanScheduler();
    const run = vi.fn(async () => {
      throw new Error("bounded failure");
    });

    scheduler.markChanged();
    expect(scheduler.requestAutomatic(run)).toBe(true);
    await waitForSnapshot(scheduler, "idle");
    expect(run).toHaveBeenCalledOnce();
    expect(scheduler.snapshot().attemptedGeneration).toBe(1);
    expect(scheduler.requestAutomatic(run)).toBe(false);
  });

  it("prevents pending or future work after idempotent disposal", async () => {
    const pendingScheduler = createJscpdScanScheduler();
    const pendingRun = vi.fn(async () => "attempted" as const);
    pendingScheduler.markChanged();
    pendingScheduler.requestAutomatic(pendingRun);
    await pendingScheduler.dispose();
    await pendingScheduler.dispose();
    await Promise.resolve();
    expect(pendingRun).not.toHaveBeenCalled();
    expect(pendingScheduler.markChanged()).toBe(1);
    expect(pendingScheduler.requestAutomatic(pendingRun)).toBe(false);
    await expect(pendingScheduler.runExplicit(async () => 1)).resolves.toEqual({
      status: "closed",
    });

    const activeScheduler = createJscpdScanScheduler();
    let activeSignal: AbortSignal | undefined;
    activeScheduler.markChanged();
    activeScheduler.requestAutomatic(
      ({ signal }) =>
        new Promise<"attempted">((resolve) => {
          activeSignal = signal;
          signal.addEventListener("abort", () => resolve("attempted"), { once: true });
        }),
    );
    await waitForSnapshot(activeScheduler, "active");
    await activeScheduler.dispose();
    expect(activeSignal?.aborted).toBe(true);
    expect(activeScheduler.snapshot()).toMatchObject({ automatic: "idle", closed: true });
  });
});

describe("scheduled explicit executor", () => {
  it("supersedes automatic work only for scan, changed, and off commands", async () => {
    const scheduler = createJscpdScanScheduler();
    const cancel = vi.fn();
    const runExplicit = vi.spyOn(scheduler, "runExplicitEffect");
    const scheduled = {
      ...scheduler,
      cancelAutomaticEffect: Effect.sync(cancel).pipe(
        Effect.zipRight(scheduler.cancelAutomaticEffect ?? Effect.void),
      ),
    };
    const execute = vi.fn<TestCommandExecute>(async (invocation) => ({
      status: "help",
      message: invocation.command,
      terminalMessage: invocation.command,
    }));
    const executor = createJscpdScheduledExecutor(commandFromPromise(execute), scheduled);
    const context = { cwd: "/project" };

    await executor.execute({ command: "status", args: [] }, context);
    await executor.execute({ command: "on", args: [] }, context);
    await executor.execute({ command: "off", args: [] }, context);
    await executor.execute({ command: "scan", args: [] }, context);
    await executor.execute({ command: "changed", args: [] }, context);

    expect(cancel).toHaveBeenCalledOnce();
    expect(runExplicit).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(5);
  });

  it("fails open instead of invoking explicit work after shutdown", async () => {
    const scheduler = createJscpdScanScheduler();
    const execute = vi.fn<TestCommandExecute>();
    const executor = createJscpdScheduledExecutor(commandFromPromise(execute), scheduler);
    await scheduler.dispose();

    await expect(
      executor.execute({ command: "scan", args: [] }, { cwd: "/project" }),
    ).resolves.toMatchObject({ status: "failed", reason: "scan-cancelled" });
    expect(execute).not.toHaveBeenCalled();
  });
});
