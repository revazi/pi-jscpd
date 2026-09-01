import {
  getJscpdCommandSpec,
  JSCPD_MAX_ARGUMENT_LENGTH,
  jscpdCommandNames,
  jscpdCommandRegistry,
} from "./registry.js";
import type { JscpdInputError, JscpdParseResult, JscpdSlashParseResult } from "./types.js";

const MAX_ARGUMENTS = Math.max(...jscpdCommandRegistry.map(({ maxArguments }) => maxArguments));
const MAX_SLASH_INPUT_LENGTH = (MAX_ARGUMENTS + 1) * (JSCPD_MAX_ARGUMENT_LENGTH + 1);

export function parseJscpdCommand(command: unknown, args?: unknown): JscpdParseResult {
  if (typeof command !== "string" || command.length === 0) {
    return invalid("invalid-command", "A jscpd command is required.");
  }

  const spec = getJscpdCommandSpec(command);
  if (!spec) {
    return invalid(
      "unsupported-command",
      `Unsupported jscpd command. Supported commands: ${jscpdCommandNames.join(", ")}.`,
    );
  }

  if (args !== undefined && !Array.isArray(args)) {
    return invalid(
      "invalid-arguments",
      "Arguments must be provided as an array of shell-free string tokens.",
    );
  }

  const tokens = args === undefined ? [] : args;
  if (tokens.length > spec.maxArguments) {
    return invalid(
      "too-many-arguments",
      `${spec.name} accepts at most ${spec.maxArguments} argument tokens.`,
    );
  }

  for (const token of tokens) {
    if (typeof token !== "string" || token.length === 0 || token.includes("\0")) {
      return invalid(
        "invalid-arguments",
        "Argument tokens must be non-empty strings without null bytes.",
      );
    }
    if (token.length > JSCPD_MAX_ARGUMENT_LENGTH) {
      return invalid(
        "argument-too-long",
        `Argument tokens must not exceed ${JSCPD_MAX_ARGUMENT_LENGTH} characters.`,
      );
    }
  }

  return { ok: true, invocation: { command: spec.name, args: [...tokens] } };
}

export function parseJscpdSlashArgs(rawArgs: string): JscpdSlashParseResult {
  if (rawArgs.length > MAX_SLASH_INPUT_LENGTH) {
    return invalid("input-too-long", "The /jscpd argument text is too long.");
  }

  const tokenized = tokenize(rawArgs);
  if (!tokenized.ok) return tokenized;
  if (tokenized.tokens.length === 0) return { ok: true, kind: "bare" };

  const [command, ...args] = tokenized.tokens;
  const parsed = parseJscpdCommand(command, args);
  if (!parsed.ok) return parsed;
  return { ok: true, kind: "command", invocation: parsed.invocation };
}

interface TokenizeResult {
  ok: true;
  tokens: string[];
}

type TokenQuote = "'" | '"';

interface TokenizerState {
  tokens: string[];
  current: string;
  quote: TokenQuote | undefined;
  tokenStarted: boolean;
}

function tokenize(input: string): TokenizeResult | { ok: false; error: JscpdInputError } {
  const state = createTokenizerState();
  for (let index = 0; index < input.length; index += 1) {
    index = consumeTokenCharacter(state, input, index);
  }

  if (state.quote) return invalid("unclosed-quote", "Unclosed quote in /jscpd arguments.");
  flushToken(state);
  return { ok: true, tokens: state.tokens };
}

function createTokenizerState(): TokenizerState {
  return { tokens: [], current: "", quote: undefined, tokenStarted: false };
}

function consumeTokenCharacter(state: TokenizerState, input: string, index: number): number {
  const char = input[index] ?? "";
  if (state.quote) return consumeQuotedCharacter(state, input, index, char);
  return consumeUnquotedCharacter(state, input, index, char);
}

function consumeQuotedCharacter(
  state: TokenizerState,
  input: string,
  index: number,
  char: string,
): number {
  if (char === state.quote) {
    state.quote = undefined;
    return index;
  }
  if (state.quote === '"' && char === "\\") {
    return consumeEscape(state, input, index, isDoubleQuotedEscape);
  }
  state.current += char;
  return index;
}

function consumeUnquotedCharacter(
  state: TokenizerState,
  input: string,
  index: number,
  char: string,
): number {
  if (isTokenWhitespace(char)) {
    flushToken(state);
    return index;
  }

  state.tokenStarted = true;
  if (isQuote(char)) {
    state.quote = char;
    return index;
  }
  if (char === "\\") return consumeEscape(state, input, index, isUnquotedEscape);
  state.current += char;
  return index;
}

function consumeEscape(
  state: TokenizerState,
  input: string,
  index: number,
  canEscape: (char: string) => boolean,
): number {
  const next = input[index + 1];
  if (next !== undefined && canEscape(next)) {
    state.current += next;
    return index + 1;
  }
  state.current += "\\";
  return index;
}

function flushToken(state: TokenizerState): void {
  if (!state.tokenStarted) return;
  state.tokens.push(state.current);
  state.current = "";
  state.tokenStarted = false;
}

function isQuote(char: string): char is TokenQuote {
  return char === "'" || char === '"';
}

function isDoubleQuotedEscape(char: string): boolean {
  return char === '"' || char === "\\";
}

function isUnquotedEscape(char: string): boolean {
  return isTokenWhitespace(char) || isQuote(char) || char === "\\";
}

function isTokenWhitespace(char: string): boolean {
  return /\s/.test(char);
}

function invalid(
  code: JscpdInputError["code"],
  message: string,
): { ok: false; error: JscpdInputError } {
  return { ok: false, error: { code, message } };
}
