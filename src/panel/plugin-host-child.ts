#!/usr/bin/env bun
// Auxiliar do plugin do projeto (contrato `panel/api.ts`): carrega $D/plugin/panel/api.ts e atende, por JSON em linha (stdin → stdout), as
// chamadas que o painel faria no mesmo processo (rota, ação, sample). Roda como processo à parte, de propósito: o plugin é
// código de terceiros, e assim fica fora do processo do painel (sem o token nem a memória dele) e morre por tempo esgotado
// sem derrubar o servidor. Sai quando o servidor fecha o stdin.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pyRepr } from "../lib/pyjson.ts";
import { PluginRefused, type PluginCtx } from "./plugin-api.ts";

type Dict = Record<string, unknown>;
interface Init {
  dir: string;
  w: string;
  nodeBin: string;
}
interface Request {
  id: number;
  op: string;
  args?: unknown[];
  state?: PluginState;
}
interface PluginState {
  config?: Record<string, string>;
  snapshot?: Dict;
  containers?: string[];
  units?: Record<string, Record<string, string>>;
  unitViews?: Record<string, Dict>;
  unitViewDefault?: Dict;
}

const DEFAULT_RUN_TIMEOUT_S = 8;
const DEFAULT_HTTP_TIMEOUT_S = 1.5;
const MS_PER_S = 1000;

// o canal do protocolo é o stdout de verdade; console.log e process.stdout.write do plugin vão para o log do painel
const protocolOut = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
console.log = console.error;

const reply = (message: Dict): void => void protocolOut(`${JSON.stringify(message)}\n`);

const shQuote = (arg: string): string => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'"'"'`)}'`);
const q = (...args: unknown[]): string => args.map((a) => shQuote(String(a))).join(" ");

function pick<T>(value: T, allowed: Iterable<T>): T {
  if (![...allowed].includes(value)) throw new PluginRefused(`valor fora da lista: ${pyRepr(value)}`);
  return value;
}

function run(argv: string[], timeoutS = DEFAULT_RUN_TIMEOUT_S): string {
  try {
    const done = Bun.spawnSync(argv, { stdout: "pipe", stderr: "ignore", timeout: timeoutS * MS_PER_S });
    return done.exitedDueToTimeout ? "" : done.stdout.toString();
  } catch {
    return "";
  }
}

async function httpStatus(url: string, timeoutS = DEFAULT_HTTP_TIMEOUT_S): Promise<number | null> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(timeoutS * MS_PER_S), redirect: "follow" })).status;
  } catch {
    return null;
  }
}

function makeCtx(init: Init, state: PluginState): PluginCtx {
  const ctx: PluginCtx = {
    D: init.dir, W: init.w, NODE_BIN: init.nodeBin, q, pick, run, httpStatus,
    refuse: (message: string): never => {
      throw new PluginRefused(message);
    },
    config: () => state.config ?? {},
    sh: (name, ...args) => q("bash", join(init.dir, name), ...args),
    snapshot: () => state.snapshot ?? {},
    containers: () => new Set(state.containers ?? []),
  };
  if (state.units) {
    const views = state.unitViews ?? {};
    const fallback = state.unitViewDefault ?? {};
    ctx.units = state.units;
    ctx.unitView = (name) => ({ ...(views[name] ?? fallback) });
  }
  return ctx;
}

type Fn = (...args: unknown[]) => unknown;

async function handle(api: Record<string, Fn>, init: Init, request: Request): Promise<unknown> {
  const ctx = makeCtx(init, request.state ?? {});
  const args = request.args ?? [];
  if (request.op === "route") return await (api[String(args[0])] as Fn)(ctx, args[1]);
  if (request.op === "action") {
    const [title, script, exclusive] = (await (api.action as Fn)(args[0], args[1], ctx)) as unknown[];
    return [String(title), String(script), Boolean(exclusive)];
  }
  if (request.op === "sample") return await (api.sample as Fn)(ctx);
  throw new PluginRefused(`operação desconhecida: ${request.op}`);
}

async function loadApi(root: string): Promise<Record<string, Fn> | undefined> {
  const file = join(root, "panel", "api.ts");
  if (!existsSync(file)) return undefined;
  try {
    const mod = (await import(file)) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(mod).filter(([name, value]) => name !== "default" && !name.startsWith("_") && typeof value === "function")) as Record<string, Fn>;
  } catch (error) {
    // código do plugin: o painel do núcleo sobe mesmo com ele quebrado
    console.error(`plugin: panel/api.ts não carregou (${String(error)}); painel sem as rotas e ações do plugin`);
    return undefined;
  }
}

async function main(): Promise<void> {
  const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
  const first = await lines.next();
  if (first.done) return;
  const init = JSON.parse(first.value) as Init;
  const api = await loadApi(join(init.dir, "plugin"));
  reply({ ready: api !== undefined, functions: api ? Object.keys(api) : [] });
  if (api === undefined) return;
  for (;;) {
    const next = await lines.next();
    if (next.done) return;
    const request = JSON.parse(next.value) as Request;
    try {
      reply({ id: request.id, ok: true, result: await handle(api, init, request) });
    } catch (error) {
      if (error instanceof PluginRefused) reply({ id: request.id, ok: false, kind: "value", message: error.message });
      else {
        // erro do plugin: detalhe só no log, a resposta leva o código
        console.error(`plugin: ${request.op} falhou: ${String(error)}`);
        reply({ id: request.id, ok: false, kind: "plugin" });
      }
    }
  }
}

await main();
process.exit(0);
