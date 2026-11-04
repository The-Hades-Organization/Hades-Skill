// Rotas de estado do painel que não dependem do amostrador: configurações, qualidade, Cerberus, doctor e documentos.
// Cada função devolve o corpo JSON ou lança BadRequest (o 400 do original).
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import * as cerberus from "../lib/cerberus.ts";
import { ConfigError, type ConfigStore, effective, exportText, plan, save } from "../lib/config-catalog.ts";
import { readText } from "../lib/fs.ts";
import * as quality from "../lib/quality.ts";
import { run } from "../lib/proc.ts";
import { BadRequest } from "./http.ts";
import type { PanelEnv } from "./env.ts";

type Json = Record<string, unknown>;

/** O terminal é execução de comando: ligar, teto, inatividade e anel só mudam pelo painel local (reference/panel.md §Terminal). */
const TERMINAL_KEYS = ["HADES_TERMINAL", "HADES_TERMINAL_MAX", "HADES_TERMINAL_IDLE_MIN", "HADES_TERMINAL_SCROLLBACK_KB"];
/** Chaves que o acesso remoto não muda (a porta e o início automático do painel); o import respeita o mesmo bloqueio. */
export const CONFIG_LOCAL_ONLY = ["HADES_PANEL_PORT", "HADES_WIDGET_PORT", "HADES_PANEL_AUTOSTART", "HADES_CHAT", "HADES_CHAT_BIN", ...TERMINAL_KEYS];
const CERBERUS_PREFIX = "HADES_CERBERUS_";
const RTK_PREFIX = "HADES_RTK_";
const EXC_TTL_KEY = "HADES_CERBERUS_EXC_TTL_H";
const HOUR_SECONDS = 3600;

/** Converte a falha de domínio das bibliotecas em 400; o resto sobe como erro de verdade. */
export function asBadRequest<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof ConfigError || error instanceof cerberus.Recusa || error instanceof quality.QualityError) {
      throw new BadRequest(error.message);
    }
    throw error;
  }
}

const store = (env: PanelEnv): ConfigStore => ({ dir: env.dir, kit: env.dir });

// ---------------------------------------------------------------- configurações

export const configValues = (env: PanelEnv): Record<string, string> => {
  try {
    return Object.fromEntries(effective(store(env)).map((item) => [item.key, item.value]));
  } catch {
    return {};
  }
};

export const configState = (env: PanelEnv): Json => ({ items: effective(store(env)), path: join(env.dir, "config.env") });

export function configExport(env: PanelEnv, query: Record<string, string>, remote: boolean): Uint8Array {
  if (remote && query.identity === "1") throw new BadRequest("contas e caminhos desta máquina só se exportam pelo painel local");
  return new TextEncoder().encode(exportText(store(env), query.all === "1", query.identity === "1"));
}

/** Chaves que só o painel local muda; o Cerberus inteiro entra pelo prefixo. */
export function remoteConfigRefusal(keys: string[]): string | undefined {
  if (keys.includes("HADES_PANEL_PORT")) return "a porta do painel só se muda pelo painel local";
  if (keys.some((k) => k === "HADES_CHAT" || k === "HADES_CHAT_BIN")) return "ligar a página Claude e o caminho do claude só se mudam pelo painel local";
  if (keys.some((k) => TERMINAL_KEYS.includes(k))) return "o terminal do painel (HADES_TERMINAL e seus limites) só se muda pelo painel local";
  if (keys.includes("HADES_PANEL_AUTOSTART")) return "o início automático do painel só se muda pelo painel local";
  if (keys.some((k) => k === "HADES_ORCH_AUTONOMY" || k === "HADES_ORCH_AUTO_START")) return "o nível de autonomia e a auto-alocação só se mudam pelo painel local";
  if (keys.some((k) => k === "HADES_CONFIRM_HOLD" || k === "HADES_CONFIRM_TYPED")) return "as travas de confirmação só se mudam pelo painel local";
  if (keys.some((k) => k.startsWith(CERBERUS_PREFIX))) return "o Cerberus só se configura pelo painel local";
  if (keys.some((k) => k.startsWith(RTK_PREFIX))) return "a política dos filtros do rtk só se muda pelo painel local";
  return undefined;
}

