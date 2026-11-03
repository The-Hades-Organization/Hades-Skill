// Lado servidor das páginas do projeto B no painel do Hades ($D/plugin/panel/api.ts), contrato `panel/api.ts` (núcleo >=4.23).
// O host carrega este módulo uma vez na subida e chama:
// - action(nome, corpo, ctx) para as ações de plugin.json → panel.actions (só `snapshot`): devolve [título, script bash,
//   exclusiva] e recusa (ctx.pick / ctx.refuse) quando o pedido foge da lista fechada (vira 400 no painel);
// - snapshots(ctx, consulta) para a rota GET /api/plugin/snapshots.
// Sem sample: o plugin não tem processo de apoio além dos serviços do services.tsv, que o núcleo já mede.
import type { PluginAction, PluginCtx } from "~/.claude/skills/hades/src/panel/plugin-api.ts";

const SNAPSHOT_ID = /^[0-9]{8}-[0-9]{6}(-[a-z0-9_-]+)?$/;
const SNAPSHOT_LIST_TIMEOUT_MS = 20_000;
const EMPTY_LIST = '{"snapshots":[],"bytes":0}';

export function action(name: string, body: Record<string, unknown>, ctx: PluginCtx): PluginAction {
  if (name !== "snapshot") return ctx.refuse(`ação desconhecida: ${name}`);
  const op = ctx.pick(body.op, ["take", "restore", "rm"]);
  if (op === "take") return ["Snapshot do banco", ctx.sh("snapshot.sh", "take", "--label", "manual"), false];
  const id = String(body.id ?? "");
  if (!SNAPSHOT_ID.test(id)) return ctx.refuse("id de snapshot inválido");
  if (op === "rm") return [`Apagar o snapshot ${id}`, ctx.sh("snapshot.sh", "rm", id), false];
  return [`Restaurar o snapshot ${id}`, ctx.sh("snapshot.sh", "restore", id), true];
}

export function snapshots(ctx: PluginCtx, _query: Record<string, unknown>): unknown {
  const done = Bun.spawnSync(["bash", `${ctx.D}/snapshot.sh`, "list", "--json"], { stdout: "pipe", stderr: "pipe", timeout: SNAPSHOT_LIST_TIMEOUT_MS });
  if (done.exitCode !== 0) throw new Error(`snapshot.sh list saiu ${done.exitCode}`);
  return JSON.parse(done.stdout.toString() || EMPTY_LIST);
}
