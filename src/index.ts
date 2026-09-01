import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerJscpdExtension } from "./extension.js";

/** Public Pi extension entrypoint. */
export default function jscpdGuardrail(pi: ExtensionAPI): void {
  registerJscpdExtension(pi);
}
