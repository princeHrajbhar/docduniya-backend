/**
 * Static route analysis for the API documentation generator.
 *
 * Express keeps only closures at runtime, so the request schemas a handler parses cannot be read
 * from the mounted routers. This module reads the route sources with the TypeScript compiler,
 * finds every `router.<method>(path, ...handlers)` registration and, inside its handlers (and the
 * controllers or helpers they call), the Zod schemas applied to `req.body`, `req.query` and
 * `req.params`. Each schema expression is then evaluated in its own module scope, so the result
 * is the exact schema instance the server validates with, not a copy.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

export type RequestPart = 'body' | 'query' | 'params';
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);
const PARSERS = new Set(['parse', 'safeParse', 'parseAsync', 'safeParseAsync']);

export interface SchemaRef {
  scope: FileScope;
  node: ts.Node;
}

export interface RouteFacts {
  file: string;
  routerName: string;
  method: string;
  pathText: string;
  pattern: RegExp;
  /** The module-level router the route is reachable from, and its path relative to it. */
  rootRouter: string;
  rootPattern: RegExp;
  schemas: Partial<Record<RequestPart, SchemaRef>>;
  /** Schemas applied to single path parameters: `schema.parse(param(req, 'type'))`. */
  pathParams: Record<string, SchemaRef>;
  /** Multipart upload field, when an upload middleware runs before the handler. */
  uploadField?: string;
  /** `requirePermission(PERMISSIONS.X)` member names guarding the route. */
  platformPermissionKeys: string[];
  /** Whether the handler reads the `Idempotency-Key` header (`idempotencyKey(req)`). */
  idempotent: boolean;
  /** Functions the handlers call: services, controllers. */
  targets: Array<{ scope: FileScope; node: ts.Node; name: string }>;
}

type ImportBinding = { specifier: string; kind: 'namespace' | 'named' | 'default'; name: string };

export class FileScope {
  readonly sf: ts.SourceFile;
  readonly imports = new Map<string, ImportBinding>();
  /** Top-level declarations: variable initializers and function declarations. */
  readonly locals = new Map<string, ts.Node>();
  readonly values = new Map<string, unknown>();
  readonly pending = new Set<string>();
  defaultExport?: string;

  constructor(readonly file: string) {
    this.sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    for (const statement of this.sf.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const specifier = statement.moduleSpecifier.text;
        const clause = statement.importClause;
        if (!clause || clause.isTypeOnly) continue;
        if (clause.name)
          this.imports.set(clause.name.text, { specifier, kind: 'default', name: 'default' });
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings))
          this.imports.set(bindings.name.text, { specifier, kind: 'namespace', name: '*' });
        else if (bindings)
          for (const element of bindings.elements) {
            if (element.isTypeOnly) continue;
            this.imports.set(element.name.text, {
              specifier,
              kind: 'named',
              name: (element.propertyName ?? element.name).text,
            });
          }
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations)
          if (ts.isIdentifier(declaration.name) && declaration.initializer)
            this.locals.set(declaration.name.text, declaration.initializer);
      } else if (ts.isFunctionDeclaration(statement) && statement.name) {
        this.locals.set(statement.name.text, statement);
      } else if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
        this.defaultExport = statement.expression.text;
      }
    }
  }

  text(node: ts.Node) {
    return node.getText(this.sf);
  }

  resolveModule(specifier: string): string | undefined {
    if (!specifier.startsWith('.')) return undefined;
    const base = resolve(dirname(this.file), specifier);
    for (const candidate of [
      base.replace(/\.js$/u, '.ts'),
      base,
      `${base}.ts`,
      join(base, 'index.ts'),
    ])
      if (existsSync(candidate)) return candidate;
    return undefined;
  }
}

const scopes = new Map<string, FileScope>();
export function scopeOf(file: string): FileScope {
  let scope = scopes.get(file);
  if (!scope) scopes.set(file, (scope = new FileScope(file)));
  return scope;
}

// ── Evaluation ──────────────────────────────────────────────────────────────

async function importValue(scope: FileScope, binding: ImportBinding): Promise<unknown> {
  const local = scope.resolveModule(binding.specifier);
  const mod = (await import(local ? pathToFileURL(local).href : binding.specifier)) as Record<
    string,
    unknown
  >;
  if (binding.kind === 'namespace') return mod;
  return mod[binding.name];
}

