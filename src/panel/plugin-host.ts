// Cliente do auxiliar do plugin: sobe só se existe $D/plugin/panel/api.ts (auxiliar: plugin-host-child.ts).
// Fala JSON em linha e morre com o servidor (o stdin fecha). Uma chamada por vez: o plugin é código de terceiros.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PanelEnv } from "./env.ts";
import { log } from "./log.ts";

type Dict = Record<string, unknown>;

export class PluginError extends Error {}
/** O plugin recusou o pedido com ValueError: a mensagem é dele e vai ao cliente como 400. */
export class PluginRefused extends Error {}

export interface PluginState {
  config: Record<string, string>;
  snapshot: Dict;
  containers: string[];
  units?: Record<string, Record<string, string>>;
  unitViews?: Record<string, Dict>;
  unitViewDefault?: Dict;
}

export interface PluginHost {
  /** nomes que o plugin exporta; indefinido sem api ou se não carregou */
  functions: ReadonlySet<string> | undefined;
  route(fn: string, data: Dict, state: PluginState): Promise<unknown>;
  action(name: string, body: Dict, state: PluginState): Promise<[string, string, boolean]>;
  sample(state: PluginState): Promise<Dict>;
  stop(): void;
}

const CALL_TIMEOUT_MS = 30_000;

interface Reply {
  id?: number;
  ready?: boolean;
  functions?: string[];
  ok?: boolean;
  result?: unknown;
  kind?: string;
  message?: string;
}

const isReply = (v: unknown): v is Reply => typeof v === "object" && v !== null;

const HOST_CHILD_TS = join(import.meta.dirname, "plugin-host-child.ts");

export const apiTsFile = (env: PanelEnv): string => join(env.dir, "plugin", "panel", "api.ts");
export const apiPyFile = (env: PanelEnv): string => join(env.dir, "plugin", "panel", "api.py");

/** O plugin instalado tem `api.ts`? O `api.py` (contrato anterior à 5.0.0) já não é carregado: o painel avisa no log. */
export const hasPluginApi = (env: PanelEnv): boolean => existsSync(apiTsFile(env));

const NO_HOST: PluginHost = {
  functions: undefined,
  route: () => Promise.reject(new PluginError("route")),
  action: () => Promise.reject(new PluginError("action")),
  sample: () => Promise.resolve({}),
  stop: () => undefined,
};

export async function startPluginHost(env: PanelEnv, wantApi: boolean, callTimeoutMs = CALL_TIMEOUT_MS): Promise<PluginHost> {
  if (wantApi && !hasPluginApi(env) && existsSync(apiPyFile(env))) {
    log("warn", "plugin: api.py não é mais carregado (contrato core >=5): porte para panel/api.ts; painel sem as rotas e ações do plugin");
  }
  if (!wantApi || !hasPluginApi(env)) return NO_HOST;
  const argv = [process.execPath, HOST_CHILD_TS];
  const initLine = `${JSON.stringify({ dir: env.dir, w: env.worktree, nodeBin: env.nodeBin })}\n`;
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let lines: AsyncGenerator<string> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let nextId = 1;
  let stopped = false;

  async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      let at = buffer.indexOf("\n");
      while (at >= 0) {
        yield buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        at = buffer.indexOf("\n");
      }
    }
  }

  const kill = (): void => {
    proc?.kill();
    proc = undefined;
    lines = undefined;
  };

  async function spawnHost(): Promise<ReadonlySet<string> | undefined> {
    const child = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
    proc = child;
    lines = readLines(child.stdout as ReadableStream<Uint8Array>);
    (child.stdin as import("bun").FileSink).write(initLine);
    await (child.stdin as import("bun").FileSink).flush();
    const first = await lines.next();
    const hello: unknown = first.done ? undefined : JSON.parse(first.value);
    if (!isReply(hello) || hello.ready !== true) {
      kill();
      return undefined;
    }
    return new Set(hello.functions ?? []);
  }

  const known = await spawnHost();
  if (known === undefined) {
    log("warn", `plugin: o auxiliar não carregou o api.ts`);
    return NO_HOST;
  }

  async function exchange(op: string, args: unknown[], state: PluginState): Promise<unknown> {
    if (proc === undefined) {
      // o auxiliar caiu ou foi morto por tempo esgotado: sobe de novo na próxima chamada
      if ((await spawnHost()) === undefined) throw new PluginError(op);
    }
    const child = proc as NonNullable<typeof proc>;
    const id = nextId++;
    const sink = child.stdin as import("bun").FileSink;
    sink.write(`${JSON.stringify({ id, op, args, state })}\n`);
    await sink.flush();
    const timer = setTimeout(kill, callTimeoutMs);
    try {
      const next = await (lines as AsyncGenerator<string>).next();
      if (next.done) throw new PluginError(op);
      const parsed: unknown = JSON.parse(next.value);
      if (!isReply(parsed) || parsed.id !== id) throw new PluginError(op);
      if (parsed.ok === true) return parsed.result;
      if (parsed.kind === "value") throw new PluginRefused(parsed.message ?? "");
      throw new PluginError(op);
    } catch (error) {
      if (error instanceof PluginRefused || error instanceof PluginError) throw error;
      log("warn", "plugin: falha no canal do auxiliar", { op, reason: error instanceof Error ? error.message : String(error) });
      kill();
      throw new PluginError(op);
    } finally {
      clearTimeout(timer);
    }
  }

  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(() => (stopped ? Promise.reject(new PluginError("stopped")) : task()));
    queue = run.catch(() => undefined);
    return run;
  };

  return {
    functions: known,
    route: (fn, data, state) => serial(() => exchange("route", [fn, data], state)),
    action: async (name, body, state) => {
      const out = await serial(() => exchange("action", [name, body], state));
      if (!Array.isArray(out) || out.length !== 3) throw new PluginError("action");
      return [String(out[0]), String(out[1]), Boolean(out[2])];
    },
    sample: async (state) => {
      try {
        const out = await serial(() => exchange("sample", [], state));
        return typeof out === "object" && out !== null && !Array.isArray(out) ? (out as Dict) : {};
      } catch (error) {
        if (error instanceof PluginRefused || error instanceof PluginError) return { error: "plugin_sample" };
        throw error;
      }
    },
    stop: () => {
      stopped = true;
      kill();
    },
  };
}