export function configKeys(body: Json): string[] {
  const values = typeof body.values === "object" && body.values !== null ? Object.keys(body.values) : [];
  return [...values, ...(Array.isArray(body.unset) ? body.unset.map(String) : [])];
}

export function configSave(env: PanelEnv, body: Json): { apply: string[]; keys: string[] } {
  const rawValues = body.values;
  const values =
    typeof rawValues === "object" && rawValues !== null
      ? Object.fromEntries(Object.entries(rawValues).map(([k, v]) => [String(k), String(v)]))
      : {};
  const unset = Array.isArray(body.unset) ? body.unset.map(String) : [];
  const apply = asBadRequest(() => save(store(env), values, unset));
  return { apply, keys: [...Object.keys(values), ...unset] };
}

export function configPreview(env: PanelEnv, body: Json, remote: boolean): Json {
  const cerberusKeys = Object.keys(cerberus.config()).filter((k) => k.startsWith(CERBERUS_PREFIX));
  const localOnly = remote ? [...CONFIG_LOCAL_ONLY, ...cerberusKeys] : [];
  return plan(store(env), String(body.text || ""), localOnly) as unknown as Json;
}

// ---------------------------------------------------------------- qualidade

export function qualityState(env: PanelEnv): Json {
  const { rules, conflicts, project } = quality.resolved(env.worktree);
  return {
    rules, conflicts, project, groups: quality.GROUPS, levels: quality.LEVELS,
    packs: quality.packs(rules), choices: join(quality.userDir(), "choices.tsv"),
  };
}

export function qualityAct(env: PanelEnv, body: Json): Json {
  const action = String(body.action || "");
  const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
  const group = body.group ? String(body.group) : undefined;
  const pack = body.pack ? String(body.pack) : undefined; // pacote: grava a escolha de cada regra dele
  asBadRequest(() => {
    if (action === "on" || action === "off") quality.setState(action, ids, group, Boolean(body.all), pack);
    else if (action === "reset") quality.reset(ids);
    else throw new BadRequest("ação inválida");
  });
  return qualityState(env);
}

// ---------------------------------------------------------------- Cerberus

export function cerberusState(env: PanelEnv): Json {
  const cfg = cerberus.config();
  const st = asBadRequest(() => {
    const state = cerberus.state(cfg);
    state.ttlH = cerberus.cfgInt(cfg, EXC_TTL_KEY, 1, 720);
    return state;
  });
  st.blocos = cerberusBlocks(env.ui);
  return st as Json;
}

/** Cabeças com bloco na página (ui/cerberus/<cabeça>.tsx, ou .js de plugin): o painel serve as duas como `<cabeça>.js`. */
export const cerberusBlocks = (ui: string): string[] =>
  cerberus.CABECAS.filter((cab) => [".tsx", ".js"].some((ext) => existsSync(join(ui, "cerberus", cab + ext))));

/** Abre exceção pelo painel local (quem chama já recusou o acesso remoto). */
export function cerberusAct(env: PanelEnv, body: Json): Json {
  if (String(body.action || "") !== "excecao") throw new BadRequest("ação inválida");
  const alvo = body.alvo ?? {};
  if (typeof alvo !== "object" || alvo === null || Array.isArray(alvo)) throw new BadRequest("alvo inválido");
  const exc = asBadRequest(() => {
    const ttlH = cerberus.cfgInt(cerberus.config(), EXC_TTL_KEY, 1, 720);
    return cerberus.openException(String(body.cabeca || ""), String(body.guarda || ""), String(body.momento || ""), String(body.motivo || ""), {
      alvo: Object.fromEntries(Object.entries(alvo).map(([k, v]) => [String(k), String(v)])), origem: "painel", ttlS: ttlH * HOUR_SECONDS,
    });
  });
  return { ...cerberusState(env), excecao: exc, remote: false };
}

// ---------------------------------------------------------------- doctor e documentos

export function doctorState(env: PanelEnv): Json {
  const file = join(env.dir, "doctor.json");
  if (!existsSync(file)) return {};
  return { ...(JSON.parse(readFileSync(file, "utf8")) as Json), mtime: statSync(file).mtimeMs / 1000 };
}

