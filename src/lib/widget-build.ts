// Lado host do build do APK do widget Android (kit/android/build.sh): onde estão as pastas, versão, imagem e argumentos do container.
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { firstLine, readText } from "./fs.ts";
import { instanceFor } from "./instance.ts";
import { EXIT, die } from "./output.ts";
import { skillRoot } from "./paths.ts";

export const IMAGE_REPO = "hades-android-build";
export const WIDGET_BUILD_KIND = "widget-android";
const VERSION_FORMAT = /^([0-9]+)\.([0-9]+)\.([0-9]+)([0-9A-Za-z.+-]*)$/;
const MAJOR_WEIGHT = 10000;
const MINOR_WEIGHT = 100;
const IMAGE_TAG_HASH_CHARS = 12;
/** onde a pasta de estado e as fontes aparecem dentro do container */
const CONTAINER_WORK = "/work";
const CONTAINER_WIDGET = "/widget";
const CONTAINER_INSIDE = "/inside.sh";

export interface AndroidDirs {
  /** pasta do kit com widget/, docker/ e shots/: kit/android da skill ou o $D/android instalado */
  kit: string;
  /** o $D */
  data: string;
  /** $D/android: o estado (keystore, APK, sidecar, cache do Gradle e cópia dos fontes) */
  state: string;
  /** de onde sai a VERSION da skill */
  versionFile: string;
}

/**
 * O shim do kit exporta HADES_KIT_DIR como a pasta android/ dele. Dentro de $D (instalado) o estado é a própria pasta; no
 * kit da skill, o $D vem de HADES_DATA ou da instância do diretório atual, e nunca se grava na skill.
 */
export function androidDirs(): AndroidDirs {
  const exported = process.env.HADES_KIT_DIR;
  const kit = exported ? (basename(exported) === "android" ? exported : join(exported, "android")) : join(skillRoot, "kit", "android");
  if (resolve(dirname(kit)) !== resolve(skillRoot, "kit")) return { kit, data: dirname(kit), state: kit, versionFile: join(dirname(kit), "kit.version") };
  const data = process.env.HADES_DATA || instanceFor(process.cwd());
  if (!data) return die("sem instalação do Hades para guardar o APK: rode kit/install.sh (ou defina HADES_DATA)", EXIT.fail);
  return { kit, data, state: join(data, "android"), versionFile: join(skillRoot, "VERSION") };
}

export interface ApkVersion {
  name: string;
  code: number;
}

/** versionName = VERSION da skill; versionCode = major*10000 + minor*100 + patch (o Android só atualiza por cima com código maior ou igual). */
export function apkVersion(versionFile: string): ApkVersion {
  const line = firstLine(versionFile).replace(/\s+/g, "");
  const m = VERSION_FORMAT.exec(line);
  if (!m) return die(`VERSION da skill ilegível ('${line}'): esperado X.Y.Z`, EXIT.fail);
  return { name: line, code: Number(m[1]) * MAJOR_WEIGHT + Number(m[2]) * MINOR_WEIGHT + Number(m[3]) };
}

/** A tag leva o hash do Dockerfile: mudou a versão fixada, a imagem é refeita. */
export function imageTag(dockerfile: string): string {
  const text = readText(dockerfile);
  if (text === undefined) return die(`Dockerfile do build do widget ausente: ${dockerfile}`, EXIT.fail);
  return `${IMAGE_REPO}:${createHash("sha256").update(text).digest("hex").slice(0, IMAGE_TAG_HASH_CHARS)}`;
}

export interface BuildRun {
  tag: string;
  state: string;
  insideScript: string;
  command: "build" | "test" | "shots";
  version: ApkVersion;
  sourcesSha: string;
  /** nome do container e uid:gid de quem roda: o APK sai do usuário, não do root */
  name: string;
  user: string;
}

/** Argumentos do `docker run` do build, test e shots: o script de dentro é o inside.sh montado, com o comando em $1. */
export function buildRunArgs(run: BuildRun): string[] {
  return [
    "run", "--rm", "--name", run.name, "--user", run.user,
    "-e", `HOME=${CONTAINER_WORK}/home`, "-e", `GRADLE_USER_HOME=${CONTAINER_WORK}/gradle-home`,
    "-e", `HADES_VERSION_NAME=${run.version.name}`, "-e", `HADES_VERSION_CODE=${run.version.code}`, "-e", `HADES_SOURCES_SHA=${run.sourcesSha}`,
    "-v", `${run.state}:${CONTAINER_WORK}`, "-v", `${run.insideScript}:${CONTAINER_INSIDE}:ro`,
    run.tag, "bash", CONTAINER_INSIDE, run.command,
  ];
}

/** Argumentos do `docker run` de `list` e `new`: `new` escreve nas fontes da skill (com o uid do usuário), `list` só lê. */
export function registryRunArgs(tag: string, widgetDir: string, user: string, sub: "list" | "new", id?: string): string[] {
  const mount = sub === "new" ? `${widgetDir}:${CONTAINER_WIDGET}` : `${widgetDir}:${CONTAINER_WIDGET}:ro`;
  return ["run", "--rm", "--user", user, "-v", mount, tag, "bash", `${CONTAINER_WIDGET}/tools/run.sh`, CONTAINER_WIDGET, sub, ...(id ? [id] : [])];
}
