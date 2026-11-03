// `hades thanatos`: post-mortem de incidente e bug em produção do projeto (reference/thanatos.md). Grava fora do repositório,
// em <work>/<owner>__<repo>/postmortems/<id>.md + <id>.json. A lógica está em src/lib/thanatos*.ts; aqui só argumentos,
// projeto ativo e a fronteira (git, gh, plugin, relógio), que o teste troca por `ThanatosContext`.
import { join } from "node:path";
import { findStateDir } from "../lib/kit.ts";
import { readText } from "../lib/fs.ts";
import { journalWorkRoot } from "../lib/journal.ts";
import { envDir } from "../lib/plugins.ts";
import { run } from "../lib/proc.ts";
import { loadProfile, type JsonObject } from "../lib/profile.ts";
import { packOf, resolveProject } from "../lib/project.ts";
import { EXIT, die, out } from "../lib/output.ts";
import { configValue, loadWorkEnv } from "../lib/work.ts";
import { fetchSource } from "../lib/thanatos-source.ts";
import { GatherError, gather, journalFacts, windowOf, type Exec } from "../lib/thanatos-gather.ts";
import {
  buildPostmortem, citedFiles, exists, formatDuration, idOf, listPostmortems, parseInput, readMarkdown, readPostmortem, savePostmortem,
  searchPostmortems, type SourceResult,
} from "../lib/thanatos.ts";

export const USAGE = `Post-mortem de incidente e bug em produção do projeto (reference/thanatos.md).
Uso: hades thanatos new <card|PR|<iso>..<iso>> [--force] [--json]
     hades thanatos list [--json]
     hades thanatos show <id> [--json]
     hades thanatos search <termo> [--json]
     hades thanatos cited [--base <ref> | --pr <n> | <arquivo>…] [--json]
  new     monta o post-mortem de git + PRs + reviews (+ diário e fonte externa do plugin, quando há) e grava em
          <work>/<owner>__<repo>/postmortems/; recusa sobrescrever sem --force
  cited   avisa quando os arquivos tocados já foram citados em post-mortem anterior (deliver e review; sempre sai 0)`;

const DEFAULTS = { sourceTimeoutS: 60, ioTimeoutS: 60, maxPrs: 30, journalMax: 40 };
const MAX = { sourceTimeoutS: 600, ioTimeoutS: 600, maxPrs: 200, journalMax: 500 };

export interface ThanatosContext {
  now(): Date;
  exec: Exec;
  /** pasta dos post-mortems do projeto */
  dir: string;
  slug: string;
  repo: string;
  cardPattern?: string;
  /** pasta env/ do plugin do projeto */
  pluginEnv?: string;
  credentials?: string;
  journalRoot?: string;
  settings: { sourceTimeoutS: number; ioTimeoutS: number; maxPrs: number; journalMax: number };
}

interface Options { force: boolean; json: boolean; base?: string; pr?: string }

function parseOptions(args: string[]): { positional: string[]; options: Options } {
  const options: Options = { force: false, json: false };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--json") options.json = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--base" || arg === "--pr") {
      const value = args[i + 1];
      if (value === undefined) die(`${arg} exige um valor\n${USAGE}`);
      options[arg.slice(2) as "base" | "pr"] = value;
      i += 1;
    } else if (arg.startsWith("--")) die(`opção desconhecida: ${arg}\n${USAGE}`);
    else positional.push(arg);
  }
  return { positional, options };
}

const intSetting = (key: keyof typeof DEFAULTS, name: string): number => {
  const n = Number.parseInt(configValue(name, String(DEFAULTS[key])).trim(), 10);
  return Number.isInteger(n) && n >= 1 && n <= MAX[key] ? n : DEFAULTS[key];
};

