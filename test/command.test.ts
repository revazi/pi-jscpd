import { describe, expect, it, vi } from "vitest";
import { dispatchJscpdCommand } from "../src/dispatch.js";
import { parseJscpdCommand, parseJscpdSlashArgs } from "../src/parser.js";
import {
  getJscpdArgumentCompletions,
  jscpdArgumentHint,
  jscpdCommandNames,
  jscpdCommandRegistry,
} from "../src/registry.js";
import type { JscpdCommandExecutor } from "../src/types.js";

const unavailableResult = {
  status: "unavailable",
  reason: "missing-binary",
  message: "Unavailable in test.",
} as const;

describe("jscpd command registry", () => {
  it("is the single source for command names, hints, and completions", () => {
    expect(jscpdCommandRegistry).toEqual([
      {
        name: "scan",
        description: "Request an explicit duplication scan",
        argumentHint: "[target ...]",
        maxArguments: 32,
      },
      {
        name: "status",
        description: "Show binary, configuration, and last-check status",
        argumentHint: "",
        maxArguments: 0,
      },
      {
        name: "off",
        description: "Disable jscpd behavior for the current session",
        argumentHint: "",
        maxArguments: 0,
      },
      {
        name: "on",
        description: "Re-enable jscpd behavior for the current session",
        argumentHint: "",
        maxArguments: 0,
      },
      {
        name: "help",
        description: "Show jscpd commands and session controls",
        argumentHint: "",
        maxArguments: 0,
      },
    ]);
    expect(jscpdCommandNames).toEqual(["scan", "status", "off", "on", "help"]);
    expect(jscpdArgumentHint).toBe("[scan [target ...]|status|off|on|help]");
    expect(getJscpdArgumentCompletions("sc")).toEqual([
      {
        value: "scan",
        label: "scan [target ...]",
        description: "Request an explicit duplication scan",
      },
    ]);
    expect(getJscpdArgumentCompletions("st")).toEqual([
      {
        value: "status",
        label: "status",
        description: "Show binary, configuration, and last-check status",
      },
    ]);
    expect(getJscpdArgumentCompletions("o")).toEqual([
      expect.objectContaining({ value: "off", label: "off" }),
      expect.objectContaining({ value: "on", label: "on" }),
    ]);
    expect(getJscpdArgumentCompletions("h")).toEqual([
      expect.objectContaining({ value: "help", label: "help" }),
    ]);
    expect(getJscpdArgumentCompletions("scan ")).toBeNull();
    expect(getJscpdArgumentCompletions("unknown")).toBeNull();
  });
});

