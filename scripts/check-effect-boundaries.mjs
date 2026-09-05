import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
const sourceRoot = join(root, "src");

/** Explicit managed Pi/test runtime adapter; no lower module may execute Effect directly. */
export const APPROVED_EFFECT_RUNTIME_BOUNDARIES = Object.freeze(["src/effect/runtime-boundary.ts"]);

export const MIGRATED_FILESYSTEM_BOUNDARIES = Object.freeze([
  "src/changed-files.ts",
  "src/clone-identity.ts",
  "src/config.ts",
  "src/effect/filesystem.ts",
  "src/fallow.ts",
  "src/jscpd-report.ts",
  "src/jscpd.ts",
  "src/path-utils.ts",
  "src/scan.ts",
]);

export const EFFECT_ONLY_SERVICE_BOUNDARIES = Object.freeze([
  "src/automatic.ts",
  "src/scheduler.ts",
  "src/types.ts",
  "src/scan.ts",
  "src/changed.ts",
  "src/status.ts",
  "src/baseline.ts",
  "src/capability.ts",
  "src/process.ts",
  "src/changed-files.ts",
  "src/clone-identity.ts",
  "src/config.ts",
  "src/fallow.ts",
  "src/jscpd-report.ts",
  "src/jscpd.ts",
]);

export const MIGRATED_APPLICATION_BOUNDARIES = Object.freeze([
  "src/baseline.ts",
  "src/changed.ts",
  "src/fallow.ts",
  "src/scan.ts",
  "src/status.ts",
  "src/verification.ts",
]);

export const MIGRATED_CONCURRENCY_BOUNDARIES = Object.freeze([
  "src/automatic.ts",
  "src/scheduler.ts",
]);

const APPROVED_NODE_FILESYSTEM_BOUNDARIES = Object.freeze(["src/effect/filesystem.ts"]);
export const APPROVED_PROMISE_WORKFLOW_BOUNDARIES = Object.freeze([
  "src/effect/filesystem.ts",
  "src/extension.ts",
  "src/overlay.ts",
]);
const UNMANAGED_ASYNC_CALLS = new Set([
  "queueMicrotask",
  "setImmediate",
  "setInterval",
  "setTimeout",
]);
const PROMISE_CHAIN_METHODS = new Set(["catch", "finally", "then"]);

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  checkEffectBoundaries();
}

