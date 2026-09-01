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
          description: "One shell-free argument token. Keep flags and values in separate items.",
        }),
        {
          maxItems: maxArguments,
          description: "Optional shell-free argument tokens passed to the selected operation.",
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
    "Request an explicit local jscpd duplication operation with shell-free argument tokens. Executable compatibility is checked, but scan execution is not implemented yet.",
  promptSnippet: "Check jscpd availability for a scan; scan execution is not implemented yet",
  parameters: jscpdRunParams,
} as const;
