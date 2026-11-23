// `hades panel action <id> [k=v ...]`: a mesma montagem da rota POST /api/action (buildAction + Jobs), sem HTTP, para quem
// executa ações por subprocesso (o painel gpui). Roda na máquina, então as recusas do acesso remoto não se aplicam.
import { effectiveConfig, resolveHerdrBin } from "../lib/config.ts";
import { PANEL_ERRORS } from "../lib/human-errors.ts";
import { type Built, buildAction, pyStr } from "./actions.ts";
import { type PanelEnv, panelEnv } from "./env.ts";
import { createHerdr } from "./herdr.ts";
import { BadRequest } from "./http.ts";
import { createJobs } from "./jobs.ts";
import { type Plugin, loadPlugin, readManifest } from "./plugin.ts";
import { PluginRefused, startPluginHost } from "./plugin-host.ts";
import * as core from "./routes-core.ts";
import { createSampler } from "./sampler.ts";

export interface ActionInfo {
  id: string;
  label: string;
  /** `op` aceitos; vazio quando a ação não leva op */
  ops: string[];
  /** ops que a tela confirma antes de lançar; `true` quando a ação inteira confirma */
  confirm: boolean | string[];
}

const info = (id: string, label: string, ops: string[] = [], confirm: boolean | string[] = false): ActionInfo => ({ id, label, ops, confirm });

/** As ações do núcleo, na ordem do `buildAction`; as do plugin do projeto entram depois, sem rótulo próprio. */
export const CORE_ACTIONS: readonly ActionInfo[] = [
  info("run-hades", "Subir tudo (run-hades)", [], true),
  info("update", "Atualizar (update.sh)", [], true),
  info("pause", "Pausar ou retomar o Hades", ["pause", "resume"], ["pause", "resume"]),
  info("widget-apk", "Gerar o APK do widget Android"),
  info("status", "Gerar STATUS.md"),
  info("svc", "Serviços: iniciar, parar, reiniciar", ["start", "stop", "restart"], ["stop", "restart"]),
  info("infra", "Infra", ["up", "stop", "start", "web"], ["stop"]),
  info("container", "Container: reiniciar, parar, iniciar", ["restart", "stop", "start"], ["stop"]),
  info("tunnel", "Túnel do front", ["start", "stop", "url"], ["start", "stop"]),
  info("svc-enable", "Ligar ou desligar um serviço", ["enable", "disable"], ["disable"]),
  info("select", "Branch: base e PRs", [], true),
  info("fetch", "git fetch origin", [], true),
  info("panel-tunnel", "Painel remoto", ["start", "stop", "url", "rotate"], ["start", "stop", "rotate"]),
  info("clean", "Limpeza", ["rotate", "run", "yes"], ["run", "yes"]),
  info("config-apply", "Aplicar configuração", ["slice", "agents", "autostart", "logrotate"]),
  info("usage", "Consumo", ["refresh", "baseline"], ["baseline"]),
  info("review", "Review de PR"),
  info("doctor", "Diagnóstico (doctor.sh)"),
  info("notify", "Notificações", ["test", "rotate"], ["rotate"]),
  info("panel", "Reiniciar o painel", ["restart"], ["restart"]),
  info("prs", "PRs do conjunto", ["show", "set", "add", "remove", "reset"], ["set", "add", "remove", "reset"]),
];

export interface ActionResult {
  rc: number;
  body: unknown;
}

/** `k=v` vira o corpo JSON da rota: chave repetida vira lista, `[...]` é JSON, `true`/`false` viram booleanos. */
export function actionBody(id: string, args: string[]): Record<string, unknown> {
  const body: Record<string, unknown> = { action: id };
  for (const arg of args) {
    const at = arg.indexOf("=");
    if (at <= 0) throw new BadRequest(`argumento fora do formato k=v: ${arg}`);
    const key = arg.slice(0, at);
    const raw = arg.slice(at + 1);
    let value: unknown = raw === "true" ? true : raw === "false" ? false : raw;
    if (raw.startsWith("[")) {
      try {
        value = JSON.parse(raw);
      } catch {
        throw new BadRequest(`lista inválida em ${key}: ${raw}`);
      }
    }
    const prev = body[key];
    body[key] = key in body && key !== "action" ? [...(Array.isArray(prev) ? prev : [prev]), value] : value;
  }
  return body;
}

type Host = Awaited<ReturnType<typeof startPluginHost>>;

async function withPlugin<T>(dir: string, run: (env: PanelEnv, host: Host, plugin: Plugin) => Promise<T>): Promise<T> {
  const env = panelEnv(dir);
  const manifest = readManifest(env);
  const host = await startPluginHost(env, typeof manifest.panel === "object" && manifest.panel !== null && Object.keys(manifest.panel).length > 0);
  try {
    return await run(env, host, loadPlugin(env, host.functions, manifest));
  } finally {
    host.stop();
  }
}

function listOf(plugin: Plugin): ActionInfo[] {
  const coreIds = new Set(CORE_ACTIONS.map((a) => a.id));
  return [...CORE_ACTIONS, ...[...plugin.actions].filter((id) => !coreIds.has(id)).map((id) => info(id, `Plugin: ${id}`))];
}

export const panelActionList = (dir: string): Promise<ActionInfo[]> => withPlugin(dir, async (_env, _host, plugin) => listOf(plugin));

/** Ação desconhecida: rc 2 com a lista; recusa da validação: rc 1 com `code`; job lançado: rc 0 com o id. */
export async function panelAction(dir: string, id: string, args: string[]): Promise<ActionResult> {
  return withPlugin(dir, async (env, host, plugin) => {
    const known = listOf(plugin);
    if (!known.some((a) => a.id === id)) {
      return { rc: 2, body: { error: `ação desconhecida: ${id}`, code: "unknown_action", actions: known.map((a) => a.id) } };
    }
    const jobs = createJobs(env);
    const config = (): Record<string, string> => core.configValues(env);
    const sampler = createSampler({
      env, plugin, jobs, herdr: createHerdr({ bin: resolveHerdrBin(effectiveConfig(dir).get("HADES_HERDR_BIN")) }), configValues: config,
      publicUrl: () => undefined, pluginSample: async () => ({}), chatUnit: process.env.HADES_CHAT_UNIT || `${env.hu}-chat`,
    });
    const body = actionBody(id, args);
    if (id === "container") await sampler.sample();
    const containerNames = (): string[] => ((sampler.snapshot().containers as { name: string }[] | undefined) ?? []).map((c) => c.name);
    const built: Built = await buildAction({
      env, plugin, config, containerNames, baseRef: sampler.baseRef,
      pluginAction: async (action, b) => {
        try {
          const [title, script, exclusive] = await host.action(action, b, { config: config(), snapshot: sampler.snapshot(), containers: containerNames() });
          return { title, script, exclusive };
        } catch (error) {
          if (error instanceof PluginRefused) throw new BadRequest(error.message);
          throw error;
        }
      },
    }, body);
    if (built.exclusive) {
      const who = (await jobs.list()).find((j) => j.state === "rodando" && j.exclusive)?.title ?? sampler.skillProcs()[0]?.cmd;
      if (who) return { rc: 1, body: { error: `ambiente ocupado: ${who}`, code: PANEL_ERRORS.envBusy } };
    }
    const job = await jobs.launch(pyStr(body.action), built.title, built.script, built.exclusive);
    return { rc: 0, body: { job, title: built.title, exclusive: built.exclusive } };
  }).catch((error: unknown) => {
    if (error instanceof BadRequest) return { rc: 1, body: { error: error.message, code: PANEL_ERRORS.badRequest } };
    throw error;
  });
}
