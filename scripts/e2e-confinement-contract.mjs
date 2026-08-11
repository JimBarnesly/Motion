import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { posix } from "node:path";

const IDENTIFIER_START = /[A-Za-z_$]/;
const IDENTIFIER_PART = /[A-Za-z0-9_$]/;
const PLAYWRIGHT_MODULE = /^(?:@playwright\/test|playwright(?:-core)?)(?:\/|$)/;
const FORBIDDEN_BROWSER_BINDINGS = new Set(["browser", "chromium", "firefox", "webkit", "_electron", "playwright"]);
const FORBIDDEN_CONTEXT_METHODS = new Set(["newContext", "launch", "launchPersistentContext", "connect", "connectOverCDP"]);

/** A small zero-dependency lexer for the JavaScript subset used by E2E specs. */
export function tokens(source) {
  const result = [];
  for (let index = 0; index < source.length;) {
    const character = source[index];
    if (/\s/.test(character)) { index += 1; continue; }
    if (character === "/" && source[index + 1] === "/") {
      index = source.indexOf("\n", index + 2); if (index < 0) break; continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2); index = end < 0 ? source.length : end + 2; continue;
    }
    if (character === "/" && (!result.length || ["(", "[", "{", ",", ":", "=", "=>", "!", "?", "return"].includes(result.at(-1)?.value))) {
      const start = index++; let inClass = false;
      while (index < source.length) {
        if (source[index] === "\\") { index += 2; continue; }
        if (source[index] === "[") inClass = true;
        else if (source[index] === "]") inClass = false;
        else if (source[index] === "/" && !inClass) { index += 1; break; }
        index += 1;
      }
      while (/[A-Za-z]/.test(source[index] ?? "")) index += 1;
      result.push({ kind: "regex", value: source.slice(start, index), start }); continue;
    }
    if (character === '"' || character === "'") {
      const quote = character; let value = ""; const start = index++;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\") { value += source[index + 1] ?? ""; index += 2; }
        else value += source[index++];
      }
      index += Number(source[index] === quote); result.push({ kind: "string", value, start }); continue;
    }
    if (character === "`") {
      const start = index++; let value = ""; let dynamic = false;
      while (index < source.length && source[index] !== "`") {
        if (source[index] === "\\") { value += source[index + 1] ?? ""; index += 2; }
        else if (source[index] === "$" && source[index + 1] === "{") { dynamic = true; value += "${"; index += 2; }
        else value += source[index++];
      }
      index += Number(source[index] === "`"); result.push({ kind: dynamic ? "template" : "string", value, start }); continue;
    }
    if (IDENTIFIER_START.test(character)) {
      const start = index++; while (index < source.length && IDENTIFIER_PART.test(source[index])) index += 1;
      result.push({ kind: "identifier", value: source.slice(start, index), start }); continue;
    }
    const pair = source.slice(index, index + 2);
    if (["=>", "?.", "??", "==", "!=", "<=", ">=", "&&", "||", "++", "--"].includes(pair)) {
      result.push({ kind: "punctuator", value: pair, start: index }); index += 2; continue;
    }
    result.push({ kind: "punctuator", value: character, start: index++ });
  }
  return result;
}

function imports(parsed) {
  const result = [];
  for (let index = 0; index < parsed.length; index += 1) {
    if (parsed[index].value !== "import") continue;
    if (parsed[index + 1]?.value === "(") continue;
    let source;
    let end = index + 1;
    for (; end < parsed.length && parsed[end].value !== ";"; end += 1) {
      if (parsed[end].value === "from" && parsed[end + 1]?.kind === "string") source = parsed[end + 1].value;
      else if (end === index + 1 && parsed[end].kind === "string") source = parsed[end].value;
    }
    const named = [];
    const open = parsed.findIndex((token, at) => at > index && at < end && token.value === "{");
    if (open >= 0) {
      for (let at = open + 1; at < end && parsed[at].value !== "}"; at += 1) {
        if (parsed[at].kind !== "identifier" || parsed[at].value === "type") continue;
        const imported = parsed[at].value;
        const local = parsed[at + 1]?.value === "as" ? parsed[at + 2]?.value : imported;
        named.push({ imported, local });
        at += parsed[at + 1]?.value === "as" ? 2 : 0;
      }
    }
    result.push({ source, named, start: index, end }); index = end;
  }
  return result;
}

