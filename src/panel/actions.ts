// POST /api/action: do pedido da tela ao (título, script bash, exclusiva) do job. Toda entrada passa por lista fechada
// ou por expressão estrita; o que escapar delas vira BadRequest (400). Nada daqui executa: quem lança é o Jobs.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pyRepr } from "../lib/pyjson.ts";
import { managerKind, type ServiceManagerKind } from "../lib/service-manager.ts";
import type { PanelEnv } from "./env.ts";
import { shlexJoin as q, shlexQuote } from "./exec.ts";
import { BadRequest } from "./http.ts";
import type { Plugin } from "./plugin.ts";
import { serviceCatalog, listFile } from "./system.ts";

type Dict = Record<string, unknown>;
export interface Built {
  title: string;
  script: string;
  exclusive: boolean;
}

export interface ActionContext {
  env: PanelEnv;
  plugin: Plugin;
  config(): Record<string, string>;
  containerNames(): string[];
  baseRef(): Promise<string>;
  /** ação do plugin do projeto: ele valida contra a lista fechada dele */
  pluginAction(action: string, body: Dict): Promise<Built>;
}

const PR_TOKEN = /^(@me|develop|author:[A-Za-z0-9-]+|-?\d{1,6})$/;
const REVIEW_PR = /^\d{1,6}$/;
const SELECT_PRS_MAX = 60;
const BASE_FLAGS = ["--no-tunnel", "--tunnel", "--rebuild"];
const DEFAULT_USAGE_DAYS = "7";

/** O gerador do STATUS é do pacote do projeto ($D/gen-status.sh ou .ts); sem nenhum, a ação recusa em vez de rodar um nome que não existe. */
const STATUS_RUNNERS: ReadonlyArray<[string, string]> = [["gen-status.sh", "bash"], ["gen-status.ts", process.execPath]];

function statusCommand(dir: string): string {
  const found = STATUS_RUNNERS.find(([file]) => existsSync(join(dir, file)));
  if (found === undefined) throw new BadRequest("o pacote do projeto não traz gen-status (sh ou ts)");
  return q([found[1], join(dir, found[0])]);
}

/** str() do Python sobre o valor do JSON. */
export function pyStr(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return String(value);
  return pyRepr(value);
}

export function pick<T extends string>(value: unknown, allowed: Iterable<T>): T {
  const set = new Set<unknown>(allowed);
  if (!set.has(value)) throw new BadRequest(`valor fora da lista: ${pyRepr(value)}`);
  return value as T;
}

const tokens = (value: unknown): string[] => pyStr(value ?? "").split(/\s+/).filter(Boolean);
const truthy = (value: unknown): boolean => !(value === undefined || value === null || value === false || value === 0 || value === "" || (Array.isArray(value) && value.length === 0));

/** A linha que hospeda o túnel do front: systemd-run no Linux; no launchd o `tunnel.sh front-start` (o launchd não tem systemd-run). */
const HOST_FRONT = (kind: ServiceManagerKind): string =>
  kind === "launchd"
    ? 'bash "$D/tunnel.sh" front-start'
    : 'systemctl --user is-active --quiet "$HU-devtunnel" || systemd-run --user --unit="$HU-devtunnel" --slice="$HSLICE" devtunnel host "$id"';

const TUNNEL_SCRIPT = (envSh: string, kind: ServiceManagerKind): string => `set -u
source ${envSh}
bash "$D/tunnel.sh" install
devtunnel user show 2>&1 | grep -qiE 'logged in as' || { echo "devtunnel não logado: rode no terminal  devtunnel user login -g -d"; exit 1; }
bash "$D/tunnel.sh" create
id=$(cat "$D/tunnel.id")
[[ -n \${HADES_TUNNEL_PORT:-} ]] || { echo "sem porta do front (HADES_TUNNEL_PORT vazio): defina em Configurações → Túnel"; exit 2; }
devtunnel access create "$id" -p "$HADES_TUNNEL_PORT" --anonymous -e "$HADES_TUNNEL_ANON_TTL" || true
${HOST_FRONT(kind)}
for i in $(seq 1 20); do bash "$D/tunnel.sh" url && break; sleep 2; done
[[ -f "$D/post-tunnel.sh" ]] && bash "$D/post-tunnel.sh"
echo "túnel: $(cat "$D/tunnel.url" 2>/dev/null)"`;

function fetchScript(worktree: string, base: string): string {
  return `set -u
cd ${q([worktree])}
git config --get-all credential.https://github.com.helper | grep -q cache || { git config --local credential.https://github.com.helper ""; git config --local --add credential.https://github.com.helper "cache --timeout=10800"; }
tok=$(gh auth token 2>/dev/null) && printf 'protocol=https\\nhost=github.com\\nusername=x-access-token\\npassword=%s\\n\\n' "$tok" | git credential approve
git fetch origin --prune 2>&1 | tail -20
echo "base remota (${base}): $(git log -1 --format='%h %s (%cr)' ${shlexQuote(base)})"
echo "commits novos na base desde a branch atual: $(git rev-list --count HEAD..${shlexQuote(base)})"`;
}

