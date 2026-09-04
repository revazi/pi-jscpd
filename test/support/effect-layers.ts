import { Effect, Layer } from "effect";
import {
  JscpdDeliveryFailure,
  JscpdFileSystemFailure,
  JscpdLimitExceeded,
  JscpdPersistenceFailure,
  JscpdProcessFailure,
  JscpdWorkspaceFailure,
} from "../../src/effect/errors.js";
import {
  type JscpdBoundedReadRequest,
  JscpdClock,
  type JscpdFileMetadata,
  JscpdFileSystem,
  type JscpdFileSystemError,
  type JscpdPiMessage,
  type JscpdPiNotification,
  JscpdPiPort,
  JscpdProcess,
  type JscpdProcessRequest,
  type JscpdProcessResult,
  type JscpdProcessRunError,
} from "../../src/effect/services.js";

export type JscpdProcessTestOutcome =
  | { readonly status: "success"; readonly result: JscpdProcessResult }
  | { readonly status: "failure"; readonly error: JscpdProcessRunError };

export function createJscpdProcessTestLayer(outcomes: readonly JscpdProcessTestOutcome[]) {
  const pending = [...outcomes];
  const requests: JscpdProcessRequest[] = [];
  const service: JscpdProcess = {
    run: (request) =>
      Effect.suspend(() => {
        requests.push(freezeProcessRequest(request));
        const outcome = pending.shift();
        if (!outcome) {
          return Effect.fail(new JscpdProcessFailure({ stage: "scan", reason: "spawn" }));
        }
        return outcome.status === "success"
          ? Effect.succeed(copyProcessResult(outcome.result))
          : Effect.fail(outcome.error);
      }),
  };
  return Object.freeze({
    layer: Layer.succeed(JscpdProcess, service),
    requests,
    remaining: () => pending.length,
  });
}

export interface JscpdFileSystemTestEntry {
  readonly path: string;
  readonly canonicalPath?: string;
  readonly kind?: JscpdFileMetadata["kind"];
  readonly bytes?: Uint8Array;
}

interface StoredTestEntry {
  readonly canonicalPath: string;
  readonly kind: JscpdFileMetadata["kind"];
  readonly bytes: Uint8Array;
}

export function createJscpdFileSystemTestLayer(entries: readonly JscpdFileSystemTestEntry[] = []) {
  const files = new Map<string, StoredTestEntry>(
    entries.map((entry) => [
      entry.path,
      {
        canonicalPath: entry.canonicalPath ?? entry.path,
        kind: entry.kind ?? "file",
        bytes: Uint8Array.from(entry.bytes ?? []),
      },
    ]),
  );
  const operations: string[] = [];
  let temporaryIndex = 0;
  const missing = (operation: JscpdFileSystemFailure["operation"]) =>
    new JscpdFileSystemFailure({ operation, reason: "missing" });
  const service: JscpdFileSystem = {
    canonicalize: (path) =>
      Effect.suspend(() => {
        operations.push(`canonicalize:${path}`);
        const entry = files.get(path);
        return entry ? Effect.succeed(entry.canonicalPath) : Effect.fail(missing("canonicalize"));
      }),
    metadata: (path) =>
      Effect.suspend(() => {
        operations.push(`metadata:${path}`);
        const entry = files.get(path);
        return entry
          ? Effect.succeed({ kind: entry.kind, size: entry.bytes.byteLength })
          : Effect.fail(missing("metadata"));
      }),
    read: (request) =>
      Effect.suspend(() => {
        operations.push(`read:${request.path}`);
        return readTestFile(files.get(request.path), request, missing("read"));
      }),
    write: (request) =>
      Effect.suspend(() => {
        operations.push(`write:${request.path}`);
        if (request.bytes.byteLength > request.maxBytes) {
          return Effect.fail(new JscpdLimitExceeded({ subject: "report" }));
        }
        files.set(request.path, {
          canonicalPath: request.path,
          kind: "file",
          bytes: Uint8Array.from(request.bytes),
        });
        return Effect.void;
      }),
    makeTempDirectory: (prefix) =>
      Effect.suspend(() => {
        operations.push(`temp:${prefix}`);
        if (prefix.length === 0) {
          return Effect.fail(new JscpdWorkspaceFailure({ operation: "create" }));
        }
        temporaryIndex += 1;
        const path = `/test-tmp/${prefix}${temporaryIndex}`;
        files.set(path, { canonicalPath: path, kind: "directory", bytes: new Uint8Array() });
        return Effect.succeed(path);
      }),
    remove: (path, recursive) =>
      Effect.sync(() => {
        operations.push(`remove:${path}:${recursive}`);
        files.delete(path);
      }),
  };
  return Object.freeze({
    layer: Layer.succeed(JscpdFileSystem, service),
    operations,
    bytes: (path: string) => {
      const bytes = files.get(path)?.bytes;
      return bytes ? Uint8Array.from(bytes) : undefined;
    },
  });
}