export function checkEffectBoundaries() {
  const violations = [];
  const filesystemViolations = [];
  const concurrencyViolations = [];
  const applicationViolations = [];
  const sourcePromiseViolations = [];
  const serviceViolations = [];
  let runtimeCalls = 0;
  let managedRuntimeCreations = 0;
  for (const absolutePath of typescriptFiles(sourceRoot)) {
    const path = relative(root, absolutePath).replaceAll("\\", "/");
    const sourceText = readFileSync(absolutePath, "utf8");
    const calls = findEffectRuntimeCalls(sourceText, path);
    runtimeCalls += calls.length;
    managedRuntimeCreations += findManagedRuntimeCreations(sourceText, path).length;
    if (!APPROVED_EFFECT_RUNTIME_BOUNDARIES.includes(path)) violations.push(...calls);
    if (
      MIGRATED_FILESYSTEM_BOUNDARIES.includes(path) &&
      !APPROVED_NODE_FILESYSTEM_BOUNDARIES.includes(path)
    ) {
      filesystemViolations.push(...findNodeFileSystemImports(sourceText, path));
    }
    if (MIGRATED_CONCURRENCY_BOUNDARIES.includes(path)) {
      concurrencyViolations.push(...findUnmanagedAsyncConstructs(sourceText, path));
    }
    if (!APPROVED_PROMISE_WORKFLOW_BOUNDARIES.includes(path)) {
      sourcePromiseViolations.push(...findPromiseWorkflowConstructs(sourceText, path));
    }
    if (MIGRATED_APPLICATION_BOUNDARIES.includes(path)) {
      applicationViolations.push(...findPromiseWorkflowConstructs(sourceText, path));
    }
    if (EFFECT_ONLY_SERVICE_BOUNDARIES.includes(path)) {
      serviceViolations.push(...findServiceExecutionBridges(sourceText, path));
      applicationViolations.push(...findPromiseWorkflowConstructs(sourceText, path));
    }
  }
  assert.deepEqual(
    violations,
    [],
    `Effect runtime calls are allowed only in ${APPROVED_EFFECT_RUNTIME_BOUNDARIES.join(", ")}:\n${violations
      .map(({ path, line, name }) => `- ${path}:${line} ${name}`)
      .join("\n")}`,
  );
  assert.deepEqual(
    serviceViolations,
    [],
    `Effect-only services must not depend on runners or Promise contracts: ${JSON.stringify(serviceViolations)}`,
  );
  assert.equal(
    managedRuntimeCreations,
    1,
    "Source must contain exactly one ManagedRuntime.make production factory.",
  );
  assert.deepEqual(
    filesystemViolations,
    [],
    `Migrated filesystem modules must use src/effect/filesystem.ts:\n${filesystemViolations
      .map(({ path, line, moduleName }) => `- ${path}:${line} ${moduleName}`)
      .join("\n")}`,
  );
  assert.deepEqual(
    concurrencyViolations,
    [],
    `Migrated concurrency modules must not create unmanaged Promise/timer work:\n${concurrencyViolations
      .map(({ path, line, name }) => `- ${path}:${line} ${name}`)
      .join("\n")}`,
  );
  assert.deepEqual(
    applicationViolations,
    [],
    `Migrated application modules must not retain async/Promise-chain orchestration:\n${applicationViolations
      .map(({ path, line, name }) => `- ${path}:${line} ${name}`)
      .join("\n")}`,
  );
  assert.deepEqual(
    sourcePromiseViolations,
    [],
    `Promise workflow orchestration is confined to reviewed host/infrastructure boundaries:\n${sourcePromiseViolations
      .map(({ path, line, name }) => `- ${path}:${line} ${name}`)
      .join("\n")}`,
  );
  console.log(
    `Effect boundary check passed: ${runtimeCalls} direct runtime calls and ${managedRuntimeCreations} managed-runtime factory in ${APPROVED_EFFECT_RUNTIME_BOUNDARIES.join(", ")}; ${MIGRATED_FILESYSTEM_BOUNDARIES.length - APPROVED_NODE_FILESYSTEM_BOUNDARIES.length} migrated modules use the shared filesystem layer; ${MIGRATED_CONCURRENCY_BOUNDARIES.length} migrated concurrency modules contain no unmanaged Promise/timer creation; Promise workflows are confined to ${APPROVED_PROMISE_WORKFLOW_BOUNDARIES.length} reviewed host/infrastructure boundaries.`,
  );
}

export function findServiceExecutionBridges(sourceText, path = "fixture.ts") {
  return findNamedSyntax(sourceText, path, (node) => {
    if (isRuntimeDependency(node)) return "runtime dependency";
    if (
      ts.isTypeReferenceNode(node) &&
      ts.isIdentifier(node.typeName) &&
      node.typeName.text === "Promise"
    ) {
      return "Promise contract";
    }
    if (ts.isCallExpression(node)) {
      const member = memberParts(node.expression);
      if (member && ["runPromise", "runPromiseExit", "runSync", "runFork"].includes(member.name)) {
        return `execution bridge: ${member.name}`;
      }
    }
    return undefined;
  });
}

function isRuntimeDependency(node) {
  if (!ts.isStringLiteral(node) || !/(?:^|\/)runtime-(?:boundary|contract)\.[jt]s$/.test(node.text))
    return false;
  const parent = node.parent;
  return (
    ts.isImportDeclaration(parent) ||
    ts.isExportDeclaration(parent) ||
    (ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.ImportKeyword)
  );
}

export function findManagedRuntimeCreations(sourceText, path = "fixture.ts") {
  return findNamedSyntax(sourceText, path, (node) => {
    if (!ts.isCallExpression(node)) return undefined;
    const member = memberParts(node.expression);
    return member &&
      member.name === "make" &&
      ts.isIdentifier(member.receiver) &&
      member.receiver.text === "ManagedRuntime"
      ? "ManagedRuntime.make"
      : undefined;
  });
}

export function findPromiseWorkflowConstructs(sourceText, path = "fixture.ts") {
  return findNamedSyntax(sourceText, path, promiseWorkflowName);
}

function promiseWorkflowName(node) {
  if (hasAsyncModifier(node)) return "async function";
  if (isPromiseConstruction(node)) return "new Promise";
  return ts.isCallExpression(node) ? promiseCallName(node.expression) : undefined;
}

