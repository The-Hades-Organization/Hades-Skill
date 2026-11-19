// `hades worker gc`: limpeza do worker (worktrees ociosas, warm, resultados, slots, refs), encaixe no comando forçado,
// limpeza automática depois do job e a garantia de que o gc não escreve antes de apagar.
import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoGc } from "../../../src/commands/worker.ts";
import { LOCK_EX, LOCK_NB, sysFlock } from "../../../src/lib/flock.ts";
import { ProtocolError, gcCommandLine, parseWorkerCommand } from "../../../src/lib/gate-remote/protocol.ts";
import { runGc, type GcEnv, type GcOptions } from "../../../src/lib/worker-gc.ts";
import { BUN, Rig, SKILL, type Env } from "./lib/rig";

const GB = 1024 ** 3;
const DAY_S = 24 * 60 * 60;
const dirs: string[] = [];
const children: ChildProcess[] = [];
const fds: number[] = [];
afterAll(() => {
  for (const child of children) child.kill("SIGKILL");
  for (const fd of fds) closeSync(fd);
  for (const dir of dirs) {
    spawnSync("chmod", ["-R", "u+rwx", dir]);
    rmSync(dir, { recursive: true, force: true });
  }
});

interface World {
  fs: string;
  base: string;
  mirror: string;
  env: GcEnv;
  /** cria worktree falsa (pasta com um arquivo) com último uso `idleDays` atrás; devolve o cwd lógico */
  add: (name: string, idleDays: number) => string;
}

const HOME = "/home/dev";
const markerId = (cwd: string): string => Buffer.from(cwd).toString("hex").slice(-24);

function world(over: Partial<GcEnv> = {}): World {
  const fs = mkdtempSync(join(tmpdir(), "worker-gc-test-"));
  dirs.push(fs);
  const base = join(fs, HOME, ".cache", "hades-worker");
  const mirror = join(base, "mirror", "acme__api.git");
  mkdirSync(mirror, { recursive: true });
  spawnSync("git", ["init", "--bare", "-q", mirror]);
  mkdirSync(join(mirror, "hades-worktrees"), { recursive: true });
  const env: GcEnv = { base, home: HOME, physical: (p) => join(fs, p), ticketPids: () => [], ...over };
  const add = (name: string, idleDays: number): string => {
    const cwd = `${HOME}/proj/.fixes/${name}`;
    mkdirSync(join(fs, cwd, "node_modules"), { recursive: true });
    writeFileSync(join(fs, cwd, "node_modules", "pkg.txt"), "x");
    const markers = join(mirror, "hades-worktrees");
    writeFileSync(join(markers, markerId(cwd)), `${cwd}\n`);
    const used = join(markers, `${markerId(cwd)}.used`);
    writeFileSync(used, "u\n");
    const when = Date.now() / 1000 - idleDays * DAY_S;
    utimesSync(used, when, when);
    utimesSync(join(fs, cwd), when, when);
    return cwd;
  };
  return { fs, base, mirror, env, add };
}

const all: GcOptions = { freeGb: undefined, allIdle: true, keepWarm: false, dryRun: false, maintenanceAlways: true };
const exists = (w: World, cwd: string): boolean => existsSync(join(w.fs, cwd));
const lockFile = (w: World, cwd: string): string => join(w.mirror, "hades-worktrees", `${markerId(cwd)}.lock`);

function warmMarker(w: World, key: string, cwd: string, state = "ready"): string {
  mkdirSync(join(w.base, "warm"), { recursive: true });
  const file = join(w.base, "warm", `${key}.json`);
  writeFileSync(file, JSON.stringify({ key, cwd, state, since: new Date().toISOString() }));
  return file;
}