/** Conta do gh do perfil sem trocar a conta ativa (como o coletor do loop): GH_TOKEN/GITHUB_TOKEN do ambiente vencem. */
function useProjectToken(profile: JsonObject, exec: Exec): void {
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return;
  const identity = typeof profile.identity === "object" && profile.identity !== null && !Array.isArray(profile.identity) ? profile.identity : {};
  const gh = (identity as JsonObject).gh;
  const ghId = typeof gh === "object" && gh !== null && !Array.isArray(gh) ? (gh as JsonObject) : {};
  const fromEnv = typeof ghId.tokenEnv === "string" ? process.env[ghId.tokenEnv] : undefined;
  if (fromEnv) {
    process.env.GH_TOKEN = fromEnv;
    return;
  }
  if (typeof ghId.user !== "string") return;
  const r = exec("gh", ["auth", "token", "--user", ghId.user]);
  if (r.status === 0 && r.stdout.trim() !== "") process.env.GH_TOKEN = r.stdout.trim();
}

function realContext(): ThanatosContext {
  const work = loadWorkEnv();
  const slug = work.slug;
  const resolution = resolveProject(work.repoTop);
  const profile = resolution.code === 0 ? loadProfile(resolution) : {};
  const pack = packOf(resolution);
  const settings = {
    sourceTimeoutS: intSetting("sourceTimeoutS", "HADES_THANATOS_SOURCE_TIMEOUT_S"),
    ioTimeoutS: intSetting("ioTimeoutS", "HADES_THANATOS_IO_TIMEOUT_S"),
    maxPrs: intSetting("maxPrs", "HADES_THANATOS_MAX_PRS"),
    journalMax: intSetting("journalMax", "HADES_THANATOS_JOURNAL_MAX"),
  };
  const exec: Exec = (command, args) => run(command, args, { cwd: work.repoTop, timeoutMs: settings.ioTimeoutS * 1000 });
  useProjectToken(profile, exec);
  const card = typeof profile.card === "object" && profile.card !== null && !Array.isArray(profile.card) ? (profile.card as JsonObject) : {};
  const state = findStateDir();
  return {
    now: () => new Date(),
    exec,
    dir: join(work.work, "postmortems"),
    slug,
    repo: slug.replace("__", "/"),
    cardPattern: card.provider !== "none" && typeof card.idPattern === "string" ? card.idPattern : undefined,
    pluginEnv: pack !== undefined ? (envDir(pack, profile) ?? undefined) : undefined,
    credentials: state !== undefined ? readText(join(state, "credenciais.md")) : undefined,
    journalRoot: journalWorkRoot(),
    settings,
  };
}

function newPostmortem(ctx: ThanatosContext, text: string, options: Options): number {
  const input = parseInput(text, ctx.cardPattern);
  const id = idOf(input);
  if (exists(ctx.dir, id) && !options.force) die(`post-mortem ${id} já existe em ${ctx.dir}; use --force para regerar (a edição à mão se perde)`, EXIT.fail);
  let gathered;
  try {
    gathered = gather(input, ctx.exec, { repo: ctx.repo, maxPrs: ctx.settings.maxPrs, journalMax: ctx.settings.journalMax });
  } catch (error) {
    if (error instanceof GatherError) return die(error.message, EXIT.fail);
    throw error;
  }
  const window = windowOf(input, gathered);
  const journal = window ? journalFacts(ctx.slug, window.from, window.to, ctx.settings.journalMax, ctx.journalRoot) : [];
  const source: SourceResult = window
    ? fetchSource(window.from, window.to, { envDir: ctx.pluginEnv, credentials: ctx.credentials, timeoutS: ctx.settings.sourceTimeoutS })
    : { status: "absent", note: "sem janela de tempo (nenhuma PR mergeada) para consultar a fonte externa", events: [], metrics: [] };
  const pm = buildPostmortem(input, gathered, source, journal, ctx.now());
  const saved = savePostmortem(ctx.dir, pm);
  if (options.json) out(JSON.stringify(pm));
  else {
    out(`post-mortem ${pm.id} gravado`);
    out(`  ${saved.md}`);
    out(`  ${saved.json}`);
    const ttf = pm.fixData.timeToFix;
    out(`  ${pm.fixData.prs.length} PR(s), ${pm.timeline.length} evento(s), tempo até a correção: ${ttf ? formatDuration(ttf.ms) : "n/d"}`);
    for (const gap of pm.gaps) out(`  lacuna: ${gap}`);
  }
  return EXIT.ok;
}

