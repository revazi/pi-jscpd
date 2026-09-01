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
          description: "One scan path scope. The status command accepts no arguments.",
        }),
        {
          maxItems: maxArguments,
          description: "Optional in-project scan scopes; omit for project scan or status.",
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
    "Run a local read-only jscpd v5 scan or inspect bounded binary, configuration, and last-check status.",
  promptSnippet: "Scan for duplicate blocks with jscpd or inspect jscpd status",
  parameters: jscpdRunParams,
} as const;
