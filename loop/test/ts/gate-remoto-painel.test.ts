// Painel da fila de gates remota: leitura dos tickets `remote:<host>` e do status dos workers (contrato da fatia 1).
import { afterEach, describe, expect, test } from "bun:test";
import { type Subprocess, spawn } from "bun";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKER_STATUS_COMMAND } from "../../../src/lib/gate-remote/transport.ts";
import { createGateWatch, remoteHostOf } from "../../../src/panel/gatewatch.ts";
import {
  type WorkerRunner, type WorkerStatus, WORKER_STATUS_ARGS, createWorkerWatch, parseWorkerStatus, parseWorkers, readWorker,
} from "../../../src/panel/gatewatch-proc.ts";

const GOOD: WorkerStatus = {
  host: "big", labels: ["docker"], memFreeGb: 20.5, memTotalGb: 32, cpus: 16, queue: 1, warm: { "web:abc": "ready", "api:def": "warming" },
};
const ok = (body: unknown): ReturnType<WorkerRunner> => Promise.resolve({ status: 0, stdout: JSON.stringify(body), stderr: "", timedOut: false });

describe("parseWorkers", () => {
  test("dado host com rótulos e host puro, então separa os rótulos", () => {
    expect(parseWorkers("big:docker,gpu small")).toEqual([{ target: "big", labels: ["docker", "gpu"] }, { target: "small", labels: [] }]);
  });
  test("dado vazio ou indefinido, então nenhum worker", () => {
    expect(parseWorkers("")).toEqual([]);
    expect(parseWorkers(undefined)).toEqual([]);
  });
  test("dado alvo que começaria como opção do ssh, então é descartado", () => {
    expect(parseWorkers("-oProxyCommand=x ok;a b")).toEqual([{ target: "ok", labels: [] }, { target: "a", labels: [] }, { target: "b", labels: [] }]);
  });
  test("dado alvo repetido ou rótulo inválido, então ignora a repetição e o rótulo", () => {
    expect(parseWorkers("u@h:ok,$(x) u@h")).toEqual([{ target: "u@h", labels: ["ok"] }]);
  });
});

describe("parseWorkerStatus", () => {
  test("dado o contrato completo, então devolve os campos", () => {
    expect(parseWorkerStatus(JSON.stringify(GOOD))).toEqual(GOOD);
  });
  test("dado campo numérico faltando, então undefined (sem inventar número)", () => {
    const { queue: _queue, ...sem } = GOOD;
    expect(parseWorkerStatus(JSON.stringify(sem))).toBeUndefined();
  });
  test("dado lixo, vazio ou array, então undefined", () => {
    expect(parseWorkerStatus("não é json")).toBeUndefined();
    expect(parseWorkerStatus("")).toBeUndefined();
    expect(parseWorkerStatus("[]")).toBeUndefined();
  });
  test("dado estado de aquecimento desconhecido, então a chave é ignorada", () => {
    const st = parseWorkerStatus(JSON.stringify({ ...GOOD, warm: { a: "ready", b: "talvez" } }));
    expect(st?.warm).toEqual({ a: "ready" });
  });
});

describe("readWorker", () => {
  test("dado um alvo, então o ssh recebe `--` antes dele e o comando do contrato depois", async () => {
    let seen: string[] = [];
    await readWorker("big", (argv) => { seen = argv; return ok(GOOD); });
    const dash = seen.indexOf("--");
    expect(seen[0]).toBe("ssh");
    expect(seen).toContain("BatchMode=yes");
    expect(seen.slice(dash + 1)).toEqual(["big", ...WORKER_STATUS_ARGS]);
  });
  test("dado o comando do painel, então é o mesmo que o motor manda ao worker", () => {
    expect(WORKER_STATUS_ARGS.join(" ")).toBe(WORKER_STATUS_COMMAND);
  });
  test("dado tempo esgotado, então erro de inacessível", async () => {
    const r = await readWorker("big", () => Promise.resolve({ status: 143, stdout: "", stderr: "", timedOut: true }));
    expect(r).toEqual({ error: expect.stringContaining("inacessível") });
  });
  test("dado ssh que falha, então o erro é a última linha do stderr", async () => {
    const r = await readWorker("big", () => Promise.resolve({ status: 255, stdout: "", stderr: "aviso\nConnection refused\n", timedOut: false }));
    expect(r).toEqual({ error: "Connection refused" });
  });
  test("dado saída fora do contrato, então erro de contrato", async () => {
    const r = await readWorker("big", () => Promise.resolve({ status: 0, stdout: "{}", stderr: "", timedOut: false }));
    expect(r).toEqual({ error: expect.stringContaining("fora do contrato") });
  });
});

