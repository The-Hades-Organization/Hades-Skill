// Rotas de leitura e ação que só dependem de $D e de scripts do kit: logs sob demanda, disco (clean.sh), onboarding,
// notificações, consumo e revisões. Erros 400 levam a mensagem.
import { painelDeLimites } from "../lib/limites-aviso.ts";
import { chaves, medidas } from "../lib/limites-io.ts";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readText } from "../lib/fs.ts";
import { home } from "../lib/paths.ts";
import { which } from "../lib/proc.ts";
import { maxParallel } from "../lib/review-queue.ts";
import { serviceManager } from "../lib/service-manager.ts";
import { type Exec, exec, out as execOut, shlexJoin } from "./exec.ts";
import { BadRequest } from "./http.ts";
import type { PanelEnv } from "./env.ts";
import type { Job, Jobs } from "./jobs.ts";
import { pyStr } from "./actions.ts";
import { serviceCatalog } from "./system.ts";
import { createJournalRoutes, type JournalRoutes } from "./journal.ts";
import { createReviewsLoop } from "./reviews-loop.ts";

type Dict = Record<string, unknown>;

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\r/g;
const LOG_NAME = /^[\w.@-]+\.log$/;
const JOB_ID = /^[\w-]+$/;
const LOG_JOB_TAIL = 200_000;
const LOG_FILE_TAIL = 400_000;
const LOG_LINES_DEFAULT = 400;
const DOCKER_LOGS_TIMEOUT_MS = 8000;
const DISK_TTL_S = 60;
const DISK_TIMEOUT_MS = 60_000;
const ONBOARD_STATUS_TIMEOUT_MS = 45_000;
const ONBOARD_ACT_TIMEOUT_MS = 20_000;
const NOTIFY_TIMEOUT_MS = 20_000;
const QRENCODE_TIMEOUT_MS = 10_000;
const USAGE_STALE_S = 900;
const REVIEW_LIST_MAX = 20;
const REVIEW_JOBS_MAX = 60;
const REVIEW_ID = /^[\w-]{8,40}$/;
const ONBOARD_OPS = ["select", "skip", "done", "undone", "run", "tour"];
const TOUR_VERBS = ["seen", "skip"];
const DOCS_ALLOWED = ["STATUS.md", "notes.md", "conflicts.log", "rebuild.report", "prs.list"];
const EFFORTS = ["low", "medium", "high"];

/** O ValueError do int() do Python: a tela mostra a mensagem. */
function pyInt(text: string): number {
  if (!/^\s*[+-]?\d+\s*$/.test(text)) throw new BadRequest(`invalid literal for int() with base 10: '${text}'`);
  return Number.parseInt(text, 10);
}

const noEntry = (path: string): BadRequest => new BadRequest(`[Errno 2] No such file or directory: '${path}'`);
const stripAnsi = (text: string): string => text.replace(ANSI, "");
const decode = (bytes: Uint8Array): string => new TextDecoder("utf-8").decode(bytes);

export interface MiscDeps {
  env: PanelEnv;
  jobs: Jobs;
  config(): Record<string, string>;
  containerNames(): string[];
  /** units que o painel aceita ler (a da instância, ver unitName do plugin) */
  unitName: RegExp;
}

export interface Misc {
  logSources(): string[];
  readLog(src: string, n?: string, offset?: string): Promise<Dict>;
  diskStatus(refresh: boolean): Promise<Dict>;
  diskPreview(op: string, cat: string): Promise<Dict>;
  notifyStatus(remote: boolean): Promise<unknown>;
  notifyQr(remote: boolean): Promise<{ status: number; body: Dict | Uint8Array }>;
  usage(): Dict;
  limits(): Dict;
  journal: JournalRoutes;
  reviews(): Promise<Dict>;
  reviewsLoop(): Dict;
  reviewReport(id: string): Dict;
  onboardStatus(quick: boolean): Promise<unknown>;
  onboardApply(body: Dict, remote: boolean): Promise<Dict>;
}

