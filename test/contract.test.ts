import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { jscpdRunParams, jscpdToolContract } from "../src/contract.js";
import { jscpdCommandNames } from "../src/registry.js";

describe("jscpd_run contract", () => {
  it("uses the registry command enum and compact command-and-args shape", () => {
    expect(jscpdToolContract.name).toBe("jscpd_run");
    expect(jscpdRunParams.properties.command).toMatchObject({
      type: "string",
      enum: jscpdCommandNames,
    });
    expect(jscpdRunParams.required).toEqual(["command"]);
    expect(
      (jscpdRunParams as typeof jscpdRunParams & { additionalProperties?: boolean })
        .additionalProperties,
    ).toBe(false);
    expect(Object.keys(jscpdRunParams.properties)).toEqual(["command", "args"]);
  });

  it("accepts scan scopes and argument-free status", () => {
    expect(Value.Check(jscpdRunParams, { command: "scan" })).toBe(true);
    expect(
      Value.Check(jscpdRunParams, {
        command: "scan",
        args: ["src/with spaces", "lib/example.ts"],
      }),
    ).toBe(true);
    expect(Value.Check(jscpdRunParams, { command: "status" })).toBe(true);
    expect(Value.Check(jscpdRunParams, { command: "off" })).toBe(true);
    expect(Value.Check(jscpdRunParams, { command: "on" })).toBe(true);
    expect(Value.Check(jscpdRunParams, { command: "help" })).toBe(true);
  });

  it.each([
    { name: "unsupported command", value: { command: "changed" } },
    { name: "missing command", value: { args: [] } },
    { name: "string args", value: { command: "scan", args: "src" } },
    { name: "empty token", value: { command: "scan", args: [""] } },
    {
      name: "too many tokens",
      value: { command: "scan", args: Array.from({ length: 33 }, () => "src") },
    },
    { name: "unknown field", value: { command: "scan", root: "/project" } },
  ])("rejects $name", ({ value }) => {
    expect(Value.Check(jscpdRunParams, value)).toBe(false);
  });
});
