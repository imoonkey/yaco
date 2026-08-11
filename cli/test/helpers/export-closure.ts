/** Transitive production import closure of the package exports, built with the
 *  TypeScript compiler rather than a regular-expression scan.
 *
 *  A regex audit is defeated by the two things this file exists to catch: a
 *  barrel that re-exports a forbidden module (`export { x } from "./tmux.ts"`
 *  is an edge, not an import statement) and a type-only import (which is *not*
 *  an edge and must not be counted). Both are one AST node kind away from each
 *  other in source text, so the compiler's own parser and module resolver are
 *  the only honest way to walk the graph.
 *
 *  Edge rules, and why:
 *    - `import type ... from` / `export type ... from` are erased entirely, so
 *      they are not edges.
 *    - `import { type A } from "m"` is NOT erased under `verbatimModuleSyntax`
 *      (it emits `import {} from "m"`, a side-effect import), so it IS an edge.
 *      Inline type modifiers therefore do not hide a module.
 *    - `export ... from` is an edge; that is the re-export hole.
 *    - `import("m")` with a literal specifier is an edge: laziness changes when
 *      a module loads, not whether it is part of the shipped closure.
 */

import ts from "typescript";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export const CLI_ROOT = resolve(import.meta.dirname, "../..");
const SRC_ROOT = join(CLI_ROOT, "src");

export interface ExportEntry {
  /** Subpath as written in the exports map, e.g. `./core/task`. */
  subpath: string;
  /** `development` condition target — the TypeScript source entry. */
  source: string;
  /** `default` condition target — the emitted JS a published consumer loads. */
  emitted: string;
  /** `types` condition target. */
  types: string;
}

/** The exports map, as the audit's entry points. */
export function packageExports(): ExportEntry[] {
  const manifest = JSON.parse(
    readFileSync(join(CLI_ROOT, "package.json"), "utf-8"),
  ) as { exports: Record<string, Record<string, string>> };

  return Object.entries(manifest.exports).map(([subpath, conditions]) => {
    const source = conditions["development"];
    const emitted = conditions["default"];
    const types = conditions["types"];
    if (!source || !emitted || !types) {
      throw new Error(
        `export "${subpath}" must declare development, types and default conditions`,
      );
    }
    return { subpath, source, emitted, types };
  });
}

/** One file in a closure, with the import chain that reached it. */
export interface ClosureFile {
  /** Path relative to `cli/`, e.g. `src/lib/core/task/store.ts`. */
  path: string;
  /** Entry-to-file chain, relative paths, inclusive of both ends. */
  via: string[];
}

export interface Closure {
  files: ClosureFile[];
  /** Every specifier the walk could not follow into first-party source: Node
   *  builtins and package dependencies. Reported rather than dropped — a module
   *  the walker silently treats as a leaf is a module nothing audits. */
  externals: string[];
}

interface Parsed {
  file: ts.SourceFile;
  specifiers: string[];
}

const compilerOptions = loadCompilerOptions();

function loadCompilerOptions(): ts.CompilerOptions {
  const configPath = join(CLI_ROOT, "tsconfig.json");
  const { config, error } = ts.readConfigFile(configPath, (p) =>
    readFileSync(p, "utf-8"),
  );
  if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
  return ts.parseJsonConfigFileContent(config, ts.sys, CLI_ROOT).options;
}

const parseCache = new Map<string, Parsed>();