export function createMisc(deps: MiscDeps): Misc {
  const { env, jobs } = deps;
  const hadesEnv = { ...process.env, HADES_DATA: env.dir };
  let disk: { t: number; v: Dict | undefined } = { t: 0, v: undefined };
  let usageProc: ReturnType<typeof Bun.spawn> | undefined;
  const usageFile = join(home(), ".claude", "hades", "usage", "latest.json");
  const reviewsDir = join(home(), ".claude", "hades", "reviews");

  const logSources = (): string[] => {
    const names = new Set<string>();
    for (const dir of [join(env.dir, "logs"), env.dir]) {
      try {
        for (const f of readdirSync(dir)) if (f.endsWith(".log") && statSync(join(dir, f)).isFile()) names.add(f);
      } catch {
        // pasta ausente: sem logs ali
      }
    }
    return [...names].sort();
  };

  async function readLog(src: string, n = String(LOG_LINES_DEFAULT), offset?: string): Promise<Dict> {
    const colon = src.indexOf(":");
    const kind = colon < 0 ? src : src.slice(0, colon);
    const name = colon < 0 ? "" : src.slice(colon + 1);
    const lines = pyInt(n);
    if (kind === "job") {
      if (!JOB_ID.test(name)) throw new BadRequest("job inválido");
      let data: Buffer;
      try {
        data = readFileSync(join(jobs.dir, `${name}.log`));
      } catch {
        data = Buffer.alloc(0);
      }
      const start = offset !== undefined ? pyInt(offset) : Math.max(0, data.length - LOG_JOB_TAIL);
      return { text: stripAnsi(decode(data.subarray(start))), offset: data.length };
    }
    if (kind === "file") {
      if (!LOG_NAME.test(name)) throw new BadRequest("arquivo inválido");
      const inLogs = join(env.dir, "logs", name);
      const path = existsSync(inLogs) ? inLogs : join(env.dir, name);
      let data: Buffer;
      try {
        data = readFileSync(path);
      } catch {
        throw noEntry(path);
      }
      const text = decode(data.subarray(Math.max(0, data.length - LOG_FILE_TAIL)));
      const all = text.split(/\r\n|\n|\r/);
      if (all[all.length - 1] === "") all.pop();
      return { text: stripAnsi(all.slice(-lines || undefined).join("\n")) };
    }
    if (kind === "svc") {
      if (!serviceCatalog(env.dir).has(name)) throw new BadRequest("serviço inválido");
      return readLog(`file:${name}.log`, n);
    }
    if (kind === "unit") {
      if (!deps.unitName.test(name)) throw new BadRequest("unit inválida");
      // no launchd não há journal: o log da unit é o arquivo que o plist dela declara
      if (serviceManager().kind === "launchd") return { text: serviceManager().readLog(name, lines) };
      return { text: await execOut(["journalctl", "--user", "-u", name, "-n", String(lines), "--no-pager", "-o", "short-iso"]) };
    }
    if (kind === "docker") {
      if (!deps.containerNames().includes(name)) throw new BadRequest("container inválido");
      const r = await exec(["docker", "logs", "--tail", String(lines), "--timestamps", name], { timeoutMs: DOCKER_LOGS_TIMEOUT_MS });
      return { text: r.timedOut ? "(docker logs demorou demais)" : stripAnsi(r.stdout + r.stderr) };
    }
    if (kind === "doc") {
      if (!DOCS_ALLOWED.includes(name)) throw new BadRequest("documento inválido");
      return { text: readText(join(env.dir, name)) || "(vazio)" };
    }
    throw new BadRequest("fonte inválida");
  }

  async function diskStatus(refresh: boolean): Promise<Dict> {
    const now = Date.now() / 1000;
    if (!refresh && disk.v && now - disk.t < DISK_TTL_S) return disk.v;
    const raw = await execOut(["bash", join(env.dir, "clean.sh"), "status", "--tsv"], DISK_TIMEOUT_MS);
    const cats: Dict[] = [];
    let timer: Dict = { state: "desligado", last: "-" };
    for (const line of raw.split("\n")) {
      const f = line.split("\t");
      if (f[0] === "@timer" && f.length >= 3) timer = { state: f[1], last: f[2] };
      else if (f.length >= 7) {
        cats.push({ id: f[0], mode: f[1], bytes: pyInt(f[2] || "0"), reclaim: pyInt(f[3] || "0"), items: pyInt(f[4] || "0"), label: f[5], detail: f[6] });
      }
    }
    const value = { cats, timer, at: Date.now() / 1000 };
    disk = { t: Date.now() / 1000, v: value };
    return value;
  }

  async function diskPreview(op: string, cat: string): Promise<Dict> {
    const known = ((await diskStatus(false)).cats as { id: string }[]).map((c) => c.id);
    let argv: string[];
    if (op === "run") argv = ["run", "--dry-run"];
    else if (op === "rotate") argv = ["rotate", "--dry-run"];
    else if (op === "yes" && known.includes(cat)) argv = ["list", cat];
    else throw new BadRequest("prévia desconhecida");
    return { text: await execOut(["bash", join(env.dir, "clean.sh"), ...argv], DISK_TIMEOUT_MS) };
  }

  const notifyRun = (reveal: boolean): Promise<Exec> =>
    exec(["bash", join(env.dir, "notify.sh"), "status", "--json", ...(reveal ? ["--reveal"] : [])], { timeoutMs: NOTIFY_TIMEOUT_MS, env: hadesEnv });

  const parseOrEmpty = (text: string): Dict => {
    try {
      return JSON.parse(text || "{}") as Dict;
    } catch {
      throw new BadRequest("notify.sh não devolveu JSON");
    }
  };

  async function notifyQr(remote: boolean): Promise<{ status: number; body: Dict | Uint8Array }> {
    if (remote) throw new BadRequest("o QR do tópico só se mostra no painel local");
    const st = parseOrEmpty((await notifyRun(true)).stdout);
    if (!st.subscribe || !which("qrencode")) return { status: 404, body: { error: "sem tópico ou sem qrencode" } };
    const r = await Bun.spawn(["qrencode", "-t", "SVG", "-m", "1", "-o", "-", String(st.subscribe)], { stdout: "pipe", stderr: "ignore", timeout: QRENCODE_TIMEOUT_MS });
    return { status: 200, body: new Uint8Array(await new Response(r.stdout as ReadableStream).arrayBuffer()) };
  }

  function usage(): Dict {
    let data: unknown = null;
    let age: number | null = null;
    try {
      data = JSON.parse(readFileSync(usageFile, "utf8"));
      age = Date.now() / 1000 - statSync(usageFile).mtimeMs / 1000;
    } catch {
      data = null;
      age = null;
    }
    let busy = usageProc !== undefined && usageProc.exitCode === null;
    if (!busy && (age === null || age > USAGE_STALE_S)) {
      const days = deps.config().HADES_USAGE_DAYS || "7";
      // um por vez; o próprio coletor grava o latest.json
      usageProc = Bun.spawn([process.execPath, join(env.skillDir, "src", "cli.ts"), "usage", "--days", days], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
      busy = true;
    }
    return { data, age, refreshing: busy };
  }

  /** % medido das janelas do plano (reference/limites.md): lê as amostras locais, sem rede e sem recalcular o consumo. */
  function limits(): Dict {
    const { atual } = medidas(new Date(), chaves());
    return { ...painelDeLimites(atual, new Date()) };
  }

  async function reviews(): Promise<Dict> {
    const byId = new Map<string, Job>((await jobs.list(REVIEW_JOBS_MAX)).map((j) => [j.id, j]));
    const items: Dict[] = [];
    let names: string[] = [];
    try {
      names = readdirSync(reviewsDir).filter((f) => f.endsWith(".json"));
    } catch {
      names = [];
    }
    for (const name of names.sort().reverse().slice(0, REVIEW_LIST_MAX)) {
      let r: Dict;
      try {
        r = JSON.parse(readFileSync(join(reviewsDir, name), "utf8")) as Dict;
      } catch {
        continue;
      }
      const job = byId.get(String(r.job));
      if (r.state === "rodando" && (!job || job.state !== "rodando")) r.state = "interrompido";
      r.report = existsSync(join(reviewsDir, `${r.id as string}.md`));
      items.push(r);
    }
    const cfg = deps.config();
    return {
      items,
      maxParallel: maxParallel(),
      defaults: { model: (cfg.HADES_MODEL_REVIEW ?? "").includes("sonnet") ? "sonnet" : "opus", effort: EFFORTS.includes(cfg.HADES_EFFORT_REVIEW ?? "") ? cfg.HADES_EFFORT_REVIEW : "medium" },
    };
  }

  function reviewReport(id: string): Dict {
    if (!REVIEW_ID.test(id)) throw new BadRequest("revisão inválida");
    const file = join(reviewsDir, `${id}.md`);
    return { id, file, text: readText(file) ?? null };
  }

  /** `quick`: sem rede nem docker; é o que o painel usa para decidir se oferece o onboarding ao abrir. */
  async function onboardStatus(quick: boolean): Promise<unknown> {
    const r = await exec(["bash", join(env.dir, "onboard.sh"), "status", "--json", ...(quick ? ["--quick"] : [])], { timeoutMs: ONBOARD_STATUS_TIMEOUT_MS, env: hadesEnv });
    if (r.status !== 0 || !r.stdout.trim()) {
      const last = r.stderr.trim().split("\n").filter(Boolean).pop();
      throw new BadRequest(`onboard.sh falhou: ${last ?? "sem saída"}`);
    }
    return JSON.parse(r.stdout);
  }

  async function onboardSh(args: string[]): Promise<void> {
    const r = await exec(["bash", join(env.dir, "onboard.sh"), ...args], { timeoutMs: ONBOARD_ACT_TIMEOUT_MS, env: hadesEnv });
    if (r.timedOut) throw new BadRequest("onboard.sh não respondeu");
    if (r.status !== 0) throw new BadRequest(r.stderr.trim().split("\n").filter(Boolean).pop() ?? "onboard.sh falhou");
  }

  /** select/skip <feature…>, tour seen|skip, done/undone <passo>, run <passo> (só passo da Hades, só no painel local). Valores vêm do catálogo. */
  async function onboardApply(body: Dict, remote: boolean): Promise<Dict> {
    const op = body.op;
    if (typeof op !== "string" || !ONBOARD_OPS.includes(op)) throw new BadRequest(`operação desconhecida: ${op === undefined ? "None" : JSON.stringify(op)}`);
    const catalog = (readText(join(env.dir, "onboard.tsv")) ?? "").split("\n").filter((l) => l.trim() && !l.startsWith("#")).map((l) => l.split("\t"));
    const feats = catalog.filter((c) => (c[0] ?? "").startsWith("@")).map((c) => (c[0] as string).slice(1));
    const steps = new Map(catalog.filter((c) => !(c[0] ?? "").startsWith("@") && c.length > 4).map((c) => [c[1] as string, c]));
    if (op === "tour") {
      const verb = pyStr(body.value ?? "");
      if (!TOUR_VERBS.includes(verb)) throw new BadRequest("tour: value deve ser seen ou skip");
      await onboardSh(["tour", verb]);
      return { ok: true };
    }
    if (op === "select" || op === "skip") {
      const names = (Array.isArray(body.features) ? body.features : []).map(pyStr);
      if (!names.length || names.some((n) => !feats.includes(n))) throw new BadRequest("feature fora do catálogo");
      await onboardSh([op, ...names]);
      return { ok: true };
    }
    const sid = pyStr(body.step ?? "");
    const step = steps.get(sid);
    if (!step) throw new BadRequest("passo fora do catálogo");
    if (op === "done" || op === "undone") {
      if (step[4] !== "manual") throw new BadRequest("só passo manual se marca à mão; os outros o painel mede");
      await onboardSh([op, sid]);
      return { ok: true };
    }
    if (remote) throw new BadRequest("os passos da Hades só se executam pelo painel local");
    if (step[3] !== "hades") throw new BadRequest("passo do dono: o onboarding só mostra o comando");
    return { job: await jobs.launch("onboard", `Onboarding: ${step[2]}`, shlexJoin(["bash", join(env.dir, "onboard.sh"), "run", sid]), false) };
  }

  return {
    logSources, readLog, diskStatus, diskPreview,
    notifyStatus: async (remote) => parseOrEmpty((await notifyRun(!remote)).stdout),
    notifyQr, usage, limits, reviews, reviewReport, onboardStatus, onboardApply,
    reviewsLoop: () => createReviewsLoop(env).overview(),
    journal: createJournalRoutes(),
  };
}
