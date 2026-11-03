// `hades consolidate`: PR de consolidação (reference/loop/consolidate.md), junta PRs abertas numa só, por merge
// (hades consolidate). Roda de dentro da worktree da consolidação.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { need } from "../lib/deps.ts";
import { EXIT, die, out, warn } from "../lib/output.ts";
import { selfCli } from "../lib/paths.ts";
import { getField, loadProfile, pathValue } from "../lib/profile.ts";
import { resolveProject } from "../lib/project.ts";
import { run } from "../lib/proc.ts";
import { shellQuote } from "../lib/shell.ts";
import { configValue, loadWorkEnv, readJson, writeJsonAtomic, type Json, type WorkEnv } from "../lib/work.ts";

const USAGE = `PR de consolidação (reference/loop/consolidate.md): junta PRs abertas numa só, por merge, para o gate rodar uma vez e
o merge na base ser um só. Rode de dentro da worktree da consolidação (alocada com hades agent --for consolidate).
  hades consolidate plan <PR>...              branches, bases, empilhamento, estado e ordem de merge
  hades consolidate merge <PR>...             git merge --no-ff de origin/<branch> de cada uma (pula as já contidas);
                                                 conflito para o script: resolva pelo conteúdo, commite e rode de novo
  hades consolidate verify <PR>...            merge-base --is-ancestor de todas contra o HEAD (antes de cada push)
  hades consolidate comment <N> <PR>... [--post]   comentário nas originais apontando para a consolidação #N
  hades consolidate ready <N> [--post]        assignee + labels + gh pr ready, sem reviewers (as originais já foram)
  hades consolidate after-merge <N> <PR>... [--post]   empilhadas: head na base → "conteúdo integrado pela #N"
Nunca cherry-pick, rebase nem squash: as originais fecham como Merged só se os commits delas entrarem por merge.`;

const PR_FIELDS = "number,title,state,isDraft,headRefName,baseRefName,headRefOid,mergeable";
const GH_TIMEOUT_MS = 120_000;
const OID_SHORT = 11;
const BRANCH_COLUMN = 46;

interface PullRequest {
  state: string;
  isDraft: string;
  mergeable: string;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
}

function iso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function fieldText(value: unknown): string {
  return value === undefined || value === null ? "null" : String(value);
}

class Consolidation {
  private readonly work: WorkEnv;
  private readonly base: string;
  private readonly post: boolean;
  private readonly profile: ReturnType<typeof loadProfile>;

  constructor(work: WorkEnv, base: string, post: boolean, profile: ReturnType<typeof loadProfile>) {
    this.work = work;
    this.base = base;
    this.post = post;
    this.profile = profile;
  }

  private git(...args: string[]): { status: number; stdout: string } {
    const r = run("git", ["-C", this.work.repoTop, ...args]);
    return { status: r.status, stdout: r.stdout };
  }

  /** git com a saída padrão descartada e o erro à vista (fetch -q, merge). */
  private gitQuiet(...args: string[]): number {
    return spawnSync("git", ["-C", this.work.repoTop, ...args], { stdio: ["ignore", "ignore", "inherit"] }).status ?? EXIT.fail;
  }

  private head(): string {
    return this.git("rev-parse", "--short", "HEAD").stdout.trim();
  }

  private pullRequest(n: string): PullRequest | undefined {
    const r = run("gh", ["pr", "view", n, "--json", PR_FIELDS], { timeoutMs: GH_TIMEOUT_MS });
    if (r.status !== 0) return undefined;
    try {
      const data = JSON.parse(r.stdout) as Record<string, unknown>;
      return {
        state: fieldText(data.state), isDraft: fieldText(data.isDraft), mergeable: fieldText(data.mergeable),
        headRefName: fieldText(data.headRefName), baseRefName: fieldText(data.baseRefName), headRefOid: fieldText(data.headRefOid),
      };
    } catch {
      return undefined;
    }
  }

  /** Registro da consolidação em <orch>/consolidations/<branch>.json (só numa worktree de consolidação). */
  private record(patch: Json): void {
    const branch = this.git("branch", "--show-current").stdout.trim();
    if (this.work.repoTop === this.work.mainClone || !branch || branch === this.base) return;
    mkdirSync(join(this.work.orch, "consolidations"), { recursive: true });
    const file = join(this.work.orch, "consolidations", `${branch.replaceAll("/", "_")}.json`);
    writeJsonAtomic(file, { ...(readJson(file) ?? { branch, worktree: this.work.repoTop }), ...patch });
  }

