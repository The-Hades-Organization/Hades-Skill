// Worker sem disco: status com disco, recusa antes do envio, causa do push, fila sem ticket morto e `ready` conferido.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveQueueLength, diskOf } from "../../../src/commands/worker.ts";
import { workerDiskItems } from "../../../src/commands/doctor.ts";
import { decide, diskShortage, type Candidate, type DispatchInput, type WorkerStatus } from "../../../src/lib/gate-remote/dispatch.ts";
import { REASON_DISK_FULL, pushFailure } from "../../../src/lib/gate-remote/ship.ts";
import { affinityOf, environmentPresent, minDiskGbOf, remoteSpecOf, warmStates, writeWarm } from "../../../src/lib/gate-remote/warm.ts";
import { parseWorkerStatus, createWorkerWatch } from "../../../src/panel/gatewatch-proc.ts";
import { BUN, Rig, SKILL, type Env, type Run } from "./lib/rig";

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "gate-disco-test-"));
  tmpDirs.push(dir);
  return dir;
}

function status(over: Partial<WorkerStatus> = {}): WorkerStatus {
  return { host: "w1", labels: [], memFreeGb: 16, memTotalGb: 32, cpus: 8, queue: 0, warm: {}, ...over };
}
const candidate = (host: string, st: WorkerStatus): Candidate => ({ spec: { host, labels: [] }, status: st });
function input(workers: Candidate[], minDiskGb?: number): DispatchInput {
  return { where: { mode: "auto" }, waitedS: 300, autoAfterS: 120, kind: "test", affinity: { labels: [], minMemGb: 0, requires: [], minDiskGb }, warmKey: undefined, workers };
}

describe("disco do worker: política pura", () => {
  test("abaixo do mínimo: motivo com livre e mínimo; acima, sem motivo", () => {
    expect(diskShortage(status({ diskFreeGb: 3.5 }), 8)).toBe("worker sem disco: 3.5 GB < 8 GB");
    expect(diskShortage(status({ diskFreeGb: 8 }), 8)).toBeUndefined();
  });

  test("worker antigo, sem os campos de disco, não é recusado; mínimo 0 ou ausente desliga a regra", () => {
    expect(diskShortage(status(), 8)).toBeUndefined();
    expect(diskShortage(status({ diskFreeGb: 0 }), 0)).toBeUndefined();
    expect(diskShortage(status({ diskFreeGb: 0 }), undefined)).toBeUndefined();
  });

  test("eligible do auto: worker sem disco sai da disputa e o item segue local", () => {
    const cheio = candidate("cheio", status({ host: "cheio", diskFreeGb: 1 }));
    const folgado = candidate("folgado", status({ host: "folgado", diskFreeGb: 50, queue: 3 }));
    expect(decide(input([cheio, folgado], 8))).toEqual({ target: "remote", host: "folgado", warm: [] });
    expect(decide(input([cheio], 8))).toEqual({ target: "local", warm: [] });
    expect(decide(input([cheio]))).toEqual({ target: "remote", host: "cheio", warm: [] });
  });

  test("remote.minDiskGb entra na afinidade da etapa; o node-nx do kit declara um mínimo", () => {
    const stack = { steps: {}, remote: { minDiskGb: 8 } };
    expect(affinityOf(stack, "build").minDiskGb).toBe(8);
    expect(affinityOf({ steps: {} }, "build").minDiskGb).toBeUndefined();
    expect(minDiskGbOf([stack, { remote: { minDiskGb: 20 } }, {}])).toBe(20);
  });
});

describe("status com disco", () => {
  test("diskOf lê o sistema de arquivos do caminho (ou do ancestral que existe)", () => {
    const dir = tmp();
    const disk = diskOf(join(dir, "ainda", "nao", "existe"));
    expect(disk.diskTotalGb).toBeGreaterThan(0);
    expect(disk.diskFreeGb).toBeGreaterThanOrEqual(0);
    expect(disk.inodesFree).toBeGreaterThan(0);
  });

  test("o painel lê os campos aditivos e ignora o que não é número", () => {
    const base = { host: "w", labels: [], memFreeGb: 1, memTotalGb: 2, cpus: 1, queue: 0, warm: {} };
    expect(parseWorkerStatus(JSON.stringify({ ...base, diskFreeGb: 12.5, diskTotalGb: 100, inodesFree: 900 }))).toMatchObject({ diskFreeGb: 12.5, diskTotalGb: 100, inodesFree: 900 });
    const antigo = parseWorkerStatus(JSON.stringify(base));
    expect(antigo?.diskFreeGb).toBeUndefined();
    expect(parseWorkerStatus(JSON.stringify({ ...base, diskFreeGb: "x" }))?.diskFreeGb).toBeUndefined();
  });

  test("a visão do painel leva o mínimo das stacks para o cartão pintar o limite", async () => {
    const out = JSON.stringify({ host: "w", labels: [], memFreeGb: 1, memTotalGb: 2, cpus: 1, queue: 0, warm: {}, diskFreeGb: 2, diskTotalGb: 10 });
    const watch = createWorkerWatch({
      specs: () => [{ target: "w", labels: [] }], now: () => 1000, minDiskGb: () => 8,
      run: async () => ({ status: 0, stdout: out, stderr: "", timedOut: false }),
    });
    await watch.refresh();
    expect(watch.view()[0]).toMatchObject({ reachable: true, minDiskGb: 8, status: { diskFreeGb: 2 } });
  });
});

