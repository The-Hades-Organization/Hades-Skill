// `hades review`: revisão de uma PR pelo painel (página Revisões): /review-pr ou /review-agents numa sessão `claude -p` própria.
// Cria um worktree descartável no head da PR (o working tree do dono e o do Hades ficam intocados), roda o comando escolhido com o
// modelo e o esforço pedidos, publica no GitHub só com --post e grava o registro do histórico em ~/.claude/hades/reviews/<id>.json,
// com o relatório final em <id>.md. O worktree sai no fim, com sucesso ou não.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as osConstants } from "node:os";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { withFlock } from "../lib/flock.ts";
import { stateDirFor } from "./review-record.ts";
import { EXIT, HadesError, out, warn } from "../lib/output.ts";
import { hadesHome, skillRoot } from "../lib/paths.ts";
import { run } from "../lib/proc.ts";
import { need } from "../lib/deps.ts";

const MODELS = { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5" } as const;
const COMMANDS = ["review-pr", "review-agents"] as const;
const EFFORTS = ["low", "medium", "high"] as const;
const PROG = "hades review";
const GIT_TIMEOUT_MS = 300_000;
const SHORT_TIMEOUT_MS = 120_000;
const GH_TIMEOUT_MS = 30_000;
const ERROR_MAX = 400;
const TEXT_MAX = 600;
const TOOL_ARG_MAX = 160;
const SIGINT_EXIT = 130;
// git fetch de fora da Hades (outra sessão, IDE) não passa pelo flock: a trava da ref volta a tentar algumas vezes
const FETCH_ATTEMPTS = 4;
const FETCH_RETRY_MS = 1500;
const REF_LOCK_RACE = /cannot lock ref|unable to update local ref|\.lock': File exists/;
// linha final que a sessão escreve para o histórico (o relatório humano vem antes dela)
const TAIL_LINE = /^HADES-REVIEW:\s*(.*)$/m;
const TAIL_ALL = /^HADES-REVIEW:\s*(.*)$/gm;

type ModelName = keyof typeof MODELS;
type ReviewCommand = (typeof COMMANDS)[number];
type Effort = (typeof EFFORTS)[number];

interface Options {
  wt: string;
  pr: number;
  cmd: ReviewCommand;
  model: ModelName;
  effort: Effort;
  post: boolean;
  id: string | undefined;
  dryRun: boolean;
}

interface PrInfo {
  title: string;
  author: string;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  url: string;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json | undefined };
type Record_ = Record<string, Json | undefined>;

/** Mensagem no formato do argparse que o original usava; o uso completo vai junto, como no original. */
const USAGE = `usage: ${PROG} [-h] --wt WT --pr PR --cmd {review-pr,review-agents} --model {opus,sonnet}
                        --effort {low,medium,high} [--post] [--id ID] [--dry-run]`;

class ArgError extends Error {}

function pick<T extends string>(flag: string, value: string, choices: readonly T[]): T {
  const found = choices.find((c) => c === value);
  if (found === undefined) {
    throw new ArgError(`argument ${flag}: invalid choice: '${value}' (choose from ${choices.map((c) => `'${c}'`).join(", ")})`);
  }
  return found;
}

function parseArgs(args: string[]): Options {
  const values = new Map<string, string>();
  const valued = ["--wt", "--pr", "--cmd", "--model", "--effort", "--id"];
  let post = false;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const raw = args[i] ?? "";
    const eq = raw.indexOf("=");
    const flag = raw.startsWith("--") && eq > 0 ? raw.slice(0, eq) : raw;
    if (flag === "--post") post = true;
    else if (flag === "--dry-run") dryRun = true;
    else if (valued.includes(flag)) {
      const value = raw.startsWith("--") && eq > 0 ? raw.slice(eq + 1) : args[++i];
      if (value === undefined) throw new ArgError(`argument ${flag}: expected one argument`);
      values.set(flag, value);
    } else throw new ArgError(`unrecognized arguments: ${raw}`);
  }
  const missing = ["--wt", "--pr", "--cmd", "--model", "--effort"].filter((f) => !values.has(f));
  if (missing.length) throw new ArgError(`the following arguments are required: ${missing.join(", ")}`);
  const prText = values.get("--pr") ?? "";
  if (!/^[+-]?\d+$/.test(prText)) throw new ArgError(`argument --pr: invalid int value: '${prText}'`);
  return {
    wt: values.get("--wt") ?? "",
    pr: Number(prText),
    cmd: pick("--cmd", values.get("--cmd") ?? "", COMMANDS),
    model: pick("--model", values.get("--model") ?? "", Object.keys(MODELS) as ModelName[]),
    effort: pick("--effort", values.get("--effort") ?? "", EFFORTS),
    post,
    id: values.get("--id"),
    dryRun,
  };
}

