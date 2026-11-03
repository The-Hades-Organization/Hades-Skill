// Catálogo de qualidade (reference/quality.md): regras globais que o dono liga e desliga e que entram nos briefs e nas fases.
// Catálogo: <skill>/quality/*.json, depois ~/.claude/hades/quality/*.json (mesmo id: o do usuário vence). Escolhas em
// ~/.claude/hades/quality/choices.tsv (só o que difere do padrão). O perfil do projeto (rules.quality) só sobe severidade
// ou declara contradição.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listDir, readText } from "./fs.ts";
import { hadesHome, skillRoot } from "./paths.ts";
import { type Json, type JsonObject, isObject, loadProfile, pathValue, pyRepr, readJson } from "./profile.ts";
import { resolveProject } from "./project.ts";

export const GROUPS = ["linguagem", "framework", "praticas", "estilo", "testes", "banco"];
export const LEVELS = ["bloqueante", "alta", "media", "baixa"];
const PHASES: Record<string, string> = {
  brief: "regras ligadas para este trabalho",
  deliver: "regras ligadas: aplique ao escrever e confira antes do gate",
  inbox: "regras ligadas: aplique ao resolver cada comentário",
  review: "regras ligadas: confira o diff contra elas e cite o id no achado",
};
const RULE_ID = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
const PACK_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SCHEMA = "hades.quality/1";

export type Source = "base" | "usuario";
export type State = "on" | "off";

export function userDir(): string {
  return join(hadesHome(), "quality");
}

