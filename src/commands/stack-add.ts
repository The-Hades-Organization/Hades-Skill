// `hades stack-add`: apoio do `/hades stack add` (reference/stacks.md §stack add). Propõe o pacote de stack de um repo pelos
// manifests e pelo CI, mede o pico de memória de uma etapa PELA FILA e só grava com o ok do dono (`--confirmed`).
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { isDir, isFile, readText } from "../lib/fs.ts";
import { HadesError, out } from "../lib/output.ts";
import { home, hadesHome, skillRoot } from "../lib/paths.ts";
import { realpathMissingOk } from "../lib/fs.ts";
import { type JsonObject, isObject, stacksRoot, type Json } from "../lib/profile.ts";
import { pyDumps, splitLines } from "../lib/pyjson.ts";
import { run } from "../lib/proc.ts";
import { validateFile } from "../lib/validate.ts";

const USAGE = `Apoio do \`/hades stack add\` (reference/stacks.md §stack add): propõe o pacote de stack de um repo, mede o pico de
memória de uma etapa PELA FILA e só grava com o ok do dono (a pergunta é do agente, AskUserQuestion; aqui o \`--confirmed\`).

  hades stack-add propose <repo> [--name N] [--stage DIR]     lê manifests e CI; escreve DIR/<n>/stack.json (rascunho)
  hades stack-add measure <rascunho-dir> <repo> <etapa> [--project P] [--timeout S]
                                                           roda a etapa com gate-lock.sh --step; grava costGb e measuredAt
  hades stack-add save <rascunho-dir> --confirmed [--force]   valida e copia para a pasta de stacks do usuário

Rascunhos ficam em --stage (padrão ~/.claude/hades/stacks-draft); o destino é HADES_STACKS_ROOT >
~/.claude/hades/stacks-root > ~/.claude/hades/stacks, como o resolvedor. Nada aqui toca o repo medido além de rodar a etapa.
`;

const EXIT_USAGE = 2;
const EXIT_NO_MANIFEST = 3;
const DEFAULT_TIMEOUT = "1800";
const MAX_CI_RUNS = 30;
const MAX_CI_MATCH = 15;
const MIB_PER_GIB = 1024;