describe("jscpd command parsing", () => {
  it("keeps scan arguments as shell-free tokens", () => {
    expect(parseJscpdSlashArgs('scan "src/with spaces" src\\ two;words')).toEqual({
      ok: true,
      kind: "command",
      invocation: {
        command: "scan",
        args: ["src/with spaces", "src two;words"],
      },
    });
  });

  it("supports single quotes and concatenated quoted segments", () => {
    expect(parseJscpdSlashArgs('scan \'src/with spaces\' pre" mid"post empty""value')).toEqual({
      ok: true,
      kind: "command",
      invocation: {
        command: "scan",
        args: ["src/with spaces", "pre midpost", "emptyvalue"],
      },
    });
  });

  it("only consumes supported escapes and preserves path backslashes", () => {
    expect(
      parseJscpdSlashArgs(String.raw`scan C:\src "C:\src" path\ with\ spaces "a\"b" don\'t`),
    ).toEqual({
      ok: true,
      kind: "command",
      invocation: {
        command: "scan",
        args: ["C:\\src", "C:\\src", "path with spaces", 'a"b', "don't"],
      },
    });
    expect(parseJscpdSlashArgs("scan trailing\\\\")).toEqual({
      ok: true,
      kind: "command",
      invocation: { command: "scan", args: ["trailing\\"] },
    });
  });

  it("preserves a leading @ instead of treating it as general syntax", () => {
    expect(parseJscpdCommand("scan", ["@src/example.ts"])).toEqual({
      ok: true,
      invocation: { command: "scan", args: ["@src/example.ts"] },
    });
  });

  it("distinguishes bare, scan, and argument-free status commands", () => {
    expect(parseJscpdSlashArgs("   ")).toEqual({ ok: true, kind: "bare" });
    expect(parseJscpdSlashArgs("scan")).toEqual({
      ok: true,
      kind: "command",
      invocation: { command: "scan", args: [] },
    });
    expect(parseJscpdSlashArgs("status")).toEqual({
      ok: true,
      kind: "command",
      invocation: { command: "status", args: [] },
    });
  });

  it.each([
    {
      name: "an unsupported command",
      result: parseJscpdSlashArgs("changed"),
      code: "unsupported-command",
    },
    {
      name: "arguments supplied to status",
      result: parseJscpdSlashArgs("status extra"),
      code: "too-many-arguments",
    },
    {
      name: "an unclosed quote",
      result: parseJscpdSlashArgs('scan "src'),
      code: "unclosed-quote",
    },
    {
      name: "an empty token",
      result: parseJscpdSlashArgs('scan ""'),
      code: "invalid-arguments",
    },
    {
      name: "a non-array args value",
      result: parseJscpdCommand("scan", "src"),
      code: "invalid-arguments",
    },
    {
      name: "a null structured token",
      result: parseJscpdCommand("scan", [null]),
      code: "invalid-arguments",
    },
    {
      name: "a null byte in slash input",
      result: parseJscpdSlashArgs("scan src\0hidden"),
      code: "invalid-arguments",
    },
    {
      name: "too many tokens",
      result: parseJscpdCommand(
        "scan",
        Array.from({ length: 33 }, () => "src"),
      ),
      code: "too-many-arguments",
    },
    {
      name: "an oversized structured token",
      result: parseJscpdCommand("scan", ["x".repeat(1_025)]),
      code: "argument-too-long",
    },
    {
      name: "an oversized slash token",
      result: parseJscpdSlashArgs(`scan ${"x".repeat(1_025)}`),
      code: "argument-too-long",
    },
    {
      name: "oversized slash input",
      result: parseJscpdSlashArgs(" ".repeat(40_000)),
      code: "input-too-long",
    },
  ])("rejects $name", ({ result, code }) => {
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });
});

describe("jscpd command dispatch", () => {
  it("passes an explicit scan through the injected execution boundary", async () => {
    const execute = vi.fn<JscpdCommandExecutor["execute"]>(async () => unavailableResult);

    const result = await dispatchJscpdCommand(
      "scan",
      ["src", "--format", "typescript"],
      { cwd: "/project" },
      { execute },
    );

    expect(execute).toHaveBeenCalledWith(
      { command: "scan", args: ["src", "--format", "typescript"] },
      { cwd: "/project" },
    );
    expect(result).toEqual(unavailableResult);
  });

  it("passes argument-free status through the same execution boundary", async () => {
    const execute = vi.fn<JscpdCommandExecutor["execute"]>(async () => unavailableResult);

    const result = await dispatchJscpdCommand("status", [], { cwd: "/project" }, { execute });

    expect(execute).toHaveBeenCalledWith({ command: "status", args: [] }, { cwd: "/project" });
    expect(result).toEqual(unavailableResult);
  });

  it("does not execute unsupported input", async () => {
    const execute = vi.fn<JscpdCommandExecutor["execute"]>(async () => unavailableResult);

    const result = await dispatchJscpdCommand("changed", [], { cwd: "/project" }, { execute });

    expect(execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "invalid", reason: "unsupported-command" });
  });

  it("fails open with a bounded message when the boundary throws", async () => {
    const execute = vi.fn<JscpdCommandExecutor["execute"]>(async () => {
      throw new Error("sensitive adapter failure");
    });

    const result = await dispatchJscpdCommand("scan", [], { cwd: "/project" }, { execute });

    expect(result).toEqual({
      status: "error",
      reason: "execution-failed",
      message: "The jscpd request failed without interrupting the Pi session.",
    });
  });
});