async function valueOf(scope: FileScope, name: string): Promise<unknown> {
  if (scope.values.has(name)) return scope.values.get(name);
  if (scope.pending.has(name)) throw new Error(`Circular reference to ${name}`);
  scope.pending.add(name);
  try {
    const binding = scope.imports.get(name);
    let value: unknown;
    if (binding) value = await importValue(scope, binding);
    else {
      const node = scope.locals.get(name);
      if (!node) throw new Error(`Unknown identifier ${name}`);
      value = await evaluate(scope, node);
    }
    scope.values.set(name, value);
    return value;
  } finally {
    scope.pending.delete(name);
  }
}

/** Evaluates a source expression (or function declaration) with its module's bindings in scope. */
export async function evaluate(scope: FileScope, node: ts.Node): Promise<unknown> {
  const names = new Set<string>();
  const visit = (child: ts.Node) => {
    if (ts.isIdentifier(child) && (scope.imports.has(child.text) || scope.locals.has(child.text)))
      names.add(child.text);
    ts.forEachChild(child, visit);
  };
  visit(node);
  const isDeclaration = ts.isFunctionDeclaration(node);
  const source = isDeclaration ? scope.text(node) : `(${scope.text(node)})`;
  const js = ts
    .transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
    })
    .outputText.replace(/^\s*["']use strict["'];?/u, '')
    .replace(/^export\s+/mu, '')
    .trim()
    .replace(/;$/u, '');
  const entries: Array<[string, unknown]> = [];
  for (const name of names)
    if (!(isDeclaration && name === (node as ts.FunctionDeclaration).name?.text))
      entries.push([name, await valueOf(scope, name)]);
  const body = isDeclaration
    ? `${js}; return ${(node as ts.FunctionDeclaration).name!.text};`
    : `return ${js};`;
  // Evaluates this repository's own route sources (never request data).
  return new Function(...entries.map(([name]) => name), body)(
    ...entries.map(([, value]) => value),
  ) as unknown;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

async function evaluatePath(scope: FileScope, node: ts.Expression): Promise<[string, RegExp]> {
  const escape = escapeRegExp;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return [node.text, new RegExp(`^${escape(node.text)}$`, 'u')];
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    let pattern = escape(node.head.text);
    for (const span of node.templateSpans) {
      try {
        const value = await evaluate(scope, span.expression);
        if (typeof value !== 'string') throw new Error('not a string');
        text += value;
        pattern += escape(value);
      } catch {
        text += `{${scope.text(span.expression)}}`;
        pattern += '[^/]+';
      }
      text += span.literal.text;
      pattern += escape(span.literal.text);
    }
    return [text, new RegExp(`^${pattern}$`, 'u')];
  }
  const value = await evaluate(scope, node);
  if (typeof value !== 'string') throw new Error(`Unsupported route path ${scope.text(node)}`);
  return [value, new RegExp(`^${escape(value)}$`, 'u')];
}

// ── Declaration lookup ──────────────────────────────────────────────────────

function functionIn(scope: FileScope, name: string): ts.Node | undefined {
  const node = scope.locals.get(name);
  if (!node) return undefined;
  if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node))
    return node;
  return undefined;
}

/** Resolves a callee such as `service.fn`, an imported `fn` or a local `fn` to its declaration. */
export function resolveFunction(
  scope: FileScope,
  callee: ts.Node,
): { scope: FileScope; node: ts.Node; name: string } | undefined {
  if (ts.isIdentifier(callee)) {
    const local = functionIn(scope, callee.text);
    if (local) return { scope, node: local, name: callee.text };
    const binding = scope.imports.get(callee.text);
    if (binding?.kind === 'named') {
      const file = scope.resolveModule(binding.specifier);
      if (!file) return undefined;
      return exportedFunction(scopeOf(file), binding.name, 0);
    }
    return undefined;
  }
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    const binding = scope.imports.get(callee.expression.text);
    if (binding?.kind !== 'namespace') return undefined;
    const file = scope.resolveModule(binding.specifier);
    if (!file) return undefined;
    return exportedFunction(scopeOf(file), callee.name.text, 0);
  }
  return undefined;
}

