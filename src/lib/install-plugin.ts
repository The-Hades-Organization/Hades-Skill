// Plugin do projeto no install: o que sai do $D quando ele está desligado, as renomeações do pacote e o disparo do
// post-install.sh. O contrato do post-install (guarda plugin-ensaio-isolado da Limiar): roda com `bash`, no cwd do
// install, com HADES_WT e HADES_DATA somados ao ambiente do install; status diferente de zero encerra o install com ele.
import { existsSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { sameContent, walkTree } from "./install-copy.ts";
import { isFile, readText } from "./fs.ts";
import { mustStep } from "./install-io.ts";

const RENAMED_OLD = /\.(sh|py)$/;
const POST_INSTALL = "post-install.sh";
/** do pacote desligado: o que nunca foi para o $D */
const NEVER_COPIED = new Set([POST_INSTALL, "renamed.tsv"]);

/**
 * Plugin desligado: sai do $D o que o env/ dele tinha posto, só o arquivo idêntico ao do pacote e que o kit não tem
 * (o kit já devolveu o do núcleo); estado gerado, segredo e arquivo mexido à mão não são iguais ao do pacote e ficam.
 */
export function removeDisabledPackFiles(packOff: string, kit: string, dest: string): void {
  const entries = walkTree(packOff, (_rel, name) => name === "__pycache__");
  for (const { rel, kind } of entries) {
    const top = rel.split("/")[0] as string;
    const keptInPack = (top === "assets" || top === "reference") && rel.includes("/");
    if (kind !== "file" || NEVER_COPIED.has(rel) || keptInPack) continue;
    if (existsSync(join(kit, rel)) || !isFile(join(dest, rel)) || !sameContent(join(packOff, rel), join(dest, rel))) continue;
    rmSync(join(dest, rel), { force: true });
  }
  // pastas que ficaram vazias, das mais fundas para cima; a que o kit tem fica
  for (const { rel, kind } of [...entries].reverse()) {
    if (kind !== "dir" || existsSync(join(kit, rel))) continue;
    try { if (readdirSync(join(dest, rel)).length === 0) rmdirSync(join(dest, rel)); } catch { /* ausente ou com conteúdo: fica */ }
  }
}

/**
 * Renomeações do pacote (env/renamed.tsv, `antigo<TAB>novo`): tira o órfão do $D. Só arquivo solto .sh/.py (sem `/`), só
 * com o novo presente e o antigo fora do pacote e do kit; nunca nome de estado.
 */
export function removeRenamedOrphans(packEnv: string, kit: string, dest: string, log: (line: string) => void): void {
  const text = readText(join(packEnv, "renamed.tsv"));
  if (text === undefined) return;
  for (const line of text.split("\n")) {
    const [old = "", renamed = ""] = line.replace(/^\t+/, "").split(/\t+/);
    if (old === "" || old.startsWith("#") || old.includes("/") || renamed.includes("/") || old === renamed || renamed === "" || !RENAMED_OLD.test(old)) continue;
    if (isFile(join(dest, renamed)) && isFile(join(dest, old)) && !existsSync(join(packEnv, old)) && !existsSync(join(kit, old))) {
      rmSync(join(dest, old), { force: true });
      log(`removido o antigo ${old} (agora ${renamed})`);
    }
  }
}

/** Roda o post-install.sh do pacote, se houver (ex.: preparar no worktree o que não vem do git). */
export function runPostInstall(packEnv: string, worktree: string, dest: string): void {
  const script = join(packEnv, POST_INSTALL);
  if (packEnv !== "" && isFile(script)) mustStep("bash", [script], { env: { HADES_WT: worktree, HADES_DATA: dest } });
}
