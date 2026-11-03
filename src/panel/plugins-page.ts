// Página Plugins (os pacotes da Hades; $D/plugins.sh). A regra (URL aceita, prévia, recusas) é do hades plugins; aqui só a
// fronteira: formato dos argumentos, painel local e token. Prévia e conferência (--check) rodam na hora; o que muda roda
// como job exclusivo, como as outras ações.
import { join } from "node:path";
import { pyRepr } from "../lib/pyjson.ts";
import type { PanelEnv } from "./env.ts";
import { exec, shlexJoin } from "./exec.ts";
import { log } from "./log.ts";

type Dict = Record<string, unknown>;

const OPS = new Set(["preview-add", "preview-update", "add", "update", "enable", "disable", "remove"]);
const PACK_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/; // o `name` do profile.schema.json
const PACK_SHA = /^[0-9a-f]{40}$/;
const PACK_PREVIEW = /^[0-9a-f]{16}$/;
export const PACK_URL_MAX = 300;
const CONFIRM_MAX = 64;
// variáveis do painel que o job precisa ver (o systemd-run e o launchd começam de um ambiente vazio): instalação de teste e raízes
const JOB_ENV = ["HADES_PACKS_ROOT", "HADES_SKILL_DIR", "HADES_WORK_ROOT", "SKIP_SYSTEMD", "SKIP_WORKTREE", "SKIP_DOCTOR"] as const;
const LIST_TIMEOUT_MS = 60_000;
const GIT_TIMEOUT_DEFAULT_S = 120;
const PREVIEW_MARGIN_S = 30;

/** Recusa da página com o código estável do hades plugins (ou plugins_local_only / plugins_bad_request). */
export class PluginsRefused extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface PluginsPage {
  list(remote: boolean): Promise<Dict>;
  /** corpo da resposta e, quando a operação vira job, o pedido para lançá-lo */
  act(body: Dict, remote: boolean): Promise<{ out: Dict; job?: { title: string; script: string } }>;
}

export interface PluginsDeps {
  env: PanelEnv;
  config(): Record<string, string>;
  /** título do que está ocupando o ambiente, se houver */
  busy(): Promise<string | undefined>;
}

