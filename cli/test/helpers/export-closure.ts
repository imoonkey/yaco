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

/** Resolve one specifier to a source file under `root`, or null for a Node
 *  builtin, a package dependency, or an unresolvable specifier. */
function resolveUnderRoot(
  spec: string,
  containingFile: string,
  root: string,
): string | null {
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
export function closureOf(entrySource: string, root: string = SRC_ROOT): ClosureFile[] {
  const base = dirname(root);
  const entry = resolve(base, entrySource);
  if (!existsSync(entry)) throw new Error(`export entry not found: ${entrySource}`);

  const seen = new Map<string, ClosureFile>();
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
      if (!next) continue;
      if (seen.has(relative(base, next))) continue;
      queue.push({ abs: next, via: [...via, relative(base, next)] });
    }
  }

  return [...seen.values()].sort((a, b) => a.path.localeCompare(b.path));
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

/** Rule 3 — synchronous process and sleep primitives, by callee name. */
const SYNC_CALLS = new Set([
  "execSync",
  "execFileSync",
  "spawnSync",
  "sleepSync",
]);

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

  const visit = (node: ts.Node): void => {
    if (isProcessMember(node, "env")) collectEnvNames(node, envRead);
    else if (isProcessMember(node, "exit")) violate(node, 2, "process.exit");
    else if (isProcessMember(node, "exitCode")) violate(node, 2, "process.exitCode");
    else if (isProcessMember(node, "stdout")) violate(node, 2, "process.stdout");
    else if (isProcessMember(node, "stderr")) violate(node, 2, "process.stderr");
    else if (isProcessMember(node, "cwd")) violate(node, 1, "process.cwd()");
    else if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "console"
    ) {
      violate(node, 2, `console.${node.name.text}`);
    } else if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name && SYNC_CALLS.has(name)) violate(node, 3, `${name}()`);
      if (name === "wait" && isAtomicsWait(node.expression)) {
        violate(node, 3, "Atomics.wait()");
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);

  return scan;
}

/** `process.<member>`, whether written bare or via `globalThis`. */
function isProcessMember(node: ts.Node, member: string): boolean {
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== member) return false;
  const target = node.expression;
  if (ts.isIdentifier(target)) return target.text === "process";
  return (
    ts.isPropertyAccessExpression(target) &&
    target.name.text === "process" &&
    ts.isIdentifier(target.expression) &&
    target.expression.text === "globalThis"
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

function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

function isAtomicsWait(expr: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "Atomics"
  );
}

/** Source path -> emitted path, by the build's `rootDir: src` / `outDir: dist`
 *  rule. The audit walks source; this is what ties that walk to the artifact a
 *  published consumer actually loads. */
export function emittedPathFor(sourcePath: string, extension: ".js" | ".d.ts"): string {
  const rel = relative(SRC_ROOT, resolve(CLI_ROOT, sourcePath));
  return `./${join("dist", rel.replace(/\.ts$/, extension))}`;
}