const DOC_GROUPS: [string, string[]][] = [
  ["Visão geral", ["SKILL.md"]],
  ["Operação", ["reference/run-hades.md", "reference/config.md", "reference/panel.md", "reference/onboard.md", "reference/branch.md"]],
  ["Ambiente", ["reference/architecture.md", "reference/tunnel.md"]],
  ["Loop", [
    "reference/loop/orchestrate.md", "reference/loop/consolidate.md", "reference/loop/brief-template.md", "reference/loop/gates.md",
    "reference/loop/collector.md", "reference/loop/report.md", "reference/loop/deliver.md", "reference/loop/inbox.md",
    "reference/loop/review.md", "reference/loop/cascade.md", "reference/loop/ops.md"]],
  ["Evolução", ["reference/evolving.md", "CHANGELOG.md"]],
];
const PROJECT_TIMEOUT_MS = 8000;

const docTitle = (text: string | undefined, fallback: string): string =>
  (text ?? "").split("\n").find((l) => l.startsWith("# "))?.slice(2).trim() ?? fallback;
const stem = (name: string): string => basename(name).replace(/\.[^.]*$/, "");

/** Textos do pacote do projeto ativo (reference/projects.md): `env/reference/*.md` e os arquivos de `refs`; id `pack/<rel>`. */
function packDocs(env: PanelEnv): { pack: string; ids: string[] } | undefined {
  const root = run(process.execPath, [join(env.skillDir, "src", "cli.ts"), "project", "pack", env.worktree], { timeoutMs: PROJECT_TIMEOUT_MS }).stdout.trim();
  if (!root || !existsSync(root) || !statSync(root).isDirectory()) return undefined;
  const refsDir = join(root, "env/reference");
  const rels = existsSync(refsDir) ? readdirSync(refsDir).filter((n) => n.endsWith(".md")).sort().map((n) => `env/reference/${n}`) : [];
  try {
    const refs = (JSON.parse(readText(join(root, "profile.json")) || "{}") as { refs?: Record<string, string> }).refs ?? {};
    for (const rel of Object.values(refs)) if (!rels.includes(rel) && existsSync(join(root, rel)) && statSync(join(root, rel)).isFile()) rels.push(rel);
  } catch {
    // profile.json ilegível: só os textos de env/reference
  }
  return { pack: root, ids: rels.map((r) => `pack/${r}`) };
}

export function docsIndex(env: PanelEnv): Json {
  const seen = new Set<string>();
  const groups: { title: string; items: { id: string; title: string }[] }[] = [];
  for (const [title, files] of DOC_GROUPS) {
    const items: { id: string; title: string }[] = [];
    for (const f of files) {
      const path = join(env.skillDir, f);
      if (!existsSync(path)) continue;
      seen.add(f);
      items.push({ id: f, title: docTitle(readText(path), stem(f)) });
    }
    groups.push({ title, items });
  }
  const refDir = join(env.skillDir, "reference");
  const extra = (existsSync(refDir) ? readdirSync(refDir).filter((n) => n.endsWith(".md")).sort() : [])
    .filter((n) => !seen.has(`reference/${n}`))
    .map((n) => ({ id: `reference/${n}`, title: docTitle(readText(join(refDir, n)), stem(n)) }));
  if (extra.length > 0) groups.push({ title: "Outros", items: extra });
  const docs = packDocs(env);
  if (docs && docs.ids.length > 0) {
    groups.splice(groups.length - 1, 0, {
      title: `Projeto (${basename(docs.pack)})`,
      items: docs.ids.map((id) => ({ id, title: docTitle(readText(join(docs.pack, id.slice(5))), stem(id)) })),
    });
  }
  return {
    groups: groups.filter((g) => g.items.length > 0),
    version: (readText(join(env.skillDir, "VERSION")) ?? "").trim(),
    path: env.skillDir,
  };
}

export function docText(env: PanelEnv, id: string): Json {
  const allowed = new Set((docsIndex(env).groups as { items: { id: string }[] }[]).flatMap((g) => g.items.map((i) => i.id)));
  if (!allowed.has(id)) throw new BadRequest("documento inválido");
  const path = id.startsWith("pack/") ? join(packDocs(env)?.pack ?? "", id.slice(5)) : join(env.skillDir, id);
  return { id, text: (readText(path) ?? "").replace(/^---\n[\s\S]*?\n---\n/, ""), mtime: statSync(path).mtimeMs / 1000 };
}