describe("createWorkerWatch", () => {
  const specs = [{ target: "big", labels: ["docker"] }];

  test("dado worker ainda não consultado, então aparece inacessível sem status", () => {
    const w = createWorkerWatch({ specs: () => specs, now: () => 0, run: () => ok(GOOD) });
    expect(w.view()).toEqual([expect.objectContaining({ target: "big", reachable: false, status: null, labels: ["docker"] })]);
  });
  test("dado worker que responde, então o status entra e não está em cache", async () => {
    const w = createWorkerWatch({ specs: () => specs, now: () => 100, run: () => ok(GOOD) });
    await w.refresh();
    expect(w.view()[0]).toMatchObject({ reachable: true, stale: false, status: GOOD, okAt: 100, error: null });
  });
  test("dado worker que cai depois de responder, então mostra a última leitura em cache e o erro", async () => {
    let t = 100;
    let up = true;
    const w = createWorkerWatch({
      specs: () => specs, now: () => t,
      run: () => (up ? ok(GOOD) : Promise.resolve({ status: 255, stdout: "", stderr: "Connection refused", timedOut: false })),
    });
    await w.refresh();
    up = false;
    t = 200;
    await w.refresh();
    expect(w.view()[0]).toMatchObject({ reachable: false, stale: true, okAt: 100, checkedAt: 200, error: "Connection refused", status: GOOD });
  });
  test("dado nunca ter respondido, então inacessível sem cache", async () => {
    const w = createWorkerWatch({ specs: () => specs, now: () => 5, run: () => Promise.resolve({ status: 255, stdout: "", stderr: "x", timedOut: false }) });
    await w.refresh();
    expect(w.view()[0]).toMatchObject({ reachable: false, stale: false, okAt: null, status: null });
  });
  test("dado nova chamada dentro do ciclo, então não consulta de novo", async () => {
    let calls = 0;
    const w = createWorkerWatch({ specs: () => specs, now: () => 10, run: () => { calls += 1; return ok(GOOD); } });
    await w.refresh();
    await w.refresh();
    expect(calls).toBe(1);
  });
  test("dado worker lento, então view() responde na hora (a rede não trava a página)", () => {
    const w = createWorkerWatch({ specs: () => specs, now: () => 0, run: () => new Promise(() => {}) });
    void w.refresh();
    expect(w.view()[0]?.reachable).toBe(false);
  });
  test("dado um worker tirado da configuração, então some da visão", async () => {
    let list = [...specs, { target: "small", labels: [] }];
    const w = createWorkerWatch({ specs: () => list, now: () => 0, run: () => ok(GOOD) });
    await w.refresh();
    list = specs;
    expect(w.view().map((v) => v.target)).toEqual(["big"]);
  });
});

describe("remoteHostOf", () => {
  test("dado remote:<host>, então o host; dado outro estado ou host vazio, então undefined", () => {
    expect(remoteHostOf("remote:big")).toBe("big");
    expect(remoteHostOf("running")).toBeUndefined();
    expect(remoteHostOf("remote:")).toBeUndefined();
    expect(remoteHostOf(undefined)).toBeUndefined();
  });
});

