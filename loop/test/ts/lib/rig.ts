// Equivalentes TypeScript de da antiga regressão em shell (run.sh): raiz temporária por arquivo, ambiente fechado (env -i), stubs no PATH,
// repositórios da fixture, `norm`, `check_text`, `check_json` e `want`. Cada arquivo de teste monta o seu rig, então
// `bun test` pode rodar os arquivos em paralelo sem corrida (nada é compartilhado fora de `T`).
import { expect } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { subsetDiff } from "./subset";

export const HERE = resolve(import.meta.dir, "..", ".."); // loop/test
export const SKILL = resolve(HERE, "..", "..");
/** Piso do contrato de plugin: texto fixo das mensagens, que não acompanha a versão em desenvolvimento. */
const CORE_FLOOR = "anterior à 5.0.0";
export const SKILL_VERSION = readFileSync(join(SKILL, "VERSION"), "utf8").trim();
export const FX = join(HERE, "fixtures");
export const GOLD = join(HERE, "golden");
export const STUBS = join(HERE, "stubs");
export const BUN = Bun.which("bun") ?? join(process.env.HOME ?? "", ".bun/bin/bun");
const NODE_DIR = dirname(Bun.which("node") ?? "/usr/bin/node");

/**
 * No macOS o /bin/bash é o 3.2 e as ferramentas do /usr/bin são BSD (sem timeout, stat -c, cp --parents…): uma pasta só
 * com o bash 4+, o flock e o coreutils do GNU (brew install bash flock coreutils), mais o bun (que lá mora em ~/.bun/bin,
 * fora do PATH fechado), vai à frente do sistema. Só esses: a pasta do Homebrew inteira traria gh, docker… que vários
 * testes exigem ausentes.
 */