type Kind = "lint" | "build" | "test" | "test:integration";
const ESTIMATES: Record<string, [Kind, number]> = {
  typecheck: ["build", 2],
  lint: ["lint", 2],
  build: ["build", 3],
  test: ["test", 4],
  integration: ["test:integration", 5],
};
const FALLBACK_ESTIMATE: [Kind, number] = ["build", 2];
// etapa -> nomes de script de package.json, em ordem de preferência
const SCRIPTS: Record<string, string[]> = {
  typecheck: ["typecheck", "type-check", "tsc"],
  lint: ["lint"],
  build: ["build"],
  test: ["test", "test:unit"],
  integration: ["test:integration", "test:e2e", "integration"],
};
const LOCKS = ["pnpm-lock.yaml", "yarn.lock", "package-lock.json"];
const GUARDED_SCRIPT = /^(test|lint|build|typecheck|type-check)/;
const PY_SPECIAL = /[()[\]{}?*+\-|^$\\.&~# \t\n\r\v\f]/g;

class StackAddError extends HadesError {}

function fail(message: string, code = EXIT_USAGE): never {
  throw new StackAddError(`stack-add: ${message}`, code);
}

/** re.escape do Python 3.7+: só escapa o que tem sentido em regex. */
function reEscape(text: string): string {
  return text.replace(PY_SPECIAL, (c) => `\\${c}`);
}

const exists = (path: string): boolean => isFile(path) || isDir(path);

function ciRuns(repo: string): string[] {
  const dir = join(repo, ".github", "workflows");
  const names = (isDir(dir) ? readdirSync(dir) : []).filter((n) => /^.*\.y.*ml$/s.test(n)).sort();
  const runs: string[] = [];
  for (const name of names) {
    for (const line of splitLines(readText(join(dir, name)) ?? "")) {
      const m = /^\s*(?:-\s*)?run:\s*(.+)$/.exec(line);
      if (m?.[1] !== undefined && !/^[|>]/.test(m[1])) runs.push(m[1].trim());
    }
  }
  return runs;
}

function workflowCount(repo: string): number {
  const dir = join(repo, ".github", "workflows");
  return isDir(dir) ? readdirSync(dir).filter((n) => /^.*\.y.*ml$/s.test(n)).length : 0;
}

interface Detected {
  det: string[];
  steps: Record<string, string>;
  guard: string[];
}

function stackNode(repo: string): Detected {
  const text = readText(join(repo, "package.json")) ?? "";
  let pkg: unknown;
  try {
    pkg = JSON.parse(text);
  } catch (error) {
    fail(`package.json ilegível: ${error instanceof Error ? error.message : String(error)}`, 1);
  }
  const scripts = isObject(pkg as Json) && isObject((pkg as JsonObject).scripts) ? ((pkg as JsonObject).scripts as JsonObject) : {};
  const names = Object.keys(scripts);
  const runner = exists(join(repo, "pnpm-lock.yaml")) ? "pnpm run" : exists(join(repo, "yarn.lock")) ? "yarn" : "npm run";
  const steps: Record<string, string> = {};
  for (const [stage, candidates] of Object.entries(SCRIPTS)) {
    const found = candidates.find((n) => n in scripts);
    if (found !== undefined) steps[stage] = `${runner} ${found}`;
  }
  const lock = LOCKS.find((f) => exists(join(repo, f)));
  const det = ["package.json", ...(lock ? [lock] : [])];
  const alternatives = names.filter((s) => GUARDED_SCRIPT.test(s)).map(reEscape).join("|");
  const guard = names.length > 0 ? [`(^|[;&|]|\\s)${reEscape(runner.split(" ")[0] as string)}\\s+(run\\s+)?(${alternatives})\\b`] : [];
  return { det, steps, guard };
}

function stackOther(repo: string): Detected | undefined {
  const has = (f: string): boolean => exists(join(repo, f));
  if (has("Cargo.toml")) {
    return {
      det: ["Cargo.toml"],
      steps: { typecheck: "cargo check --all-targets", lint: "cargo clippy --all-targets -- -D warnings", build: "cargo build --release", test: "cargo test" },
      guard: ["(^|[;&|]|\\s)cargo\\s+(build|check|clippy|test|nextest)\\b"],
    };
  }
  if (has("go.mod")) {
    return { det: ["go.mod"], steps: { lint: "go vet ./...", build: "go build ./...", test: "go test ./..." }, guard: ["(^|[;&|]|\\s)go\\s+(build|vet|test)\\b"] };
  }
  if (has("pyproject.toml") || has("requirements.txt")) {
    const det = ["pyproject.toml", "requirements.txt"].filter(has).slice(0, 1);
    return { det, steps: { lint: "ruff check .", typecheck: "mypy .", test: "pytest" }, guard: ["(^|[;&|]|\\s)(ruff\\s+check|mypy|pytest)\\b"] };
  }
  return undefined;
}

/** Path.expanduser(): só o `~` do início. */
function expandUser(path: string): string {
  return path === "~" ? home() : path.startsWith("~/") ? join(home(), path.slice(2)) : path;
}

function propose(argv: string[]): number {
  let repo: string | undefined;
  let name: string | undefined;
  let stage = join(hadesHome(), "stacks-draft");
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--name") name = argv[++i];
    else if (a === "--stage") stage = expandUser(argv[++i] ?? "") || ".";
    else repo = realpathMissingOk(a);
  }
  if (!repo || !isDir(repo)) fail("propose exige <repo>");
  let found: Detected | undefined;
  if (isFile(join(repo, "package.json"))) found = stackNode(repo);
  else {
    found = stackOther(repo);
    if (!found) {
      fail("nenhum manifest conhecido (package.json, Cargo.toml, go.mod, pyproject.toml): escreva o pacote à mão (reference/projects.md §Pacote de stack)", EXIT_NO_MANIFEST);
    }
  }
  const { det, steps, guard } = found;
  if (Object.keys(steps).length === 0) fail("o manifest não declara scripts de typecheck/lint/build/test: escreva as etapas à mão", EXIT_NO_MANIFEST);
  const stackName = (name || basename(repo)).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const doc: JsonObject = {
    schema: "hades.stack/1",
    name: stackName,
    description: `Proposto por stack-add a partir dos manifests de ${basename(repo)}; custos estimados até a medição.`,
    detect: { files: det, ...(det.length > 1 ? { all: true } : {}) },
    steps: Object.fromEntries(
      Object.entries(steps).map(([stageName, cmd]) => {
        const [kind, costGb] = ESTIMATES[stageName] ?? FALLBACK_ESTIMATE;
        return [stageName, { cmd, kind, costGb }];
      }),
    ),
    ...(guard.length > 0 ? { guard: { patterns: guard } } : {}),
  };
  const target = join(stage, stackName, "stack.json");
  mkdirSync(join(stage, stackName), { recursive: true });
  writeFileSync(target, `${pyDumps(doc, 2)}\n`);
  const errors = validateFile(target);
  const runs = ciRuns(repo);
  const cmds = Object.values(steps);
  const lastToken = (cmd: string): string => cmd.trim().split(/\s+/).at(-1) as string;
  const evidence = runs.filter((r) => cmds.some((cmd) => r.includes(lastToken(cmd)) || r.includes(cmd)));
  out(
    pyDumps(
      {
        draft: target,
        stack: doc,
        valid: errors.length === 0,
        errors,
        ci: { workflows: workflowCount(repo), run: runs.slice(0, MAX_CI_RUNS), match: evidence.slice(0, MAX_CI_MATCH) },
      },
      2,
    ),
  );
  return errors.length > 0 ? 1 : 0;
}