describe("createGateWatch com tickets fabricados", () => {
  const procs: Subprocess[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const p of procs.splice(0)) p.kill();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** Um wrapper de gate de mentira (o amostrador reconhece pela linha de comando) e o ticket dele, no formato do gate-lock. */
  function fixture(tickets: { label: string; fields: string[] }[], journal: string[], workers = "") {
    const root = mkdtempSync(join(tmpdir(), "gate-remoto-painel-"));
    dirs.push(root);
    const locks = join(root, "work", "o__r", "locks");
    mkdirSync(join(locks, "gate-queue"), { recursive: true });
    tickets.forEach((t, i) => {
      const p = spawn(["bash", "-c", `sleep 60; true # gate-lock.sh run test --label ${t.label} -- true`], { stdout: "ignore", stderr: "ignore" });
      procs.push(p);
      const base = ["kind=test", `label=${t.label}`, "cost=2", "heavy=0", "clone=/tmp/clone", `pid=${p.pid}`, "since=2026-11-15T10:00:00"];
      writeFileSync(join(locks, "gate-queue", `${1000 + i}-${p.pid}.t`), `${[...base, ...t.fields].join("\n")}\n`);
    });
    writeFileSync(join(locks, "gate-journal.tsv"), journal.join("\n") + (journal.length ? "\n" : ""));
    const settings: Record<string, string> = { HADES_GATE_WORKERS: workers, HADES_GATE_WHERE: "auto" };
    const w = createGateWatch({
      dir: root, locks, gateLock: undefined, root: join(root, "work"), fallbackGates: () => [], setting: (k) => settings[k],
      workerRun: (argv) => (argv.includes("down") ? Promise.resolve({ status: 255, stdout: "", stderr: "Connection timed out", timedOut: false }) : ok(GOOD)),
    });
    return w;
  }

  test("dado um ticket local, um remoto e um em espera, então o remoto não soma memória nem conta como rodando", async () => {
    const w = fixture([
      { label: "loc", fields: ["state=running", "where=local"] },
      { label: "rem", fields: ["state=remote:big", "where=remote", "host=origem", "remote=big"] },
      { label: "esp", fields: ["state=waiting"] },
    ], []);
    await w.sample();
    const d = w.detail() as { gates: { label: string; state: string; where: string; host: string | null; rss: number }[]; history: { running: number; waiting: number; remote: number }[] };
    const by = Object.fromEntries(d.gates.map((g) => [g.label, g]));
    expect(by.loc?.state).toBe("running");
    expect(by.loc?.where).toBe("local");
    expect(by.rem).toMatchObject({ state: "remote:big", where: "remote", host: "big", rss: 0 });
    expect(by.esp?.state).toBe("waiting");
    const last = d.history.at(-1);
    expect(last).toMatchObject({ running: 1, remote: 1 });
  });

  test("dado ticket com host local e remote, então o destino vem de remote e nunca de host", async () => {
    const w = fixture([{ label: "so-remote", fields: ["where=remote", "host=origem", "remote=big"] }], []);
    await w.sample();
    const g = (w.detail() as { gates: { label: string; host: string | null }[] }).gates.find((x) => x.label === "so-remote");
    expect(g?.host).toBe("big");
  });

  test("dado workers configurados (um fora do ar), então detail traz os dois sem travar", async () => {
    const w = fixture([], [], "big:docker down");
    w.detail();
    await Bun.sleep(50);
    const r = (w.detail() as { remote: { where: string; workers: { target: string; reachable: boolean; error: string | null }[] } }).remote;
    expect(r.where).toBe("auto");
    expect(r.workers.map((x) => x.target)).toEqual(["big", "down"]);
    expect(r.workers.find((x) => x.target === "down")).toMatchObject({ reachable: false, error: "Connection timed out" });
    expect(r.workers.find((x) => x.target === "big")?.reachable).toBe(true);
  });

  test("dado o journal com host e remoto perdido, então as linhas chegam à página como estão", () => {
    const w = fixture([], [
      "2026-11-15T10:00:00\tdone\ttest\ta\t2\t/c\trc=0\tdur=30s\tcmd=nx test\thost=big\tpeak=900MB",
      "2026-11-15T10:05:00\tdone\ttest\tb\t2\t/c\trc=75\tdur=12s\tcmd=nx test\thost=big\tremoto perdido",
    ]);
    return w.sample().then(() => {
      const j = (w.detail() as { journal: string[][] }).journal;
      expect(j).toHaveLength(2);
      expect(j[0]).toContain("host=big");
      expect(j[1]).toContain("remoto perdido");
    });
  });

  test("dado nenhum worker configurado, então a lista de workers é vazia", async () => {
    const w = fixture([], []);
    await w.sample();
    expect((w.detail() as { remote: { workers: unknown[] } }).remote.workers).toEqual([]);
  });
});

describe("encaixe painel e worker", () => {
  test("dado o comando forçado `worker exec` com o que o painel manda, então o parse do painel devolve o contrato", async () => {
    const cli = join(import.meta.dir, "../../../src/cli.ts");
    const proc = spawn({
      cmd: ["bun", cli, "worker", "exec"], stdout: "pipe", stderr: "pipe",
      env: { ...process.env, SSH_ORIGINAL_COMMAND: WORKER_STATUS_ARGS.join(" ") },
    });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const status = parseWorkerStatus(out);
    expect(status).toBeDefined();
    expect(Array.isArray(status?.labels)).toBe(true);
    expect(typeof status?.host).toBe("string");
    expect(status?.cpus).toBeGreaterThan(0);
  });
});