function readTestFile(
  entry: StoredTestEntry | undefined,
  request: JscpdBoundedReadRequest,
  missing: JscpdFileSystemFailure,
): Effect.Effect<Uint8Array, JscpdFileSystemError> {
  if (!entry) return Effect.fail(missing);
  const safetyFailure = testReadSafetyFailure(entry, request);
  if (safetyFailure) return Effect.fail(safetyFailure);
  const offset = request.offset ?? 0;
  if (offset > entry.bytes.byteLength) {
    return Effect.fail(new JscpdFileSystemFailure({ operation: "read", reason: "io" }));
  }
  const length = request.length ?? entry.bytes.byteLength - offset;
  if (length > request.maxBytes || offset + length > entry.bytes.byteLength) {
    return Effect.fail(new JscpdLimitExceeded({ subject: request.limitSubject }));
  }
  return Effect.succeed(Uint8Array.from(entry.bytes.subarray(offset, offset + length)));
}

function testReadSafetyFailure(
  entry: StoredTestEntry,
  request: JscpdBoundedReadRequest,
): JscpdFileSystemFailure | undefined {
  if (request.noFollow && entry.kind === "symlink") {
    return new JscpdFileSystemFailure({ operation: "read", reason: "symlink" });
  }
  return request.regularFileOnly && entry.kind !== "file"
    ? new JscpdFileSystemFailure({ operation: "read", reason: "not-regular" })
    : undefined;
}

export function createJscpdClockTestLayer(initialMilliseconds = 0) {
  let current = initialMilliseconds;
  const sleeps: number[] = [];
  const service: JscpdClock = {
    now: Effect.sync(() => current),
    sleep: (milliseconds) =>
      Effect.sync(() => {
        sleeps.push(milliseconds);
        current += milliseconds;
      }),
  };
  return Object.freeze({
    layer: Layer.succeed(JscpdClock, service),
    sleeps,
    advance: (milliseconds: number) => {
      current += milliseconds;
    },
    current: () => current,
  });
}

export function createJscpdPiPortTestLayer() {
  const sessionEntries: { customType: string; data: unknown }[] = [];
  const messages: { message: JscpdPiMessage; triggerTurn: false }[] = [];
  const notifications: JscpdPiNotification[] = [];
  const statuses: { key: string; text: string | undefined }[] = [];
  let nextFailure: "persistence" | "delivery" | undefined;
  const delivery = (write: () => void) =>
    Effect.suspend(() => {
      if (nextFailure === "delivery") {
        nextFailure = undefined;
        return Effect.fail(new JscpdDeliveryFailure({ channel: "message" }));
      }
      write();
      return Effect.void;
    });
  const service: JscpdPiPort = {
    appendSessionEntry: (customType, data) =>
      Effect.suspend(() => {
        if (nextFailure === "persistence") {
          nextFailure = undefined;
          return Effect.fail(new JscpdPersistenceFailure({ operation: "append" }));
        }
        sessionEntries.push({ customType, data });
        return Effect.void;
      }),
    sendMessage: (message, triggerTurn) => delivery(() => messages.push({ message, triggerTurn })),
    notify: (notification) => delivery(() => notifications.push(notification)),
    setStatus: (key, text) => delivery(() => statuses.push({ key, text })),
  };
  return Object.freeze({
    layer: Layer.succeed(JscpdPiPort, service),
    sessionEntries,
    messages,
    notifications,
    statuses,
    failNext: (failure: "persistence" | "delivery") => {
      nextFailure = failure;
    },
  });
}

function freezeProcessRequest(request: JscpdProcessRequest): JscpdProcessRequest {
  return Object.freeze({
    ...request,
    args: Object.freeze([...request.args]),
    environment: request.environment ? Object.freeze({ ...request.environment }) : undefined,
  });
}

function copyProcessResult(result: JscpdProcessResult): JscpdProcessResult {
  return Object.freeze({
    exitCode: result.exitCode,
    stdout: Uint8Array.from(result.stdout),
    stderr: Uint8Array.from(result.stderr),
  });
}