function measure(argv: string[]): number {
  const positional: string[] = [];
  let project = "";
  let timeout = DEFAULT_TIMEOUT;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--project") project = argv[++i] ?? "";
    else if (a === "--timeout") timeout = argv[++i] ?? timeout;
    else positional.push(a);
  }
  if (positional.length !== 3) fail("measure <rascunho-dir> <repo> <etapa>");
  const dir = realpathMissingOk(positional[0] as string);
  const repo = realpathMissingOk(positional[1] as string);
  const stage = positional[2] as string;
  const file = join(dir, "stack.json");
  const text = readText(file);
  if (text === undefined) fail(`${file} ilegível`, 1);
  const doc = JSON.parse(text) as JsonObject;
  const steps = isObject(doc.steps) ? doc.steps : {};
  const step = steps[stage];
  if (!isObject(step) || Object.keys(step).length === 0) fail(`etapa ${pyReprText(stage)} não está no rascunho`);
  const raw = String(step.cmd);
  const cmd = raw.replaceAll("{project}", project).replaceAll("{files}", ".").replaceAll("{base}", "HEAD");
  if (cmd.includes("{") && /\{(project|files|base)\}/.test(raw) && !project && raw.includes("{project}")) fail("a etapa usa {project}: informe --project");
  const label = `stack-add-${String(doc.name)}-${stage}`;
  const env = { ...process.env, HADES_STACKS_ROOT: join(dir, "..") };
  const gateLock = join(skillRoot, "kit", "gate", "gate-lock.sh");
  const gate = spawnSync("bash", [gateLock, "run", "--step", `${String(doc.name)}:${stage}`, "--label", label, "--timeout", timeout, "--", "sh", "-c", cmd], {
    cwd: repo,
    env,
    stdio: "inherit",
  });
  const rc = gate.status ?? 1;
  const peak = run("bash", [gateLock, "peak", label], { cwd: repo });
  const peakText = peak.stdout.trim();
  const peakMb = peak.status === 0 && /^[0-9]+$/.test(peakText) ? Number(peakText) : null;
  const result: Record<string, Json> = { etapa: stage, rc, peakMb, costGb: step.costGb ?? null, gravado: false };
  if (rc === 0 && peakMb !== null) {
    const costGb = Math.max(1, Math.ceil(peakMb / MIB_PER_GIB));
    step.costGb = costGb;
    step.measuredAt = localDate();
    writeFileSync(file, `${pyDumps(doc, 2)}\n`);
    Object.assign(result, { costGb, gravado: true });
  } else if (peakMb === null) {
    result.aviso = process.platform === "darwin"
      ? "sem pico medido (precisa de HADES_GATE_MEMCAP=1: no macOS o pico vem do vigia de memória do gate-lock)"
      : "sem pico medido (precisa de systemd-run --user --scope e HADES_GATE_MEMCAP=1)";
  }
  out(pyDumps(result));
  return rc === 0 ? 0 : 1;
}

function pyReprText(text: string): string {
  return text.includes("'") && !text.includes('"') ? `"${text}"` : `'${text.replaceAll("'", "\\'")}'`;
}

function localDate(): string {
  const d = new Date();
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

function save(argv: string[]): number {
  if (!argv.includes("--confirmed")) fail("save só com o ok do dono (AskUserQuestion): passe --confirmed depois dele");
  const positional = argv.filter((a) => !a.startsWith("--"));
  if (positional.length !== 1) fail("save <rascunho-dir> --confirmed");
  const dir = realpathMissingOk(positional[0] as string);
  const errors = validateFile(join(dir, "stack.json"));
  if (errors.length > 0) fail(`rascunho inválido: ${errors.join("; ")}`, 1);
  const dest = join(stacksRoot(), basename(dir));
  if (exists(dest) && !argv.includes("--force")) fail(`${dest} já existe (--force substitui)`, 1);
  mkdirSync(dest, { recursive: true });
  const from = join(dir, "stack.json");
  const to = join(dest, "stack.json");
  copyFileSync(from, to);
  const { atime, mtime } = statSync(from);
  utimesSync(to, atime, mtime);
  out(to);
  return 0;
}

export function stackAddCommand(args: string[]): number {
  const [op, ...rest] = args;
  const ops: Record<string, (argv: string[]) => number> = { propose, measure, save };
  const handler = op === undefined ? undefined : ops[op];
  if (!handler) {
    process.stderr.write(USAGE);
    return EXIT_USAGE;
  }
  try {
    return handler(rest);
  } catch (error) {
    if (error instanceof StackAddError) {
      process.stderr.write(`${error.message}\n`);
      return error.code;
    }
    throw error;
  }
}