describe("gc: o que sai e o que fica", () => {
  test("worktree ociosa sai; com lock vivo, ticket vivo ou marcador de job vivo, fica", () => {
    const sleeper = spawn("sleep", ["60"], { stdio: "ignore" });
    children.push(sleeper);
    const w = world();
    const idle = w.add("ociosa", 5);
    const locked = w.add("com-lock", 6);
    const queued = w.add("na-fila", 7);
    const running = w.add("rodando", 8);
    // lock vivo: outro descritor segurando o flock do arquivo `.lock`
    writeFileSync(lockFile(w, locked), "");
    const fd = openSync(lockFile(w, locked), "r");
    fds.push(fd);
    expect(sysFlock()(fd, LOCK_EX | LOCK_NB)).toBe(0);
    // ticket vivo: processo cujo cwd está dentro da worktree
    const cwdOfQueued = join(w.fs, queued);
    const waiting = spawn("sleep", ["60"], { cwd: cwdOfQueued, stdio: "ignore" });
    children.push(waiting);
    // marcador de job com o pid deste processo (vivo)
    writeFileSync(join(w.mirror, "hades-worktrees", `${markerId(running)}.job`), `${process.pid} \n`);
    const report = runGc({ ...w.env, ticketPids: () => [waiting.pid ?? 0] }, all);
    expect(report.removed.map((r) => r.cwd)).toEqual([idle]);
    expect(Object.fromEntries(report.kept.map((k) => [k.cwd, k.reason]))).toEqual({
      [locked]: "job ativo (lock)", [queued]: "ticket vivo na fila", [running]: "job ativo (marcador)",
    });
    expect(exists(w, idle)).toBe(false);
    for (const cwd of [locked, queued, running]) expect(exists(w, cwd)).toBe(true);
    expect(existsSync(join(w.mirror, "hades-worktrees", markerId(idle)))).toBe(false);
    sleeper.kill();
  });

  test("a mais antiga sai primeiro e --free-gb para quando o pedido foi liberado", () => {
    const sizes = new Map<string, number>();
    const w = world({ sizeOf: (path) => sizes.get(path) ?? 0 });
    const names = ["velha", "media", "nova", "novissima"];
    const cwds = names.map((n, i) => w.add(n, 10 - i));
    for (const cwd of cwds) sizes.set(join(w.fs, cwd), 3 * GB);
    const report = runGc(w.env, { ...all, allIdle: false, freeGb: 5 });
    expect(report.removed.map((r) => r.cwd)).toEqual(cwds.slice(0, 2));
    expect(report.freedGb).toBe(6);
    expect(report.kept.map((k) => k.reason)).toEqual(["pedido já atendido", "pedido já atendido"]);
    expect(exists(w, cwds[2] as string)).toBe(true);
    expect(exists(w, cwds[3] as string)).toBe(true);
  });

  test("--dry-run lista o que sairia e não apaga nada", () => {
    const w = world();
    const cwd = w.add("a-sair", 4);
    const marker = warmMarker(w, "node-nx-aaaa", cwd);
    const old = join(w.base, "results", "velho.txt");
    mkdirSync(join(w.base, "results"), { recursive: true });
    writeFileSync(old, "peak=1\n");
    utimesSync(old, 1, 1);
    const report = runGc(w.env, { ...all, dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.removed.map((r) => r.cwd)).toEqual([cwd]);
    expect(report.warmCleared).toEqual(["node-nx-aaaa"]);
    expect(report.resultsRemoved).toBe(1);
    expect(exists(w, cwd)).toBe(true);
    expect(existsSync(marker)).toBe(true);
    expect(existsSync(old)).toBe(true);
    expect(existsSync(join(w.mirror, "hades-worktrees", markerId(cwd)))).toBe(true);
  });

  test("warm das worktrees removidas some; com --keep-warm a worktree aquecida fica com o marcador", () => {
    const w = world();
    const cold = w.add("fria", 9);
    const warm = w.add("quente", 8);
    const coldMarker = warmMarker(w, "node-nx-1111", cold, "failed");
    const warmFile = warmMarker(w, "node-nx-2222", warm);
    const report = runGc(w.env, { ...all, keepWarm: true });
    expect(report.removed.map((r) => r.cwd)).toEqual([cold]);
    expect(report.kept).toEqual([{ cwd: warm, reason: "aquecida (--keep-warm)" }]);
    expect(existsSync(coldMarker)).toBe(false);
    expect(existsSync(warmFile)).toBe(true);
    expect(exists(w, warm)).toBe(true);
    const sem = runGc(w.env, all);
    expect(sem.removed.map((r) => r.cwd)).toEqual([warm]);
    expect(existsSync(warmFile)).toBe(false);
  });

  test("worktree registrada no espelho sai por `git worktree remove`; a não registrada, por rm", () => {
    const w = world();
    const src = join(w.fs, "src");
    mkdirSync(src);
    const git = (...args: string[]): string => spawnSync("git", args, { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).stdout.trim();
    git("-C", src, "init", "-q");
    writeFileSync(join(src, "a.txt"), "a");
    git("-C", src, "add", ".");
    git("-C", src, "commit", "-q", "-m", "c");
    const sha = git("-C", src, "rev-parse", "HEAD");
    git("--git-dir", w.mirror, "fetch", "-q", src, "HEAD");
    const registered = `${HOME}/proj/.fixes/registrada`;
    git("--git-dir", w.mirror, "worktree", "add", "-q", "-f", "--detach", join(w.fs, registered), sha);
    writeFileSync(join(w.mirror, "hades-worktrees", markerId(registered)), `${registered}\n`);
    const loose = w.add("solta", 3);
    const report = runGc(w.env, all);
    expect(report.removed.map((r) => r.cwd).sort()).toEqual([registered, loose].sort());
    expect(exists(w, registered)).toBe(false);
    expect(exists(w, loose)).toBe(false);
    const admin = join(w.mirror, "worktrees");
    expect(existsSync(admin) ? readdirSync(admin) : []).toEqual([]);
  });

  test("resultados e slots vencidos saem, o slot de dono vivo fica; ref de job antiga sai e a recente fica", () => {
    const w = world();
    const results = join(w.base, "results");
    mkdirSync(results, { recursive: true });
    for (const name of ["velho.txt", "velho.start", "novo.start"]) writeFileSync(join(results, name), "1\n");
    utimesSync(join(results, "velho.txt"), 1, 1);
    utimesSync(join(results, "velho.start"), 1, 1);
    const slots = join(w.base, "slots", "acme__api");
    mkdirSync(join(slots, "0"), { recursive: true });
    mkdirSync(join(slots, "1"), { recursive: true });
    writeFileSync(join(slots, "0", "pid"), "999999999\n");
    writeFileSync(join(slots, "1", "pid"), `${process.pid}\n`);
    const git = (args: string[], env: Env = {}): string => spawnSync("git", ["--git-dir", w.mirror, ...args], { encoding: "utf8", env: { ...process.env, ...env } }).stdout.trim();
    const author = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    const tree = git(["hash-object", "-t", "tree", "-w", "--stdin"]);
    const older = git(["commit-tree", tree, "-m", "o"], { ...author, GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z", GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z" });
    const newer = git(["commit-tree", tree, "-m", "n"], author);
    git(["update-ref", "refs/hades/jobs/antigo", older]);
    git(["update-ref", "refs/hades/jobs/recente", newer]);
    const report = runGc(w.env, all);
    expect(report.resultsRemoved).toBe(2);
    expect(report.slotsRemoved).toBe(1);
    expect(report.refsDeleted).toBe(1);
    expect(report.errors).toEqual([]);
    expect(existsSync(join(results, "novo.start"))).toBe(true);
    expect(existsSync(join(slots, "0"))).toBe(false);
    expect(existsSync(join(slots, "1"))).toBe(true);
    expect(git(["for-each-ref", "--format=%(refname)", "refs/hades/jobs"])).toBe("refs/hades/jobs/recente");
  });

  test("a pasta do job que acabou de rodar nunca sai, mesmo ociosa e com disco curto", () => {
    const w = world();
    const current = w.add("atual", 30);
    const other = w.add("outra", 2);
    const report = runGc(w.env, { ...all, allIdle: false, freeGb: 100, exclude: [current] });
    expect(report.kept).toEqual([{ cwd: current, reason: "job que acabou de rodar" }]);
    expect(report.removed.map((r) => r.cwd)).toEqual([other]);
    expect(exists(w, current)).toBe(true);
  });
});

describe("gc não escreve antes de apagar", () => {
  test.skipIf(process.getuid?.() === 0)("com a pasta base sem permissão de escrita, apaga o que pede e não cria nada nela", () => {
    const w = world();
    const cwd = w.add("cheia", 5);
    warmMarker(w, "node-nx-3333", cwd);
    mkdirSync(join(w.base, "results"), { recursive: true });
    const before = readdirSync(w.base).sort();
    // o disco cheio recusa criar entradas na base: sem `w` nela, só as subpastas já existentes aceitam remoção
    chmodSync(w.base, 0o555);
    try {
      const report = runGc(w.env, all);
      expect(report.removed.map((r) => r.cwd)).toEqual([cwd]);
      expect(report.errors).toEqual([]);
    } finally {
      chmodSync(w.base, 0o755);
    }
    expect(exists(w, cwd)).toBe(false);
    expect(readdirSync(w.base).sort()).toEqual(before);
    expect(readdirSync(join(w.base, "warm"))).toEqual([]);
  });

  test("worktree sem arquivo .lock (nenhum job passou por ela) é ociosa e o gc não cria o arquivo", () => {
    const w = world();
    const cwd = w.add("sem-lock", 1);
    runGc(w.env, all);
    expect(existsSync(lockFile(w, cwd))).toBe(false);
  });
});

describe("comando forçado", () => {
  const home = "/home/dev";

  test("gc entra na lista e as opções são fechadas", () => {
    expect(parseWorkerCommand("gc --all-idle --dry-run", home)).toEqual({ kind: "gc", request: { freeGb: undefined, allIdle: true, keepWarm: false, dryRun: true } });
    expect(parseWorkerCommand("gc --free-gb 20 --keep-warm", home)).toEqual({ kind: "gc", request: { freeGb: 20, allIdle: false, keepWarm: true, dryRun: false } });
    for (const bad of ["gc", "gc --all-idle --free-gb 5", "gc --free-gb", "gc --free-gb 0", "gc --free-gb 5x", "gc --free-gb -3", "gc --all-idle --rm", "gc ; rm -rf /", "gc --all-idle extra"]) {
      expect(() => parseWorkerCommand(bad, home)).toThrow(ProtocolError);
    }
  });

  test("a linha que o cliente envia é a que o worker aceita", () => {
    for (const request of [{ freeGb: 7, allIdle: false, keepWarm: true, dryRun: false }, { freeGb: undefined, allIdle: true, keepWarm: false, dryRun: true }]) {
      expect(parseWorkerCommand(gcCommandLine(request), home)).toEqual({ kind: "gc", request });
    }
  });

  test("SSH_ORIGINAL_COMMAND='gc --all-idle' roda o worker de verdade, primeiro como --dry-run e depois apagando", () => {
    const r = new Rig();
    try {
      const fs = join(r.T, "worker-fs");
      const base = join(fs, r.H, ".cache", "hades-worker");
      const mirror = join(base, "mirror", "acme__api.git");
      mkdirSync(mirror, { recursive: true });
      spawnSync("git", ["init", "--bare", "-q", mirror]);
      const markers = join(mirror, "hades-worktrees");
      mkdirSync(markers, { recursive: true });
      const idle = join(r.H, "proj", ".fixes", "ociosa");
      const busy = join(r.H, "proj", ".fixes", "ativa");
      for (const cwd of [idle, busy]) {
        mkdirSync(join(fs, cwd, "node_modules"), { recursive: true });
        writeFileSync(join(fs, cwd, "node_modules", "x"), "x");
        writeFileSync(join(markers, markerId(cwd)), `${cwd}\n`);
      }
      writeFileSync(join(markers, `${markerId(busy)}.lock`), "");
      const fd = openSync(join(markers, `${markerId(busy)}.lock`), "r");
      fds.push(fd);
      expect(sysFlock()(fd, LOCK_EX | LOCK_NB)).toBe(0);
      const exec = (command: string): { rc: number; json: Record<string, unknown> } => {
        const run = spawnSync(BUN, [join(SKILL, "src/cli.ts"), "worker", "exec"], {
          encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: r.H, HADES_WORK_ROOT: join(r.T, "work-worker"), HADES_WORKER_FS_ROOT: fs, SSH_ORIGINAL_COMMAND: command },
        });
        return { rc: run.status ?? -1, json: run.stdout.trim() === "" ? {} : (JSON.parse(run.stdout) as Record<string, unknown>) };
      };
      const dry = exec("gc --all-idle --dry-run");
      expect(dry.rc).toBe(0);
      expect(dry.json.dryRun).toBe(true);
      expect((dry.json.removed as { cwd: string }[]).map((x) => x.cwd)).toEqual([idle]);
      expect(existsSync(join(fs, idle))).toBe(true);
      const real = exec("gc --all-idle");
      expect(real.rc).toBe(0);
      expect((real.json.removed as { cwd: string }[]).map((x) => x.cwd)).toEqual([idle]);
      expect((real.json.kept as { cwd: string; reason: string }[])).toEqual([{ cwd: busy, reason: "job ativo (lock)" }]);
      expect(typeof real.json.diskFreeGb).toBe("number");
      expect(existsSync(join(fs, idle))).toBe(false);
      expect(existsSync(join(fs, busy))).toBe(true);
      expect(exec("gc").rc).toBe(2);
    } finally {
      r.cleanup();
    }
  });
});

describe("limpeza automática depois do job", () => {
  function withEnv(w: World, vars: Env, fn: () => void): void {
    const keys = ["HADES_WORKER_FS_ROOT", "HOME", "HADES_WORK_ROOT", "HADES_WORKER_GC_MIN_FREE_GB", "HADES_WORKER_GC_IDLE_DAYS"];
    const saved = new Map(keys.map((k) => [k, process.env[k]]));
    Object.assign(process.env, { HADES_WORKER_FS_ROOT: w.fs, HOME: HOME, HADES_WORK_ROOT: join(w.fs, "work"), ...vars });
    try {
      fn();
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  test("disco abaixo do teto: libera as ociosas e poupa a do job que acabou de rodar", () => {
    const w = world();
    const current = w.add("atual", 20);
    const other = w.add("outra", 10);
    withEnv(w, { HADES_WORKER_GC_MIN_FREE_GB: "100000", HADES_WORKER_GC_IDLE_DAYS: "0" }, () => autoGc(current));
    expect(exists(w, current)).toBe(true);
    expect(exists(w, other)).toBe(false);
  });

  test("ociosa há mais dias que o limite sai mesmo com disco folgado; a recente fica", () => {
    const w = world();
    const current = w.add("atual", 30);
    const stale = w.add("velha", 4);
    const fresh = w.add("recente", 1);
    withEnv(w, { HADES_WORKER_GC_MIN_FREE_GB: "0", HADES_WORKER_GC_IDLE_DAYS: "3" }, () => autoGc(current));
    expect(exists(w, stale)).toBe(false);
    expect(exists(w, fresh)).toBe(true);
    expect(exists(w, current)).toBe(true);
  });

  test("as duas regras desligadas (0 e 0): não mexe em nada", () => {
    const w = world();
    const old = w.add("velha", 40);
    withEnv(w, { HADES_WORKER_GC_MIN_FREE_GB: "0", HADES_WORKER_GC_IDLE_DAYS: "0" }, () => autoGc("/home/dev/outro"));
    expect(exists(w, old)).toBe(true);
  });

  test("falha do gc não lança: vai ao stderr e ao journal", () => {
    const w = world();
    const current = w.add("atual", 1);
    const errors: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      errors.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      withEnv(w, { HADES_WORKER_GC_MIN_FREE_GB: "100000", HADES_WORKER_GC_IDLE_DAYS: "3" }, () => autoGc(current, () => { throw new Error("disco sumiu"); }));
    } finally {
      process.stderr.write = original;
    }
    expect(errors.join("")).toContain("gc após o job falhou: disco sumiu");
    const journal = join(w.fs, "work", "_maquina", "journal", "_sessions", "_gate.jsonl");
    expect(existsSync(journal) ? readFileSync(journal, "utf8") : "").toContain("gate.gc-erro");
  });

  test("configuração inválida também só avisa", () => {
    const w = world();
    const errors: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      errors.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      withEnv(w, { HADES_WORKER_GC_MIN_FREE_GB: "muito", HADES_WORKER_GC_IDLE_DAYS: "3" }, () => autoGc("/home/dev/x"));
    } finally {
      process.stderr.write = original;
    }
    expect(errors.join("")).toContain("HADES_WORKER_GC_MIN_FREE_GB exige inteiro");
  });
});

describe("falha do gc não muda o rc do job", () => {
  test("job que sai com 3 volta 3 com o gc quebrado por configuração, e o aviso chega ao stderr do cliente", () => {
    const r = new Rig();
    try {
      const repo = join(r.H, "repo");
      r.mkrepo("acme/gc", repo);
      mkdirSync(join(r.T, "worker-fs"), { recursive: true });
      const script = join(r.T, "ssh-gc.sh");
      writeFileSync(script, `#!/bin/bash\nexport HOME='${r.H}' HADES_WORK_ROOT='${join(r.T, "work-worker")}' HADES_WORKER_FS_ROOT='${join(r.T, "worker-fs")}' HADES_WORKER_GC_MIN_FREE_GB=quebrado SSH_ORIGINAL_COMMAND="$2"\nexec '${BUN}' '${join(SKILL, "src/cli.ts")}' worker exec\n`);
      chmodSync(script, 0o755);
      const env: Env = { HADES_GATE_MEMCAP: "0", HADES_GATE_RESERVE_GB: "0", HADES_GATE_PSI_MAX: "100", HADES_GATE_SSH: script };
      const run = r.hades(["gate-lock", "run", "test", "--label", "gc-rc", "--where", "sim-host", "--timeout", "60", "--", "sh", "-c", "exit 3"], { cwd: repo, env });
      expect(run.rc).toBe(3);
      expect(run.err).toContain("gc após o job falhou");
    } finally {
      r.cleanup();
    }
  }, 60_000);
});