function darwinBin(): string {
  if (process.platform !== "darwin") return "";
  const brew = ["/opt/homebrew", "/usr/local"].find((p) => existsSync(join(p, "bin/brew"))) ?? "/opt/homebrew";
  const dir = mkdtempSync(join(tmpdir(), "hades-sysbin-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  const gnubin = join(brew, "opt/coreutils/libexec/gnubin");
  for (const name of existsSync(gnubin) ? readdirSync(gnubin) : []) symlinkSync(join(gnubin, name), join(dir, name));
  for (const name of ["bash", "flock"]) if (existsSync(join(brew, "bin", name))) symlinkSync(join(brew, "bin", name), join(dir, name));
  if (!existsSync(join(dir, "bun"))) symlinkSync(BUN, join(dir, "bun"));
  return `${dir}:`;
}
/** A pasta do darwinBin com o `:` do fim, ou "" fora do macOS: vai à frente de /usr/bin nos PATH que não usam o SYS_PATH. */
export const MAC_BIN = darwinBin();
/** As pastas do sistema no fim do PATH fechado dos testes. */
export const SYS_PATH = `${MAC_BIN}/usr/local/bin:/usr/bin:/bin`;
/** A pasta real do bun (o instalador oficial usa ~/.bun/bin, que o HOME falso do rig esconde), para PATH sem o node. */
export const BUN_DIR = dirname(BUN);

export type Env = Record<string, string>;
export interface Run { rc: number; out: string; err: string; all: string }
export interface RunOpts { env?: Env; cwd?: string; stdin?: string; merge?: boolean; timeoutMs?: number }
/** Prazo de cada processo do rig: o maior caso legítimo mede poucos segundos; 120 s só estoura em travamento. */
export const RUN_TIMEOUT_MS = 120_000;
/** Saída do `timeout` do GNU quando o prazo estoura . */
const TIMEOUT_EXIT = 124;
/** Caminho absoluto: alguns testes rodam com PATH reduzido, onde `timeout` não existe. */
const GNU_TIMEOUT = Bun.which("timeout") ?? "";

/**
 * Espera síncrona sem o laço do `Bun.spawnSync`: no bun 1.4.2 o spawnSync de um worker do `bun test --parallel` chegou a girar
 * a 100% de CPU em espaço de usuário com o filho já morto e não colhido (o pidfd legível, sem nenhuma syscall), e só voltava
 * quando o prazo dele estourava. Por isso o `Rig.X` cria o filho com `Bun.spawn` e espera pelo arquivo de status que o próprio
 * invólucro grava ao terminar.
 */
const POLL_MS = 1;
const pauseCell = new Int32Array(new SharedArrayBuffer(4));
const pause = (ms: number) => { Atomics.wait(pauseCell, 0, 0, ms); };
/** Folga além do prazo do `timeout` (que já tem `--kill-after`) antes de dar o invólucro por perdido. */
const WRAPPER_SLACK_MS = 5_000;
/**
 * Invólucro: roda o comando com stdin/stdout/stderr em arquivos e grava o rc por último, com `\n` no fim (quem lê só aceita a linha
 * completa). Só builtins do shell: há testes com PATH reduzido, onde `mv` e afins não existem.
 */
const WRAP_SPLIT = 'i=$1; o=$2; e=$3; r=$4; shift 4; "$@" <"$i" >"$o" 2>"$e"; printf "%s\\n" "$?" >"$r"';
const WRAP_MERGED = 'i=$1; o=$2; r=$4; shift 4; "$@" <"$i" >"$o" 2>&1; printf "%s\\n" "$?" >"$r"';

/** Variáveis `K=V` soltas, como no `env -i … K=V cmd` do bash. */
export function kv(...pairs: (string | Env)[]): Env {
  const o: Env = {};
  for (const p of pairs) {
    if (typeof p === "string") { const i = p.indexOf("="); o[p.slice(0, i)] = p.slice(i + 1); } else Object.assign(o, p);
  }
  return o;
}

export class Rig {
  readonly T: string;
  readonly H: string;
  readonly C: string; // clone example/monorepo
  readonly P: string; // clone other/plain
  readonly env0: Env;
  readonly ae: Env;
  private dirs: Record<string, string> | null = null;

  constructor() {
    // realpath: no macOS o tmpdir passa por um symlink (/var → /private/var) e a CLI imprime o caminho resolvido
    this.T = mkdtempSync(join(realpathSync(tmpdir()), "hades-ts-"));
    this.H = join(this.T, "home");
    for (const d of [join(this.H, ".claude/skills"), join(this.T, "work"), join(this.T, "packs"), join(this.T, "nogit")]) mkdirSync(d, { recursive: true });
    symlinkSync(SKILL, join(this.H, ".claude/skills/hades"));
    // node e bun por links numa pasta do rig: o caminho deles some do PATH gravado nos goldens, venha do nvm, do
    // ~/.bun/bin ou do /usr/bin, e não colide com as pastas do SYS_PATH
    const tools = join(this.T, "tools");
    mkdirSync(tools);
    for (const tool of ["node", "npm", "npx"]) if (existsSync(join(NODE_DIR, tool))) symlinkSync(join(NODE_DIR, tool), join(tools, tool));
    symlinkSync(BUN, join(tools, "bun"));
    this.C = join(this.T, "clone/monorepo");
    this.P = join(this.T, "clone/plain");
    this.env0 = {
      HOME: this.H, PATH: `${STUBS}:${tools}:${SYS_PATH}`, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC",
      HADES_WORK_ROOT: join(this.T, "work"), HADES_PACKS_ROOT: join(this.T, "packs"), HADES_STACKS_ROOT: join(this.T, "stacks"),
      GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "regressao", GIT_AUTHOR_EMAIL: "regressao@example.invalid",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_NAME: "regressao", GIT_COMMITTER_EMAIL: "regressao@example.invalid",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z", FAKE_GH_LOG: join(this.T, "gh.log"), FAKE_HERDR_LOG: join(this.T, "herdr.log"),
      FAKE_NPX_LOG: join(this.T, "npx.log"), HADES_BUN: BUN, HADES_INSTALL_BUSY_PORTS: "",
      // os testes de systemd valem no macOS também: lá o padrão seria o launchd (launchd.test.ts força o dele)
      HADES_SERVICE_MANAGER: "systemd",
      // o cache de transpilação do bun fica em ~/.cache no Linux (fora das fotos de estado); no macOS iria para ~/Library/Caches
      ...(process.platform === "darwin" ? { XDG_CACHE_HOME: join(this.H, ".cache") } : {}),
    };
    // Configurações fixas dos comandos do agente: o padrão do config.tsv muda com o kit, o teste não
    this.ae = {
      HADES_PLAN_REQUIRED: "0", HADES_ORCH_WORKTREE_ROOT: join(this.T, "agents"), HADES_ORCH_REPORTS_DIR: ".design-sync-reports",
      HADES_MODEL_IMPL: "modelo-impl", HADES_EFFORT_IMPL: "alto", HADES_ORCH_PR_ASSIGNEE: "dono-x",
      HADES_ORCH_PR_REVIEWERS: "rev-b,rev-c", HADES_ORCH_SPEC_OWNERS: "dono@example.invalid", HADES_ORCH_SPEC_REVIEWERS: "rev-b",
      HADES_ESCALATE_GATE_WAVES: "2", HADES_PARK_GATE_WAIT_MIN: "20",
    };
  }

  /**
   * `X cmd…`: processo com o ambiente fechado do rig mais as variáveis pedidas. Todo processo tem prazo (`timeoutMs`, padrão
   * RUN_TIMEOUT_MS): estourado, o `timeout` do GNU mata o grupo inteiro (o filho e os netos) e a chamada lança um erro
   * que diz qual comando travou, em vez de o worker do `bun test` ficar preso sem fim. A espera não passa pelo `Bun.spawnSync`
   * (ver POLL_MS).
   */
  X(argv: string[], o: RunOpts = {}): Run {
    const ms = o.timeoutMs ?? RUN_TIMEOUT_MS;
    const cmd = GNU_TIMEOUT ? [GNU_TIMEOUT, "--kill-after=2", `${ms / 1000}`, ...argv] : argv;
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "hades-x-"));
    const inF = join(dir, "in"), outF = join(dir, "out"), errF = join(dir, "err"), rcF = join(dir, "rc");
    try {
      writeFileSync(inF, o.stdin ?? "");
      const child = Bun.spawn(["/bin/sh", "-c", o.merge ? WRAP_MERGED : WRAP_SPLIT, "sh", inF, outF, errF, rcF, ...cmd], {
        env: { ...this.env0, ...o.env }, cwd: o.cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore",
      });
      child.unref();
      const t0 = performance.now();
      let lost = false;
      let rcText = "";
      while (!rcText.endsWith("\n")) {
        if (performance.now() - t0 > ms + WRAPPER_SLACK_MS) { lost = true; child.kill("SIGKILL"); break; }
        pause(POLL_MS);
        rcText = existsSync(rcF) ? readFileSync(rcF, "utf8") : "";
      }
      const elapsed = Math.round(performance.now() - t0);
      const rc = lost ? -1 : Number(rcText.trim());
      const out = existsSync(outF) ? readFileSync(outF, "utf8") : "", err = !o.merge && existsSync(errF) ? readFileSync(errF, "utf8") : "";
      // 124 também é o que um `timeout N` do próprio teste devolve (N menor, de propósito): só vale como travamento se o prazo do rig passou
      if (lost || (rc === TIMEOUT_EXIT && elapsed >= ms)) {
        throw new Error(`processo travou: excedeu ${ms} ms e foi morto (rc=${rc}, pid ${child.pid}, decorridos ${elapsed} ms): ${argv.join(" ")}\n${out}${err}`);
      }
      return { rc, out, err, all: o.merge ? out : out + err };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  /** Comando da CLI nova: `bun src/cli.ts <sub> …`. */
  hades(args: string[], o: RunOpts = {}): Run { return this.hadesIn(SKILL, args, o); }
  /** A CLI de uma cópia da skill (skill-new/skill-clean mexem no git da cópia, nunca no da skill de verdade). */
  hadesIn(skill: string, args: string[], o: RunOpts = {}): Run { return this.X([BUN, join(skill, "src/cli.ts"), ...args], o); }
  /** Cópia da skill com git próprio e um commit `base`. */
  skillCopy(dir: string): void {
    mkdirSync(dir, { recursive: true });
    this.must(this.sh(`cd '${SKILL}' && git ls-files -co --exclude-standard -z | grep -zv '^\\.design-sync-reports/' | tar -cf - --null -T - | tar -xf - -C '${dir}'`));
    this.must(this.git(dir, "init", "-q", "-b", "main")); this.must(this.git(dir, "add", "-A")); this.must(this.git(dir, "commit", "-qm", "base"));
  }
  git(dir: string, ...a: string[]): Run { return this.X(["git", "-C", dir, ...a]); }
  sh(cmd: string, o: RunOpts = {}): Run { return this.X(["bash", "-c", cmd], o); }

  /** Troca o caminho do rig, o da skill, o host e a versão da skill por marcadores (o golden não envelhece a cada release). */
  norm(s: string): string {
    return s.split(this.T).join("<T>").split(SKILL).join("<SKILL>").split(hostname()).join("<HOST>").split(CORE_FLOOR).join("\0").split(SKILL_VERSION).join("<V>").split("\0").join(CORE_FLOOR);
  }

  mkrepo(slug: string, clone: string): void {
    const bare = join(this.T, "remotes", `${slug}.git`), src = join(this.T, "src", slug);
    mkdirSync(dirname(bare), { recursive: true }); mkdirSync(dirname(src), { recursive: true });
    this.must(this.X(["git", "init", "-q", "--bare", "-b", "develop", bare]));
    this.must(this.X(["git", "init", "-q", "-b", "develop", src]));
    writeFileSync(join(src, "README.md"), "demo\n");
    this.must(this.git(src, "add", "-A")); this.must(this.git(src, "commit", "-qm", "init"));
    this.must(this.git(src, "push", "-q", bare, "develop"));
    mkdirSync(dirname(clone), { recursive: true });
    this.must(this.X(["git", "clone", "-q", bare, clone]));
  }
  must(r: Run): Run { if (r.rc !== 0) throw new Error(`falhou (rc=${r.rc}): ${r.all}`); return r; }

  /** Estado comum do início do run.sh: repos da fixture, catálogo de qualidade todo desligado, pacotes da fixture. */
  setup(profile?: string): this {
    this.hades(["quality", "off", "--all"]);
    this.mkrepo("example/monorepo", this.C);
    this.mkrepo("other/plain", this.P);
    if (existsSync(join(FX, "packs"))) cpSync(join(FX, "packs"), join(this.T, "packs"), { recursive: true });
    void profile;
    return this;
  }

  stateFixture(): void {
    const w = join(this.T, "work/example__monorepo");
    mkdirSync(w, { recursive: true });
    if (!existsSync(join(w, "state"))) cpSync(join(FX, "collector/state"), join(w, "state"), { recursive: true });
  }

  /** Worktree comum, worktree de agente registrado e o mapa "onde" dos casos do hook (uma vez). */
  hookDirs(): Record<string, string> {
    if (this.dirs) return this.dirs;
    const a = join(this.T, "agents-hook/impl-x"), o = join(this.T, "work/example__monorepo/orchestration/agents");
    this.must(this.git(this.C, "worktree", "add", "-q", "-b", "hook/wt", join(this.T, "wt-hook")));
    this.must(this.git(this.C, "worktree", "add", "-q", "-b", "hook/agent", a));
    mkdirSync(o, { recursive: true });
    writeFileSync(join(o, "impl-x.json"), JSON.stringify({ name: "impl-x", mode: "deliver", role: "impl", worktree: a, state: "working" }));
    this.dirs = { main: this.C, wt: join(this.T, "wt-hook"), agent: a, plain: this.P, nogit: join(this.T, "nogit") };
    writeFileSync(join(this.T, "dirs.json"), JSON.stringify(this.dirs));
    return this.dirs;
  }

  /** Comando do agente no clone principal, com as configurações fixas `AE`. */
  agent(args: string[], o: RunOpts = {}): Run { return this.hades(["agent", ...args], { cwd: this.C, merge: true, ...o, env: { ...this.ae, ...o.env } }); }

  /** Comando do agente pela CLI de uma cópia da skill, no clone principal. */
  agentIn(skill: string, args: string[], o: RunOpts = {}): Run {
    return this.hadesIn(skill, ["agent", ...args], { cwd: this.C, merge: true, ...o, env: { ...this.ae, ...o.env } });
  }
  cleanup(): void { rmSync(this.T, { recursive: true, force: true }); }
}

/** check_text: o texto atual é byte a byte o gravado em golden/. */
export function checkText(gold: string, actual: string): void {
  const g = join(GOLD, gold);
  if (!existsSync(g)) throw new Error(`${gold}: sem esperado gravado`);
  expect(actual, gold).toBe(readFileSync(g, "utf8"));
}
/** check_json: todo campo gravado igual; campo novo passa; listas comparam por posição e tamanho. */
export function checkJson(gold: string, actual: string): void {
  const g = join(GOLD, gold);
  if (!existsSync(g)) throw new Error(`${gold}: sem esperado gravado`);
  expect(subsetDiff(JSON.parse(readFileSync(g, "utf8")), JSON.parse(actual)), gold).toEqual([]);
}
/** want: esperado e atual (já como texto) iguais. */
export function want(label: string, expected: string | number, actual: string | number): void {
  expect(String(actual), label).toBe(String(expected));
}
/** `cut -f2-`: tira o primeiro campo de cada linha (linha sem TAB fica inteira). */
export const cutF2 = (s: string) => s.split("\n").map((l) => (l.includes("\t") ? l.split("\t").slice(1).join("\t") : l)).join("\n");
export const lines = (s: string) => s.split("\n");
export const rd = (p: string) => readFileSync(p, "utf8");
export const ls = (p: string) => readdirSync(p).sort();

/** `jq -Sc .`: chaves ordenadas em todos os níveis, uma linha. */
export function sortedJson(text: string): string {
  const s = (v: unknown): unknown => Array.isArray(v) ? v.map(s)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, s((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify(s(JSON.parse(text)));
}
export const readJson = <T = Record<string, any>>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T; // eslint-disable-line @typescript-eslint/no-explicit-any
export const writeJson = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v, null, 2) + "\n");

/** `jq -S .`: JSON com chaves ordenadas e recuo de 2, como o jq imprime. */
export function jqS(text: string, strip: string[] = []): string {
  const v = JSON.parse(text) as Record<string, unknown>;
  for (const k of strip) delete v[k];
  const s = (x: unknown): unknown => Array.isArray(x) ? x.map(s)
    : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, s((x as Record<string, unknown>)[k])])) : x;
  return JSON.stringify(s(v), null, 2) + "\n";
}
export const GATE_ENV = { HADES_GATE_MEMCAP: "0", HADES_GATE_RESERVE_GB: "0", HADES_GATE_PSI_MAX: "100" };
export const gateSeds = (s: string) => s.split("\n")
  .map((l) => l.replace(/avail=[0-9]+MB/, "avail=<MB>").replace(/dur=[0-9]+s/, "dur=<S>").replace(/waited=[0-9]+/, "waited=<S>")).join("\n");

/** `cut -c1-80` do run.sh, cego ao tamanho do caminho temporário: o corte vale para um `mktemp -d` de 19 caracteres. */
export function cut80(rig: Rig, line: string): string {
  const fixed = line.split(rig.T).join("/tmp/tmp.XXXXXXXXXX");
  return Array.from(fixed).slice(0, 80).join("").split("/tmp/tmp.XXXXXXXXXX").join(rig.T);
}

/** `cut -c1-N` em locale UTF-8: conta caracteres. */
export const cutBytes = (s: string, n: number) => Array.from(s).slice(0, n).join("");
