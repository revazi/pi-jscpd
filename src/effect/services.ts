import { Context, type Effect } from "effect";
import type {
  JscpdDeliveryFailure,
  JscpdFileSystemFailure,
  JscpdLimitExceeded,
  JscpdOperationCancelled,
  JscpdOperationTimedOut,
  JscpdPersistenceFailure,
  JscpdProcessFailure,
  JscpdWorkspaceFailure,
} from "./errors.js";

export interface JscpdProcessRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface JscpdProcessResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

export type JscpdProcessRunError =
  | JscpdProcessFailure
  | JscpdOperationCancelled
  | JscpdOperationTimedOut
  | JscpdLimitExceeded;

/** Shell-free, bounded execution whose implementation owns process-tree cleanup. */
export interface JscpdProcess {
  readonly run: (
    request: JscpdProcessRequest,
  ) => Effect.Effect<JscpdProcessResult, JscpdProcessRunError>;
}

export const JscpdProcess = Context.GenericTag<JscpdProcess>("pi-jscpd/effect/Process");

export interface JscpdBoundedReadRequest {
  readonly path: string;
  readonly maxBytes: number;
  readonly regularFileOnly: boolean;
  readonly noFollow: boolean;
}

export interface JscpdBoundedWriteRequest {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly maxBytes: number;
  readonly mode: number;
}

export interface JscpdFileMetadata {
  readonly kind: "file" | "directory" | "symlink" | "other";
  readonly size: number;
}

export type JscpdFileSystemError = JscpdFileSystemFailure | JscpdLimitExceeded;

/** Bounded filesystem capabilities; callers never receive an unbounded stream. */
export interface JscpdFileSystem {
  readonly canonicalize: (path: string) => Effect.Effect<string, JscpdFileSystemFailure>;
  readonly metadata: (path: string) => Effect.Effect<JscpdFileMetadata, JscpdFileSystemFailure>;
  readonly read: (
    request: JscpdBoundedReadRequest,
  ) => Effect.Effect<Uint8Array, JscpdFileSystemError>;
  readonly write: (request: JscpdBoundedWriteRequest) => Effect.Effect<void, JscpdFileSystemError>;
  readonly makeTempDirectory: (
    prefix: string,
  ) => Effect.Effect<string, JscpdWorkspaceFailure | JscpdFileSystemFailure>;
  readonly remove: (
    path: string,
    recursive: boolean,
  ) => Effect.Effect<void, JscpdFileSystemFailure>;
}

export const JscpdFileSystem = Context.GenericTag<JscpdFileSystem>("pi-jscpd/effect/FileSystem");

/** Explicit time dependency for timeout, scheduling, and lifecycle tests. */
export interface JscpdClock {
  readonly now: Effect.Effect<number>;
  readonly sleep: (milliseconds: number) => Effect.Effect<void>;
}

export const JscpdClock = Context.GenericTag<JscpdClock>("pi-jscpd/effect/Clock");

export interface JscpdPiMessage {
  readonly customType: string;
  readonly content: string;
  readonly display: boolean;
  readonly details?: unknown;
}

export interface JscpdPiNotification {
  readonly message: string;
  readonly level: "info" | "warning" | "error";
}

/** Narrow host callbacks needed by application workflows; no Pi UI types leak below adapters. */
export interface JscpdPiPort {
  readonly appendSessionEntry: (
    customType: string,
    data: unknown,
  ) => Effect.Effect<void, JscpdPersistenceFailure>;
  readonly sendMessage: (
    message: JscpdPiMessage,
    triggerTurn: false,
  ) => Effect.Effect<void, JscpdDeliveryFailure>;
  readonly notify: (notification: JscpdPiNotification) => Effect.Effect<void, JscpdDeliveryFailure>;
  readonly setStatus: (
    key: string,
    text: string | undefined,
  ) => Effect.Effect<void, JscpdDeliveryFailure>;
}

export const JscpdPiPort = Context.GenericTag<JscpdPiPort>("pi-jscpd/effect/PiPort");