function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function two(n: number): string {
  return String(n).padStart(2, "0");
}

/** Identificador do disparo: a hora local (como o strftime do original) e 4 hex. */
function newId(): string {
  const d = new Date();
  const stamp = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
  return `${stamp}-${randomBytes(2).toString("hex")}`;
}

function sh(argv: string[], timeoutMs: number = SHORT_TIMEOUT_MS): string {
  const [command = "", ...rest] = argv;
  const r = run(command, rest, { timeoutMs });
  if (r.timedOut) throw new Error(`Command '${argv.join(" ")}' timed out after ${timeoutMs / 1000} seconds`);
  if (r.status !== 0) {
    const lines = (r.stderr || r.stdout).trim().split("\n");
    const last = (r.stderr || r.stdout).trim() ? lines[lines.length - 1] : `rc=${r.status}`;
    throw new Error(`${argv.slice(0, 4).join(" ")}…: ${last}`);
  }
  return r.stdout;
}

/**
 * Revisões disparadas juntas pelo painel compartilham o clone: fetches paralelos que atualizam a mesma
 * `refs/remotes/origin/<base>` disputam a trava da ref e todos menos um morrem. O flock no diretório git comum
 * enfileira as revisões da Hades; a nova tentativa cobre o fetch de quem não passa por ele.
 */
function fetchSerialized(wt: string, argv: string[]): void {
  const common = sh(["git", "-C", wt, "rev-parse", "--git-common-dir"]).trim();
  const lock = join(isAbsolute(common) ? common : join(wt, common), "hades-review-fetch.lock");
  withFlock(lock, () => {
    for (let attempt = 1; ; attempt++) {
      try {
        sh(argv, GIT_TIMEOUT_MS);
        return;
      } catch (error) {
        if (attempt >= FETCH_ATTEMPTS || !(error instanceof Error) || !REF_LOCK_RACE.test(error.message)) throw error;
        Bun.sleepSync(FETCH_RETRY_MS * attempt);
      }
    }
  });
}

/**
 * O `hades` do dono é um alias de shell interativo, que não existe na sessão `claude -p`: sem um executável no PATH, o
 * Cerberus e o `hades review-record` que o prompt pede viram `command not found` e o review não é publicado.
 */
function hadesShimDir(): string {
  const dir = join(hadesHome(), "bin");
  const shim = join(dir, "hades");
  mkdirSync(dir, { recursive: true });
  writeFileSync(shim, `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(skillRoot, "src", "cli.ts"))} "$@"\n`);
  chmodSync(shim, 0o755);
  return dir;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string") throw new Error(`gh pr view: campo '${key}' ausente ou inválido`);
  return value;
}

/** Valida na fronteira o JSON do `gh pr view`; o miolo só vê o PrInfo. */
function parsePr(text: string): PrInfo {
  const data: unknown = JSON.parse(text);
  if (!isRecord(data)) throw new Error("gh pr view: resposta não é um objeto");
  const author = data.author;
  if (!isRecord(author)) throw new Error("gh pr view: campo 'author' ausente ou inválido");
  return {
    title: stringField(data, "title"),
    author: stringField(author, "login"),
    baseRefName: stringField(data, "baseRefName"),
    headRefName: stringField(data, "headRefName"),
    headRefOid: stringField(data, "headRefOid"),
    url: stringField(data, "url"),
  };
}