function isPromiseConstruction(node) {
  return (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "Promise"
  );
}

function promiseCallName(expression) {
  const member = memberParts(expression);
  if (!member) return undefined;
  if (PROMISE_CHAIN_METHODS.has(member.name)) return `Promise.${member.name}`;
  return ts.isIdentifier(member.receiver) && member.receiver.text === "Promise"
    ? `Promise.${member.name}`
    : undefined;
}

function hasAsyncModifier(node) {
  if (
    !ts.isFunctionDeclaration(node) &&
    !ts.isFunctionExpression(node) &&
    !ts.isArrowFunction(node) &&
    !ts.isMethodDeclaration(node)
  ) {
    return false;
  }
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
}

export function findUnmanagedAsyncConstructs(sourceText, path = "fixture.ts") {
  return findNamedSyntax(sourceText, path, unmanagedAsyncName);
}

function findNamedSyntax(sourceText, path, classify) {
  const source = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const findings = [];
  walk(source, (node) => {
    const name = classify(node);
    if (!name) return;
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    findings.push(Object.freeze({ path, line: line + 1, name }));
  });
  return findings;
}

function unmanagedAsyncName(node) {
  if (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "Promise"
  ) {
    return "new Promise";
  }
  return ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    UNMANAGED_ASYNC_CALLS.has(node.expression.text)
    ? node.expression.text
    : undefined;
}

export function findNodeFileSystemImports(sourceText, path = "fixture.ts") {
  const source = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const imports = [];
  walk(source, (node) => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return;
    const moduleName = node.moduleSpecifier.text;
    if (moduleName !== "node:fs" && moduleName !== "node:fs/promises") return;
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    imports.push(Object.freeze({ path, line: line + 1, moduleName }));
  });
  return imports;
}

/** Find actual Effect run calls through supported imports; comments and string literals are ignored. */
export function findEffectRuntimeCalls(sourceText, path = "fixture.ts") {
  const source = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const checker = createTypeChecker(source);
  const classify = createEffectClassifier(checker);
  return collectRuntimeCalls(source, path, classify);
}

function createTypeChecker(source) {
  const options = { noLib: true, noResolve: true };
  const host = ts.createCompilerHost(options);
  const loadDefaultSource = host.getSourceFile;
  host.getSourceFile = (fileName, ...args) =>
    fileName === source.fileName ? source : loadDefaultSource(fileName, ...args);
  return ts.createProgram([source.fileName], options, host).getTypeChecker();
}

function createEffectClassifier(checker) {
  const cache = new Map();
  const active = new Set();
  return (expression) => classifyExpression(expression, checker, cache, active);
}

function classifyExpression(expression, checker, cache, active) {
  if (ts.isParenthesizedExpression(expression)) {
    return classifyExpression(expression.expression, checker, cache, active);
  }
  if (ts.isIdentifier(expression)) {
    return classifySymbol(checker.getSymbolAtLocation(expression), checker, cache, active);
  }
  const member = memberParts(expression);
  return member ? classifyEffectMember(member, checker, cache, active) : undefined;
}

function classifySymbol(symbol, checker, cache, active) {
  if (!symbol) return undefined;
  if (cache.has(symbol)) return cache.get(symbol);
  if (active.has(symbol)) return undefined;
  active.add(symbol);
  const classification = classifyDeclarations(symbol.declarations, checker, cache, active);
  active.delete(symbol);
  cache.set(symbol, classification);
  return classification;
}

function classifyDeclarations(declarations, checker, cache, active) {
  for (const declaration of declarations ?? []) {
    const classification = classifyDeclaration(declaration, checker, cache, active);
    if (classification) return classification;
  }
  return undefined;
}

function classifyDeclaration(declaration, checker, cache, active) {
  if (ts.isImportSpecifier(declaration)) return classifyImportSpecifier(declaration);
  if (ts.isNamespaceImport(declaration)) return classifyNamespaceImport(declaration);
  if (ts.isVariableDeclaration(declaration)) {
    return classifyVariableAlias(declaration, checker, cache, active);
  }
  if (ts.isBindingElement(declaration)) {
    return classifyDestructuredAlias(declaration, checker, cache, active);
  }
  return undefined;
}

