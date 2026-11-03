// Lado servidor das páginas do proj-a no painel do Hades ($D/plugin/panel/api.ts), contrato `panel/api.ts` (núcleo >=4.23).
// O host carrega este módulo uma vez na subida e chama:
// - action(nome, corpo, ctx) para as ações de plugin.json → panel.actions: devolve [título, script bash, exclusiva] e recusa
//   (ctx.pick / ctx.refuse) quando o pedido foge da lista fechada (vira 400 no painel);
// - sample(ctx) a cada amostra: simuladores, unidades de apoio, memória da série "extra" e units para a página Logs;
// - snapshots(ctx, consulta) para a rota GET /api/plugin/snapshots.
// O ctx traz D, W, run, q, sh, pick, NODE_BIN e afins (reference/projects.md §Plugin).
import type { PluginAction, PluginCtx, UnitView } from "~/.claude/skills/hades/src/panel/plugin-api.ts";

const SIM_PREFIX = "hds-dev-";
const BUS_UNIT = "hds-dev-bus";
const APOIO = [["console", "hds-console"], ["alarmSim", "hds-demo-sim"], ["devBus", BUS_UNIT]] as const;
const SNAPSHOT_ID = /^[0-9]{8}-[0-9]{6}(-[a-z0-9_-]+)?$/;
const SNAPSHOT_LIST_TIMEOUT_MS = 20_000;
const EMPTY_LIST = '{"snapshots":[],"bytes":0}';

export function action(name: string, body: Record<string, unknown>, ctx: PluginCtx): PluginAction {
  const op = body.op;
  if (name === "sims") {
    const picked = ctx.pick(op, ["start", "stop", "restart", "status"]);
    return [`Simuladores: ${String(picked)}`, ctx.sh("sims.sh", picked), false];
  }
  if (name === "console") {
    const picked = ctx.pick(op, ["start", "stop", "restart"]);
    return [`Console de eventos: ${String(picked)}`, ctx.sh("console.sh", picked), false];
  }
  if (name === "alarm-sim") return alarmSim(op, ctx);
  if (name === "bootstrap") {
    const args = body.skipTopology === true ? ["--skip-topology"] : [];
    return ["Carregar dados" + (args.length ? " (sem topologia)" : ""), ctx.sh("bootstrap-data.sh", ...args), true];
  }
  if (name === "snapshot") return snapshot(op, body, ctx);
  return ctx.refuse(`ação desconhecida: ${name}`);
}

function alarmSim(op: unknown, ctx: PluginCtx): PluginAction {
  const picked = ctx.pick(op, ["start", "stop", "rules"]);
  const seed = `${ctx.D}/seed`;
  if (picked === "rules") return ["Regras SIM_* do simulador de alarmes", ctx.q(ctx.NODE_BIN, `${seed}/alarm-sim-rules.mjs`), false];
  if (picked === "stop") return ["Simulador de alarmes: parar", ctx.q("systemctl", "--user", "stop", "hds-demo-sim"), false];
  const log = `${ctx.D}/logs/alarm-sim.log`;
  return [
    "Simulador de alarmes: iniciar",
    ctx.q(
      "systemd-run", "--user", "--quiet", "--unit=hds-demo-sim", "--slice=hades", `--working-directory=${seed}`,
      "-p", "Restart=on-failure", "-p", "RestartSec=10", "-p", `StandardOutput=append:${log}`, "-p", `StandardError=append:${log}`,
      ctx.NODE_BIN, `${seed}/alarm-sim.mjs`,
    ),
    false,
  ];
}

function snapshot(op: unknown, body: Record<string, unknown>, ctx: PluginCtx): PluginAction {
  const picked = ctx.pick(op, ["take", "restore", "rm"]);
  if (picked === "take") return ["Snapshot dos bancos", ctx.sh("snapshot.sh", "take", "--label", "manual"), false];
  const id = String(body.id ?? "");
  if (!SNAPSHOT_ID.test(id)) return ctx.refuse("id de snapshot inválido");
  if (picked === "rm") return [`Apagar o snapshot ${id}`, ctx.sh("snapshot.sh", "rm", id), false];
  return [`Restaurar o snapshot ${id}`, ctx.sh("snapshot.sh", "restore", id), true];
}

const mem = (view: UnitView): number => (typeof view.mem === "number" ? view.mem : 0);

export function sample(ctx: PluginCtx): Record<string, unknown> {
  // um simulador por unit hds-dev-<serial>; parado com sucesso some da lista, falho continua visível
  const units = ctx.units ?? {};
  const view = (name: string): UnitView => (ctx.unitView ? ctx.unitView(name) : {});
  const sims: UnitView[] = [];
  for (const name of Object.keys(units).sort()) {
    if (!name.startsWith(SIM_PREFIX) || name === BUS_UNIT) continue;
    const v = view(name);
    const result = units[name]?.Result;
    if (v.state !== "inactive" || !(result === "success" || result === undefined)) sims.push({ ...v, name: name.slice(SIM_PREFIX.length) });
  }
  const extras = Object.fromEntries(APOIO.map(([key, unit]) => [key, view(unit)]));
  const total = sims.reduce((sum, s) => sum + mem(s), 0) + mem(extras.devBus as UnitView);
  return { sims, extras, mem: total, logUnits: sims.map((s) => SIM_PREFIX + String(s.name)) };
}

export function snapshots(ctx: PluginCtx, _query: Record<string, unknown>): unknown {
  const done = Bun.spawnSync(["bash", `${ctx.D}/snapshot.sh`, "list", "--json"], { stdout: "pipe", stderr: "pipe", timeout: SNAPSHOT_LIST_TIMEOUT_MS });
  if (done.exitCode !== 0) throw new Error(`snapshot.sh list saiu ${done.exitCode}`);
  return JSON.parse(done.stdout.toString() || EMPTY_LIST);
}
