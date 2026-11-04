// `hades install`: instala o kit do Hades na pasta de dados ($D) e prepara o worktree. Idempotente; é o que o
// kit/install.sh executa (a casca existe porque roda antes de haver Bun). Reference/cli.md §install.
//   - copia o kit para $D (sobrescreve código; NUNCA toca estado/segredos: root.env, credenciais.md, o estado que o
//     ambiente do projeto grava (ex.: seed/state.json), conflicts.log, notes.md, *.sha, logs/, services.enabled,
//     config.env, snapshots/, panel/remote.key, panel/widget-token.json, panel-tunnel.*, panel-linger.mine, linger.mine,
//     boot.json, doctor.json, clean.lock, ntfy.topic, notify/, claude/, onboard.json, plugins.disabled, plugins-staging/,
//     plugins.lock, version-check.json, kit.manifest, rtk/, canvas-trash/, canvas.json, canvases/)
//   - grava $D/kit.manifest (sha256 de cada arquivo do kit instalado) e, na reinstalação, remove do $D o que estava no
//     manifesto anterior, o kit não tem mais e não foi editado à mão (editado: só avisa e fica); sem manifesto anterior,
//     só avisa os *.py e panel/ui/** que o kit não tem mais.
//     Em qualquer caso remove de panel/ui/** (fora de vendor/) o *.js que tem *.tsx irmão no kit: é a UI gerada de antes do TSX e sombreia o fonte Nada do $D é removido por espelho: ele guarda estado
//   - grava $D/kit.version (a VERSION da skill instalada; o doctor.sh compara com a da skill)
//   - gera $D/env.sh só se não existir (modelo kit/env.template.sh); env.sh antigo ganha o que falta (config.sh, HADES_ID, NODE_BIN)
//   - cria a slice `hades` no systemd (teto de memória, HADES_SLICE_* — config.sh apply-slice), timers e vigia
//   - sobrepõe o ambiente do projeto: a pasta `env.pack` do pacote do projeto ativo (reference/projects.md) vai para $D
//     com o mesmo layout; roda o `post-install.sh` dele, se houver, com HADES_WT e HADES_DATA somados ao ambiente do
//     install, no cwd do install: status diferente de zero encerra o install com ele. Sem `env.pack`, só a máquina
//   - os pontos de extensão do plugin (config.tsv, onboard.tsv, doctor.sh, plugin.json, panel/ do env.pack) vão para
//     $D/plugin/, espelhados (o que o plugin tirou some); sem env.pack, $D/plugin/ é removido
//   - remove do $D os scripts que o pacote renomeou (env/renamed.tsv: antigo<TAB>novo, só nome de arquivo; só se o novo veio junto)
//   - aplica o $D/config.defaults do ambiente (K=V) no config.env só onde o dono ainda não escolheu a chave
//   - recusa (exit 1) núcleo fora da faixa `core` do perfil do plugin do projeto (reference/projects.md §Plugin); sem `core`, só avisa
//   - plugin desligado ($D/plugins.disabled): instala só a máquina, sem conferir o `core`, e tira do $D o que o env/ dele
//     tinha posto (só arquivo idêntico ao do pacote e ausente do kit). Reinstalar nunca religa
//   - rtk presente (HADES_RTK_FILTERS=auto): gera o .rtk/filters.toml do worktree (filtros das stacks + do plugin), põe no
//     .git/info/exclude e confia nele (rtk trust --yes); off remove. env.sh exporta RTK_RECALL_DB/RTK_TEE_DIR em $D/rtk/ (reference/rtk.md)
//   - liga o rerere no worktree; registra o hook (guard register) e o slash-command /hades
//   - instância (reference/projects.md §Várias instâncias): HADES_ID no env.sh novo; instância a mais ganha porta de painel
//     (a partir de 21220) e de widget (a partir de 21221) provadas por bind. Registra o $D em ~/.claude/hades/instances/<projeto>
// Ambiente: HADES_WT, HADES_DATA, HADES_ID ([a-z0-9_], até 24; só vale na primeira instalação), SLICE_MEMORY_MAX/HIGH,
//   SKIP_SYSTEMD=1 / SKIP_WORKTREE=1 (o check do skill-release), SKIP_DOCTOR=1, GATE_LOCK, HADES_WORK_ROOT.
//   Sem HADES_WT, rodado de dentro do clone principal: cria o worktree <clone>-hades na branch hades/local.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { need } from "../lib/deps.ts";
import { ConfigError, effective, save } from "../lib/config-catalog.ts";
import { isDir, isFile, readText } from "../lib/fs.ts";
import { run, which } from "../lib/proc.ts";
import { git } from "../lib/kit.ts";
import {
  copyKit, copyPack, kitManifest, manifestText, mirrorPlugin, readOldManifest, retireOldKit, retireShadowedUiJs, warnLegacyCode,
} from "../lib/install-copy.ts";
import { renderEnvSh, upgradeEnvSh } from "../lib/install-env.ts";
import { installForWorktree } from "../lib/rtk-filters.ts";
import {
  assignPanelPort, assignWidgetPort, otherInstances, registerInstance, resolveHadesId,
} from "../lib/install-instance.ts";
import { exitWith, runStep, say, sayErr } from "../lib/install-io.ts";
import { removeDisabledPackFiles, removeRenamedOrphans, runPostInstall } from "../lib/install-plugin.ts";
import { applySystemd } from "../lib/install-systemd.ts";
import { enableRerere, ensureHadesWorktree, installSlashCommand, registerGuardHook, worktreeOf } from "../lib/install-worktree.ts";
import { EXIT, HadesError, warn } from "../lib/output.ts";
import { hadesHome, home, skillRoot } from "../lib/paths.ts";
import { workRoot } from "../lib/cerberus.ts";
import { coreCheck, getField, loadProfile } from "../lib/profile.ts";
import { packOf, resolveProject, slugOf } from "../lib/project.ts";