function showOne(ctx: ThanatosContext, id: string, options: Options): number {
  const pm = readPostmortem(ctx.dir, id);
  const md = readMarkdown(ctx.dir, id);
  if (pm === undefined || md === undefined) return die(`post-mortem não encontrado: ${id}`, EXIT.fail);
  if (options.json) out(JSON.stringify(pm));
  else out(md.replace(/\n$/, ""));
  return EXIT.ok;
}

function touchedFiles(ctx: ThanatosContext, positional: string[], options: Options): string[] {
  if (options.base !== undefined) {
    const r = ctx.exec("git", ["diff", "--name-only", `${options.base}...HEAD`]);
    if (r.status !== 0) return die(`git diff ${options.base}...HEAD: ${r.stderr.trim().split("\n").pop() ?? "falhou"}`, EXIT.fail);
    return r.stdout.split("\n").filter(Boolean);
  }
  if (options.pr !== undefined) {
    if (!/^\d+$/.test(options.pr)) return die(`--pr é o número da PR: ${options.pr}`);
    const r = ctx.exec("gh", ["pr", "view", options.pr, "-R", ctx.repo, "--json", "files", "--jq", ".files[].path"]);
    if (r.status !== 0) return die(`gh pr view ${options.pr}: ${r.stderr.trim().split("\n").pop() ?? "falhou"}`, EXIT.fail);
    return r.stdout.split("\n").filter(Boolean);
  }
  return positional;
}

function cited(ctx: ThanatosContext, positional: string[], options: Options): number {
  const found = citedFiles(ctx.dir, touchedFiles(ctx, positional, options));
  if (options.json) out(JSON.stringify(found));
  else for (const c of found) out(`AVISO ${c.file} já foi citado no post-mortem ${c.id} (${c.title}${c.mergedAt ? `, correção em ${c.mergedAt}` : ""}): leia antes de mexer (hades thanatos show ${c.id})`);
  return EXIT.ok;
}

export function runThanatos(args: string[], ctx: () => ThanatosContext): number {
  const [verb, ...rest] = args;
  const { positional, options } = parseOptions(rest);
  switch (verb) {
    case "new": {
      const [text] = positional;
      if (text === undefined || positional.length > 1) return die(`hades thanatos new <card|PR|<iso>..<iso>>\n${USAGE}`);
      return newPostmortem(ctx(), text, options);
    }
    case "list": {
      const items = listPostmortems(ctx().dir);
      if (options.json) out(JSON.stringify(items));
      else for (const i of items) out(`${i.id}\t${i.createdAt}\t${i.kind}\t${i.prs.map((n) => `#${n}`).join(",") || "-"}\t${i.title}`);
      return EXIT.ok;
    }
    case "show": {
      const [id] = positional;
      if (id === undefined || positional.length > 1) return die(`hades thanatos show <id>\n${USAGE}`);
      return showOne(ctx(), id, options);
    }
    case "search": {
      const term = positional.join(" ").trim();
      if (term === "") return die(`hades thanatos search <termo>\n${USAGE}`);
      const hits = searchPostmortems(ctx().dir, term);
      if (options.json) out(JSON.stringify(hits));
      else for (const h of hits) out(`${h.id}\t${h.title}\t${h.line}`);
      return EXIT.ok;
    }
    case "cited":
      return cited(ctx(), positional, options);
    case "-h":
    case "--help":
    case undefined:
      out(USAGE);
      return verb === undefined ? EXIT.usage : EXIT.ok;
    default:
      return die(`subcomando desconhecido: ${verb}\n${USAGE}`);
  }
}

export function thanatosCommand(args: string[]): number {
  return runThanatos(args, realContext);
}
