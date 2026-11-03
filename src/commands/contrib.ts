// `hades contrib`: devolve ao repositório da skill a melhoria do núcleo que serve a qualquer usuário (Fase 8, evolving.md).
// Com acesso de escrita só prepara e mostra, e a PR só abre com confirmação; sem acesso grava um .html. Nada sai sozinho.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join, resolve } from "node:path";
import { detectAccess, REASON_TEXT, type Access } from "../lib/contrib-access.ts";
import { areaOf, baseOfVersion, collectDiff, diffText, parseDiff, splitCore, subjectsSince, type Split } from "../lib/contrib-diff.ts";
import { loadTemplate, renderContribHtml } from "../lib/contrib-html.ts";
import { branchOf, openPr } from "../lib/contrib-pr.ts";
import { formatFinding, scanContribution } from "../lib/contrib-scan.ts";
import { buildBody, REQUIRED_META, type Meta } from "../lib/contrib-text.ts";
import { loadRegistry } from "../lib/deps.ts";
import { kitDir } from "../lib/kit.ts";
import { EXIT, out } from "../lib/output.ts";
import { hadesHome } from "../lib/paths.ts";
import { guardTerms } from "../lib/release-guard.ts";
import { run, which } from "../lib/proc.ts";
import { readText } from "../lib/fs.ts";
import { localVersion, settings } from "../lib/version-check.ts";

export const USAGE = `hades contrib suggest|prepare|pr|html --title <t> --why <texto> --gains <linhas> --proof <texto> [--what <texto>] [--base <ref>] [--slug <s>] [--yes]
  suggest   decide o caminho: com acesso de escrita ao repo da skill prepara e mostra a PR; sem acesso grava o .html
  prepare   com acesso: mostra branch, título, corpo e diff, sem abrir nada
  pr        com acesso: abre a PR contra a branch padrão, só com confirmação (--yes ou pergunta interativa; agente nunca passa --yes)
  html      grava ~/.claude/hades/contrib/<slug>.html (autocontido) para enviar ao dono da skill; nada sai da máquina`;

const SUBCOMMANDS = ["suggest", "prepare", "pr", "html"] as const;
type Sub = (typeof SUBCOMMANDS)[number];
const SLUG = /^[a-z0-9][a-z0-9-]{0,60}$/;
const VALUE_FLAGS = ["--base", "--slug", "--title", "--what", "--why", "--gains", "--proof"] as const;
const SLUG_HASH_LENGTH = 8;
const CONFIRM_YES = /^(s|sim|y|yes)$/i;

interface Options {
  sub: Sub;
  yes: boolean;
  values: Partial<Record<(typeof VALUE_FLAGS)[number], string>>;
}

function parseArgs(args: string[]): Options | string {
  const [sub, ...rest] = args;
  if (!SUBCOMMANDS.includes(sub as Sub)) return USAGE;
  const values: Options["values"] = {};
  let yes = false;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i] as string;
    if (flag === "--yes") {
      yes = true;
    } else if ((VALUE_FLAGS as readonly string[]).includes(flag)) {
      const value = rest[++i];
      if (value === undefined) return `${flag} pede um valor\n${USAGE}`;
      values[flag as (typeof VALUE_FLAGS)[number]] = value;
    } else {
      return `opção desconhecida: ${flag}\n${USAGE}`;
    }
  }
  return { sub: sub as Sub, yes, values };
}

const metaOf = (o: Options, fallbackWhat: string): Meta => ({
  title: o.values["--title"] ?? "", what: o.values["--what"] ?? fallbackWhat, why: o.values["--why"] ?? "",
  gains: o.values["--gains"] ?? "", proof: o.values["--proof"] ?? "",
});

function detectGhAccess(repo: string, timeoutSeconds: number): Access {
  const gh = loadRegistry().find((d) => d.id === "gh");
  return detectAccess(repo, {
    hasGh: gh !== undefined && which(gh.command) !== undefined,
    run: (command, args) => run(command, args, { timeoutMs: timeoutSeconds * 1000 }),
  });
}

function reportLeft(split: Split): void {
  if (split.left.length) out(`ficou de fora (não entra na contribuição):\n${split.left.map((l) => `  ${l.path} — ${l.reason}`).join("\n")}`);
}

function showPreparation(repo: string, defaultBranch: string, branch: string, title: string, body: string, diff: string): void {
  out([`destino: ${repo} (${defaultBranch})`, `branch: ${branch}`, `título: ${title}`, "--- corpo ---", body.trimEnd(), "--- diff ---", diff.trimEnd(), "---"].join("\n"));
}