function postInstructions(o: Options, pr: PrInfo, slug: string, texto: string): string {
  if (!o.post) return "- **Publicar: NÃO.** Nada vai para o GitHub (nem review, nem comentário, nem label). O relatório fica só aqui.";
  return `- **Publicar: SIM, pedido explícito do dono neste disparo.** Ao fim, publique como em
  ~/.claude/skills/hades/reference/loop/review.md §4: UMA chamada \`gh api repos/${slug}/pulls/${o.pr}/reviews -X POST\`
  com \`event: COMMENT\` (nunca APPROVE nem REQUEST_CHANGES), \`commit_id\` = head atual da PR, in-line validados contra os
  hunks RIGHT do diff (o que cair fora de hunk vai para o corpo com \`arquivo:linha\`).
  O corpo publicado é EXATAMENTE o modelo de review.md §3, e nada além dele:
  - Veredito com um destes três rótulos: \`🔴 bloquear\`, \`🟡 ajustes\` ou \`✅ aprovado\`.
  - "Pontos positivos" são omitidos quando o review é aprovado sem achados.
  - Link de arquivo (spec, código) sempre absoluto no head:
    \`https://github.com/${slug}/blob/${pr.headRefOid}/<caminho>\`. Caminho relativo quebra no GitHub.
  - Nenhuma nota sobre como esta sessão rodou: nada de build/teste não executado, painel, disparo ou modelo.
    Isso fica só no relatório local.
  Antes do POST, o Cerberus (~/.claude/skills/hades/reference/cerberus.md): grave o corpo exato em \`${texto}\` e rode
  \`hades cerberus avaliar comentario --ctx pr=${o.pr} --ctx texto=${texto}\`. Saída 1 = barrado: NÃO publique,
  diga no relatório o que o Cerberus barrou e feche com \`posted=no\`.
  Depois grave o shard:
  \`hades review-record ${o.pr} <headOid> <reviewId> <veredito> <🔴> <🟡> <inline> <foraDeHunk>\`.`;
}

function buildPrompt(o: Options, pr: PrInfo, slug: string, texto: string): string {
  const cmd = o.cmd === "review-pr" ? `/${o.cmd} ${o.pr}` : `/review-agents ${pr.baseRefName}`;
  return `${cmd}

Contexto do disparo (painel da Hades → Revisões; sessão não interativa, ninguém responde perguntas):
- PR #${o.pr} de ${slug}: "${pr.title}" (autor ${pr.author}), base \`${pr.baseRefName}\`, head \`${pr.headRefOid}\`.
- O cwd é um worktree descartável já no head da PR (HEAD destacado). Não faça checkout, não crie branch, não faça push.
- Review de leitura: não rode build, lint nem teste (a fila de builds da máquina não é para isto). Os critérios de aceite
  ficam como "não executados neste disparo".
- Target branch (se o comando pedir): \`${pr.baseRefName}\`. Não pergunte nada: decida pelo padrão do comando.
${postInstructions(o, pr, slug, texto)}
- Termine com o relatório completo em pt-BR e, como ÚLTIMA linha, exatamente:
  \`HADES-REVIEW: verdict=<red|yellow|green> blocking=<n> important=<n> inline=<n> posted=<yes|no> reviewId=<id ou ->\`
`;
}

function num(value: unknown): number {
  return typeof value === "number" && value ? value : 0;
}

function field(source: Record<string, unknown>, key: string): number {
  return num(source[key]);
}

const TOKEN_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

/** Tokens da revisão inteira. O modelUsage do resultado soma a sessão e os subagentes (o /review-agents roda subagentes em
 * outros modelos); o usage cobre só a sessão principal e fica de reserva. */
