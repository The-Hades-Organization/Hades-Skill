// Projeto ativo (reference/projects.md): repo do diretório → <raiz dos pacotes>/<projeto>/profile.json.
// Mesmo contrato do hades project resolve (lib.sh project_resolve).
import { dirname, join } from "node:path";
import { EXIT } from "./output.ts";
import { firstLine, isFile, listDir, readText } from "./fs.ts";
import { hadesHome } from "./paths.ts";
import { run } from "./proc.ts";

export interface Resolution {
  project: string | null;
  profile: string | null;
  repo: string | null;
  root: string | null;
  packs: string;
  /** 0 com perfil, 3 repo sem perfil, 4 fora de repo com remote.origin.url */
  code: number;
  message: string;
}

/** HADES_PACKS_ROOT > ~/.claude/hades/packs-root (uma linha) > ~/.claude/hades/packs */
export function packsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.HADES_PACKS_ROOT ?? "";
  if (fromEnv) return fromEnv;
  return firstLine(join(hadesHome(), "packs-root")) || join(hadesHome(), "packs");
}

/** `dono/nome` de uma url de remote (https ou scp), ou "" se não há os dois campos. */
export function slugOf(url: string): string {
  const fields = url.replace(/\.git$/, "").split(/[/:]/);
  if (fields.length < 2) return "";
  return `${fields[fields.length - 2]}/${fields[fields.length - 1]}`;
}

function jsonField(file: string): { repo: string; name: string } {
  const text = readText(file);
  if (text === undefined) return { repo: "", name: "" };
  try {
    const data: unknown = JSON.parse(text);
    if (typeof data !== "object" || data === null) return { repo: "", name: "" };
    const identity = (data as { identity?: unknown }).identity;
    const repo = typeof identity === "object" && identity !== null ? (identity as { repo?: unknown }).repo : undefined;
    const name = (data as { name?: unknown }).name;
    return { repo: typeof repo === "string" ? repo : "", name: typeof name === "string" ? name : "" };
  } catch {
    return { repo: "", name: "" };
  }
}

/** Caminho do profile.json cujo identity.repo casa com o slug (sem caixa). */
export function findProfile(slug: string, root: string = packsRoot()): string | undefined {
  const wanted = slug.toLowerCase();
  if (!wanted) return undefined;
  for (const name of listDir(root)) {
    const file = join(root, name, "profile.json");
    if (isFile(file) && jsonField(file).repo.toLowerCase() === wanted) return file;
  }
  return undefined;
}

export function resolveProject(dir: string = process.cwd()): Resolution {
  const packs = packsRoot();
  const result: Resolution = { project: null, profile: null, repo: null, root: null, packs, code: 0, message: "" };
  const url = run("git", ["-C", dir, "config", "--get", "remote.origin.url"]).stdout.trim();
  if (!url) {
    result.code = EXIT.outsideRepo;
    result.message = `hades: ${dir} não está num repositório git com remote.origin.url — o projeto ativo vem do repo do diretório atual`;
    return result;
  }
  result.root = run("git", ["-C", dir, "rev-parse", "--show-toplevel"]).stdout.trim() || null;
  const repo = slugOf(url);
  result.repo = repo || null;
  const profile = findProfile(repo, packs);
  if (!profile) {
    result.code = EXIT.noProfile;
    result.message = `hades: ${repo} sem perfil em ${packs}/ — rode /hades project init para criar o perfil do projeto (reference/projects.md)`;
    return result;
  }
  result.profile = profile;
  result.project = jsonField(profile).name || null;
  return result;
}

/** O formato JSON dos três resolvedores (hades project, hades project, hades project). */
export function resolutionJson(r: Resolution): string {
  return JSON.stringify({ project: r.project, profile: r.profile, repo: r.repo, root: r.root, packs: r.packs });
}

export function packOf(r: Resolution): string | undefined {
  return r.profile ? dirname(r.profile) : undefined;
}

/** Resolve pelo slug `dono/nome`, sem olhar o git (hades_project.resolve(slug=…)): `root` fica vazio. */
export function resolveSlug(slug: string): Resolution {
  const packs = packsRoot();
  const result: Resolution = { project: null, profile: null, repo: slug || null, root: null, packs, code: 0, message: "" };
  const profile = findProfile(slug, packs);
  if (!profile) {
    result.code = EXIT.noProfile;
    result.message = `hades: ${slug} sem perfil em ${packs}/ — rode /hades project init para criar o perfil do projeto (reference/projects.md)`;
    return result;
  }
  result.profile = profile;
  result.project = jsonField(profile).name || null;
  return result;
}