export async function buildAction(ctx: ActionContext, body: Dict): Promise<Built> {
  const { env, plugin } = ctx;
  const a = body.action;
  const op = body.op;
  const svcs = [...serviceCatalog(env.dir).keys()];
  const sh = (name: string, ...args: string[]): string => q(["bash", join(env.dir, name), ...args]);
  const cli = (...args: string[]): string[] => [process.execPath, join(env.skillDir, "src", "cli.ts"), ...args];
  const remoteKey = join(env.panelDir, "remote.key");
  const built = (title: string, script: string, exclusive = false): Built => ({ title, script, exclusive });

  if (a === "run-hades") {
    const prs = tokens(body.prs);
    if (prs.some((t) => !PR_TOKEN.test(t))) throw new BadRequest("PRs: use números, @me, author:<login>, -<n> ou develop");
    const known = [...BASE_FLAGS, ...plugin.runFlags.flatMap((f) => ["", "no-"].map((p) => `--${p}${f.key as string}`))];
    const flags = (Array.isArray(body.flags) ? body.flags : []).map((f) => pick(f, known));
    return built(["Subir tudo: run-hades", ...prs, ...flags].join(" "), sh("run-hades.sh", ...prs, ...flags), true);
  }
  if (a === "update") {
    const args = truthy(body.all) ? ["--all"] : [];
    return built(`Atualizar (update.sh${args.length ? " --all" : ""})`, sh("update.sh", ...args), true);
  }
  if (a === "pause") {
    const which = pick(op, ["pause", "resume"]);
    return built(which === "pause" ? "Pausar o Hades" : "Retomar o Hades", sh("hades.sh", which), true);
  }
  if (a === "widget-apk") return built("Gerar o APK do widget Android", sh("android/build.sh", "build"));
  if (a === "status") return built("Gerar STATUS.md", statusCommand(env.dir));
  if (a === "svc") {
    const verb = pick(op, ["start", "stop", "restart"]);
    const targets = (Array.isArray(body.targets) ? body.targets : []).map((t) => pick(t, svcs));
    return built(`svc ${verb}: ${targets.length ? targets.join(", ") : "todos os habilitados"}`, sh("svc.sh", verb, ...targets));
  }
  if (a === "infra") {
    const verb = pick(op, ["up", "stop", "start", "web"]);
    return built(`Infra: ${verb}`, sh("infra.sh", verb), verb !== "web");
  }
  if (a === "container") {
    const verb = pick(op, ["restart", "stop", "start"]);
    const name = pick(body.name, ctx.containerNames());
    return built(`docker ${verb} ${name}`, q(["docker", verb, name]));
  }
  if (typeof a === "string" && plugin.actions.has(a)) return ctx.pluginAction(a, body);
  if (a === "tunnel") {
    const verb = pick(op, ["start", "stop", "url"]);
    const kind = managerKind();
    if (verb === "stop") return built("Túnel: parar", kind === "launchd" ? sh("tunnel.sh", "front-stop") : q(["systemctl", "--user", "stop", `${env.hu}-devtunnel`]));
    if (verb === "url") return built("Túnel: reler a URL", sh("tunnel.sh", "url"));
    // mesma sequência do run-hades (passo 11): acesso anônimo de 1 dia + host + URL + restart de quem lê a URL
    return built("Túnel: publicar o front", TUNNEL_SCRIPT(q([join(env.dir, "env.sh")]), kind));
  }
  if (a === "svc-enable") {
    const verb = pick(op, ["enable", "disable"]);
    const name = pick(body.name, svcs);
    if (verb === "disable") {
      if (listFile(join(env.dir, "services.required")).includes(name)) throw new BadRequest(`${name} é obrigatório`);
      return built(`Desligar ${name}`, sh("svc-enable.sh", "--disable", name));
    }
    return built(`Ligar ${name}`, sh("svc-enable.sh", name, ...(truthy(body.noBuild) ? ["--no-build"] : [])), true);
  }
  if (a === "select") {
    const mode = pick(body.mode, ["develop", "prs"]);
    const nums = (Array.isArray(body.prs) ? body.prs : []).filter((n) => /^\d+$/.test(pyStr(n))).map((n) => Number.parseInt(pyStr(n), 10)).slice(0, SELECT_PRS_MAX);
    if (mode === "prs" && !nums.length) throw new BadRequest("selecione ao menos uma PR (ou escolha só a develop)");
    // o modo e o token seguem "develop"; o texto diz a base do perfil
    const baseName = (await ctx.baseRef()).replace(/^origin\//, "");
    let script: string;
    let title: string;
    if (mode === "develop") {
      script = `printf '# ${baseName} pura (sem PRs), escolhida no painel\\n-0\\n' > ${q([join(env.dir, "prs.list")])} && echo ${shlexQuote(`conjunto: só a ${baseName}`)}`;
      title = `Branch: só a ${baseName}`;
    } else {
      script = sh("prs.sh", "set", ...nums.map(String));
      title = `Branch: ${baseName} + ${nums.map((n) => `#${n}`).join(" ")}`;
    }
    if (truthy(body.apply)) {
      script += ` && ${sh("update.sh")}`;
      title += " e atualizar";
    }
    return built(title, script, true);
  }
  if (a === "fetch") return built("git fetch origin", fetchScript(env.worktree, await ctx.baseRef()), true);
  if (a === "panel-tunnel") {
    const verb = pick(op, ["start", "stop", "url", "rotate"]);
    if (verb === "rotate") {
      const key = q([remoteKey]);
      return built("Painel remoto: nova chave de acesso", `head -c 18 /dev/urandom | base64 | tr -d '/+=' > ${key} && chmod 600 ${key} && echo 'chave trocada: sessões remotas antigas caem'`);
    }
    const titles = { start: "Painel remoto: publicar (só a sua conta)", stop: "Painel remoto: parar", url: "Painel remoto: reler a URL" } as const;
    return built(titles[verb], sh("tunnel.sh", `panel-${verb}`));
  }
  if (a === "clean") {
    const verb = pick(op, ["rotate", "run", "yes"]);
    if (verb === "rotate") return built("Rotacionar os logs", sh("clean.sh", "rotate"));
    if (verb === "run") return built("Limpeza segura (logs, execuções, cache)", sh("clean.sh", "run"));
    const cat = pick(body.cat, ["images", "releases", "worktrees"]);
    return built(`Limpar: ${cat}`, sh("clean.sh", "yes", cat));
  }
  if (a === "config-apply") {
    const verb = pick(op, ["slice", "agents", "autostart", "logrotate"]);
    if (verb === "logrotate") return built(`Aplicar o timer de limpeza (${env.hu}-logrotate)`, sh("clean.sh", "apply"));
    if (verb === "autostart") return built("Aplicar o início automático do painel", sh("panel.sh", "autostart"));
    if (verb === "agents") return built("Aplicar o modelo dos subagentes de review", q(cli("models")));
    return built(`Aplicar o teto de memória no slice ${env.slice}`, sh("config.sh", "apply-slice"));
  }
  if (a === "usage") {
    const verb = pick(op, ["refresh", "baseline"]);
    const days = ctx.config().HADES_USAGE_DAYS || DEFAULT_USAGE_DAYS;
    const args = verb === "baseline" ? ["--baseline"] : [];
    return built(args.length ? "Gravar a linha de base de consumo" : "Atualizar o consumo", q(cli("usage", "--days", days, ...args)));
  }
  if (a === "review") {
    const cmd = pick(body.cmd, ["review-pr", "review-agents"]);
    const model = pick(body.model, ["opus", "sonnet"]);
    const effort = pick(body.effort, ["low", "medium", "high"]);
    const pr = pyStr(body.pr ?? "");
    if (!REVIEW_PR.test(pr)) throw new BadRequest("PR inválida");
    const post = truthy(body.post);
    return built(
      `/${cmd} #${pr} · ${model} · ${effort}${post ? " · publica" : ""}`,
      q(cli("review", "--wt", env.worktree, "--pr", pr, "--cmd", cmd, "--model", model, "--effort", effort, ...(post ? ["--post"] : []))),
    );
  }
  if (a === "doctor") {
    // --json grava o quadro que o card Diagnóstico lê (GET /api/doctor); o texto do log é o mesmo diagnóstico, por escrito
    const out = q([join(env.dir, "doctor.json")]);
    return built("Diagnóstico (doctor.sh)", `${sh("doctor.sh", "--json")} > ${out}.tmp; mv ${out}.tmp ${out}; ${sh("doctor.sh")}; true`);
  }
  if (a === "notify") {
    const verb = pick(op, ["test", "rotate"]);
    if (verb === "rotate") {
      return built("Notificações: trocar o tópico do ntfy", `${sh("notify.sh", "topic", "rotate")} >/dev/null && echo "tópico trocado: assine o novo no app (painel → Configurações → Notificações)"`);
    }
    return built("Notificações: testar", sh("notify.sh", "test"));
  }
  if (a === "panel") {
    pick(op, ["restart"]);
    return built("Reiniciar o painel", sh("panel.sh", "restart"));
  }
  if (a === "prs") {
    const verb = pick(op, ["show", "set", "add", "remove", "reset"]);
    const toks = tokens(body.prs);
    if (toks.some((t) => !PR_TOKEN.test(t) || t === "develop")) throw new BadRequest("PRs: use números, @me, author:<login> ou -<n>");
    if ((verb === "set" || verb === "add" || verb === "remove") && !toks.length) throw new BadRequest("informe ao menos uma entrada");
    return built(`PRs: ${verb} ${toks.join(" ")}`.trim(), sh("prs.sh", verb, ...toks), verb !== "show");
  }
  throw new BadRequest(`ação desconhecida: ${pyRepr(a)}`);
}
