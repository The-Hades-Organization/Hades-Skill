// Base dos testes do widget Android (widget-api, widget-apk, widget-sistema-prs): pasta de dados descartável, painel real
// em processo numa porta livre, pedidos HTTP com `<caso> <status> <código>` e um dublê do coletor de PRs (sem gh, sem rede).
import { copyFileSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { createAuth } from "../../../../src/panel/auth.ts";
import { panelEnv } from "../../../../src/panel/env.ts";
import { type Panel, startPanel } from "../../../../src/panel/server.ts";
import { createWidget, type Widget, type WidgetDeps } from "../../../../src/panel/widget.ts";
import { Rig, SKILL } from "./rig";

export type Dict = Record<string, unknown>;
export const NOW = 1793000000; // 2026-10-26T06:13:20Z
export const STAMP = "2026-10-26T06:00:00Z";
export const PUB = "painel.example.invalid";
export const GIB = 1 << 30;

/** str() do Python sobre o valor: True/False/None. */
export const py = (v: unknown): string => (v === true ? "True" : v === false ? "False" : v === null || v === undefined ? "None" : String(v));
/** json.dumps(sort_keys=True) do Python: separadores ", " e ": ". */
export function pyDump(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(pyDump).join(", ")}]`;
  if (v !== null && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}: ${pyDump((v as Dict)[k])}`).join(", ")}}`;
  return JSON.stringify(v);
}

export const freePort = (): number => { const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") }); const p = s.port as number; s.stop(true); return p; };

/** $D descartável: painel/, chave remota de teste, catálogo de config, fontes do widget e o túnel do painel; a porta do listener sai do config.env. */
export function widgetData(r: Rig, tag: string): { D: string; listenerPort: number } {
  const D = `${r.T}/${tag}-data`;
  mkdirSync(`${r.T}/${tag}`, { recursive: true }); // worktree do ambiente (o D sem o -data)
  for (const d of ["panel", "logs", "android"]) mkdirSync(`${D}/${d}`, { recursive: true });
  copyFileSync(`${SKILL}/kit/config.tsv`, `${D}/config.tsv`);
  cpSync(`${SKILL}/kit/android/widget`, `${D}/android/widget`, { recursive: true });
  writeFileSync(`${D}/panel/remote.key`, "chave-do-teste\n");
  writeFileSync(`${D}/panel-tunnel.url`, `https://${PUB}\n`);
  const listenerPort = freePort();
  writeFileSync(`${D}/config.env`, `HADES_WIDGET_PORT=${listenerPort}\n`);
  return { D, listenerPort };
}

export interface Reply { status: number; raw: Uint8Array; text: string; json: Dict | null; hdr: Headers; code: string }

export async function fetchRaw(base: string, path: string, headers: Record<string, string> = {}, body?: unknown, method?: string): Promise<Reply> {
  const res = await fetch(base + path, { method: method ?? (body !== undefined ? "POST" : "GET"), headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: "manual" });
  const raw = new Uint8Array(await res.arrayBuffer());
  const text = Buffer.from(raw).toString("utf8");
  let json: Dict | null = null;
  try { const j: unknown = JSON.parse(text); if (j !== null && typeof j === "object" && !Array.isArray(j)) json = j as Dict; } catch { /* corpo que não é JSON */ }
  return { status: res.status, raw, text, json, hdr: res.headers, code: String(json?.code || json?.error || "-") };
}

/** Linhas `<caso> <valor>` na ordem em que saem, lidas depois por `caso()`. */
export class Lines {
  readonly lines: string[] = [];
  print(...parts: unknown[]): void { this.lines.push(parts.map(py).join(" ")); }
  /** Pedido que imprime `<caso> <status> <código ou erro ou ->`. */
  async ask(base: string, label: string, path: string, headers: Record<string, string> = {}, body?: unknown, method?: string): Promise<Reply> {
    const rep = await fetchRaw(base, path, headers, body, method);
    this.print(label, rep.status, rep.code);
    return rep;
  }
  get out(): string { return `${this.lines.join("\n")}\n`; }
}

/** Painel de verdade, em processo, numa porta livre de 127.0.0.1. */
export async function startTestPanel(D: string): Promise<{ panel: Panel; base: string; port: number; token: string; stop(): void }> {
  const port = freePort();
  const panel = await startPanel(D, port);
  return { panel, base: `http://127.0.0.1:${panel.port}`, port: panel.port, token: panel.token, stop: () => panel.stop() };
}

export const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });
export const JSON_CT = { "Content-Type": "application/json" };

/** Cabeçalhos de quem chega pelo túnel (com o cookie da sessão remota, se pedido). */
export function remoteHeaders(D: string, withCookie = true): Record<string, string> {
  const env = panelEnv(D);
  const auth = createAuth(env);
  const h: Record<string, string> = { Host: PUB, "X-Forwarded-Host": PUB, "X-Forwarded-Proto": "https" };
  if (withCookie) h.Cookie = `${env.cookie}=${auth.sessionValue(auth.remoteKey() as string)}`;
  return h;
}

/** Widget em processo sobre o mesmo $D (mesmos arquivos de token), com relógio e fontes controlados pelo teste. */
export function directWidget(D: string, deps: Partial<WidgetDeps> & { now: () => number; config?: () => Record<string, string> }): Widget {
  const env = panelEnv(D);
  return createWidget({
    env, auth: createAuth(env), panelPort: 0, config: () => ({}), orchestration: async () => ({ available: false, agents: [] }),
    gates: () => ({}), sampler: () => ({}), optionalContainers: () => new Set<string>(), ...deps,
  });
}

/**
 * Dublê do coletor: o painel o chama como `bun src/cli.ts pr-loop-state --json`; aqui essa chamada (e só ela) vira um `cat` do
 * relatório combinado ou uma falha com detalhe no stderr. O resto do Bun.spawn passa direto.
 */
export function stubCollector(r: Rig) {
  const real = Bun.spawn;
  const calls: string[][] = [];
  const reportFile = `${r.T}/coletor-relatorio.json`;
  const state: { report: unknown; fail: boolean } = { report: { prs: [] }, fail: false };
  (Bun as unknown as { spawn: unknown }).spawn = (argv: unknown, opts?: Record<string, unknown>) => {
    if (Array.isArray(argv) && argv.includes("pr-loop-state")) {
      calls.push(argv as string[]);
      writeFileSync(reportFile, JSON.stringify(state.report));
      const script = state.fail ? "echo 'falhou com detalhe /caminho/secreto' >&2; exit 1" : `cat '${reportFile}'`;
      return (real as (...a: unknown[]) => unknown)(["sh", "-c", script], { ...opts, cwd: undefined });
    }
    return (real as (...a: unknown[]) => unknown)(argv, opts);
  };
  return { calls, state, restore: () => { (Bun as unknown as { spawn: unknown }).spawn = real; } };
}

/** Repete `read` até `done` ser verdadeiro: a coleta roda em segundo plano e nunca dentro da leitura. */
export async function until<T>(read: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
  let v = await read();
  for (let i = 0; i < 300 && !done(v); i++) { await Bun.sleep(10); v = await read(); }
  return v;
}