function parse(absPath: string): Parsed {
  const cached = parseCache.get(absPath);
  if (cached) return cached;

  const file = ts.createSourceFile(
    absPath,
    readFileSync(absPath, "utf-8"),
    ts.ScriptTarget.ESNext,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const parsed: Parsed = { file, specifiers: runtimeSpecifiers(file) };
  parseCache.set(absPath, parsed);
  return parsed;
}

/** Every module specifier that survives to runtime — see the edge rules above. */
function runtimeSpecifiers(file: ts.SourceFile): string[] {
  const out: string[] = [];

  for (const stmt of file.statements) {
    if (ts.isImportDeclaration(stmt)) {
      if (stmt.importClause?.isTypeOnly) continue;
      out.push((stmt.moduleSpecifier as ts.StringLiteral).text);
    } else if (ts.isExportDeclaration(stmt)) {
      if (stmt.isTypeOnly || !stmt.moduleSpecifier) continue;
      out.push((stmt.moduleSpecifier as ts.StringLiteral).text);
    }
    // `import x = require("m")` needs no case: `verbatimModuleSyntax` on an ESM
    // source makes it a compile error, so the typecheck gate rejects it first.
  }

  // Dynamic `import("...")` can appear anywhere, including inside a function.
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteral(arg)) out.push(arg.text);
      else {
        throw new Error(
          `${relative(CLI_ROOT, file.fileName)}: dynamic import with a computed specifier cannot be audited`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);

  return out;
}

/** `@yaco/cli/core/task` -> the source file the audit knows that name by.
 *
 *  A self-import resolves through the package map to `dist/**.d.ts`, which is
 *  outside the source root and would otherwise be dropped as if it were a
 *  third-party leaf — even though shipped Node loads the corresponding JS. */
function resolveSelfImport(spec: string): string | null {
  if (!spec.startsWith("@yaco/cli/")) return null;
  const subpath = `.${spec.slice("@yaco/cli".length)}`;
  const entry = packageExports().find((e) => e.subpath === subpath);
  if (!entry) throw new Error(`self-import of an undeclared subpath: ${spec}`);
  return resolve(CLI_ROOT, entry.source);
}

/** Resolve one specifier to a source file under `root`, or null for a Node
 *  builtin, a package dependency, or an unresolvable specifier. */
function resolveUnderRoot(
  spec: string,
  containingFile: string,
  root: string,
): string | null {
  const self = resolveSelfImport(spec);
  if (self) return self;

  const { resolvedModule } = ts.resolveModuleName(
    spec,
    containingFile,
    compilerOptions,
    ts.sys,
  );
  const file = resolvedModule?.resolvedFileName;
  if (!file || !file.startsWith(root + "/")) return null;
  return file;
}

/** Transitive first-party closure of one entry, breadth-first so `via` is a
 *  shortest chain.
 *
 *  `root` bounds the walk to first-party source and is also what reported paths
 *  are made relative to (via its parent), so the audit's own self-test can run
 *  the identical walker over a temporary fixture tree. */
export function closureOf(entrySource: string, root: string = SRC_ROOT): Closure {
  const base = dirname(root);
  const entry = resolve(base, entrySource);
  if (!existsSync(entry)) throw new Error(`export entry not found: ${entrySource}`);

  const seen = new Map<string, ClosureFile>();
  const externals = new Set<string>();
  const queue: { abs: string; via: string[] }[] = [
    { abs: entry, via: [relative(base, entry)] },
  ];

  while (queue.length > 0) {
    const { abs, via } = queue.shift()!;
    const rel = relative(base, abs);
    if (seen.has(rel)) continue;
    seen.set(rel, { path: rel, via });

    for (const spec of parse(abs).specifiers) {
      const next = resolveUnderRoot(spec, abs, root);
      if (!next) {
        externals.add(spec);
        continue;
      }
      if (seen.has(relative(base, next))) continue;
      queue.push({ abs: next, via: [...via, relative(base, next)] });
    }
  }

  return {
    files: [...seen.values()].sort((a, b) => a.path.localeCompare(b.path)),
    externals: [...externals].sort(),
  };
}

/** The names one export entry actually publishes, resolved by the compiler so
 *  a re-export chain is followed to its origin. Pinning these is what keeps a
 *  mutation from re-entering a barrel unnoticed; the file census cannot, since
 *  the module is already in the closure for its read half. */
export function exportedNames(entrySource: string): string[] {
  const entry = resolve(CLI_ROOT, entrySource);
  const program = ts.createProgram([entry], compilerOptions);
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  if (!source) throw new Error(`export entry not in program: ${entrySource}`);
  const symbol = checker.getSymbolAtLocation(source);
  if (!symbol) throw new Error(`export entry has no module symbol: ${entrySource}`);
  return checker
    .getExportsOfModule(symbol)
    .map((s) => s.getName())
    .sort();
}

export interface Finding {
  /** Path relative to `cli/`. */
  path: string;
  line: number;
  /** Eligibility rule number from the design's Export eligibility section. */
  rule: number;
  detail: string;
}

export interface EnvRead {
  /** Path relative to `cli/`. */
  path: string;
  line: number;
  name: string;
}

export interface FileScan {
  /** Every ambient environment name the file reads, for the caller to judge
   *  against the allowlist. */
  envReads: EnvRead[];
  /** Rule 1-3 breaches that need no allowlist to judge. */
  violations: Finding[];
}

/** Ambient process-wide roots an exported closure may read (design rule 1). */
export const AMBIENT_ENV_ALLOWLIST = [
  "YACO_HOME",
  "HOME",
  "YACO_AGENT_SESSIONS_DIR",
] as const;

/** Rule 3 — synchronous process and sleep primitives. Matched both where they
 *  are imported (so an alias cannot hide one) and where they are called (so a
 *  namespace import cannot either). */
const SYNC_CALLS = new Set([
  "execSync",
  "execFileSync",
  "spawnSync",
  "sleepSync",
]);

/** Rule 5's grep-checkable half — synchronous directory enumeration, which is
 *  input-sized by definition. `readFileSync` is deliberately absent: rule 5
 *  admits single bounded reads of a known file. */
const SYNC_ENUMERATION = new Set(["readdirSync", "globSync", "cpSync"]);

/** Rule 2 — members whose use means the module owns the process. */
const PROCESS_OWNERSHIP: Record<string, number> = {
  exit: 2,
  exitCode: 2,
  stdout: 2,
  stderr: 2,
  // Rule 1: the repo root of a request is an argument, not an ambient read.
  cwd: 1,
};

/** Every rule-1..3 finding in one file. Rules 4-6 are behavioural and are
 *  covered by the interface and concurrency tests, not by this scan. */
export function scanFile(absPath: string, root: string = SRC_ROOT): FileScan {
  const { file } = parse(absPath);
  const path = relative(dirname(root), absPath);
  const scan: FileScan = { envReads: [], violations: [] };

  const at = (node: ts.Node): number =>
    file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const violate = (node: ts.Node, rule: number, detail: string): void => {
    scan.violations.push({ path, line: at(node), rule, detail });
  };
  const envRead = (node: ts.Node, name: string | null): void => {
    if (name === null) {
      // An audit that cannot see the name cannot bound the ambient surface, so
      // an opaque read is itself the breach.
      violate(node, 1, "process.env read with no literal name");
      return;
    }
    scan.envReads.push({ path, line: at(node), name });
  };

  // An alias is the cheapest way to defeat a name-matching scan, so the
  // forbidden primitives are caught where they enter the module.
  for (const stmt of file.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const original = (element.propertyName ?? element.name).text;
      if (SYNC_CALLS.has(original)) violate(element, 3, `import ${original}`);
      if (SYNC_ENUMERATION.has(original)) violate(element, 5, `import ${original}`);
    }
  }

  const visit = (node: ts.Node): void => {
    const member = memberOnProcess(node);
    if (member !== undefined) {
      if (member === null) violate(node, 2, "process[<computed member>]");
      else if (member === "env") collectEnvNames(node, envRead);
      else {
        const rule = PROCESS_OWNERSHIP[member];
        if (rule) violate(node, rule, `process.${member}`);
      }
    } else if (isDestructuredProcess(node)) {
      // `const { stdout } = process` hands the banned member a local name.
      violate(node, 2, "process destructured");
    } else if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "console"
    ) {
      violate(node, 2, `console.${node.name.text}`);
    } else if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name && SYNC_CALLS.has(name)) violate(node, 3, `${name}()`);
      if (name && SYNC_ENUMERATION.has(name)) violate(node, 5, `${name}()`);
      if (name === "wait" && isNamespacedCall(node.expression, "Atomics")) {
        violate(node, 3, "Atomics.wait()");
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);

  return scan;
}

