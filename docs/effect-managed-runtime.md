# Managed Effect runtime and Pi boundary

Issue [#70](https://github.com/revazi/pi-jscpd/issues/70) completes the runtime
integration slice. Each registered extension instance creates exactly one
`ManagedRuntime` backed by the production process, filesystem, and clock layers.
The runtime is passed to every compatibility facade and host adapter; commands,
tools, lifecycle work, automatic fibers, and overlay actions no longer create or
use independent Effect runtimes.

## Runtime boundary

`src/effect/runtime-boundary.ts` is the only production/test adapter that calls
`Effect.run*` or creates a `ManagedRuntime`. It exposes:

- `createJscpdManagedRuntime()` for one extension-owned production runtime;
- the bounded `JscpdEffectRuntime` host interface used by facades;
- `JscpdTestEffectRuntime` and filesystem helpers for isolated compatibility
  tests only.

The production layer graph supplies `JscpdProcess`, `JscpdFileSystem`, and
`JscpdClock`. Lower modules expose effects and accept the host runner only for
legacy Promise entrypoints. Their native methods retain visible service
requirements, so application effects execute on the extension runtime without a
nested run.

## Commands, tools, and overlay

`dispatchJscpdCommandEffect` parses and executes a command as one effect. Tool and
slash-command adapters submit it to the extension runtime. Native execution is
linked to the Pi `AbortSignal`: aborting races and interrupts the command fiber,
waits for owned finalizers, and maps to the established bounded scan/changed
cancellation result. Legacy injected Promise executors retain their existing
characterized behavior.

The scheduled executor now preserves `executeEffect` and submits explicit scan
work through the scheduler's native `runExplicitEffect`. Consequently a tool,
slash subcommand, non-TUI status fallback, or TUI overlay action performs one
host runtime submission rather than nesting scheduler, status, and scan Promise
facades. The bare overlay still starts with status and never scans implicitly;
RPC, JSON, and print modes remain deterministic and provider-free.

## Lifecycle and shutdown

Session start/tree/switch hooks reuse the same runtime-backed service owners and
retain the existing single reset/invalidation sequence. Baseline, capability,
adapter, changed-file, configuration, Fallow, scheduler, status, and automatic
effectful compatibility methods delegate to their native owner effects through
that runtime, while bounded synchronous state transitions retain their shared
owners.

Shutdown remains idempotent. It invalidates baseline/Fallow/verification state,
closes scheduler-owned fibers and their scope, aborts capability and adapter
work, awaits bounded adapter/process/workspace finalizers, and finally disposes
the managed runtime layer scope. Repeated shutdown events return the same
Promise and do not dispose a second time.

## Conformance

The architecture check permits direct Effect runtime calls only in
`src/effect/runtime-boundary.ts`. `test/effect-managed-runtime.test.ts` proves
that a native tool command makes one runtime submission, Pi cancellation
interrupts the running fiber, and repeated shutdown disposes the runtime once.
The existing extension, overlay, cancellation, process-tree, automatic,
scheduler, RPC, package, and supported-Node tests continue to guard public
behavior and cleanup bounds.