async function confirmed(opts: Options, repo: string): Promise<boolean | undefined> {
  if (opts.yes) return true;
  if (!process.stdin.isTTY) return undefined;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return CONFIRM_YES.test((await rl.question(`Abrir a PR em ${repo}? [s/N] `)).trim());
  } finally {
    rl.close();
  }
}

function writeHtml(slug: string, html: string): string {
  const dir = join(hadesHome(), "contrib");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${slug}.html`);
  writeFileSync(file, html);
  return file;
}

export async function contribCommand(args: string[]): Promise<number> {
  const opts = parseArgs(args);
  if (typeof opts === "string") {
    process.stderr.write(`${opts}\n`);
    return EXIT.usage;
  }
  const skill = resolve(kitDir(), "..");
  const cfg = settings();
  const installed = localVersion(process.env.HADES_DATA || kitDir()) || (readText(join(skill, "VERSION")) ?? "").trim();
  const base = opts.values["--base"] ?? baseOfVersion(skill, installed);
  if (!base) {
    out(`não achei o commit da versão ${installed || "instalada"}: informe --base <ref>`);
    return EXIT.usage;
  }
  const slugFlag = opts.values["--slug"];
  if (slugFlag !== undefined && !SLUG.test(slugFlag)) {
    out("--slug: use minúsculas, números e hífen (até 61 caracteres)");
    return EXIT.usage;
  }

  const split = splitCore(parseDiff(collectDiff(skill, base)));
  if (!split.core.length) {
    out("nada a sugerir: a mudança desde a versão instalada não toca o núcleo (kit/, src/, reference/, loop/, SKILL.md)");
    reportLeft(split);
    return EXIT.ok;
  }
  const meta = metaOf(opts, subjectsSince(skill, base).map((s) => `- ${s}`).join("\n"));
  const missing = REQUIRED_META.filter((k) => !meta[k].trim());
  if (missing.length) {
    out(`faltam: ${missing.map((k) => `--${k}`).join(" ")}\n${USAGE}`);
    return EXIT.usage;
  }

  const diff = diffText(split.core);
  const body = buildBody(meta, split.core, split.left);
  const findings = scanContribution(split.core, [{ label: "título", text: meta.title }, { label: "corpo", text: body }], guardTerms([skill]));
  if (findings.length) {
    out(`a guarda barrou a contribuição (nada foi gerado). Limpe e rode de novo:\n${findings.map((f) => `  ${formatFinding(f)}`).join("\n")}`);
    return EXIT.fail;
  }

  const slug = slugFlag ?? `evolucao-${createHash("sha256").update(diff).digest("hex").slice(0, SLUG_HASH_LENGTH)}`;
  reportLeft(split);
  const html = (): number => {
    const file = writeHtml(slug, renderContribHtml(loadTemplate(), { ...meta, files: split.core, diff, left: split.left, repo: cfg.repo, version: installed }));
    out(`arquivo: ${file}\nAbra, confira e envie ao dono da skill pelo canal que preferir; nada saiu da máquina.`);
    return EXIT.ok;
  };
  if (opts.sub === "html") return html();

  const access = detectGhAccess(cfg.repo, cfg.timeout);
  if (access.kind !== "push") {
    out(`sem acesso de escrita a ${access.repo}: ${REASON_TEXT[access.reason]}`);
    if (opts.sub === "suggest") return html();
    out("use `hades contrib html` para gerar o arquivo e enviar ao dono da skill");
    return EXIT.fail;
  }

  const branch = branchOf(slug);
  showPreparation(access.repo, access.defaultBranch, branch, meta.title, body, diff);
  const areas = [...new Set(split.core.map((f) => areaOf(f.path)))].join(", ");
  if (opts.sub !== "pr") {
    out(`com acesso a ${access.repo} (áreas: ${areas}). Revise acima; para abrir a PR rode \`hades contrib pr\` com os mesmos argumentos (--yes só depois de revisar).`);
    return EXIT.ok;
  }
  const answer = await confirmed(opts, access.repo);
  if (answer === undefined) {
    out("PR não aberta: sem confirmação (modo não interativo). Revise o que foi mostrado e rode de novo com --yes.");
    return EXIT.usage;
  }
  if (!answer) {
    out("PR não aberta.");
    return EXIT.ok;
  }
  const url = openPr({ repo: access.repo, defaultBranch: access.defaultBranch, branch, title: meta.title, body, patch: diff });
  out(`PR aberta: ${url}\nPróximo: o dono revisa lá; a consolidação traz o diff para a main local como patch (git am/apply), sai na próxima release e o dono fecha a PR citando a versão.`);
  return EXIT.ok;
}