function str(value: Json | undefined, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function items(file: string, key: "rules" | "packs"): JsonObject[] {
  const doc = readJson(file);
  if (!isObject(doc) || doc.schema !== SCHEMA) return [];
  const list = doc[key];
  return Array.isArray(list) ? list.filter(isObject) : [];
}

function* catalogFiles(): Generator<{ file: string; source: Source }> {
  for (const [root, source] of [
    [join(skillRoot, "quality"), "base"],
    [userDir(), "usuario"],
  ] as [string, Source][]) {
    for (const name of listDir(root).filter((n) => n.endsWith(".json"))) yield { file: join(root, name), source };
  }
}

/** Itens na ordem do catálogo base, depois os do usuário; id repetido: o último vence (e fica no lugar do primeiro). */
function collect(key: "rules" | "packs"): JsonObject[] {
  const out = new Map<string, JsonObject>();
  for (const { file, source } of catalogFiles()) {
    for (const item of items(file, key)) out.set(str(item.id), { ...item, source });
  }
  return [...out.values()];
}

export const catalog = (): JsonObject[] => collect("rules");
export const packDefs = (): JsonObject[] => collect("packs");

function strings(value: Json | undefined): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Verdade como no Python: null, false, 0, "" e vazios são falsos. */
function truthy(value: Json | undefined): boolean {
  if (value === undefined || value === null || value === false || value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  return isObject(value) ? Object.keys(value).length > 0 : true;
}

const unique = (list: string[]): string[] => [...new Set(list)];

export function readChoices(): Map<string, State> {
  const choices = new Map<string, State>();
  const text = readText(join(userDir(), "choices.tsv"));
  if (text === undefined) return choices;
  for (const line of text.split(/\r?\n/)) {
    const cols = line.split("\t");
    if (line && !line.startsWith("#") && cols.length === 2 && (cols[1] === "on" || cols[1] === "off")) choices.set(cols[0] as string, cols[1]);
  }
  return choices;
}

const codepointOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Só as linhas que diferem do padrão; mantém os comentários do dono. */
export function writeChoices(choices: Map<string, State>, rules: JsonObject[]): void {
  const defaults = new Map(rules.map((r) => [str(r.id), str(r.default, "on")]));
  const file = join(userDir(), "choices.tsv");
  const previous = readText(file);
  const keep = previous === undefined ? [] : previous.split(/\r?\n/).filter((l) => l.startsWith("#"));
  const body = [...choices]
    .sort(([a], [b]) => codepointOrder(a, b))
    .filter(([id, state]) => defaults.get(id) !== state)
    .map(([id, state]) => `${id}\t${state}`);
  mkdirSync(userDir(), { recursive: true });
  if (keep.length === 0 && body.length === 0) {
    rmSync(file, { force: true });
    return;
  }
  writeFileSync(file, `${[...keep, ...body].join("\n")}\n`);
}

export function effective(rules: JsonObject[] = catalog(), choices: Map<string, State> = readChoices()): JsonObject[] {
  return rules.map((r) => {
    const id = str(r.id);
    const fallback = str(r.default, "on");
    return { ...r, state: choices.get(id) ?? fallback, default: fallback, chosen: choices.has(id) };
  });
}

/** Pacotes com o estado tirado das regras: on (todas ligadas), off (nenhuma) ou partial. */
export function packs(rules: JsonObject[] = effective()): JsonObject[] {
  const state = new Map(rules.map((r) => [str(r.id), str(r.state)]));
  return packDefs().map((k) => {
    const listed = strings(k.rules);
    const members = unique(listed).filter((i) => state.has(i));
    const on = members.filter((i) => state.get(i) === "on").length;
    return {
      ...k,
      rules: members,
      missing: listed.filter((i) => !state.has(i)),
      on,
      total: members.length,
      state: on === 0 ? "off" : on === members.length ? "on" : "partial",
    };
  });
}

/** Erros do catálogo: id fora do formato, regra ou pacote repetido entre arquivos base e pacote que cita regra inexistente. */
export function validateCatalog(): string[] {
  const errors: string[] = [];
  const seen = new Map<string, string>();
  const seenPack = new Map<string, string>();
  for (const { file, source } of catalogFiles()) {
    const name = file.slice(file.lastIndexOf("/") + 1);
    for (const r of items(file, "rules")) {
      const id = str(r.id);
      if (!RULE_ID.test(id)) errors.push(`${name}: id de regra fora do formato: ${pyRepr(id)}`);
      if (source === "base" && seen.has(id)) errors.push(`${name}: regra repetida ${id} (já em ${seen.get(id)})`);
      if (!seen.has(id)) seen.set(id, name);
    }
    for (const k of items(file, "packs")) {
      const id = str(k.id);
      if (!PACK_ID.test(id)) errors.push(`${name}: id de pacote fora do formato: ${pyRepr(id)}`);
      if (source === "base" && seenPack.has(id)) errors.push(`${name}: pacote repetido ${id} (já em ${seenPack.get(id)})`);
      if (!seenPack.has(id)) seenPack.set(id, name);
      const listed = strings(k.rules);
      const dup = unique(listed.filter((x) => listed.filter((y) => y === x).length > 1)).sort(codepointOrder);
      if (dup.length > 0) errors.push(`${name}: pacote ${id} repete ${dup.join(", ")}`);
    }
  }
  const known = new Set(catalog().map((r) => str(r.id)));
  for (const k of packDefs()) {
    for (const x of strings(k.rules)) if (!known.has(x)) errors.push(`pacote ${str(k.id)}: regra desconhecida ${x}`);
  }
  return errors;
}

// ------------------------------------------------------------------ perfil do projeto

function overlayOf(dir: string | undefined): { overlay: Map<string, JsonObject>; project: string | null } {
  const resolution = resolveProject(dir ?? process.cwd());
  if (resolution.code !== 0) return { overlay: new Map(), project: null };
  const raw = pathValue(loadProfile(resolution), "rules.quality");
  const entries = Array.isArray(raw) ? raw : [];
  const overlay = new Map<string, JsonObject>();
  for (const e of entries) if (isObject(e) && str(e.id)) overlay.set(str(e.id), e);
  return { overlay, project: resolution.project };
}

export interface Conflict {
  id: string;
  kind: "severidade-menor" | "contradiz" | "id-desconhecido";
  project: string | null;
  note: string;
  detail: string;
}

/** Regras com a severidade efetiva (o perfil só sobe) e os conflitos com o projeto. */
export function resolved(dir: string | undefined): { rules: JsonObject[]; conflicts: Conflict[]; project: string | null } {
  const { overlay, project } = overlayOf(dir);
  const rules: JsonObject[] = [];
  const conflicts: Conflict[] = [];
  for (const base of effective()) {
    const severity = str(base.severity);
    const r: JsonObject = { ...base, effSeverity: severity };
    const o = overlay.get(str(base.id));
    if (o) {
      const want = str(o.severity);
      const wantAt = LEVELS.indexOf(want);
      const haveAt = LEVELS.indexOf(severity);
      if (wantAt >= 0 && wantAt < haveAt) {
        r.effSeverity = want;
        r.raisedBy = project;
      } else if (wantAt >= 0 && wantAt > haveAt && r.state === "on") {
        conflicts.push({
          id: str(r.id),
          kind: "severidade-menor",
          project,
          note: str(o.note),
          detail: `o projeto pede ${want}, o catálogo ligado exige ${severity}: vale ${severity}`,
        });
      }
      if (truthy(o.contradicts) && r.state === "on") {
        conflicts.push({ id: str(r.id), kind: "contradiz", project, note: str(o.note), detail: "a regra do projeto contraria este item ligado" });
      }
    }
    rules.push(r);
  }
  const known = new Set(rules.map((r) => str(r.id)));
  for (const [id, o] of overlay) {
    if (!known.has(id)) {
      conflicts.push({ id, kind: "id-desconhecido", project, note: str(o.note), detail: "o perfil cita um id que não está no catálogo" });
    }
  }
  return { rules, conflicts, project };
}

function checkSuffix(check: Json | undefined): string {
  if (!isObject(check)) return "";
  if (check.kind === "grep") return ` — checagem: \`grep -E '${str(check.pattern)}'\` em \`${str(check.files, "*")}\``;
  return ` — checagem: \`${str(check.cmd)}\``;
}

export function inject(phase: string, dir: string | undefined): string {
  const { rules } = resolved(dir);
  const on = rules.filter((r) => r.state === "on");
  if (on.length === 0) return "";
  const rank = (r: JsonObject): [number, number, string] => [LEVELS.indexOf(str(r.effSeverity)), GROUPS.indexOf(str(r.group)), str(r.id)];
  const order = (a: JsonObject, b: JsonObject): number => {
    const [la, ga, ia] = rank(a);
    const [lb, gb, ib] = rank(b);
    return la - lb || ga - gb || codepointOrder(ia, ib);
  };
  const out = [
    `## Qualidade — ${PHASES[phase] ?? PHASES.brief}`,
    "",
    "Precedência: invariantes da Hades > pedido do dono > regras do projeto > estas regras > código vizinho. " +
      "Regra do projeto que contraria uma destas vale; registre o conflito no relatório da passada.",
    "",
  ];
  for (const level of LEVELS) {
    const group = on.filter((r) => r.effSeverity === level).sort(order);
    if (group.length === 0) continue;
    out.push(`**${level}**`);
    for (const r of group) {
      const extra = ["review", "deliver", "brief"].includes(phase) ? checkSuffix(r.check) : "";
      const tag = r.raisedBy ? ` (subida por ${str(r.raisedBy)})` : "";
      out.push(`- \`${str(r.id)}\` [${str(r.group)}]${tag}: ${str(r.text)}${extra}`);
    }
    out.push("");
  }
  return `${out.join("\n").trimEnd()}\n`;
}

export function conflictsSection(dir: string | undefined): string {
  const { conflicts } = resolved(dir);
  if (conflicts.length === 0) return "";
  const out = ["## Conflitos de qualidade", ""];
  for (const c of conflicts) {
    const note = c.note ? ` Nota do projeto: ${c.note}` : "";
    out.push(`- \`${c.id}\` (${c.kind}, projeto ${c.project || "—"}): ${c.detail}.${note}`);
  }
  return `${out.join("\n")}\n`;
}

// ------------------------------------------------------------------ escolhas

export class QualityError extends Error {}

export function packMembers(pack: string, rules: JsonObject[]): string[] {
  const defs = packDefs();
  const k = defs.find((d) => d.id === pack);
  if (!k) throw new QualityError(`pacote desconhecido: ${pack} (use ${defs.map((x) => str(x.id)).join(", ")})`);
  const known = new Set(rules.map((r) => str(r.id)));
  return unique(strings(k.rules)).filter((i) => known.has(i));
}

export function select(rules: JsonObject[], ids: string[], group: string | undefined, all: boolean, pack?: string): string[] {
  if (all) return rules.map((r) => str(r.id));
  const out: string[] = [];
  for (const a of ids) {
    const hit = rules.map((r) => str(r.id)).filter((id) => id === a || (a.endsWith(".") && id.startsWith(a)));
    if (hit.length === 0) throw new QualityError(`regra desconhecida: ${a}`);
    out.push(...hit);
  }
  if (group) {
    if (!GROUPS.includes(group)) throw new QualityError(`grupo desconhecido: ${group} (use ${GROUPS.join(", ")})`);
    out.push(...rules.filter((r) => r.group === group).map((r) => str(r.id)));
  }
  if (pack) out.push(...packMembers(pack, rules));
  if (out.length === 0) throw new QualityError("diga o id, um prefixo terminado em ponto, --group, --pack ou --all");
  return out;
}

export function setState(state: State, ids: string[], group: string | undefined, all: boolean, pack: string | undefined): number {
  const rules = catalog();
  const choices = readChoices();
  for (const id of select(rules, ids, group, all, pack)) choices.set(id, state);
  writeChoices(choices, rules);
  return choices.size;
}

export function reset(ids: string[]): void {
  const rules = catalog();
  const choices = readChoices();
  for (const id of select(rules, ids, undefined, ids.length === 0)) choices.delete(id);
  writeChoices(choices, rules);
}
