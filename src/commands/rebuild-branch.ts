// Reconstrói hades/local do zero (kit/rebuild-branch.sh): a base (hadesBase) + o conjunto de PRs de `hades pr-set`
// ($D/prs.list; padrão @me), em ordem topológica. Saída: prs.tsv (ordem aplicada), rebuild.report (resultado). Não
// reinicia serviços.
import { spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hadesBase } from "../lib/base.ts";
import { need } from "../lib/deps.ts";
import { readText } from "../lib/fs.ts";
import { stateDir } from "../lib/kit.ts";
import { EXIT, out } from "../lib/output.ts";
import { run } from "../lib/proc.ts";

const EXIT_ABORT = 3;
const MERGE_FLAGS = ["merge", "-q", "--no-ff", "--no-edit", "-m"] as const;
const JSON_FILE = /\.json$/;

interface Git {
  /** Saída capturada (a stderr passa para o terminal). */
  text: (...args: string[]) => { status: number; stdout: string };
  /** Sem saída nenhuma (`>/dev/null 2>&1`). */
  quiet: (...args: string[]) => number;
  /** Saída direta no terminal. */
  loud: (...args: string[]) => number;
}

function gitIn(cwd: string): Git {
  const exec = (args: string[], stdio: "pipe" | "inherit" | "ignore", env?: NodeJS.ProcessEnv) =>
    spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      env: env ?? process.env,
      stdio: stdio === "pipe" ? ["ignore", "pipe", "inherit"] : stdio === "ignore" ? "ignore" : ["ignore", "inherit", "inherit"],
    });
  return {
    text: (...args) => {
      const r = exec(args, "pipe");
      return { status: r.status ?? EXIT.fail, stdout: (r.stdout ?? "").replace(/\n+$/, "") };
    },
    quiet: (...args) => exec(args, "ignore").status ?? EXIT.fail,
    loud: (...args) => exec(args, "inherit").status ?? EXIT.fail,
  };
}

const lines = (text: string): string[] => text.split("\n").filter(Boolean);
/** `tr '\n' ' '` de uma lista de linhas que veio de pipe ou here-string: cada nome com um espaço depois. */
const spaced = (items: string[]): string => items.map((item) => `${item} `).join("");

