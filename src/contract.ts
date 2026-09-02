import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { JSCPD_MAX_ARGUMENT_LENGTH, jscpdCommandNames, jscpdCommandRegistry } from "./registry.js";

const maxArguments = Math.max(
  ...jscpdCommandRegistry.map(({ maxArguments: commandMaximum }) => commandMaximum),
);

export const jscpdRunParams = Type.Object(
  {
    command: StringEnum(jscpdCommandNames, {
      description: "The jscpd operation to request.",
    }),
    args: Type.Optional(
      Type.Array(
        Type.String({
          minLength: 1,
          maxLength: JSCPD_MAX_ARGUMENT_LENGTH,
          description: "One scan path scope. Other commands accept no arguments.",
        }),
        {
          maxItems: maxArguments,
          description:
            "Optional in-project scan scopes; omit for a full scan or argument-free command.",
        },
      ),
    ),
  },
  { additionalProperties: false },
);

export const jscpdToolContract = {
  name: "jscpd_run",
  label: "jscpd",
  description:
    "Run a local read-only jscpd v5 scan, show new session duplication, or inspect bounded status.",
  promptSnippet: "Scan for duplicate blocks or show new session duplication with jscpd",
  parameters: jscpdRunParams,
} as const;