describe("doctor: disco dos workers", () => {
  const fake = (map: Record<string, WorkerStatus | undefined>) => (target: string): WorkerStatus | undefined => map[target];

  test("worker abaixo do limite vira aviso com o motivo; o outro não", () => {
    const items = workerDiskItems(["a", "b"], 8, fake({ a: status({ diskFreeGb: 1 }), b: status({ diskFreeGb: 40 }) }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ level: "warn", id: "workers-disco" });
    expect(items[0]?.msg).toBe("a: worker sem disco: 1 GB < 8 GB");
  });

  test("todos acima do limite: uma linha ok; sem resposta ou worker antigo: nenhuma linha", () => {
    expect(workerDiskItems(["a"], 8, fake({ a: status({ diskFreeGb: 40 }) }))[0]?.level).toBe("ok");
    expect(workerDiskItems(["a", "b"], 8, fake({ a: undefined, b: status() }))).toEqual([]);
  });
});

describe("causa do push ao espelho", () => {
  const STDERR = [
    "erro: não foi possível criar o diretório de objetos temporário",
    "error: remote unpack failed: unable to start object transaction",
    " ! [remote rejected] HEAD -> refs/hades/jobs/abc (unpacker error)",
    "error: failed to push some refs to 'ssh://w/x/mirror/r.git'",
  ].join("\n");

  test("unpacker error vira worker sem disco e guarda as linhas de causa, não só a última", () => {
    const message = pushFailure("w", STDERR);
    expect(message.startsWith(`${REASON_DISK_FULL}: push ao espelho de w`)).toBe(true);
    expect(message).toContain("remote unpack failed");
    expect(message).toContain("[remote rejected]");
    expect(message).toContain("failed to push some refs");
  });

  test.each(["fatal: No space left on device", "remote: Out of diskspace", "erro: não foi possível criar o diretório de objetos temporário"])("marca de disco cheio: %s", (line) => {
    expect(pushFailure("w", line)).toContain(REASON_DISK_FULL);
  });

  test("falha que não é de disco não leva o motivo de disco e continua dizendo a causa", () => {
    const message = pushFailure("w", "remote: Permission denied\nerror: failed to push some refs");
    expect(message).not.toContain(REASON_DISK_FULL);
    expect(message).toContain("Permission denied");
  });

  test("stderr vazio: mensagem ainda sai", () => {
    expect(pushFailure("w", "")).toBe("push ao espelho de w: falhou");
  });
});

describe("fila do worker sem ticket morto", () => {
  test("só conta ticket de processo vivo", () => {
    const root = tmp();
    const dir = join(root, "locks", "gate-queue");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "1.t"), `pid=${process.pid}\npstart=\nstate=waiting\n`);
    writeFileSync(join(dir, "2.t"), "pid=2147483000\npstart=\nstate=waiting\n");
    writeFileSync(join(dir, "3.t"), "state=waiting\n");
    writeFileSync(join(dir, "leia-me.txt"), "pid=1\n");
    expect(liveQueueLength([root])).toBe(1);
  });

  test("raiz sem fila conta zero", () => {
    expect(liveQueueLength([tmp()])).toBe(0);
  });
});

describe("marcação ready conferida", () => {
  test("sem worktree, ou sem a prova da instalação, o ambiente não está presente", () => {
    const wt = tmp();
    const spec = { installed: ["node_modules/.package-lock.json", "node_modules/.bin"] };
    expect(environmentPresent(spec, join(wt, "sumiu"))).toBe(false);
    expect(environmentPresent(spec, wt)).toBe(false);
    mkdirSync(join(wt, "node_modules", ".bin"), { recursive: true });
    expect(environmentPresent(spec, wt)).toBe(true);
  });

  test("stack sem prova declarada: só o worktree é conferido", () => {
    expect(environmentPresent({ installed: [] }, tmp())).toBe(true);
    expect(environmentPresent(undefined, tmp())).toBe(true);
  });

  test("warmStates tira o registro que o filtro recusa", () => {
    const base = tmp();
    writeWarm(base, { key: "k-1", cwd: "/a", state: "ready", since: "x" });
    writeWarm(base, { key: "k-2", cwd: "/b", state: "ready", since: "x" });
    expect(warmStates(base, (record) => record.cwd === "/a")).toEqual({ "k-1": "ready" });
  });

  test("node-nx declara minDiskGb e as provas de instalação", () => {
    const spec = remoteSpecOf(JSON.parse(spawnSync("cat", [join(SKILL, "stacks", "node-nx", "stack.json")], { encoding: "utf8" }).stdout));
    expect(spec?.minDiskGb).toBeGreaterThan(0);
    expect(spec?.installed).toContain("node_modules/.bin");
  });
});