function classifyImportSpecifier(specifier) {
  const details = effectImportDetails(specifier);
  if (!details || isTypeOnlyImport(specifier)) return undefined;
  const imported = specifier.propertyName?.text ?? specifier.name.text;
  if (details.moduleName === "effect" && imported === "Effect") return effectObject();
  return isRuntimeRunner(imported) ? effectRunner(imported) : undefined;
}

function classifyNamespaceImport(namespaceImport) {
  const details = effectImportDetails(namespaceImport);
  if (!details || details.importClause.isTypeOnly) return undefined;
  return details.moduleName === "effect" ? effectPackageNamespace() : effectObject();
}

function effectImportDetails(node) {
  const declaration = findAncestor(node, ts.isImportDeclaration);
  if (!declaration || !ts.isStringLiteral(declaration.moduleSpecifier)) return undefined;
  const moduleName = declaration.moduleSpecifier.text;
  if (moduleName !== "effect" && moduleName !== "effect/Effect") return undefined;
  return declaration.importClause
    ? { moduleName, importClause: declaration.importClause }
    : undefined;
}

function isTypeOnlyImport(specifier) {
  const importClause = findAncestor(specifier, ts.isImportDeclaration)?.importClause;
  return specifier.isTypeOnly || importClause?.isTypeOnly;
}

function classifyVariableAlias(declaration, checker, cache, active) {
  return declaration.initializer
    ? classifyExpression(declaration.initializer, checker, cache, active)
    : undefined;
}

function classifyDestructuredAlias(element, checker, cache, active) {
  if (!ts.isIdentifier(element.name) || element.dotDotDotToken) return undefined;
  const declaration = findAncestor(element, ts.isVariableDeclaration);
  if (!declaration?.initializer) return undefined;
  const receiver = classifyExpression(declaration.initializer, checker, cache, active);
  const propertyName = bindingPropertyName(element);
  return classifyDestructuredMember(receiver, propertyName);
}

function bindingPropertyName(element) {
  return element.propertyName ? propertyNameText(element.propertyName) : element.name.text;
}

function classifyDestructuredMember(receiver, propertyName) {
  if (receiver?.kind === "effectObject" && isRuntimeRunner(propertyName)) {
    return effectRunner(propertyName);
  }
  return receiver?.kind === "effectPackageNamespace" && propertyName === "Effect"
    ? effectObject()
    : undefined;
}

function classifyEffectMember(member, checker, cache, active) {
  const receiver = classifyExpression(member.receiver, checker, cache, active);
  if (receiver?.kind === "effectObject" && isRuntimeRunner(member.name)) {
    return effectRunner(member.name);
  }
  return receiver?.kind === "effectPackageNamespace" && member.name === "Effect"
    ? effectObject()
    : undefined;
}

function effectObject() {
  return { kind: "effectObject" };
}

function effectPackageNamespace() {
  return { kind: "effectPackageNamespace" };
}

function effectRunner(name) {
  return { kind: "effectRunner", name };
}

function collectRuntimeCalls(source, path, classify) {
  const calls = [];
  walk(source, (node) => collectRuntimeCall(node, source, path, classify, calls));
  return calls;
}

function collectRuntimeCall(node, source, path, classify, calls) {
  if (!ts.isCallExpression(node)) return;
  const classification = classify(node.expression);
  if (classification?.kind !== "effectRunner") return;
  const { line } = source.getLineAndCharacterOfPosition(node.expression.getStart(source));
  calls.push(Object.freeze({ path, line: line + 1, name: classification.name }));
}

function findAncestor(node, predicate) {
  let current = node.parent;
  while (current && !predicate(current)) current = current.parent;
  return current;
}

function memberParts(node) {
  if (ts.isPropertyAccessExpression(node)) {
    return { receiver: node.expression, name: node.name.text };
  }
  if (ts.isElementAccessExpression(node) && node.argumentExpression) {
    const name = propertyNameText(node.argumentExpression);
    return name ? { receiver: node.expression, name } : undefined;
  }
  return undefined;
}

function propertyNameText(node) {
  return ts.isIdentifier(node) ||
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : undefined;
}

function isRuntimeRunner(name) {
  return /^run[A-Z][A-Za-z0-9]*$/.test(name);
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function typescriptFiles(directory) {
  const paths = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...typescriptFiles(path));
    else if (entry.isFile() && extname(entry.name) === ".ts") paths.push(path);
  }
  return paths.sort();
}
