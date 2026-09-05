import { constants as fsConstants, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { chmod, mkdtemp, open, realpath, rm, stat, writeFile } from "node:fs/promises";
import { Effect, Layer } from "effect";
import { JscpdFileSystemFailure, JscpdLimitExceeded, JscpdWorkspaceFailure } from "./errors.js";
import {
  type JscpdBoundedReadRequest,
  type JscpdFileMetadata,
  JscpdFileSystem,
  type JscpdFileSystemError,
} from "./services.js";

const MAX_FILESYSTEM_BYTES = 64 * 1_024 * 1_024;

/** Live bounded filesystem implementation shared by configuration and untrusted-data boundaries. */
export const jscpdFileSystemLive: JscpdFileSystem = {
  canonicalize: (path) =>
    Effect.tryPromise({
      try: () => realpath(path),
      catch: (error) => fileSystemFailure("canonicalize", error),
    }),
  metadata: (path) =>
    Effect.tryPromise({
      try: async () => metadataFrom(await stat(path)),
      catch: (error) => fileSystemFailure("metadata", error),
    }),
  read: readBoundedFile,
  write: (request) => {
    if (!isValidByteBound(request.maxBytes) || request.bytes.byteLength > request.maxBytes) {
      return Effect.fail(new JscpdLimitExceeded({ subject: "state" }));
    }
    return Effect.tryPromise({
      try: () => writeFile(request.path, request.bytes, { mode: request.mode }),
      catch: (error) => fileSystemFailure("write", error),
    });
  },
  makeTempDirectory: makeSecureTempDirectory,
  remove: (path, recursive) =>
    Effect.tryPromise({
      try: () =>
        rm(path, {
          recursive,
          force: true,
          maxRetries: recursive ? 2 : 0,
          retryDelay: recursive ? 10 : 100,
        }),
      catch: (error) => fileSystemFailure("remove", error),
    }),
};

export const JscpdFileSystemLive = Layer.succeed(JscpdFileSystem, jscpdFileSystemLive);

function makeSecureTempDirectory(
  prefix: string,
): Effect.Effect<string, JscpdWorkspaceFailure | JscpdFileSystemFailure> {
  return Effect.tryPromise({
    try: () => mkdtemp(prefix),
    catch: () => new JscpdWorkspaceFailure({ operation: "create" }),
  }).pipe(
    Effect.flatMap((directory) =>
      Effect.tryPromise({
        try: () => chmod(directory, 0o700),
        catch: () => new JscpdWorkspaceFailure({ operation: "create" }),
      }).pipe(
        Effect.as(directory),
        Effect.catchAll((error) =>
          Effect.tryPromise({
            try: () => rm(directory, { recursive: true, force: true }),
            catch: () => fileSystemFailure("remove", undefined),
          }).pipe(
            Effect.catchAll(() => Effect.void),
            Effect.zipRight(Effect.fail(error)),
          ),
        ),
      ),
    ),
  );
}

function readBoundedFile(
  request: JscpdBoundedReadRequest,
): Effect.Effect<Uint8Array, JscpdFileSystemError> {
  if (!isValidReadRequest(request)) {
    return Effect.fail(new JscpdFileSystemFailure({ operation: "read", reason: "io" }));
  }
  const flags = fsConstants.O_RDONLY | (request.noFollow ? fsConstants.O_NOFOLLOW : 0);
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => open(request.path, flags),
      catch: (error) => fileSystemFailure("read", error),
    }),
    (file) => readFromHandle(file, request),
    closeFile,
  );
}

function readFromHandle(
  file: FileHandle,
  request: JscpdBoundedReadRequest,
): Effect.Effect<Uint8Array, JscpdFileSystemError> {
  return Effect.tryPromise({
    try: () => readValidatedFile(file, request),
    catch: (error) => readFailure(error),
  });
}