// --- ponta a ponta: o "ssh" é o próprio `hades worker exec` com outro prefixo físico ---

const r = new Rig();
const HOST = "sim-host";
const GE: Env = { HADES_GATE_MEMCAP: "0", HADES_GATE_RESERVE_GB: "0", HADES_GATE_PSI_MAX: "100" };
const SLOW_MS = 60_000;
let repo = "";
let env: Env = {};
let fsRoot = "";

const gate = (args: string[]): Run => r.hades(["gate-lock", "run", ...args], { cwd: repo, env });

function workerStatus(): Record<string, unknown> {
  const run = spawnSync(BUN, [join(SKILL, "src/cli.ts"), "worker", "exec"], {
    encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: r.H, HADES_WORK_ROOT: join(r.T, "work-worker"), HADES_WORKER_FS_ROOT: fsRoot, HADES_STACKS_ROOT: join(r.T, "stacks"), HADES_PACKS_ROOT: join(r.T, "packs"), SSH_ORIGINAL_COMMAND: "status --json" },
  });
  expect(run.status).toBe(0);
  return JSON.parse(run.stdout) as Record<string, unknown>;
}

beforeAll(() => {
  repo = join(r.H, "repo");
  r.mkrepo("acme/disco", repo);
  fsRoot = join(r.T, "worker-fs");
  mkdirSync(fsRoot, { recursive: true });
  const script = join(r.T, "ssh-local.sh");
  writeFileSync(script, `#!/bin/bash\nexport HOME='${r.H}' HADES_WORK_ROOT='${join(r.T, "work-worker")}' HADES_WORKER_FS_ROOT='${fsRoot}' SSH_ORIGINAL_COMMAND="$2"\nexec '${BUN}' '${join(SKILL, "src/cli.ts")}' worker exec\n`);
  chmodSync(script, 0o755);
  env = { ...GE, HADES_GATE_SSH: script };
  const stack = (name: string, remote: Record<string, unknown>): void => {
    mkdirSync(join(r.T, "stacks", name), { recursive: true });
    writeFileSync(join(r.T, "stacks", name, "stack.json"), JSON.stringify({ name, steps: { build: { cmd: "true", kind: "build", costGb: 1 } }, remote }));
  };
  // disco exigido que nenhuma máquina tem: a recusa é determinística
  stack("disco-impossivel", { key: ["README.md"], prepare: [], minDiskGb: 1_000_000_000 });
  stack("disco-ok", { key: ["README.md"], prepare: [], minDiskGb: 0.001 });
  stack("amb-node", { key: ["README.md"], prepare: ["mkdir -p node_modules && touch node_modules/.package-lock.json"], installed: ["node_modules/.package-lock.json", "node_modules/.bin"] });
});
afterAll(() => r.cleanup());

const ARGS = (stackName: string, label: string): string[] => ["build", "--label", label, "--step", `${stackName}:build`, "--where", HOST, "--timeout", "60", "--", "true"];

describe("status e recusa de ponta a ponta", () => {
  test("status --json por SSH_ORIGINAL_COMMAND traz disco e inodes do sistema de arquivos da raiz do worker", () => {
    const s = workerStatus();
    expect(typeof s.diskFreeGb).toBe("number");
    expect(s.diskTotalGb as number).toBeGreaterThan(0);
    expect(s.inodesFree as number).toBeGreaterThan(0);
    expect(s.queue).toBe(0);
  });

  test("disco abaixo do mínimo da stack: rc 75 com o motivo e o código nem chega ao espelho", () => {
    const run = gate(ARGS("disco-impossivel", "disco-recusa"));
    expect(run.rc).toBe(75);
    expect(run.err).toMatch(/worker sem disco: [\d.]+ GB < 1000000000 GB/);
    expect(existsSync(join(fsRoot, r.H, ".cache", "hades-worker"))).toBe(false);
  }, SLOW_MS);

  test("disco acima do mínimo: o gate roda", () => {
    expect(gate(ARGS("disco-ok", "disco-passa")).rc).toBe(0);
  }, SLOW_MS);

  test("ready com node_modules apagado: o status não o lista e o gate seguinte prepara de novo", () => {
    expect(gate(ARGS("amb-node", "amb-1")).rc).toBe(0);
    const ready = (): string[] => Object.entries(workerStatus().warm as Record<string, string>).filter(([k, v]) => k.startsWith("amb-node-") && v === "ready").map(([k]) => k);
    expect(ready()).toHaveLength(1);
    const worktree = join(fsRoot, repo);
    expect(existsSync(join(worktree, "node_modules", ".package-lock.json"))).toBe(true);
    rmSync(join(worktree, "node_modules"), { recursive: true, force: true });
    expect(ready()).toEqual([]);
    expect(gate(ARGS("amb-node", "amb-2")).rc).toBe(0);
    expect(existsSync(join(worktree, "node_modules", ".package-lock.json"))).toBe(true);
    expect(ready()).toHaveLength(1);
  }, SLOW_MS);
});
