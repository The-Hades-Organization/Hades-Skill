// Cópia do kit e do env.pack para o $D, manifesto sha256 e retirada do que saiu do kit (kit/install.sh antes do rsync).
// A cópia preserva o modo (os .sh seguem executáveis) e nunca remove nada do $D, que também guarda estado.
import { createHash } from "node:crypto";
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, rmdirSync, symlinkSync, utimesSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import { isFile, readText } from "./fs.ts";

/** Arquivos do kit que o install não copia (o install.sh e o skill-release.sh rodam da skill, o modelo do env.sh é lido de lá). */
const KIT_NOT_COPIED = ["env.template.sh", "install.sh", "skill-release.sh"] as const;
/** Do env.pack: arquivo solto que não vai para o $D, e as pastas que ficam no pacote (textos e arquivos do post-install). */
const PACK_NOT_COPIED_FILES = ["post-install.sh", "renamed.tsv"] as const;
const PACK_NOT_COPIED_DIRS = ["assets", "reference"] as const;
const BYTECODE_DIR = "__pycache__";
/** Pontos de extensão do plugin: vão espelhados para $D/plugin, não para a raiz do $D. */
export const PLUGIN_FILES = ["config.tsv", "onboard.tsv", "doctor.sh", "plugin.json", "panel"] as const;

const alternation = (names: readonly string[]): string => names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
/** Nome (basename) dos arquivos que o install não copia; o skill-release confere o kit instalado contra ela. */
export const NOT_INSTALLED = new RegExp(`^(${alternation([...KIT_NOT_COPIED, ...PACK_NOT_COPIED_FILES])})$`);

type Kind = "dir" | "file" | "link";
interface Entry { rel: string; kind: Kind; mode: number; }

const bytewise = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
const nameOf = (rel: string): string => rel.slice(rel.lastIndexOf("/") + 1);

/** Percorre a árvore (pastas antes do conteúdo, ordem estável); `skip` poda a entrada e tudo que há dentro dela. */
export function walkTree(root: string, skip: (rel: string, name: string) => boolean): Entry[] {
  const found: Entry[] = [];
  const visit = (relDir: string): void => {
    const names = readdirSync(relDir ? join(root, relDir) : root).sort(bytewise);
    for (const name of names) {
      const rel = relDir ? `${relDir}/${name}` : name;
      if (skip(rel, name)) continue;
      const st = lstatSync(join(root, rel));
      const mode = st.mode & 0o7777;
      if (st.isDirectory()) { found.push({ rel, kind: "dir", mode }); visit(rel); }
      else if (st.isSymbolicLink()) found.push({ rel, kind: "link", mode });
      else if (st.isFile()) found.push({ rel, kind: "file", mode });
    }
  };
  visit("");
  return found;
}