export function createPluginsPage(deps: PluginsDeps): PluginsPage {
  const { env } = deps;
  const script = join(env.dir, "plugins.sh");

  /** Teto do clone/fetch das Configurações, com folga para o resto da prévia. */
  function previewTimeoutMs(): number {
    const raw = deps.config().HADES_PLUGIN_GIT_TIMEOUT || String(GIT_TIMEOUT_DEFAULT_S);
    // valor ilegível: o teto padrão com a folga, como o original
    if (!/^\s*[+-]?\d+\s*$/.test(raw)) return (GIT_TIMEOUT_DEFAULT_S + PREVIEW_MARGIN_S) * 1000;
    return (Number.parseInt(raw, 10) + PREVIEW_MARGIN_S) * 1000;
  }

  /** plugins.sh <args> --json, na hora: (ok, saída JSON); a saída de recusa traz `code` e `error`. */
  async function cli(args: string[], timeoutMs: number): Promise<[boolean, Dict]> {
    const result = await exec(["bash", script, ...args, "--json"], {
      timeoutMs,
      env: { ...process.env, HADES_DATA: env.dir, HADES_PANEL_JOB: "painel" },
    });
    if (result.timedOut) throw new PluginsRefused("git_timeout", "a operação passou do tempo (HADES_PLUGIN_GIT_TIMEOUT)");
    const lastLine = result.stdout.trim().split("\n").at(-1) ?? "";
    let out: unknown;
    try {
      out = JSON.parse(lastLine);
    } catch {
      log("warn", "plugins: saída inesperada do plugins.sh", { status: result.status, stderr: result.stderr.trim().slice(-500) });
      throw new PluginsRefused("plugins_error", "o plugins.sh falhou (detalhe no log do painel)", 500);
    }
    if (typeof out !== "object" || out === null || Array.isArray(out)) {
      throw new PluginsRefused("plugins_error", "o plugins.sh falhou (detalhe no log do painel)", 500);
    }
    const dict = out as Dict;
    return [result.status === 0 && dict.ok === true, dict];
  }

  function arg(body: Dict, key: string, pattern: RegExp, what: string): string {
    const v = body[key];
    if (typeof v !== "string" || !pattern.test(v)) throw new PluginsRefused("plugins_bad_request", `${what} inválido`);
    return v;
  }

  /** (título, argumentos do plugins.sh) da operação que muda estado, com os argumentos validados. */
  function plan(body: Dict): { title: string; args: string[] } {
    const op = body.op;
    if (op === "add") {
      const id = arg(body, "id", PACK_PREVIEW, "id da prévia");
      const sha = arg(body, "commit", PACK_SHA, "commit");
      return { title: `Plugins: adicionar ${sha.slice(0, 12)}`, args: ["add", "--apply", id, "--commit", sha] };
    }
    const name = arg(body, "name", PACK_NAME, "nome do pacote");
    if (op === "update") {
      const sha = arg(body, "commit", PACK_SHA, "commit");
      return { title: `Plugins: atualizar ${name} para ${sha.slice(0, 12)}`, args: ["update", name, "--apply", "--commit", sha] };
    }
    if (op === "enable" || op === "disable") return { title: `Plugins: ${op === "enable" ? "ligar" : "desligar"} ${name}`, args: [op, name] };
    if (op === "remove") {
      const confirm = body.confirm;
      if (typeof confirm !== "string" || confirm.length > CONFIRM_MAX) throw new PluginsRefused("plugins_bad_request", "confirmação inválida");
      return { title: `Plugins: remover ${name}`, args: ["remove", name, "--confirm", confirm] };
    }
    throw new PluginsRefused("plugins_bad_request", `operação desconhecida: ${pyRepr(op)}`);
  }

  const jobScript = (args: string[]): string => {
    const vars = JOB_ENV.flatMap((k) => (process.env[k] ? [`${k}=${process.env[k]}`] : []));
    return shlexJoin(["env", ...vars, "bash", script, ...args]);
  };

  return {
    async list(remote) {
      const [ok, out] = await cli(["list"], LIST_TIMEOUT_MS);
      if (!ok) throw new PluginsRefused(String(out.code ?? "plugins_error"), String(out.error ?? "falha ao listar"), 500);
      return { ...out, remote };
    },
    async act(body, remote) {
      if (remote) throw new PluginsRefused("plugins_local_only", "plugins só se adicionam, atualizam, ligam, desligam e removem pelo painel local", 403);
      const op = body.op;
      if (typeof op !== "string" || !OPS.has(op)) throw new PluginsRefused("plugins_bad_request", `operação desconhecida: ${pyRepr(op)}`);
      if (op === "preview-add") {
        const url = body.url;
        if (typeof url !== "string" || url.length === 0 || url.length > PACK_URL_MAX) {
          throw new PluginsRefused("invalid_url", `URL vazia ou com mais de ${PACK_URL_MAX} caracteres`);
        }
        return { out: (await cli(["add", url], previewTimeoutMs()))[1] };
      }
      if (op === "preview-update") {
        return { out: (await cli(["update", arg(body, "name", PACK_NAME, "nome do pacote")], previewTimeoutMs()))[1] };
      }
      const { title, args } = plan(body);
      const [ok, out] = await cli([...args, "--check"], LIST_TIMEOUT_MS);
      if (!ok) throw new PluginsRefused(String(out.code ?? "plugins_error"), String(out.error ?? "recusado"));
      const who = await deps.busy();
      if (who) throw new PluginsRefused("busy", `ambiente ocupado: ${who}`, 409);
      return { out, job: { title, script: jobScript(args) } };
    },
  };
}
