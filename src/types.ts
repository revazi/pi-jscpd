import type { JscpdCommand } from "./registry.js";

export type { JscpdCommand } from "./registry.js";

export interface JscpdCommandInvocation {
  command: JscpdCommand;
  args: readonly string[];
}

export interface JscpdExecutionContext {
  cwd: string;
  signal?: AbortSignal;
}

export interface JscpdUnavailableResult {
  status: "unavailable";
  reason: "not-implemented";
  message: string;
}

export interface JscpdCommandExecutor {
  execute(
    invocation: JscpdCommandInvocation,
    context: JscpdExecutionContext,
  ): Promise<JscpdUnavailableResult>;
}

export type JscpdInputErrorCode =
  | "invalid-command"
  | "unsupported-command"
  | "invalid-arguments"
  | "input-too-long"
  | "too-many-arguments"
  | "argument-too-long"
  | "unclosed-quote";

export interface JscpdInputError {
  code: JscpdInputErrorCode;
  message: string;
}

export type JscpdParseResult =
  | { ok: true; invocation: JscpdCommandInvocation }
  | { ok: false; error: JscpdInputError };

export type JscpdSlashParseResult =
  | { ok: true; kind: "bare" }
  | { ok: true; kind: "command"; invocation: JscpdCommandInvocation }
  | { ok: false; error: JscpdInputError };

export type JscpdDispatchResult =
  | JscpdUnavailableResult
  | {
      status: "invalid";
      reason: JscpdInputErrorCode;
      message: string;
    }
  | {
      status: "error";
      reason: "execution-failed";
      message: string;
    };
