// Base dos checks do Cerberus em TypeScript: contexto injetado, comandos com
// limite de tempo e o veredito. Cada check é uma função pura do ambiente que devolve o veredito; quem imprime é a borda
// (src/commands/cerberus-check.ts). O contrato de saída é o de sempre: uma linha JSON {resultado, evidencia, detalhe?}.
import { spawnSync } from "node:child_process";
import { getField, loadProfile } from "./profile.ts";
import { resolveProject } from "./project.ts";

export const TIMEOUT_S = 20;
export const EVID_MAX_CHARS = 500;
const OUTPUT_BUFFER_MAX = 256 * 1024 * 1024;
const EVID_MAX_ITEMS = 20;
const DETAIL_MAX_CHARS = 1000;
const MISSING_EVIDENCE = { conferido: "nada conferido", onde: "guarda sem evidência" };

export type Resultado = "ok" | "aviso" | "barra";
export interface Evid { conferido: string; onde: string }
export interface CheckVerdict { resultado: Resultado; evidencia: Evid[]; detalhe?: string }

/** O que o núcleo do Cerberus passa a um check exec (variáveis CERBERUS_*), injetado em vez de lido do ambiente global. */
export interface CheckEnv {
  dir: string;
  skill: string;
  momento: string;
  ctx: Record<string, string>;
  env: Record<string, string | undefined>;
}

export function checkEnvFromProcess(): CheckEnv {
  const env = process.env;
  return { dir: env.CERBERUS_DIR || process.cwd(), skill: env.CERBERUS_SKILL ?? "", momento: env.CERBERUS_MOMENTO ?? "", ctx: parseCtx(env.CERBERUS_CTX), env };
}

function parseCtx(text: string | undefined): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(text || "{}");
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
  } catch {
    return {};
  }
}

export function ev(conferido: unknown, onde: unknown): Evid {
  return { conferido: String(conferido).slice(0, EVID_MAX_CHARS), onde: String(onde).slice(0, EVID_MAX_CHARS) };
}

export function verdict(resultado: Resultado, evidencia: Evid[], detalhe?: string): CheckVerdict {
  const v: CheckVerdict = { resultado, evidencia: evidencia.length ? evidencia.slice(0, EVID_MAX_ITEMS) : [MISSING_EVIDENCE] };
  if (detalhe) v.detalhe = detalhe.slice(0, DETAIL_MAX_CHARS);
  return v;
}

export interface Ran { code: number | null; stdout: string; stderr: string }

/** Executa o comando; code null quando o binário não existe ou estourou o tempo (stderr diz qual). */
export function exec(argv: string[], ce: CheckEnv, opts: { cwd?: string; env?: Record<string, string>; timeoutS?: number } = {}): Ran {
  const timeoutS = opts.timeoutS ?? TIMEOUT_S;
  const r = spawnSync(argv[0] as string, argv.slice(1), {
    cwd: opts.cwd ?? ce.dir, env: { ...ce.env, ...opts.env }, encoding: "utf8", timeout: timeoutS * 1000, maxBuffer: OUTPUT_BUFFER_MAX,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return { code: null, stdout: "", stderr: `${argv[0]}: não encontrado no PATH` };
  if (code === "ETIMEDOUT") return { code: null, stdout: "", stderr: `${argv.slice(0, 3).join(" ")}: passou de ${timeoutS} s` };
  if (r.error) return { code: null, stdout: "", stderr: `${argv[0]}: ${r.error.message}` };
  return { code: r.status, stdout: r.stdout ?? "", stderr: (r.stderr ?? "").trim() };
}

export function git(ce: CheckEnv, ...args: string[]): Ran {
  return exec(["git", ...args], ce);
}

/** Campo do perfil ativo do diretório (undefined sem perfil ou sem o campo). */
export function profileField(ce: CheckEnv, field: string): string | undefined {
  const value = getField(loadProfile(resolveProject(ce.dir)), field, undefined)?.trim();
  return value ? value : undefined;
}

export function ghRepoSlug(ce: CheckEnv): string | undefined {
  const r = git(ce, "config", "--get", "remote.origin.url");
  return r.code === 0 ? /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(r.stdout.trim())?.[1] : undefined;
}

export interface BranchInfo { branch: string; remote: string; merge: string; pushRemote: string }

/** Onde o push da branch atual vai, pela configuração do git. */
export function branchInfo(ce: CheckEnv): BranchInfo {
  const head = git(ce, "symbolic-ref", "--short", "-q", "HEAD");
  const branch = head.code === 0 ? head.stdout.trim() : "";
  const cfg = (key: string): string => git(ce, "config", "--get", key).stdout.trim();
  const remote = branch ? cfg(`branch.${branch}.remote`) : "";
  const merge = branch ? cfg(`branch.${branch}.merge`) : "";
  const pushRemote = branch ? cfg(`branch.${branch}.pushRemote`) || cfg("remote.pushDefault") || remote : "";
  return { branch, remote, merge: merge.startsWith("refs/heads/") ? merge.slice("refs/heads/".length) : merge, pushRemote };
}

export interface HeadRef { head?: string; headEv?: Evid; error?: Evid }

/** headRefName da PR do contexto: `head` do contexto, ou `gh pr view <pr>`. */
export function headRef(ce: CheckEnv): HeadRef {
  const { head, pr } = ce.ctx;
  if (head) return { head, headEv: ev(`headRefName = ${head}`, "contexto da avaliação (--ctx head=)") };
  if (pr) {
    const r = exec(["gh", "pr", "view", pr, "--json", "headRefName", "--jq", ".headRefName"], ce);
    const name = r.stdout.trim();
    if (r.code === 0 && name) return { head: name, headEv: ev(`headRefName da PR #${pr} = ${name}`, `gh pr view ${pr}`) };
    return { error: ev(`não consegui ler o headRefName da PR #${pr}: ${r.stderr || "resposta vazia"}`, `gh pr view ${pr} --json headRefName`) };
  }
  return { error: ev("sem pr nem head no contexto", "CERBERUS_CTX (--ctx pr=<n> ou --ctx head=<branch>)") };
}

/** fnmatch.fnmatchcase: *, ? e [seq] sobre o texto inteiro. */
export function fnmatchCase(text: string, pattern: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else if (ch === "[") {
      const close = pattern.indexOf("]", i + 2);
      if (close < 0) re += "\\[";
      else {
        let set = pattern.slice(i + 1, close);
        if (set.startsWith("!")) set = `^${set.slice(1)}`;
        re += `[${set.replaceAll("\\", "\\\\")}]`;
        i = close;
      }
    } else re += ch.replace(/[.+^${}()|\\/]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "s").test(text);
}