async function readValidatedFile(
  file: FileHandle,
  request: JscpdBoundedReadRequest,
): Promise<Uint8Array> {
  const metadata = await file.stat();
  assertRegularFile(metadata, request.regularFileOnly);
  const offset = request.offset ?? 0;
  const capacity = readCapacity(metadata.size, offset, request);
  const bytes = Buffer.alloc(capacity);
  const total = await fillBuffer(file, bytes, offset);
  assertValidReadLength(total, request);
  return bytes.subarray(0, total);
}

function assertRegularFile(metadata: Stats, regularFileOnly: boolean): void {
  if (regularFileOnly && !metadata.isFile()) {
    throw new JscpdFileSystemFailure({ operation: "read", reason: "not-regular" });
  }
}

function readCapacity(fileSize: number, offset: number, request: JscpdBoundedReadRequest): number {
  const requestedLength = request.length;
  if (offset > fileSize || (requestedLength !== undefined && offset + requestedLength > fileSize)) {
    throw new JscpdFileSystemFailure({ operation: "read", reason: "io" });
  }
  if (requestedLength === undefined && fileSize - offset > request.maxBytes) {
    throw new JscpdLimitExceeded({ subject: request.limitSubject });
  }
  return requestedLength ?? request.maxBytes + 1;
}

function assertValidReadLength(total: number, request: JscpdBoundedReadRequest): void {
  if (request.length !== undefined && total !== request.length) {
    throw new JscpdFileSystemFailure({ operation: "read", reason: "io" });
  }
  if (total > request.maxBytes) {
    throw new JscpdLimitExceeded({ subject: request.limitSubject });
  }
}

async function fillBuffer(file: FileHandle, bytes: Buffer, offset: number): Promise<number> {
  let total = 0;
  while (total < bytes.byteLength) {
    const read = await file.read(bytes, total, bytes.byteLength - total, offset + total);
    if (read.bytesRead === 0) break;
    total += read.bytesRead;
  }
  return total;
}

function closeFile(file: FileHandle): Effect.Effect<void> {
  return Effect.tryPromise({
    try: () => file.close(),
    catch: (error) => fileSystemFailure("read", error),
  }).pipe(Effect.orDie);
}

function metadataFrom(metadata: Stats): JscpdFileMetadata {
  const kind = metadata.isFile()
    ? "file"
    : metadata.isDirectory()
      ? "directory"
      : metadata.isSymbolicLink()
        ? "symlink"
        : "other";
  return { kind, size: metadata.size };
}

function isValidReadRequest(request: JscpdBoundedReadRequest): boolean {
  const offset = request.offset ?? 0;
  return (
    isValidByteBound(request.maxBytes) &&
    Number.isSafeInteger(offset) &&
    offset >= 0 &&
    (request.length === undefined ||
      (Number.isSafeInteger(request.length) &&
        request.length >= 0 &&
        request.length <= request.maxBytes &&
        Number.isSafeInteger(offset + request.length)))
  );
}

function isValidByteBound(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_FILESYSTEM_BYTES;
}

function readFailure(error: unknown): JscpdFileSystemError {
  return error instanceof JscpdFileSystemFailure || error instanceof JscpdLimitExceeded
    ? error
    : fileSystemFailure("read", error);
}

function fileSystemFailure(
  operation: JscpdFileSystemFailure["operation"],
  error: unknown,
): JscpdFileSystemFailure {
  const code = errorCode(error);
  const reason = isMissingCode(operation, code)
    ? "missing"
    : code === "EACCES" || code === "EPERM"
      ? "permission"
      : code === "ELOOP"
        ? "symlink"
        : "io";
  return new JscpdFileSystemFailure({ operation, reason });
}

function isMissingCode(
  operation: JscpdFileSystemFailure["operation"],
  code: string | undefined,
): boolean {
  return (
    code === "ENOENT" ||
    code === "ENOTDIR" ||
    (operation === "canonicalize" && process.platform === "win32" && code === "EINVAL")
  );
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}