export function rebuildBranchCommand(): number {
  need("git");
  const d = stateDir();
  const w = process.env.HADES_WT ?? "";
  const git = gitIn(w);
  const report = join(d, "rebuild.report");
  const log = (line: string): void => appendFileSync(report, `${line}\n`);

  if (git.text("branch", "--show-current").stdout !== "hades/local") {
    out("branch atual não é hades/local");
    return EXIT.usage;
  }
  // relatório zerado antes de tudo: um aborto não pode deixar o status=ok da rodada anterior para o update.sh
  writeFileSync(report, "");
  // lock órfão (queda da máquina no meio de um git) faz todo git falhar em silêncio: aborta com instrução
  const lock = `${git.text("rev-parse", "--git-dir").stdout}/index.lock`;
  if (existsSync(join(w, lock))) {
    out(`ABORTADO: ${lock} existe. Se nenhum git estiver rodando neste worktree e o lock for anterior ao boot`);
    out(`(${run("uptime", ["-s"]).stdout.trim()}), remova-o: rm -f '${lock}'`);
    return EXIT_ABORT;
  }
  if (git.loud("fetch", "-q", "origin") !== 0) {
    out("ABORTADO: git fetch falhou");
    return EXIT_ABORT;
  }
  const base = hadesBase(w);
  const env = { ...process.env, HADES_BASE_BRANCH: base.replace(/^origin\//, "") }; // o pr-set para a stack nela
  const warnFile = join(d, "logs", "pr-set.warn");
  const tsvFile = join(d, "prs.tsv");
  const [tsvFd, warnFd] = [openSync(tsvFile, "w"), openSync(warnFile, "w")];
  const prSet = spawnSync(process.execPath, [join(import.meta.dirname, "..", "cli.ts"), "pr-set"], { env, stdio: ["ignore", tsvFd, warnFd] });
  closeSync(tsvFd);
  closeSync(warnFd);
  const warnings = readText(warnFile) ?? "";
  if (prSet.status !== 0) {
    out("pr-set falhou");
    process.stdout.write(warnings);
    return EXIT.usage;
  }
  process.stderr.write(warnings);
  const prev = git.text("rev-parse", "HEAD").stdout;
  const dev = git.text("rev-parse", base);
  if (dev.status !== 0) {
    out(`ABORTADO: base ${base} não encontrada`);
    return EXIT_ABORT;
  }
  if (git.loud("reset", "-q", "--hard", dev.stdout) !== 0) {
    out(`ABORTADO: git reset --hard ${dev.stdout} falhou`);
    return EXIT_ABORT;
  }
  writeFileSync(report, "");
  let status = "ok";
  const unmerged = (): string[] => lines(git.text("diff", "--name-only", "--diff-filter=U").stdout);
  const tsv = readText(tsvFile) ?? "";
  const rows = tsv.split("\n");
  if (rows[rows.length - 1] === "") rows.pop();

  for (const row of rows) {
    const [n = "", , prBase = "", ,] = row.split("\t");
    const ref = `refs/hades/pr-${n}`;
    const baseRef = `refs/hades/pr-${prBase}`;
    const mergeMessage = `Hades: merge PR #${n}`;
    git.loud("fetch", "-q", "origin", `pull/${n}/head:${ref}`, "--force");
    const stacked = prBase !== "-";
    const baseInside = (): boolean => git.quiet("merge-base", "--is-ancestor", baseRef, ref) === 0;
    if (stacked && !baseInside() && git.quiet(...MERGE_FLAGS, mergeMessage, ref) === 0) {
      // stack desalinhada que já absorveu a base (ou outra PR do conjunto) por merge: o merge direto entra limpo, e o
      // cherry-pick reaplicaria commits que o HEAD já tem
      log(`#${n} ok (merge direto, stack desalinhada sobre #${prBase})`);
    } else if (stacked && !baseInside()) {
      git.quiet("merge", "--abort");
      // stack desalinhada (base rebaseada): aplica só os commits próprios da PR
      const commits = lines(git.text("rev-list", "--no-merges", "--right-only", "--cherry-pick", "--reverse", `${baseRef}...${ref}`).stdout);
      for (const c of commits) {
        if (git.quiet("cherry-pick", "-x", c) === 0) continue;
        const conflicts = unmerged();
        if (conflicts.length === 0) {
          const resume = spawnSync("git", ["-c", "core.editor=true", "cherry-pick", "--continue"], {
            cwd: w,
            env: { ...process.env, GIT_EDITOR: "true" },
            stdio: "ignore",
          });
          if (resume.status !== 0) git.loud("commit", "-q", "--no-edit");
        } else {
          log(`#${n} CONFLITO-NOVO (cherry-pick ${c}): ${spaced(conflicts)}`);
          git.loud("cherry-pick", "--abort");
          status = "conflict";
          break;
        }
      }
      if (status === "conflict") break;
      log(`#${n} ok (cherry-pick, stack desalinhada sobre #${prBase})`);
    } else if (git.quiet(...MERGE_FLAGS, mergeMessage, ref) === 0) {
      log(`#${n} ok`);
    } else if (unmerged().length === 0) {
      const before = git.text("rev-parse", "HEAD").stdout;
      if (git.loud("commit", "-q", "--no-edit") === 0 && git.text("rev-parse", "HEAD").stdout !== before) log(`#${n} ok (rerere)`);
      else {
        log(`#${n} FALHA-GIT: merge sem conflito e sem commit (ver git status)`);
        git.quiet("merge", "--abort");
        status = "conflict";
        break;
      }
    } else {
      // só JSON em conflito (catálogos i18n)? merge estrutural de 3 vias; conflito real de chave cai no CONFLITO-NOVO
      const files = unmerged();
      if (files.every((f) => JSON_FILE.test(f)) && jsonMerge(w, d, env, files) && unmerged().length === 0 && git.loud("commit", "-q", "--no-edit") === 0) {
        log(`#${n} ok (json-merge3: ${spaced(files)})`);
        continue;
      }
      log(`#${n} CONFLITO-NOVO: ${spaced(unmerged())}`);
      git.loud("merge", "--abort");
      status = "conflict";
      break;
    }
  }

  const append = (script: string, withStderr: boolean): number => {
    const fd = openSync(report, "a");
    const r = spawnSync("bash", [join(d, script)], { stdio: ["ignore", fd, withStderr ? fd : "inherit"] });
    closeSync(fd);
    return r.status ?? EXIT.fail;
  };
  if (status === "ok") append("fixups.sh", false);
  if (status === "ok" && append("web-overlay.sh", true) !== 0) log("web-overlay FALHOU (ver acima)");
  const head = git.text("rev-parse", "HEAD").stdout;
  log(`status=${status} prev=${prev} new=${head} develop=${dev.stdout}`);
  // last-build.develop guarda o sha da base (o nome ficou da base fixa de antes; quem lê o arquivo segue igual)
  if (status === "ok") {
    writeFileSync(join(d, "last-build.heads"), rows.map((row) => `${row.split("\t").slice(0, 2).join("\t")}\n`).join(""));
    writeFileSync(join(d, "last-build.develop"), `${dev.stdout}\n`);
  }
  process.stdout.write(readText(report) ?? "");
  return EXIT.ok;
}

function jsonMerge(cwd: string, d: string, env: NodeJS.ProcessEnv, files: string[]): boolean {
  const fd = openSync(join(d, "logs", "json-merge3.log"), "a");
  const r = spawnSync(process.execPath, [join(import.meta.dirname, "..", "cli.ts"), "json-merge3", ...files], { cwd, env, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  return r.status === 0;
}