function tokens(result: Record<string, unknown>): Record_ {
  const usageByModel = result.modelUsage;
  if (isRecord(usageByModel) && Object.keys(usageByModel).length) {
    const byModel: Record<string, Record_> = {};
    const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const [model, raw] of Object.entries(usageByModel)) {
      const v = isRecord(raw) ? raw : {};
      const entry = {
        input: field(v, "inputTokens"),
        output: field(v, "outputTokens"),
        cacheRead: field(v, "cacheReadInputTokens"),
        cacheWrite: field(v, "cacheCreationInputTokens"),
      };
      for (const k of TOKEN_KEYS) total[k] += entry[k];
      const cost = v.costUSD;
      byModel[model] = { ...entry, costUsd: typeof cost === "number" ? cost : null };
    }
    return { tokens: total, tokensByModel: byModel };
  }
  const usage = result.usage;
  if (!isRecord(usage) || !Object.keys(usage).length) return { tokens: null };
  return {
    tokens: {
      input: field(usage, "input_tokens"),
      output: field(usage, "output_tokens"),
      cacheRead: field(usage, "cache_read_input_tokens"),
      cacheWrite: field(usage, "cache_creation_input_tokens"),
    },
  };
}

const LINE_BREAKS = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/;

function clip(text: string, max: number): string {
  return Array.from(text).slice(0, max).join("");
}

function formatTool(block: Record<string, unknown>): string {
  const input = isRecord(block.input) ? block.input : {};
  const arg = [input.command, input.file_path, input.pattern, input.description, input.subagent_type].find((v) => Boolean(v)) ?? "";
  const first = arg ? (String(arg).split(LINE_BREAKS)[0] ?? "") : "";
  return `→ ${String(block.name)}: ${arg ? clip(first, TOOL_ARG_MAX) : ""}`;
}

function digits(value: string | undefined): number | null {
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
}

/** Os campos `chave=valor` da linha final HADES-REVIEW. */
function parseTail(line: string): Record_ {
  const kv = new Map<string, string>();
  for (const word of line.split(/\s+/)) {
    const eq = word.indexOf("=");
    if (eq >= 0) kv.set(word.slice(0, eq), word.slice(eq + 1));
  }
  const reviewId = kv.get("reviewId");
  return {
    verdict: kv.get("verdict") ?? null,
    blocking: digits(kv.get("blocking")),
    important: digits(kv.get("important")),
    inline: digits(kv.get("inline")),
    posted: kv.get("posted") === "yes",
    reviewId: reviewId === undefined || reviewId === "-" ? null : reviewId,
  };
}

class Journal {
  readonly directory = join(hadesHome(), "reviews");
  readonly rec: Record_;
  private readonly dry: boolean;

  constructor(dry: boolean, rec: Record_) {
    this.dry = dry;
    this.rec = rec;
  }

  update(fields: Record_): void {
    Object.assign(this.rec, fields);
  }

  save(): void {
    if (this.dry) return;
    mkdirSync(this.directory, { recursive: true });
    const file = join(this.directory, `${String(this.rec.id)}.json`);
    const tmp = `${file.replace(/\.json$/, "")}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.rec, null, 2)}\n`);
    renameSync(tmp, file);
  }
}

interface StreamOutcome {
  result: Record<string, unknown> | undefined;
  code: number;
}

