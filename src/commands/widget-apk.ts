// Gera o APK assinado do widget Android (kit/android/build.sh): monta os fontes, roda o build num container Docker
// descartável e grava $D/android/hades-widget.apk e o sidecar hades-widget.apk.json que o painel lê.
import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { need } from "../lib/deps.ts";
import { EXIT, die, out } from "../lib/output.ts";
import { selfCli } from "../lib/paths.ts";
import { run } from "../lib/proc.ts";
import { WIDGET_BUILD_KIND, androidDirs, apkVersion, buildRunArgs, imageTag, registryRunArgs } from "../lib/widget-build.ts";
import { sourcesSha, syncSources } from "../lib/widget-sources.ts";

const USAGE = `uso: hades widget-apk [build|test|shots|list|new <id>|image|status]
  build      testes JVM + APK assinado em $D/android/hades-widget.apk (padrão)
  test       só os testes JVM (gradle testDebugUnitTest)
  shots      renderiza cada widget (layout e bind reais, layoutlib/Paparazzi) em $D/android/shots/*.png
  list       widgets registrados (widget/registry/*.widget), validando o registro
  new <id>   esqueleto de um widget novo, já registrado
  image      só garante a imagem e imprime tag e digest
  status     onde estão a imagem, o APK e a keystore
Estado em $D/android/ (reference/android-widget.md). Passa pela fila de builds sozinho; dentro da fila, roda direto.`;
const GATE_COST_GB = "3";
const STATE_DIR_MODE = 0o700;
const SECRET_FILE_MODE = 0o600;
const PUBLIC_FILE_MODE = 0o644;
const KEYSTORE = "hades-widget.keystore";
const KEYSTORE_PASS = "keystore.pass";
const APK = "hades-widget.apk";

type BuildCommand = "build" | "test" | "shots";
const BUILD_COMMANDS: readonly string[] = ["build", "test", "shots"];

const OTHER_COMMANDS: readonly string[] = ["list", "new", "image", "status"];

/** uid:gid de quem roda: o APK e as fontes novas saem do usuário, não do root */
const userSpec = (): string => `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;

const isBuildCommand = (name: string): name is BuildCommand => BUILD_COMMANDS.includes(name);

function dockerRun(args: string[]): number {
  return spawnSync("docker", args, { stdio: "inherit" }).status ?? EXIT.fail;
}

/** Garante a imagem do build (refeita quando o Dockerfile muda) e imprime a linha `imagem:` com o digest. */
function ensureImage(dockerDir: string, announce: boolean): string {
  const tag = imageTag(join(dockerDir, "Dockerfile"));
  if (run("docker", ["image", "inspect", tag]).status !== 0) {
    const built = run("docker", ["build", "-q", "-t", tag, dockerDir]);
    if (built.status !== 0) die(`docker build da imagem ${tag} falhou:\n${built.stderr.trim()}`, EXIT.fail);
  }
  const id = run("docker", ["image", "inspect", "--format", "{{.Id}}", tag]).stdout.trim();
  if (announce) out(`imagem: ${tag} ${id}`);
  return tag;
}

function status(dockerDir: string, state: string): number {
  const tag = imageTag(join(dockerDir, "Dockerfile"));
  const present = run("docker", ["image", "inspect", tag]).status === 0;
  out(`imagem: ${tag} (${present ? "presente" : "ausente"})`);
  const apk = join(state, APK);
  out(existsSync(apk) ? `apk: ${apk} (${statSync(apk).size} bytes)` : "apk: ainda não gerado");
  const keystore = join(state, KEYSTORE);
  out(existsSync(keystore) ? `keystore: ${keystore}` : "keystore: ainda não gerada");
  return EXIT.ok;
}

/** Já dentro de um gate (GATE_LOCK_TICKET) roda direto: a fila não admite gate dentro de gate. */
function queuedRunner(data: string): string | undefined {
  if (process.env.GATE_LOCK_TICKET) return undefined;
  const lock = process.env.GATE_LOCK || join(data, "gate", "gate-lock.sh");
  try {
    accessSync(lock, constants.X_OK);
  } catch {
    return undefined;
  }
  return lock;
}

function build(command: BuildCommand, dirs: ReturnType<typeof androidDirs>): number {
  const { kit, state } = dirs;
  const dockerDir = join(kit, "docker");
  mkdirSync(join(state, "build"), { recursive: true });
  mkdirSync(join(state, "gradle-home"), { recursive: true });
  chmodSync(state, STATE_DIR_MODE);
  const tag = ensureImage(dockerDir, true);
  // fontes copiados para $D/android/build: o build não suja a árvore da skill
  const widget = join(kit, "widget");
  syncSources(widget, join(state, "build", "src"));
  if (command === "shots") syncSources(join(kit, "shots"), join(state, "build", "shots"));
  const version = apkVersion(dirs.versionFile);
  const code = dockerRun(buildRunArgs({
    tag, state, insideScript: join(dockerDir, "inside.sh"), command, version, sourcesSha: sourcesSha(widget),
    name: `skilldev-widget-android-${process.pid}`, user: userSpec(),
  }));
  if (code !== EXIT.ok || command !== "build") return code;
  chmodSync(join(state, KEYSTORE), SECRET_FILE_MODE);
  chmodSync(join(state, KEYSTORE_PASS), SECRET_FILE_MODE);
  chmodSync(join(state, APK), PUBLIC_FILE_MODE);
  chmodSync(join(state, `${APK}.json`), PUBLIC_FILE_MODE);
  out(`apk: ${join(state, APK)} (${statSync(join(state, APK)).size} bytes, versão ${version.name}, código ${version.code})`);
  out(`imagem: ${tag}`);
  return EXIT.ok;
}

export function widgetApkCommand(args: string[]): number {
  const [sub = "build", id = ""] = args;
  if (sub === "-h" || sub === "--help") {
    out(USAGE);
    return EXIT.ok;
  }
  if (!isBuildCommand(sub) && !OTHER_COMMANDS.includes(sub)) {
    process.stderr.write(`${USAGE}\n`);
    return EXIT.usage;
  }
  need("docker");
  const dirs = androidDirs();
  const dockerDir = join(dirs.kit, "docker");
  if (sub === "status") return status(dockerDir, dirs.state);
  if (sub === "list" || sub === "new") {
    if (sub === "new" && !id) {
      process.stderr.write("uso: build.sh new <id>\n");
      return EXIT.usage;
    }
    const tag = ensureImage(dockerDir, false);
    return dockerRun(registryRunArgs(tag, join(dirs.kit, "widget"), userSpec(), sub, id));
  }
  const lock = queuedRunner(dirs.data);
  if (lock) {
    const self = selfCli("widget-apk", sub);
    return spawnSync(lock, ["run", "build", "--label", WIDGET_BUILD_KIND, "--cost-gb", GATE_COST_GB, "--", self.command, ...self.args], { stdio: "inherit" }).status ?? EXIT.fail;
  }
  if (!isBuildCommand(sub)) {
    ensureImage(dockerDir, true);
    return EXIT.ok;
  }
  return build(sub, dirs);
}
