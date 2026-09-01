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
] as const satisfies readonly JscpdCommandSpec[];

type RegisteredJscpdCommandSpec = (typeof jscpdCommandRegistry)[number];
export type JscpdCommand = RegisteredJscpdCommandSpec["name"];

export const jscpdCommandNames = jscpdCommandRegistry.map(({ name }) => name);

const commandSpecsByName = new Map<JscpdCommand, RegisteredJscpdCommandSpec>(
  jscpdCommandRegistry.map((spec) => [spec.name, spec]),
);

export const jscpdArgumentHint = `[${jscpdCommandRegistry
  .map(({ name, argumentHint }) => `${name} ${argumentHint}`)
  .join("|")}]`;

const jscpdCommandCompletions = jscpdCommandRegistry.map(({ name, description, argumentHint }) => ({
  value: name,
  label: `${name} ${argumentHint}`,
  description,
}));

export function getJscpdCommandSpec(command: string): RegisteredJscpdCommandSpec | undefined {
  return commandSpecsByName.get(command as JscpdCommand);
}

export function getJscpdArgumentCompletions(prefix: string) {
  const commandPrefix = prefix.trimStart();
  if (/\s/.test(commandPrefix)) return null;

  const matches = jscpdCommandCompletions.filter(({ value }) => value.startsWith(commandPrefix));
  return matches.length > 0 ? matches : null;
}
