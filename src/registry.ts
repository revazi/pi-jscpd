interface JscpdCommandSpec {
  name: string;
  description: string;
  argumentHint: string;
  maxArguments: number;
}

export const JSCPD_MAX_ARGUMENT_LENGTH = 1_024;

export const jscpdCommandRegistry = [
  {
    name: "scan",
    description: "Request an explicit duplication scan",
    argumentHint: "[target ...]",
    maxArguments: 32,
  },
  {
    name: "changed",
    description: "Show unacknowledged new duplication involving session changes",
    argumentHint: "",
    maxArguments: 0,
  },
  {
    name: "status",
    description: "Show binary, configuration, and last-check status",
    argumentHint: "",
    maxArguments: 0,
  },
  {
    name: "off",
    description: "Disable jscpd behavior for the current session",
    argumentHint: "",
    maxArguments: 0,
  },
  {
    name: "on",
    description: "Re-enable jscpd behavior for the current session",
    argumentHint: "",
    maxArguments: 0,
  },
  {
    name: "help",
    description: "Show jscpd commands and session controls",
    argumentHint: "",
    maxArguments: 0,
  },
] as const satisfies readonly JscpdCommandSpec[];

type RegisteredJscpdCommandSpec = (typeof jscpdCommandRegistry)[number];
export type JscpdCommand = RegisteredJscpdCommandSpec["name"];

export const jscpdCommandNames = jscpdCommandRegistry.map(({ name }) => name);

const commandSpecsByName = new Map<JscpdCommand, RegisteredJscpdCommandSpec>(
  jscpdCommandRegistry.map((spec) => [spec.name, spec]),
);

export const jscpdArgumentHint = `[${jscpdCommandRegistry.map(commandUsage).join("|")}]`;

const jscpdCommandCompletions = jscpdCommandRegistry.map((spec) => ({
  value: spec.name,
  label: commandUsage(spec),
  description: spec.description,
}));

function commandUsage(spec: RegisteredJscpdCommandSpec): string {
  return spec.argumentHint ? `${spec.name} ${spec.argumentHint}` : spec.name;
}

export function renderJscpdCommandHelp(): string {
  const commands = jscpdCommandRegistry.map(
    (spec) => `  /jscpd ${commandUsage(spec)} — ${spec.description}`,
  );
  return [
    "jscpd commands",
    ...commands,
    "  /jscpd — reserved for the future interactive overlay (no scan)",
  ].join("\n");
}

export function getJscpdCommandSpec(command: string): RegisteredJscpdCommandSpec | undefined {
  return commandSpecsByName.get(command as JscpdCommand);
}

export function getJscpdArgumentCompletions(prefix: string) {
  const commandPrefix = prefix.trimStart();
  if (/\s/.test(commandPrefix)) return null;

  const matches = jscpdCommandCompletions.filter(({ value }) => value.startsWith(commandPrefix));
  return matches.length > 0 ? matches : null;
}
