import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { createJscpdUpdateNoticeService } from "../src/update-notice.js";

function noticeService(
  currentVersion: string | undefined,
  latestVersion: string | undefined,
  environment: Readonly<Record<string, string | undefined>> = {},
) {
  return createJscpdUpdateNoticeService({
    environment,
    currentVersionEffect: Effect.succeed(currentVersion),
    latestVersionEffect: Effect.succeed(latestVersion),
  });
}

describe("pi-jscpd update notice", () => {
  it("reports a newer npm release once with the canonical Pi update command", async () => {
    const service = noticeService("0.2.0", "0.3.0");

    await expect(Effect.runPromise(service.noticeEffect)).resolves.toBe(
      "pi-jscpd 0.3.0 is available (you have 0.2.0). Update: pi update npm:pi-jscpd",
    );
    await expect(Effect.runPromise(service.noticeEffect)).resolves.toBeUndefined();
  });

  it.each([
    ["0.2.0", "0.2.0"],
    ["0.2.0", "0.1.1"],
    ["0.2.0", undefined],
    [undefined, "0.3.0"],
    ["0.3.0", "0.3.0-beta.1"],
  ])("stays quiet when %s does not need %s", async (currentVersion, latestVersion) => {
    const service = noticeService(currentVersion, latestVersion);

    await expect(Effect.runPromise(service.noticeEffect)).resolves.toBeUndefined();
  });

  it.each([
    { PI_OFFLINE: "1" },
    { PI_JSCPD_DISABLE_UPDATE_NOTICE: "1" },
    { PI_JSCPD_UPDATE_CHECK: "false" },
  ])("skips disabled or offline checks for %o", async (environment) => {
    const latestVersionEffect = vi.fn(() => Effect.succeed("99.0.0"));
    const service = createJscpdUpdateNoticeService({
      environment,
      currentVersionEffect: Effect.succeed("0.2.0"),
      latestVersionEffect: Effect.suspend(latestVersionEffect),
    });

    await expect(Effect.runPromise(service.noticeEffect)).resolves.toBeUndefined();
    expect(latestVersionEffect).not.toHaveBeenCalled();
  });

  it("fails open when npm metadata lookup fails or times out", async () => {
    const failed = createJscpdUpdateNoticeService({
      environment: {},
      currentVersionEffect: Effect.succeed("0.2.0"),
      latestVersionEffect: Effect.fail(new Error("registry unavailable")),
    });
    const timedOut = createJscpdUpdateNoticeService({
      environment: {},
      currentVersionEffect: Effect.succeed("0.2.0"),
      latestVersionEffect: Effect.never,
      timeoutMs: 1,
    });

    await expect(Effect.runPromise(failed.noticeEffect)).resolves.toBeUndefined();
    await expect(Effect.runPromise(timedOut.noticeEffect)).resolves.toBeUndefined();
  });

  it("ignores malformed version metadata", async () => {
    const service = noticeService("0.2.0", "not-a-version");

    await expect(Effect.runPromise(service.noticeEffect)).resolves.toBeUndefined();
  });
});