/** The member name this node reads off `process`: a string for a literal one,
 *  `null` for a computed one, `undefined` when the node is not a process
 *  member access at all. Property and element access are both handled — the
 *  latter is what makes `process["exit"]` no cheaper than `process.exit`. */
function memberOnProcess(node: ts.Node): string | null | undefined {
  if (ts.isPropertyAccessExpression(node)) {
    return isProcess(node.expression) ? node.name.text : undefined;
  }
  if (ts.isElementAccessExpression(node)) {
    if (!isProcess(node.expression)) return undefined;
    const key = node.argumentExpression;
    return ts.isStringLiteral(key) ? key.text : null;
  }
  return undefined;
}

/** `process`, bare or reached through `globalThis`. */
function isProcess(expr: ts.Expression): boolean {
  if (ts.isIdentifier(expr)) return expr.text === "process";
  if (ts.isPropertyAccessExpression(expr)) {
    return expr.name.text === "process" && isGlobalThis(expr.expression);
  }
  if (ts.isElementAccessExpression(expr)) {
    const key = expr.argumentExpression;
    return (
      ts.isStringLiteral(key) && key.text === "process" && isGlobalThis(expr.expression)
    );
  }
  return false;
}

const isGlobalThis = (expr: ts.Expression): boolean =>
  ts.isIdentifier(expr) && expr.text === "globalThis";