/** Finds an exported function, following `export { x } from` and `export * from` re-exports. */
function exportedFunction(
  scope: FileScope,
  name: string,
  depth: number,
): { scope: FileScope; node: ts.Node; name: string } | undefined {
  const local = functionIn(scope, name);
  if (local) return { scope, node: local, name };
  if (depth > 4) return undefined;
  for (const statement of scope.sf.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue;
    const file = scope.resolveModule(statement.moduleSpecifier.text);
    if (!file) continue;
    const clause = statement.exportClause;
    if (!clause) {
      const found = exportedFunction(scopeOf(file), name, depth + 1);
      if (found) return found;
    } else if (ts.isNamedExports(clause)) {
      const element = clause.elements.find((item) => item.name.text === name);
      if (element)
        return exportedFunction(
          scopeOf(file),
          (element.propertyName ?? element.name).text,
          depth + 1,
        );
    }
  }
  return undefined;
}

// ── Handler scanning ────────────────────────────────────────────────────────

const REQUEST_PART = /^req\.(body|query|params)$/u;

function scanHandlers(
  scope: FileScope,
  nodes: readonly ts.Node[],
  facts: RouteFacts,
  depth: number,
  visited: Set<ts.Node>,
) {
  const followFunction = (target: ReturnType<typeof resolveFunction>) => {
    if (!target || isHttpPlumbing(target.name) || visited.has(target.node) || depth > 3) return;
    visited.add(target.node);
    if (depth === 0) record(target);
    scanHandlers(target.scope, [target.node], facts, depth + 1, visited);
  };
  /** Services and controllers count as targets; route-file helpers and HTTP utilities do not. */
  const record = (target: NonNullable<ReturnType<typeof resolveFunction>>) => {
    if (target.scope.file === facts.file || /[\\/]shared[\\/]http[\\/]/u.test(target.scope.file))
      return;
    facts.targets.push(target);
  };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const first = node.arguments[0];
      if (ts.isIdentifier(callee) && callee.text === 'idempotencyKey') facts.idempotent = true;
      if (ts.isPropertyAccessExpression(callee) && PARSERS.has(callee.name.text) && first) {
        const part = REQUEST_PART.exec(scope.text(first).replace(/\s+/gu, ''))?.[1] as
          RequestPart | undefined;
        if (part && !facts.schemas[part]) facts.schemas[part] = { scope, node: callee.expression };
        const name = /^param\(req,'(\w+)'\)$/u.exec(scope.text(first).replace(/\s+/gu, ''))?.[1];
        if (name && !facts.pathParams[name])
          facts.pathParams[name] = { scope, node: callee.expression };
      } else if (ts.isIdentifier(callee) && callee.text === 'validate' && first) {
        if (ts.isObjectLiteralExpression(first))
          for (const property of first.properties)
            if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
              const part = property.name.text as RequestPart;
              if (['body', 'query', 'params'].includes(part) && !facts.schemas[part])
                facts.schemas[part] = { scope, node: property.initializer };
            } else if (ts.isShorthandPropertyAssignment(property)) {
              const part = property.name.text as RequestPart;
              if (!facts.schemas[part]) facts.schemas[part] = { scope, node: property.name };
            }
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        ['single', 'array', 'fields'].includes(callee.name.text) &&
        /upload/iu.test(scope.text(callee.expression))
      ) {
        facts.uploadField ??=
          first && ts.isStringLiteral(first)
            ? first.text
            : /name:\s*'(\w+)'/u.exec(scope.text(node))?.[1];
      } else if (ts.isIdentifier(callee) && callee.text === 'requirePermission' && first) {
        const key = /PERMISSIONS\.(\w+)/u.exec(scope.text(first))?.[1];
        if (key) facts.platformPermissionKeys.push(key);
      }
      // Follow calls that receive the request: services, controllers and local helpers.
      if (node.arguments.some((argument) => scope.text(argument) === 'req'))
        followFunction(resolveFunction(scope, callee));
      else if (depth === 0) {
        const target = resolveFunction(scope, callee);
        if (target && !visited.has(target.node) && !isHttpPlumbing(target.name)) {
          visited.add(target.node);
          record(target);
        }
      }
    } else if (depth === 0 && (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node))) {
      // A handler passed by reference (`controller.login`) or a local middleware list.
      const parent = node.parent;
      const isArgument =
        (ts.isCallExpression(parent) && parent.arguments.includes(node as ts.Expression)) ||
        ts.isSpreadElement(parent) ||
        ts.isArrayLiteralExpression(parent);
      if (isArgument) {
        if (ts.isIdentifier(node)) {
          const local = scope.locals.get(node.text);
          if (local && !visited.has(local) && !functionIn(scope, node.text)) {
            visited.add(local);
            if (/upload/iu.test(node.text) && !facts.uploadField)
              facts.uploadField = /name:\s*'(\w+)'/u.exec(scope.text(local))?.[1] ?? 'file';
            scanHandlers(scope, [local], facts, depth, visited);
          }
        }
        const target = resolveFunction(scope, node);
        if (target && !isHttpPlumbing(target.name)) followFunction(target);
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const node of nodes) visit(node);
}