const KIT = join(skillRoot, "kit");

/** Variável de ambiente ligada (não vazia): o SKIP_* do check do skill-release. */
const flag = (name: string): boolean => Boolean(process.env[name]);

function hasBunDependencies(): boolean {
  const text = readText(join(skillRoot, "package.json"));
  if (text === undefined) return false;
  try {
    const deps = (JSON.parse(text) as { dependencies?: Record<string, string> }).dependencies;
    return Object.keys(deps ?? {}).length > 0;
  } catch {
    return false;
  }
}

/** Slug do remote como o nome da fila e do projeto (`dono__nome`). */
function queueSlug(origin: string): string {
  const owner = slugOf(origin);
  return owner === "" ? `${origin}__${origin}` : owner.replace("/", "__");
}

function addExecutable(path: string): void {
  const umask = process.umask();
  chmodSync(path, statSync(path).mode | (0o111 & ~umask));
}

function listScripts(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => n.endsWith(".sh") && isFile(join(dir, n))).sort().map((n) => join(dir, n));
  } catch {
    return [];
  }
}

/** Arquivo lido linha a linha, sem a última linha vazia. */
const linesOf = (text: string): string[] => text.split("\n").filter((l, i, all) => !(i === all.length - 1 && l === ""));

function applyConfigDefaults(data: string): void {
  const defaults = readText(join(data, "config.defaults"));
  if (defaults === undefined) return;
  for (const line of linesOf(defaults)) {
    const eq = line.indexOf("=");
    const key = eq < 0 ? line : line.slice(0, eq);
    if (key === "" || key.startsWith("#")) continue;
    const own = (readText(join(data, "config.env")) ?? "").split("\n");
    if (own.some((l) => l.startsWith(`${key}=`))) continue;
    try {
      save({ dir: data, kit: KIT }, { [key]: eq < 0 ? "" : line.slice(eq + 1) });
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      sayErr(error.message);
    }
  }
}

async function offerOnboarding(data: string): Promise<void> {
  say("");
  say("Onboarding: o que dá para preparar agora (escolha o que quer; o resto fica para depois)");
  runStep("bash", [join(data, "onboard.sh"), "status", "--brief", "--quick"], { env: { HADES_DATA: data } });
  say(`  → no Claude Code: /hades env onboard · no terminal: ${data}/onboard.sh pick · no painel: página Onboarding`);
  say("  Nada muda na máquina sem a sua aprovação.");
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await rl.question("Escolher agora? [s/N] ");
    rl.close();
    if (/^[sSyY]/.test(answer)) runStep("bash", [join(data, "onboard.sh"), "pick"], { env: { HADES_DATA: data } });
  }
}