function isDestructuredProcess(node: ts.Node): boolean {
  return (
    ts.isVariableDeclaration(node) &&
    !!node.initializer &&
    isProcess(node.initializer) &&
    ts.isObjectBindingPattern(node.name)
  );
}

/** Every environment variable name read through one `process.env` node.
 *
 *  Anything that does not name a literal — a computed key, a spread, or handing
 *  the whole object to a child process — reports a null name, which the caller
 *  treats as the breach it is. */
function collectEnvNames(
  node: ts.Node,
  emit: (node: ts.Node, name: string | null) => void,
): void {
  const parent = node.parent;

  if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
    emit(parent, parent.name.text);
    return;
  }
  if (ts.isElementAccessExpression(parent) && parent.expression === node) {
    const key = parent.argumentExpression;
    emit(parent, ts.isStringLiteral(key) ? key.text : null);
    return;
  }
  if (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === node &&
    ts.isObjectBindingPattern(parent.name)
  ) {
    for (const element of parent.name.elements) {
      if (element.dotDotDotToken) {
        emit(element, null);
        continue;
      }
      const key = element.propertyName ?? element.name;
      emit(element, ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : null);
    }
    return;
  }
  emit(node, null);
}

/** The name being called, through a bare identifier, a namespace member, or a
 *  string-keyed member — `cp["spawnSync"]()` must not read differently from
 *  `cp.spawnSync()`. */
function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (ts.isElementAccessExpression(expr)) {
    const key = expr.argumentExpression;
    return ts.isStringLiteral(key) ? key.text : null;
  }
  return null;
}

function isNamespacedCall(expr: ts.Expression, namespace: string): boolean {
  const target = ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)
    ? expr.expression
    : null;
  return !!target && ts.isIdentifier(target) && target.text === namespace;
}

/** Source path -> emitted path, by the build's `rootDir: src` / `outDir: dist`
 *  rule. The audit walks source; this is what ties that walk to the artifact a
 *  published consumer actually loads. */
export function emittedPathFor(sourcePath: string, extension: ".js" | ".d.ts"): string {
  const rel = relative(SRC_ROOT, resolve(CLI_ROOT, sourcePath));
  return `./${join("dist", rel.replace(/\.ts$/, extension))}`;
}