const PLUMBING = new Set([
  'actor',
  'idempotencyKey',
  'idParam',
  'param',
  'ok',
  'noStore',
  'protect',
  'optionalAuth',
  'requirePermission',
  'validate',
]);
const isHttpPlumbing = (name: string) => PLUMBING.has(name);

// ── Route discovery ─────────────────────────────────────────────────────────

function routerVariables(scope: FileScope): Set<string> {
  const names = new Set<string>();
  for (const [name, node] of scope.locals)
    if (ts.isCallExpression(node) && /^(express\.)?Router$/u.test(scope.text(node.expression)))
      names.add(name);
  return names;
}

export async function analyzeRoutes(file: string): Promise<RouteFacts[]> {
  const scope = scopeOf(file);
  const routers = routerVariables(scope);
  const routes: RouteFacts[] = [];
  /** `router.use(...)` guards apply to every route registered after them on that router. */
  const guards = new Map<string, string[]>();
  const mounts = new Map<string, { parent: string; prefix: string }>();
  const calls: ts.CallExpression[] = [];
  const collect = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      routers.has(node.expression.expression.text)
    )
      calls.push(node);
    ts.forEachChild(node, collect);
  };
  collect(scope.sf);
  calls.sort((a, b) => a.getStart() - b.getStart());

  for (const call of calls) {
    const access = call.expression as ts.PropertyAccessExpression;
    const routerName = (access.expression as ts.Identifier).text;
    const method = access.name.text;
    if (method === 'use') {
      const [first] = call.arguments;
      const last = call.arguments[call.arguments.length - 1];
      if (
        first &&
        ts.isStringLiteral(first) &&
        last &&
        ts.isIdentifier(last) &&
        routers.has(last.text)
      )
        mounts.set(last.text, { parent: routerName, prefix: first.text });
      const keys = [...scope.text(call).matchAll(/requirePermission\(\s*PERMISSIONS\.(\w+)/gu)].map(
        (match) => match[1]!,
      );
      if (keys.length) guards.set(routerName, [...(guards.get(routerName) ?? []), ...keys]);
      continue;
    }
    if (!METHODS.has(method) || !call.arguments[0]) continue;
    const [pathText, pattern] = await evaluatePath(scope, call.arguments[0]);
    const facts: RouteFacts = {
      file,
      routerName,
      method,
      pathText,
      pattern,
      rootRouter: routerName,
      rootPattern: pattern,
      schemas: {},
      pathParams: {},
      idempotent: false,
      platformPermissionKeys: [...(guards.get(routerName) ?? [])],
      targets: [],
    };
    scanHandlers(scope, call.arguments.slice(1), facts, 0, new Set());
    routes.push(facts);
  }
  for (const route of routes) {
    let source = route.pattern.source.slice(1, -1);
    let name = route.routerName;
    for (let mount = mounts.get(name); mount; mount = mounts.get(name)) {
      // A sub-router's own '/' route is reachable at the mount path itself.
      source = `${escapeRegExp(mount.prefix)}${source === '\\/' || source === '/' ? '' : source}`;
      name = mount.parent;
    }
    route.rootRouter = name;
    route.rootPattern = new RegExp(`^${source}$`, 'u');
  }
  return routes;
}