// reinstalação: enquanto o onboarding não estiver completo, uma linha com o que falta (vazia = completo)
function remindOnboarding(data: string): void {
  const line = run("env", [`HADES_DATA=${data}`, "bash", join(data, "onboard.sh"), "status", "--line", "--quick"]).stdout.trim();
  if (line.startsWith("Onboarding:") && !line.includes("\n")) {
    say("");
    say(line);
  }
}

async function install(): Promise<void> {
  // o Bun roda a CLI hades e os wrappers dos scripts; git: falham cedo (o gerenciador de serviço é checado em applySystemd), com a instrução do registro
  const bun = need("bun");
  need("git");
  say(`bun: ${bun.version ?? ""} (${bun.path ?? ""})`);
  // lado Bun: a CLI roda do fonte e não tem dependência de runtime; se algum dia tiver (package.json "dependencies"), entra aqui
  if (hasBunDependencies()) {
    const status = runStep(bun.path as string, ["install", "--production", "--frozen-lockfile"]);
    if (status !== 0) exitWith(status);
  }
  const worktree = ensureHadesWorktree(worktreeOf());
  const data = process.env.HADES_DATA || `${worktree}-data`;
  const first = !isFile(join(data, "env.sh")); // primeira instalação: ao fim, o resumo do onboarding

  // plugin do projeto: o núcleo tem de estar na faixa `core` do perfil (sai 1 fora dela; sem `core` ou sem perfil, segue)
  const resolution = resolveProject(worktree);
  const pack = resolution.code === 0 ? packOf(resolution) : undefined;
  const packName = pack ? pack.slice(pack.lastIndexOf("/") + 1) : "";
  const disabledName = pack && linesOf(readText(join(data, "plugins.disabled")) ?? "").includes(packName) ? packName : "";
  if (disabledName === "") {
    const core = coreCheck(worktree, undefined);
    if (core.state === "fora" || core.state === "invalido") warn(`hades: ${core.message}`);
    else if (core.state === "sem-core") warn(`aviso: ${core.message}`);
    if (core.state === "fora" || core.state === "invalido") exitWith(EXIT.fail);
  }
  // ambiente do projeto: pasta env.pack do pacote do projeto deste worktree (vazio = só a parte da máquina)
  let packEnv = "";
  let packOff = "";
  const envPack = pack ? (getField(loadProfile(resolution), "env.pack", "") ?? "") : "";
  if (pack && envPack !== "" && isDir(join(pack, envPack))) {
    if (disabledName !== "") packOff = join(pack, envPack);
    else packEnv = join(pack, envPack);
  }
  if (disabledName !== "") say(`plugin ${disabledName} desligado (${data}/plugins.disabled): instalando só a parte da máquina (ligar: ${data}/plugins.sh enable ${disabledName})`);
  else if (packEnv === "") say(`aviso: o projeto de ${worktree} não declara env.pack: instalando só a parte da máquina (sem infra, seeds nem serviços)`);

  // fila de builds (kit/gate/gate-lock.sh): a mesma do loop, nos mesmos tickets de ~/.claude/hades/work — uma fila só
  const gateLock = process.env.GATE_LOCK || join(data, "gate", "gate-lock.sh");
  const origin = git(["-C", worktree, "config", "--get", "remote.origin.url"]).stdout.trim();
  if (origin === "") {
    sayErr(`erro: ${worktree} não tem remote.origin.url: o Hades nomeia a fila de gates e o projeto pelo remote. Rode git -C ${worktree} remote add origin <url> e instale de novo`);
    exitWith(EXIT.fail);
  }
  const slug = queueSlug(origin);
  const locks = join(workRoot(), slug, "locks");

  // instância: o HADES_ID do env.sh existente manda; numa instalação nova, o do ambiente ou o nome do projeto. Decide antes de tocar o $D
  const registry = hadesHome();
  const others = otherInstances(registry, data);
  const hadesId = resolveHadesId({
    data, envId: process.env.HADES_ID, project: packName, slug, others, skipSystemd: flag("SKIP_SYSTEMD"), say, sayErr,
  });
  process.env.HADES_ID = hadesId;
  const unitPrefix = `hds${hadesId ? `_${hadesId}` : ""}`;

  mkdirSync(join(data, "logs"), { recursive: true });
  mkdirSync(join(data, "gate"), { recursive: true });
  mkdirSync(join(data, "rtk", "tee"), { recursive: true });
  mkdirSync(locks, { recursive: true });
  const manifestFile = join(data, "kit.manifest");
  const oldManifest = readOldManifest(manifestFile);
  copyKit(KIT, data);
  // a cópia não remove nada do $D (ele também guarda estado): o manifesto diz o que era do kit
  const kept = oldManifest !== "" ? retireOldKit(oldManifest, KIT, data, say) : (warnLegacyCode(KIT, data, packEnv, say), []);
  retireShadowedUiJs(KIT, data, say);
  writeFileSync(manifestFile, manifestText([...kitManifest(KIT), ...kept]));

  if (packEnv !== "") {
    copyPack(packEnv, data);
    mirrorPlugin(packEnv, data);
  } else {
    rmSync(join(data, "plugin"), { recursive: true, force: true });
  }
  // plugin desligado: sai do $D o que o env/ dele pôs
  if (packOff !== "") removeDisabledPackFiles(packOff, KIT, data);
  if (packEnv !== "") removeRenamedOrphans(packEnv, KIT, data, say);
  rmSync(join(data, "boot.sh"), { force: true }); // saiu na migração do $HU-boot
  for (const script of [...listScripts(data), ...listScripts(join(data, "gate")), ...listScripts(join(data, "infra"))]) addExecutable(script);

  const envFile = join(data, "env.sh");
  const nodeBin = which("node") ?? "";
  if (!isFile(envFile)) {
    writeFileSync(envFile, renderEnvSh(readFileSync(join(KIT, "env.template.sh"), "utf8"), { wt: worktree, data, gateLock, locks, nodeBin, id: hadesId }));
  }
  const current = readFileSync(envFile, "utf8");
  const upgraded = upgradeEnvSh(current, nodeBin);
  if (upgraded !== current) writeFileSync(envFile, upgraded);
  for (const name of ["conflicts.log", "notes.md"]) if (!existsSync(join(data, name))) writeFileSync(join(data, name), "");

  applyConfigDefaults(data);
  if (hadesId !== "") {
    const ports = { data, kit: KIT, others, say };
    await assignPanelPort(ports);
    await assignWidgetPort(ports);
  }
  const version = readText(join(skillRoot, "VERSION"));
  writeFileSync(join(data, "kit.version"), version === undefined ? "" : `${version.split("\n", 1)[0]}${version.includes("\n") ? "\n" : ""}`);

  if (!flag("SKIP_SYSTEMD")) applySystemd({ data, kit: KIT, unitPrefix });
  if (!flag("SKIP_WORKTREE")) {
    enableRerere(worktree);
    runPostInstall(packEnv, worktree, data);
    const rtkLine = installForWorktree(worktree, data, home());
    if (rtkLine !== "") say(rtkLine);
  }
  registerGuardHook();
  if (!flag("SKIP_WORKTREE") || process.env.HADES_CLAUDE_COMMANDS) installSlashCommand(skillRoot);
  if (!flag("SKIP_WORKTREE")) registerInstance(registry, data, packName, say);

  if (hadesId !== "") {
    const port = effective({ dir: data, kit: KIT }).find((item) => item.key === "HADES_PANEL_PORT")?.value ?? "";
    say(`instância ${hadesId}: units ${unitPrefix}-*, slice hades_${hadesId}, projeto compose hades_${hadesId}, painel :${port}`);
  }
  const pluginState = packEnv !== "" ? `${data}/plugin` : disabledName !== "" ? `${disabledName} desligado` : "nenhum";
  say(`kit instalado em ${data} (worktree ${worktree}; gate-lock: ${gateLock || "ausente"}; plugin: ${pluginState})`);
  // diagnóstico informativo: nunca derruba a instalação
  if (!flag("SKIP_DOCTOR")) {
    say("");
    runStep("bash", [join(data, "doctor.sh")], { env: { HADES_DATA: data } });
  }
  // onboarding: só na primeira instalação (e sem onboard.json). Com terminal oferece o menu; sem, só imprime
  if (first && !existsSync(join(data, "onboard.json"))) await offerOnboarding(data);
  else remindOnboarding(data);
}

export async function installCommand(_args: string[]): Promise<number> {
  try {
    await install();
    return EXIT.ok;
  } catch (error) {
    if (!(error instanceof HadesError)) throw error;
    if (error.message !== "") sayErr(error.message);
    return error.code;
  }
}
