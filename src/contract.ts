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
          description: "One existing in-project file or directory scope. Options are not accepted.",
        }),
        {
          maxItems: maxArguments,
          description: "Optional in-project scan scopes. Omit to scan the whole project.",
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
    "Run a local read-only jscpd v5 duplication scan for the project or selected in-project file and directory scopes.",
  promptSnippet: "Scan the project or selected in-project paths for duplicate blocks with jscpd",
  parameters: jscpdRunParams,
} as const;
