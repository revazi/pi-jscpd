import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createJscpdManagedRuntime } from "./effect/runtime-boundary.js";
import { registerJscpdExtension } from "./extension.js";

/** Public Pi extension entrypoint. */
export default function jscpdGuardrail(pi: ExtensionAPI): void {
  registerJscpdExtension(pi, { runtime: createJscpdManagedRuntime() });
}