export function routeFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.routes\.ts$|[\\/]routes[\\/]index\.ts$/u.test(path)) out.push(path);
    }
  };
  walk(root);
  return out.sort();
}

// ── Service facts ───────────────────────────────────────────────────────────

export type CodeKind = 'organization' | 'platform' | 'patient';

/** Permission codes and the doc comment of a handler's service or controller function. */
export function describeTarget(
  target: { scope: FileScope; node: ts.Node; name: string },
  literalKinds: Map<string, CodeKind>,
  platformKeys: Record<string, string>,
): { codes: Map<string, CodeKind>; summary?: string; returnsCommand: boolean } {
  const codes = new Map<string, CodeKind>();
  const visited = new Set<ts.Node>();
  /** A code literal counts only where it is a value, never a type or a query-filter field. */
  const isCheck = (node: ts.Node) => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isTypeNode(parent)) return false;
      if (ts.isPropertyAssignment(parent) || ts.isArrayLiteralExpression(parent)) return false;
      if (ts.isCallExpression(parent) || ts.isVariableDeclaration(parent)) return true;
      if (ts.isBlock(parent) || ts.isSourceFile(parent)) return true;
    }
    return true;
  };
  const walk = (scope: FileScope, root: ts.Node, depth: number, crossed: boolean) => {
    if (visited.has(root) || depth > 3) return;
    visited.add(root);
    const visit = (node: ts.Node) => {
      if (
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
        literalKinds.has(node.text) &&
        isCheck(node)
      )
        codes.set(node.text, literalKinds.get(node.text)!);
      else if (
        ts.isPropertyAccessExpression(node) &&
        scope.text(node.expression) === 'PERMISSIONS' &&
        platformKeys[node.name.text]
      )
        codes.set(platformKeys[node.name.text]!, 'platform');
      else if (ts.isCallExpression(node)) {
        // Same-module helpers are followed; an imported module helper (`encounterForWrite`)
        // only one hop, so generic utilities deeper down do not add unrelated codes.
        const callee = resolveFunction(scope, node.expression);
        if (callee && callee.scope === scope) walk(scope, callee.node, depth + 1, crossed);
        else if (callee && !crossed && /[\\/]modules[\\/]/u.test(callee.scope.file))
          walk(callee.scope, callee.node, depth + 1, true);
      }
      ts.forEachChild(node, visit);
    };
    visit(root);
  };
  walk(target.scope, target.node, 0, false);

  const declaration = ts.isFunctionDeclaration(target.node) ? target.node : target.node.parent;
  const docs = ts.getJSDocCommentsAndTags(
    ts.isVariableDeclaration(declaration) ? declaration : (target.node as ts.Node),
  );
  const raw = docs
    .map((doc) =>
      typeof doc.comment === 'string' ? doc.comment : ts.getTextOfJSDocComment(doc.comment),
    )
    .find(Boolean);
  // The function returns `{ id, version }` only when it returns the command result unchanged:
  // `return command(…)`, `return await command(…)` or an arrow body `=> command(…)`.
  const isCommandCall = (expression: ts.Expression | undefined): boolean => {
    let current = expression;
    while (current && (ts.isAwaitExpression(current) || ts.isParenthesizedExpression(current)))
      current = current.expression;
    return Boolean(
      current &&
      ts.isCallExpression(current) &&
      ts.isIdentifier(current.expression) &&
      current.expression.text === 'command',
    );
  };
  const fn = target.node as ts.FunctionLikeDeclaration;
  let returnsCommand = Boolean(fn.body && !ts.isBlock(fn.body) && isCommandCall(fn.body));
  const findReturns = (node: ts.Node) => {
    if (ts.isReturnStatement(node) && isCommandCall(node.expression)) returnsCommand = true;
    // Returns inside nested functions belong to those functions.
    if (!ts.isFunctionLike(node) || node === target.node) ts.forEachChild(node, findReturns);
  };
  findReturns(target.node);
  return { codes, summary: raw?.replace(/\s+/gu, ' ').trim(), returnsCommand };
}