export function sameContent(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

function copyEntry(src: string, dst: string, entry: Entry): void {
  if (entry.kind === "dir") {
    mkdirSync(dst, { recursive: true });
    if ((lstatSync(dst).mode & 0o7777) !== entry.mode) chmodSync(dst, entry.mode);
    return;
  }
  mkdirSync(dirname(dst), { recursive: true });
  if (entry.kind === "link") {
    rmSync(dst, { force: true });
    symlinkSync(readlinkSync(src), dst);
    return;
  }
  const st = lstatSync(src);
  if (!existsSync(dst) || !sameContent(src, dst)) copyFileSync(src, dst);
  if ((lstatSync(dst).mode & 0o7777) !== entry.mode) chmodSync(dst, entry.mode);
  utimesSync(dst, st.atime, st.mtime);
}

function copyTree(src: string, dst: string, skip: (rel: string, name: string) => boolean): void {
  mkdirSync(dst, { recursive: true });
  for (const entry of walkTree(src, skip)) copyEntry(join(src, entry.rel), join(dst, entry.rel), entry);
}

const kitSkip = (_rel: string, name: string): boolean => (KIT_NOT_COPIED as readonly string[]).includes(name) || name === BYTECODE_DIR;
const packSkip = (rel: string, name: string): boolean =>
  (PACK_NOT_COPIED_FILES as readonly string[]).includes(name) || (PACK_NOT_COPIED_DIRS as readonly string[]).includes(name) ||
  name === BYTECODE_DIR || (!rel.includes("/") && (PLUGIN_FILES as readonly string[]).includes(name));

export function copyKit(kit: string, dest: string): void {
  copyTree(kit, dest, kitSkip);
}

/** Sobrepõe o env.pack ao $D (os pontos de extensão do plugin ficam de fora: vão por mirrorPlugin). */
export function copyPack(pack: string, dest: string): void {
  copyTree(pack, dest, packSkip);
}

const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

/** Linhas `<sha256>␠␠<caminho>` de cada arquivo que o install põe, em ordem de bytes: o conteúdo do kit.manifest. */
export function kitManifest(kit: string): string[] {
  const files = walkTree(kit, kitSkip).filter((e) => e.kind === "file").map((e) => e.rel).sort(bytewise);
  return files.map((rel) => `${sha256(join(kit, rel))}  ${rel}`);
}

const safeRel = (rel: string): boolean => rel !== "" && !rel.startsWith("/") && !rel.startsWith("../") && !rel.includes("/../");

function removeEmptyParents(dir: string, stop: string): void {
  for (let cur = dir; cur.startsWith(stop + sep) && cur !== stop; cur = dirname(cur)) {
    try { rmdirSync(cur); } catch { return; }
  }
}

/**
 * O que o manifesto anterior listava, o kit não tem mais e continua igual: sai do $D. Editado à mão: avisa e fica, e a
 * linha segue no manifesto (devolvida) para o drift continuar apontando. `log` recebe cada linha de saída.
 */
export function retireOldKit(oldManifest: string, kit: string, dest: string, log: (line: string) => void): string[] {
  const kept: string[] = [];
  for (const line of oldManifest.split("\n")) {
    const at = line.indexOf("  ");
    if (at < 0) continue;
    const sum = line.slice(0, at), rel = line.slice(at + 2);
    if (!safeRel(rel) || existsSync(join(kit, rel)) || !isFile(join(dest, rel))) continue;
    if (sha256(join(dest, rel)) === sum) {
      rmSync(join(dest, rel), { force: true });
      removeEmptyParents(dirname(join(dest, rel)), dest);
      log(`removido do kit: ${rel}`);
    } else {
      log(`aviso: ${rel} saiu do kit mas foi editado em ${dest}; ficou (apague à mão se não precisa dele)`);
      kept.push(line);
    }
  }
  return kept;
}

/**
 * `.js` de panel/ui que sobrou de uma instalação anterior à UI em TSX: sem `.tsx` irmão ele sombreava o fonte novo (o
 * servidor só transpila quando o `.js` não existe) e não está no manifesto, então a reinstalação não o remove. É código
 * gerado, não estado. `vendor/` e `.js` sem `.tsx` irmão no kit (sw.js, bibliotecas) ficam.
 */
export function retireShadowedUiJs(kit: string, dest: string, log: (line: string) => void): void {
  const ui = join(dest, "panel", "ui");
  if (!existsSync(ui)) return;
  const files = walkTree(ui, (rel) => rel === "vendor").filter((e) => e.kind === "file" && e.rel.endsWith(".js")).map((e) => e.rel);
  for (const rel of files) {
    const base = join("panel", "ui", rel);
    if (existsSync(join(kit, base)) || !isFile(join(kit, base.replace(/\.js$/, ".tsx")))) continue;
    rmSync(join(dest, base), { force: true });
    removeEmptyParents(dirname(join(dest, base)), dest);
    log(`removido ${base}: o kit agora traz o .tsx (código gerado de uma versão anterior)`);
  }
}

const LEGACY_PRUNED = ["logs", "plugin", "plugins-staging", "snapshots", "notify", "claude", "seed", "pkgs"] as const;

/** Sem manifesto anterior não há como saber o que era do kit: só avisa o código antigo (*.py, panel/ui) que o kit não tem mais. */
export function warnLegacyCode(kit: string, dest: string, packEnv: string, log: (line: string) => void): void {
  const entries = walkTree(dest, (rel) => (LEGACY_PRUNED as readonly string[]).includes(rel));
  const files = entries.filter((e) => e.kind === "file").map((e) => e.rel).sort(bytewise);
  for (const rel of files) {
    if (!(rel.endsWith(".py") || rel.startsWith("panel/ui/"))) continue;
    if (!existsSync(join(kit, rel)) && (packEnv === "" || !existsSync(join(packEnv, rel)))) {
      log(`aviso: ${rel} não está mais no kit (código da versão anterior); apague à mão se não for seu`);
    }
  }
}

const pluginScope = (rel: string): boolean => (PLUGIN_FILES as readonly string[]).includes(rel.split("/")[0] as string);
const pluginSkip = (rel: string, name: string): boolean => name === BYTECODE_DIR || !pluginScope(rel);

/**
 * Espelha os pontos de extensão do pacote em $D/plugin: copia e remove o que o plugin tirou. Só mexe no que é ponto de
 * extensão (o resto de $D/plugin e os __pycache__ ficam), como o rsync --delete com filtro de inclusão que fazia isso.
 */
export function mirrorPlugin(pack: string, dest: string): void {
  const target = join(dest, "plugin");
  mkdirSync(target, { recursive: true });
  const wanted = walkTree(pack, pluginSkip);
  for (const entry of wanted) copyEntry(join(pack, entry.rel), join(target, entry.rel), entry);
  const keep = new Set(wanted.map((e) => e.rel));
  for (const entry of walkTree(target, pluginSkip)) if (!keep.has(entry.rel)) rmSync(join(target, entry.rel), { recursive: true, force: true });
}

export const manifestText = (lines: string[]): string => lines.map((l) => `${l}\n`).join("");

/** O conteúdo do manifesto anterior, ou "" se não há (arquivo ausente ou só linhas em branco). */
export function readOldManifest(file: string): string {
  return (readText(file) ?? "").replace(/\n+$/, "");
}
