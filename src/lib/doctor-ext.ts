// Linha do doctor por extensão (reference/extensoes.md). O julgamento é puro: recebe o estado medido e devolve nível,
// texto e a ação que corrige. Extensão ausente não é falha: ela é opcional, e a linha mostra como instalar.
import { EXT_ERRORS } from "./extension-manifest.ts";
import { CARDINAL_EXT, CARDINAL_WEB_KEY, webBuildPresent } from "./drawing-engine.ts";
import { loadManifests, realDeps, statusOf, type ExtensionDeps, type ExtensionStatus } from "./extension.ts";

export interface ExtVerdict {
  level: "ok" | "warn";
  msg: string;
  fix: string;
}

export interface ExtDoctorItem extends ExtVerdict {
  id: string;
}

export function judgeExtension(s: ExtensionStatus): ExtVerdict {
  const estado = s.enabled ? "ligada" : "desligada";
  if (!s.installed) return { level: "ok", msg: `${s.name}: não instalada, ${estado} (instalar: ${s.install})`, fix: "" };
  const detail = `${s.name}: instalada${s.version === null ? "" : ` ${s.version}`}, ${estado}`;
  if (s.problems.length === 0) return { level: "ok", msg: `${detail}, saudável`, fix: "" };
  const why = s.problems.map((p) => p.message).join("; ");
  const belowMin = s.problems.some((p) => p.code === EXT_ERRORS.versionBelowMin);
  return { level: "warn", msg: `${detail}, com problema: ${why}`, fix: belowMin ? `atualize a extensão: ${s.install}` : `confira o binário de ${s.name}` };
}

/** Uma linha por extensão válida e um aviso por manifesto quebrado (o doctor da skill pega manifesto ruim cedo). */
export function extensionDoctorItems(deps: ExtensionDeps = realDeps()): ExtDoctorItem[] {
  const { extensions, broken } = loadManifests();
  const items: ExtDoctorItem[] = extensions.map(({ manifest }) => ({ id: `ext-${manifest.name}`, ...judgeExtension(statusOf(manifest, deps)) }));
  const cardinal = extensions.find((e) => e.manifest.name === CARDINAL_EXT);
  if (cardinal !== undefined) items.push(cardinalWebItem(deps.config.get(CARDINAL_WEB_KEY), webBuildPresent));
  for (const b of broken) {
    items.push({ id: `ext-${b.dir}`, level: "warn", msg: `manifesto de ${b.dir} inválido: ${b.errors.map((e) => `${e.field || "arquivo"} (${e.code})`).join("; ")}`, fix: "reinstale a skill (`/hades env update`)" });
  }
  return items;
}

/** Linha do build web do Cardinal: o binário e o editor são dependências independentes (reference/extensoes.md §Cardinal). */
export function cardinalWebItem(dir: string | undefined, present: (dir: string | undefined) => boolean): ExtDoctorItem {
  const id = "ext-cardinal-web";
  if (dir === undefined || dir === "") return { id, level: "ok", msg: `cardinal: build web não configurado (${CARDINAL_WEB_KEY} vazio); o nó mostra só o SVG guardado`, fix: "" };
  if (present(dir)) return { id, level: "ok", msg: `cardinal: build web presente em ${dir}`, fix: "" };
  return { id, level: "warn", msg: `cardinal: build web não encontrado em ${dir} (sem index.html)`, fix: `compile crates/cardinal/web e aponte ${CARDINAL_WEB_KEY} para a pasta dist/` };
}