function fixturePathFor(spec) {
  const relative = posix.relative(posix.dirname(spec), "e2e/fixtures");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function isFunctionParameter(parsed, index) {
  let depth = 0;
  for (let at = index - 1; at >= 0; at -= 1) {
    if (parsed[at].value === ")") depth += 1;
    else if (parsed[at].value === "(") {
      if (depth) { depth -= 1; continue; }
      const before = parsed[at - 1]?.value;
      return before === "function" || parsed[at - 2]?.value === "function";
    }
    if (!depth && [";", "{", "}"].includes(parsed[at].value)) return false;
  }
  return false;
}

function assertNotShadowed(parsed, binding, spec, importRange) {
  for (let index = 0; index < parsed.length; index += 1) {
    if (index >= importRange.start && index <= importRange.end) continue;
    const token = parsed[index];
    if (token.value !== binding) continue;
    const before = parsed[index - 1]?.value;
    const beforeTwo = parsed[index - 2]?.value;
    const declaration = ["const", "let", "var", "function", "class", "catch"].includes(before)
      || (["{", ",", "("].includes(before) && ["const", "let", "var"].includes(beforeTwo))
      || isFunctionParameter(parsed, index)
      || (parsed[index + 1]?.value === ")" && parsed[index + 2]?.value === "=>")
      || (parsed[index + 1]?.value === "," && parsed.slice(index + 1, index + 8).some(item => item.value === "=>"));
    assert.equal(declaration, false, `${spec} shadows the fixture-bound ${binding}`);
  }
}

export function validateFixtureBindings(source, spec = "e2e/spec.spec.ts") {
  const parsed = tokens(source);
  const declarations = imports(parsed);
  for (const declaration of declarations) {
    assert.ok(!PLAYWRIGHT_MODULE.test(declaration.source ?? ""), `${spec} has a direct @playwright/test import`);
  }
  assert.ok(!parsed.some((token, index) => token.kind === "string" && PLAYWRIGHT_MODULE.test(token.value)
    && ["import", "require"].includes(parsed[index - 2]?.value ?? parsed[index - 1]?.value)), `${spec} loads Playwright directly`);

  const expectedSource = fixturePathFor(spec);
  const fixtureImport = declarations.find(declaration => declaration.source === expectedSource || declaration.source === `${expectedSource}.ts`);
  assert.ok(fixtureImport, `${spec} must use a named import from ${expectedSource}`);
  for (const protectedName of ["test", "expect"]) {
    const binding = fixtureImport.named.find(item => item.imported === protectedName)?.local;
    assert.ok(binding, `${spec} must bind ${protectedName} from ${expectedSource}`);
    assertNotShadowed(parsed, binding, spec, fixtureImport);
    assert.ok(parsed.some((token, index) => token.value === binding && index > fixtureImport.end && ["(", ".", "?."].includes(parsed[index + 1]?.value)),
      `${spec} must use the fixture-bound ${protectedName}`);
  }
}

export function validateNoUnprotectedContexts(source, spec = "spec") {
  const parsed = tokens(source);
  for (const declaration of imports(parsed)) {
    assert.ok(!PLAYWRIGHT_MODULE.test(declaration.source ?? ""), `${spec} has a direct @playwright/test import`);
  }
  for (let index = 0; index < parsed.length; index += 1) {
    const token = parsed[index];
    if (token.kind === "identifier" && FORBIDDEN_BROWSER_BINDINGS.has(token.value)) {
      assert.fail(`${spec} creates an implicit unprotected BrowserContext or browser launch via ${token.value}`);
    }
    if ((token.kind === "identifier" || token.kind === "string") && FORBIDDEN_CONTEXT_METHODS.has(token.value)) {
      assert.fail(`${spec} creates an unprotected BrowserContext or browser launch`);
    }
  }
}

export function e2eSpecsFromTracked(tracked) {
  const outside = tracked.filter(file => file.endsWith(".spec.ts") && !file.startsWith("e2e/"));
  assert.deepEqual(outside, [], `Playwright specs must live below e2e/:\n${outside.join("\n")}`);
  return tracked.filter(file => /^e2e\/(?:.+\/)*[^/]+\.spec\.ts$/.test(file)).sort();
}

export function trackedE2eSpecs(root = new URL("../", import.meta.url)) {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  return e2eSpecsFromTracked(tracked);
}