  /** Executa com --post; sem ele, só imprime o comando que rodaria. */
  private ghDo(args: string[]): number {
    if (!this.post) {
      // o printf do original repete o molde a cada argumento; a saída é contrato
      out(args.map((a) => `  [sem --post] ${shellQuote(a)} `).join(""));
      return EXIT.ok;
    }
    return spawnSync(args[0] as string, args.slice(1), { stdio: "inherit" }).status ?? EXIT.fail;
  }

  /** Cerberus (reference/cerberus.md): o corpo exato vai a um arquivo e passa por `avaliar comentario`; barra = não posta. */
  private commentPr(n: string, body: string): number {
    const command = ["gh", "pr", "comment", n, "--body", body];
    if (!this.post) return this.ghDo(command);
    const dir = mkdtempSync(join(tmpdir(), "hades-consolidate-"));
    const file = join(dir, "body.md");
    writeFileSync(file, `${body}\n`);
    try {
      const cli = selfCli("cerberus", "avaliar", "comentario");
      const verdict = spawnSync(cli.command, [...cli.args, "--dir", this.work.repoTop, "--ctx", `pr=${n}`, "--ctx", `texto=${file}`], { stdio: "inherit" });
      if (verdict.status === 0) return spawnSync("gh", ["pr", "comment", n, "--body-file", file], { stdio: "inherit" }).status ?? EXIT.fail;
      out(`✗ #${n}: o Cerberus barrou o comentário (acima)`);
      return EXIT.fail;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  plan(prs: string[]): number {
    if (!prs.length) return die("plan <PR>...");
    this.gitQuiet("fetch", "-q", "origin");
    const row = (cols: string[]): string => `${cols[0]?.padEnd(7)} ${cols[1]?.padEnd(7)} ${cols[2]?.padEnd(6)} ${cols[3]?.padEnd(11)} ${cols[4]?.padEnd(BRANCH_COLUMN)} ${cols[5]}`;
    out(row(["PR", "ESTADO", "DRAFT", "MERGEABLE", "BRANCH", "BASE"]));
    for (const n of prs) {
      const pr = this.pullRequest(n) ?? die(`PR ${n} não encontrada`);
      out(row([`#${n}`, pr.state, pr.isDraft, pr.mergeable, pr.headRefName.slice(0, BRANCH_COLUMN), pr.baseRefName]));
    }
    out("");
    out(`Ordem de merge: a de baixo antes da empilhada. Empilhada (base ≠ ${this.base}) fecha como Closed, não Merged;`);
    out("depois do merge da consolidação, use after-merge para conferir e comentar.");
    this.record({ members: prs.map(Number), plannedAt: iso() });
    return EXIT.ok;
  }

  merge(prs: string[]): number {
    if (!prs.length) return die("merge <PR>...");
    if (this.git("rev-parse", "--show-toplevel").stdout.trim() === this.work.mainClone) die("o clone principal não é usado para trabalho");
    if (this.git("status", "--porcelain", "--untracked-files=no").stdout.trim() !== "") die("worktree com mudança sem commit");
    this.gitQuiet("fetch", "-q", "origin");
    for (const n of prs) {
      const r = run("gh", ["pr", "view", n, "--json", "headRefName", "--jq", ".headRefName"], { timeoutMs: GH_TIMEOUT_MS });
      if (r.status !== 0) die(`PR ${n} não encontrada`);
      const branch = r.stdout.trim();
      if (this.git("merge-base", "--is-ancestor", `origin/${branch}`, "HEAD").status === 0) {
        out(`#${n} já contida`);
        continue;
      }
      if (this.gitQuiet("merge", "--no-ff", "--no-edit", `origin/${branch}`) === 0) {
        out(`#${n} integrada (${branch})`);
        continue;
      }
      out(`#${n}: conflito com ${this.git("diff", "--name-only", "--diff-filter=U").stdout.replaceAll("\n", " ")}`);
      die("resolva pelo conteúdo (as duas mudanças convivem), commite o merge e rode de novo; o que já entrou é pulado");
    }
    this.record({ members: prs.map(Number), mergedAt: iso(), head: this.head() });
    return EXIT.ok;
  }

  verify(prs: string[]): number {
    if (!prs.length) return die("verify <PR>...");
    this.gitQuiet("fetch", "-q", "origin");
    let bad = 0;
    for (const n of prs) {
      const pr = this.pullRequest(n);
      const oid = pr?.headRefOid ?? "";
      const label = `#${n} ${oid.slice(0, OID_SHORT)}`;
      if (this.git("merge-base", "--is-ancestor", oid, "HEAD").status === 0) out(`✓ ${label} contida`);
      else {
        out(`✗ ${label} NÃO contida (merge de origin/${pr?.headRefName ?? ""} pendente)`);
        bad = 1;
      }
    }
    this.record({ verifiedAt: iso(), verifyOk: bad === 0 ? 1 : 0, head: this.head() });
    return bad;
  }

  comment(args: string[]): number {
    const [into, ...prs] = args;
    if (into === undefined) return die("faltou <número da consolidação>", EXIT.fail);
    if (!prs.length) return die("comment <N> <PR>...");
    for (const n of prs) {
      this.commentPr(n, `Esta PR entra na ${this.base} pela consolidação #${into} (merge commit, com os commits desta PR). Correções de review continuam aqui e são levadas à #${into} por merge.`);
    }
    return EXIT.ok;
  }

  /** Cerberus: consolidação posta para review é momento de fronteira; barra para antes do gh. */
  ready(args: string[]): number {
    const [n] = args;
    if (n === undefined) return die("faltou <número da consolidação>", EXIT.fail);
    if (this.post) {
      const branch = this.git("branch", "--show-current").stdout.trim();
      const cli = selfCli("cerberus", "avaliar", "consolidacao");
      const verdict = spawnSync(cli.command, [...cli.args, "--dir", this.work.repoTop, "--ctx", `pr=${n}`, "--ctx", `branch=${branch}`], { stdio: "inherit" });
      if (verdict.status !== 0) die(`o Cerberus barrou a consolidação #${n} (acima)`);
    }
    const edit: string[] = [];
    const assignee = configValue("HADES_ORCH_PR_ASSIGNEE", "");
    if (assignee) edit.push("--add-assignee", assignee);
    const labels = pathValue(this.profile, "pr.labels");
    for (const label of Array.isArray(labels) ? labels : []) edit.push("--add-label", typeof label === "string" ? label : JSON.stringify(label));
    if (edit.length) this.ghDo(["gh", "pr", "edit", n, ...edit]);
    this.ghDo(["gh", "pr", "ready", n]);
    out(`Lembrete ao dono: o merge da #${n} tem de ser "Create a merge commit" (squash ou rebase deixa as originais abertas).`);
    return EXIT.ok;
  }

  afterMerge(args: string[]): number {
    const [into, ...prs] = args;
    if (into === undefined) return die("faltou <número da consolidação>", EXIT.fail);
    if (!prs.length) return die("after-merge <N> <PR>...");
    this.gitQuiet("fetch", "-q", "origin", this.base);
    for (const n of prs) {
      const pr = this.pullRequest(n);
      const oid = pr?.headRefOid ?? "";
      const label = `#${n} ${oid.slice(0, OID_SHORT)}`;
      if (this.git("merge-base", "--is-ancestor", oid, `origin/${this.base}`).status !== 0) {
        out(`✗ ${label} não está na ${this.base}`);
      } else if (pr?.state === "MERGED") out(`✓ #${n} Merged`);
      else if (pr !== undefined && pr.baseRefName !== this.base) {
        out(`✓ #${n} empilhada (base ${pr.baseRefName}): head na ${this.base}`);
        this.commentPr(n, `Conteúdo integrado pela #${into}.`);
      } else out(`? #${n} ${pr?.state ?? ""} com head na ${this.base}: confira no GitHub`);
    }
    return EXIT.ok;
  }
}

export function consolidateCommand(args: string[]): number {
  const [sub = "", ...rest] = args;
  need("git");
  const work = loadWorkEnv();
  const resolution = resolveProject(work.repoTop);
  if (!resolution.profile) {
    warn(resolution.message);
    return resolution.code;
  }
  const profile = loadProfile(resolution);
  const baseField = getField(profile, "flow.base", undefined);
  const post = rest.includes("--post");
  const operands = rest.filter((a) => a !== "--post");
  for (const a of operands) if (!/^[0-9]+$/.test(a)) die(`número de PR inválido: ${a}`);
  const consolidation = new Consolidation(work, baseField ?? "", post, profile);
  switch (sub) {
    case "plan": need("gh"); return consolidation.plan(operands);
    case "merge": need("gh"); return consolidation.merge(operands);
    case "verify": need("gh"); return consolidation.verify(operands);
    case "comment": need("gh"); return consolidation.comment(operands);
    case "ready": return consolidation.ready(operands);
    case "after-merge": need("gh"); return consolidation.afterMerge(operands);
    default:
      out(USAGE);
      return EXIT.usage;
  }
}
