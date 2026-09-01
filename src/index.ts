import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Public Pi extension entrypoint.
 *
 * Keep this file as a thin composition root. Detection, baseline comparison,
 * configuration, and presentation should live in focused modules as they are
 * implemented.
 */
export default function jscpdGuardrail(pi: ExtensionAPI): void {
  // The project is intentionally at the scaffold stage. The first milestone
  // will register an on-demand, read-only duplication scan command and tool.
  void pi;
}