/** Roda o claude e lê o stream-json (stdout e stderr juntos, linha a linha) enquanto ele escreve. */
function streamClaude(argv: string[], cwd: string, journal: Journal, env: NodeJS.ProcessEnv): Promise<StreamOutcome> {
  return new Promise((resolve, reject) => {
    const [command = "", ...rest] = argv;
    const child = spawn(command, rest, { cwd, env, stdio: ["inherit", "pipe", "pipe"] });
    journal.update({ claudePid: child.pid ?? null });
    journal.save();
    let result: Record<string, unknown> | undefined;
    const handle = (line: string): void => {
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        out(line.replace(/\s+$/, ""));
        return;
      }
      if (!isRecord(event)) {
        out(line.replace(/\s+$/, ""));
        return;
      }
      const subChild = Boolean(event.parent_tool_use_id);
      if (event.type === "system" && event.subtype === "init") {
        journal.update({ session: typeof event.session_id === "string" ? event.session_id : null });
        journal.save();
      } else if (event.type === "assistant") {
        const content = isRecord(event.message) && Array.isArray(event.message.content) ? event.message.content : [];
        for (const block of content) {
          if (!isRecord(block)) continue;
          if (block.type === "tool_use") out((subChild ? "  " : "") + formatTool(block));
          else if (block.type === "text" && !subChild && typeof block.text === "string" && block.text.trim()) {
            out(clip(block.text.trim(), TEXT_MAX));
          }
        }
      } else if (event.type === "result") result = event;
    };
    const pending = new Map<string, string>();
    const feed = (name: string) => (chunk: Buffer) => {
      const lines = ((pending.get(name) ?? "") + chunk.toString("utf8")).split("\n");
      pending.set(name, lines.pop() ?? "");
      for (const line of lines) handle(line);
    };
    child.stdout.on("data", feed("stdout"));
    child.stderr.on("data", feed("stderr"));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      for (const rest_ of pending.values()) if (rest_) handle(rest_);
      const signaled = signal ? -(osConstants.signals[signal] ?? 1) : 1;
      resolve({ result, code: code ?? signaled });
    });
  });
}

function claudeArgv(o: Options, prompt: string): string[] {
  const allowed = ["Read", "Grep", "Glob", "Agent", "Bash(git:*)", "Bash(gh pr view:*)", "Bash(gh pr diff:*)"];
  if (o.post) allowed.push("Bash(gh api:*)", "Bash(hades review-record:*)", "Bash(hades cerberus avaliar comentario:*)");
  const denied = o.post ? [] : ["Bash(gh pr review:*)", "Bash(gh pr comment:*)"];
  denied.push("Bash(gh pr checkout:*)", "Bash(git push:*)", "Bash(gh pr merge:*)", "Bash(gh pr close:*)");
  return [
    "claude", "-p", prompt, "--model", MODELS[o.model], "--effort", o.effort, "--permission-mode", "auto",
    "--output-format", "stream-json", "--verbose", "--allowedTools", ...allowed, "--disallowedTools", ...denied,
  ];
}

function cleanup(wt: string, tmp: string, ref: string): void {
  if (existsSync(tmp)) {
    run("git", ["-C", wt, "worktree", "remove", "--force", tmp]);
    rmSync(tmp, { recursive: true, force: true });
    run("git", ["-C", wt, "worktree", "prune"]);
  }
  run("git", ["-C", wt, "update-ref", "-d", ref]);
}

async function review(o: Options): Promise<number> {
  const rid = o.id ?? newId();
  const journal = new Journal(o.dryRun, {
    id: rid, pr: o.pr, cmd: o.cmd, model: o.model, effort: o.effort, post: o.post, state: "rodando", started: utcNow(),
    job: process.env.HADES_PANEL_JOB ?? null,
  });
  journal.save();
  const tmp = join(dirname(o.wt), `wt-review-${o.pr}-${rid.slice(-4)}`);
  const ref = `refs/hades-review/${rid}`;
  const texto = join(journal.directory, `${rid}.corpo.md`); // o corpo que o Cerberus avalia antes do POST
  const git = ["git", "-C", o.wt, "-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];
  // Parar pelo painel (parada do serviço: systemctl stop ou launchctl bootout) manda SIGTERM: o worktree sai e o registro fecha como interrompido
  process.once("SIGTERM", () => {
    journal.update({ state: "interrompido", ended: utcNow() });
    journal.save();
    cleanup(o.wt, tmp, ref);
    process.exit(SIGINT_EXIT);
  });
  try {
    const remote = sh(["git", "-C", o.wt, "config", "--get", "remote.origin.url"]).trim();
    const slug = /github\.com[:/]([^/]+\/[^/.]+)/.exec(remote)?.[1];
    if (slug === undefined) throw new Error(`remote.origin.url não é um repositório do GitHub: ${remote}`);
    const pr = parsePr(sh(["gh", "pr", "view", String(o.pr), "--repo", slug, "--json", "title,author,baseRefName,headRefName,headRefOid,url,isDraft,state"], GH_TIMEOUT_MS));
    journal.update({ title: pr.title, author: pr.author, base: pr.baseRefName, head: pr.headRefName, headOid: pr.headRefOid, url: pr.url, slug });
    journal.save();
    out(`PR #${o.pr} ${pr.title} · ${pr.author} · ${pr.baseRefName} ← ${pr.headRefName} @ ${pr.headRefOid.slice(0, 10)}`);
    fetchSerialized(o.wt, [...git, "fetch", "--quiet", "origin", `+pull/${o.pr}/head:${ref}`, `+${pr.baseRefName}:refs/remotes/origin/${pr.baseRefName}`]);
    sh(["git", "-C", o.wt, "worktree", "add", "--quiet", "--detach", tmp, ref], GIT_TIMEOUT_MS);
    out(`worktree descartável: ${tmp}`);
    const prompt = buildPrompt(o, pr, slug, texto);
    if (o.dryRun) {
      out(`--- prompt ---\n${prompt}`);
      out(`worktree HEAD: ${sh(["git", "-C", tmp, "log", "-1", "--format=%h %s"]).trim()}`);
      return EXIT.ok;
    }
    need("claude");
    out(`$ claude -p /${o.cmd} --model ${MODELS[o.model]} --effort ${o.effort}${o.post ? " (publica)" : " (sem publicar)"}`);
    // a sessão às vezes chama `hades review-record` de fora do worktree (da pasta da skill, sem origin): o estado já vai resolvido
    const [owner = "", repo = ""] = slug.split("/");
    const env = { ...process.env, PATH: `${hadesShimDir()}:${process.env.PATH ?? ""}`, HADES_STATE: process.env.HADES_STATE ?? stateDirFor(owner, repo) };
    const { result, code } = await streamClaude(claudeArgv(o, prompt), tmp, journal, env);
    const text = typeof result?.result === "string" ? result.result : "";
    mkdirSync(journal.directory, { recursive: true });
    writeFileSync(join(journal.directory, `${rid}.md`), `${text.replace(TAIL_ALL, "").trimEnd()}\n`);
    const turns = result?.num_turns;
    const duration = result?.duration_ms;
    const cost = result?.total_cost_usd;
    journal.update({ costUsd: cost ?? null, turns: turns ?? null, durationMs: duration ?? null, ...tokens(result ?? {}) } as Record_);
    const tail = TAIL_LINE.exec(text);
    if (tail) journal.update(parseTail(tail[1] ?? ""));
    else journal.update({ posted: null }); // a sessão não fechou com a linha do histórico: o painel mostra "?"
    const ok = code === 0 && result !== undefined && !result.is_error;
    journal.update({ state: ok ? "ok" : "falhou", ended: utcNow(), rc: code });
    if (!ok) journal.update({ error: (typeof result?.subtype === "string" && result.subtype) || `claude saiu com ${code}` });
    journal.save();
    out(`\nrelatório: ${join(journal.directory, `${rid}.md`)}`);
    return ok ? EXIT.ok : EXIT.fail;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    journal.update({ state: "falhou", ended: utcNow(), error: message.slice(0, ERROR_MAX) });
    journal.save();
    if (error instanceof HadesError) throw error; // dependência ausente: a CLI diz como instalar e sai com o código dela
    warn(`falhou: ${message}`);
    return EXIT.fail;
  } finally {
    cleanup(o.wt, tmp, ref);
  }
}

export async function reviewCommand(args: string[]): Promise<number> {
  if (args.includes("-h") || args.includes("--help")) {
    out(`${USAGE}\n\nRevisão de uma PR pelo painel (página Revisões).`);
    return EXIT.ok;
  }
  let options: Options;
  try {
    options = parseArgs(args);
  } catch (error) {
    if (!(error instanceof ArgError)) throw error;
    warn(`${USAGE}\n${PROG}: error: ${error.message}`);
    return EXIT.usage;
  }
  need("git");
  need("gh");
  return review(options);
}
