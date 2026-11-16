// Gate remoto: partes puras (despacho, chave de aquecimento, protocolo, tradução de rc) e o envio por índice temporário.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, shouldProbe, type Candidate, type DispatchInput, type WorkerStatus } from "../../../src/lib/gate-remote/dispatch.ts";
import { checkOut, parseWhere, planOf } from "../../../src/lib/gate-remote/plan.ts";
import {
  PROTOCOL_VERSION, ProtocolError, RC_NOT_RUN, REASON_LOST, REASON_OUT, TrailerFilter, encodePayload, formatTrailer, mirrorPath,
  parseWorkerCommand, parseWorkers, translateRc,
} from "../../../src/lib/gate-remote/protocol.ts";
import { snapshotCommit } from "../../../src/lib/gate-remote/ship.ts";
import { affinityOf, warmKey } from "../../../src/lib/gate-remote/warm.ts";

const HOME = "/home/worker";
const NONCE = "0123456789abcdef0123456789abcdef";
const SHA = "a".repeat(40);

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "gate-remoto-test-"));
  tmpDirs.push(dir);
  return dir;
}

function status(over: Partial<WorkerStatus> = {}): WorkerStatus {
  return { host: "w1", labels: [], memFreeGb: 16, memTotalGb: 32, cpus: 8, queue: 0, warm: {}, ...over };
}
function candidate(host: string, st: WorkerStatus | undefined, labels: string[] = []): Candidate {
  return { spec: { host, labels }, status: st };
}
function input(over: Partial<DispatchInput> = {}): DispatchInput {
  return {
    where: { mode: "auto" }, waitedS: 300, autoAfterS: 120, kind: "test", affinity: { labels: [], minMemGb: 0 },
    warmKey: "node-nx-abc", workers: [candidate("w1", status({ warm: { "node-nx-abc": "ready" } }))], ...over,
  };
}

describe("despacho", () => {
  test("dado where local, quando decide, então roda local sem aquecer", () => {
    expect(decide(input({ where: { mode: "local" } }))).toEqual({ target: "local", warm: [] });
  });

  test("dado where host, quando decide, então vai ao host mesmo antes do transbordo", () => {
    expect(decide(input({ where: { mode: "host", host: "w9" }, waitedS: 0 }))).toEqual({ target: "remote", host: "w9", warm: [] });
  });

  test("dado auto antes do transbordo, quando decide, então fica local", () => {
    expect(decide(input({ waitedS: 119 })).target).toBe("local");
  });

  test("dado auto no limite do transbordo, quando decide, então vai ao worker pronto", () => {
    expect(decide(input({ waitedS: 120 }))).toEqual({ target: "remote", host: "w1", warm: [] });
  });

  test("dado concessão gate em auto, quando decide, então nunca sai da máquina", () => {
    expect(decide(input({ kind: "gate" })).target).toBe("local");
  });

  test("dado worker frio, quando decide, então roda local e pede aquecimento", () => {
    const frio = candidate("w1", status({ warm: {} }));
    expect(decide(input({ workers: [frio] }))).toEqual({ target: "local", warm: ["w1"] });
  });

  test("dado worker aquecendo ou falho, quando decide, então roda local e não reinicia o aquecimento", () => {
    const warming = candidate("w1", status({ warm: { "node-nx-abc": "warming" } }));
    const failed = candidate("w2", status({ warm: { "node-nx-abc": "failed" } }));
    expect(decide(input({ workers: [warming, failed] }))).toEqual({ target: "local", warm: [] });
  });

  test("dado worker inalcançável, quando decide, então é ignorado", () => {
    expect(decide(input({ workers: [candidate("w1", undefined)] }))).toEqual({ target: "local", warm: [] });
  });

  test("dado etapa que exige docker, quando só um worker o declara, então vai a ele", () => {
    const ready = { "node-nx-abc": "ready" as const };
    const semDocker = candidate("w1", status({ warm: ready }));
    const comDocker = candidate("w2", status({ warm: ready }), ["docker"]);
    const d = decide(input({ affinity: { labels: ["docker"], minMemGb: 0 }, workers: [semDocker, comDocker] }));
    expect(d.host).toBe("w2");
  });

  test("dado memória mínima acima da livre, quando decide, então o worker não é elegível", () => {
    const ready = { "node-nx-abc": "ready" as const };
    const d = decide(input({ affinity: { labels: [], minMemGb: 17 }, workers: [candidate("w1", status({ warm: ready, memFreeGb: 16 }))] }));
    expect(d.target).toBe("local");
  });

  test("dado dois prontos, quando decide, então escolhe a menor fila, depois mais memória, depois o host", () => {
    const ready = { "node-nx-abc": "ready" as const };
    const cheio = candidate("a", status({ warm: ready, queue: 2 }));
    const folgado = candidate("c", status({ warm: ready, queue: 0, memFreeGb: 20 }));
    const apertado = candidate("b", status({ warm: ready, queue: 0, memFreeGb: 10 }));
    expect(decide(input({ workers: [cheio, apertado, folgado] })).host).toBe("c");
    const gemeoB = candidate("b", status({ warm: ready, memFreeGb: 10 }));
    const gemeoA = candidate("a", status({ warm: ready, memFreeGb: 10 }));
    expect(decide(input({ workers: [gemeoB, gemeoA] })).host).toBe("a");
  });

  test("dado stack sem aquecimento, quando decide, então o worker conta como pronto", () => {
    expect(decide(input({ warmKey: undefined, workers: [candidate("w1", status())] })).host).toBe("w1");
  });

  test("dado lista vazia de workers, quando decide, então roda local", () => {
    expect(decide(input({ workers: [] }))).toEqual({ target: "local", warm: [] });
  });

  test("shouldProbe: só depois do transbordo e a cada everyS", () => {
    expect(shouldProbe(119, 120, 15)).toBe(false);
    expect(shouldProbe(120, 120, 15)).toBe(true);
    expect(shouldProbe(125, 120, 15)).toBe(false);
    expect(shouldProbe(135, 120, 15)).toBe(true);
  });
});

describe("--where", () => {
  test("parseWhere: vazio e local são local", () => {
    expect(parseWhere("", true)).toEqual({ mode: "local" });
    expect(parseWhere("local", true)).toEqual({ mode: "local" });
  });

  test("parseWhere: auto só pela chave", () => {
    expect(parseWhere("auto", false)).toEqual({ mode: "auto" });
    expect(() => parseWhere("auto", true)).toThrow(ProtocolError);
  });

  test("parseWhere: host válido passa e opção disfarçada de host é recusada", () => {
    expect(parseWhere("dev@box.lan", true)).toEqual({ mode: "host", host: "dev@box.lan" });
    expect(() => parseWhere("-oProxyCommand=x", true)).toThrow(ProtocolError);
    expect(() => parseWhere("a b", true)).toThrow(ProtocolError);
  });

  test("parseWorkers: host com rótulos, lista vazia e entrada malformada", () => {
    expect(parseWorkers("w1:docker+big, w2")).toEqual([{ host: "w1", labels: ["docker", "big"] }, { host: "w2", labels: [] }]);
    expect(parseWorkers("")).toEqual([]);
    expect(() => parseWorkers("w1:Docker")).toThrow(ProtocolError);
    expect(() => parseWorkers("-x")).toThrow(ProtocolError);
  });

  test("checkOut: relativo vira absoluto e fora de $HOME é recusado", () => {
    expect(checkOut(["out/junit.xml"], HOME, `${HOME}/repo`)).toEqual([`${HOME}/repo/out/junit.xml`]);
    expect(() => checkOut(["/etc/passwd"], HOME, `${HOME}/repo`)).toThrow(ProtocolError);
    expect(() => checkOut(["../../x"], HOME, `${HOME}/repo`)).toThrow(ProtocolError);
  });
});

describe("chave de aquecimento", () => {
  const files = (lock: string | undefined, nvm = "20") => new Map<string, string | undefined>([["package-lock.json", lock], [".nvmrc", nvm]]);

  test("dado o mesmo conteúdo, quando calcula, então a chave é igual e independe da ordem", () => {
    const a = warmKey({ stack: "node-nx", scope: "/r", files: files("L1") });
    const reordenado = new Map([...files("L1")].reverse());
    expect(warmKey({ stack: "node-nx", scope: "/r", files: reordenado })).toBe(a);
  });

  test("dado lockfile, toolchain, escopo ou stack diferentes, quando calcula, então a chave muda", () => {
    const base = warmKey({ stack: "node-nx", scope: "/r", files: files("L1") });
    expect(warmKey({ stack: "node-nx", scope: "/r", files: files("L2") })).not.toBe(base);
    expect(warmKey({ stack: "node-nx", scope: "/r", files: files("L1", "22") })).not.toBe(base);
    expect(warmKey({ stack: "node-nx", scope: "/outro", files: files("L1") })).not.toBe(base);
    expect(warmKey({ stack: "rust-cargo", scope: "/r", files: files("L1") })).not.toBe(base);
  });

  test("dado arquivo ausente, quando calcula, então difere de arquivo vazio", () => {
    expect(warmKey({ stack: "s", scope: "/r", files: files(undefined) })).not.toBe(warmKey({ stack: "s", scope: "/r", files: files("") }));
  });

  test("planOf: etapa sem ':' não tem plano e stack sem remote não tem chave", () => {
    expect(planOf("lint", "/r", new Map())).toEqual({ stack: "", warmKey: undefined, affinity: { labels: [], minMemGb: 0 }, passEnv: [] });
    const semRemote = new Map([["go", { steps: { test: { remote: { labels: ["docker"], minMemGb: 4 } } } }]]);
    expect(planOf("go:test", "/r", semRemote)).toEqual({ stack: "", warmKey: undefined, affinity: { labels: ["docker"], minMemGb: 4 }, passEnv: [] });
  });

  test("affinityOf: valor inválido não vira exigência", () => {
    expect(affinityOf({ steps: { test: { remote: { labels: ["docker", 3], minMemGb: -2 } } } }, "test")).toEqual({ labels: ["docker"], minMemGb: 0 });
    expect(affinityOf(undefined, "test")).toEqual({ labels: [], minMemGb: 0 });
  });
});

describe("protocolo na fronteira do worker", () => {
  const job = (over: Record<string, unknown> = {}) => ({
    v: PROTOCOL_VERSION, nonce: NONCE, id: "job-12345678", repo: "acme__api", sha: SHA, cwd: `${HOME}/repo`, subdir: "", kind: "lint",
    label: "agente", cost: 0, timeout: 60, priority: 0, step: "", stack: "", argv: ["true"], out: [], warmInline: false, ...over,
  });
  const exec = (over?: Record<string, unknown>) => `exec ${encodePayload(job(over))}`;

  test("dado job válido, quando parseia, então devolve o job com o argv intacto", () => {
    const req = parseWorkerCommand(exec({ argv: ["sh", "-c", "echo $(x) 'a b'"] }), HOME);
    expect(req.kind === "exec" && req.job.argv).toEqual(["sh", "-c", "echo $(x) 'a b'"]);
  });

  test("dado subcomando fora da lista ou texto livre, quando parseia, então é recusado", () => {
    for (const bad of ["", "ls", "rm -rf /", "exec", "status --x", "status --json x", "exec a b", "bash -c id", "status\nid"]) {
      expect(() => parseWorkerCommand(bad, HOME)).toThrow(ProtocolError);
    }
    expect(parseWorkerCommand("status --json", HOME)).toEqual({ kind: "status" });
  });

  test("dado cwd fora de $HOME ou com .., quando parseia, então é recusado", () => {
    for (const cwd of ["/etc", `${HOME}/../etc`, HOME, `${HOME}/repo/`, "relativo"]) {
      expect(() => parseWorkerCommand(exec({ cwd }), HOME)).toThrow(ProtocolError);
    }
  });

  test("dado campo inválido, quando parseia, então é recusado pelo campo certo", () => {
    expect(() => parseWorkerCommand(exec({ v: 2 }), HOME)).toThrow(/protocolo/);
    expect(() => parseWorkerCommand(exec({ kind: "rm" }), HOME)).toThrow(/kind/);
    expect(() => parseWorkerCommand(exec({ subdir: "../x" }), HOME)).toThrow(/subdir/);
    expect(() => parseWorkerCommand(exec({ argv: [] }), HOME)).toThrow(/argv/);
    expect(() => parseWorkerCommand(exec({ argv: ["a\0b"] }), HOME)).toThrow(/argv/);
    expect(() => parseWorkerCommand(exec({ sha: "HEAD" }), HOME)).toThrow(/sha/);
    expect(() => parseWorkerCommand(exec({ out: ["/etc/passwd"] }), HOME)).toThrow(/out/);
    expect(() => parseWorkerCommand(exec({ timeout: -1 }), HOME)).toThrow(/timeout/);
  });

  test("dado payload que não é base64url nem JSON, quando parseia, então é recusado", () => {
    expect(() => parseWorkerCommand("exec $(id)", HOME)).toThrow(ProtocolError);
    expect(() => parseWorkerCommand(`exec ${Buffer.from("{nao").toString("base64url")}`, HOME)).toThrow(/JSON/);
  });

  test("receive-pack: só o espelho do worker, um nível, terminado em .git", () => {
    const ok = mirrorPath(HOME, "acme__api");
    expect(parseWorkerCommand(`git-receive-pack '${ok}'`, HOME)).toEqual({ kind: "receive-pack", path: ok });
    for (const bad of ["/etc/x.git", `${HOME}/outro.git`, `${ok}/../../x.git`, `${HOME}/.cache/hades-worker/mirror/a/b.git`, `${HOME}/.cache/hades-worker/mirror/a`]) {
      expect(() => parseWorkerCommand(`git-receive-pack '${bad}'`, HOME)).toThrow(ProtocolError);
    }
  });
});

describe("trailer e rc", () => {
  const trailer = (nonce = NONCE, rc = 0) => formatTrailer(nonce, { rc, peakMb: 512, host: "w1", durS: 7 });

  test("dado trailer do próprio nonce, quando filtra, então some da saída e é lido", () => {
    const f = new TrailerFilter(NONCE);
    expect(f.push(`antes\n${trailer(NONCE, 3)}`)).toBe("antes\n");
    expect(f.trailer).toEqual({ rc: 3, peakMb: 512, durS: 7, host: "w1" });
  });

  test("dado trailer de outro nonce (job forjando), quando filtra, então passa ao terminal e não vale", () => {
    const f = new TrailerFilter(NONCE);
    const forjado = trailer("f".repeat(32));
    expect(f.push(forjado)).toBe(forjado);
    expect(f.trailer).toBeUndefined();
  });

  test("dado trailer cortado entre pedaços, quando filtra, então segura o trecho aberto e fecha no pedaço seguinte", () => {
    const f = new TrailerFilter(NONCE);
    const t = trailer();
    expect(f.push(`x${t.slice(0, 10)}`)).toBe("x");
    expect(f.push(`${t.slice(10)}y`)).toBe("y");
    expect(f.trailer?.rc).toBe(0);
  });

  test("dado trecho aberto sem fim, quando o fluxo acaba, então flush devolve o resto e não há trailer", () => {
    const f = new TrailerFilter(NONCE);
    f.push("\u0001hades-worker-end sem-fim");
    expect(f.flush()).toBe("\u0001hades-worker-end sem-fim");
    expect(f.trailer).toBeUndefined();
  });

  test("translateRc: rc do trailer passa igual, inclusive 137 e 143", () => {
    for (const rc of [0, 1, 2, 137, 143]) {
      expect(translateRc({ rc, peakMb: 10, host: "w1", durS: 1 }, false)).toEqual({ rc, reason: undefined, peakMb: 10, host: "w1" });
    }
  });

  test("translateRc: sem trailer é 75 remoto perdido, nunca 0", () => {
    expect(translateRc(undefined, false)).toEqual({ rc: RC_NOT_RUN, reason: REASON_LOST, peakMb: undefined, host: undefined });
  });

  test("translateRc: rc 0 com --out que falhou vira 75, e rc de falha com --out falho segue o rc", () => {
    expect(translateRc({ rc: 0, peakMb: undefined, host: "w1", durS: 1 }, true)).toMatchObject({ rc: RC_NOT_RUN, reason: REASON_OUT });
    expect(translateRc({ rc: 2, peakMb: undefined, host: "w1", durS: 1 }, true).rc).toBe(2);
  });
});

describe("envio por índice temporário", () => {
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };
  function repoComEstado(): string {
    const root = tmp();
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "t@t");
    git(root, "config", "user.name", "t");
    git(root, "config", "commit.gpgsign", "false");
    writeFileSync(join(root, ".gitignore"), "ignorado.log\n");
    writeFileSync(join(root, "a.txt"), "v1\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base");
    writeFileSync(join(root, "stash.txt"), "para o stash\n");
    git(root, "add", "stash.txt");
    git(root, "stash", "push", "-q", "-m", "do-dono");
    writeFileSync(join(root, "a.txt"), "v2 nao commitado\n");
    writeFileSync(join(root, "novo.txt"), "arquivo novo\n");
    writeFileSync(join(root, "ignorado.log"), "segredo local\n");
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "b.txt"), "preparado\n");
    git(root, "add", "sub/b.txt");
    return root;
  }

  test("dado worktree sujo, quando tira o snapshot, então o commit leva modificado e novo, sem ignorados", () => {
    const root = repoComEstado();
    const sha = snapshotCommit(root, "job-12345678");
    expect(git(root, "show", `${sha}:a.txt`)).toBe("v2 nao commitado\n");
    expect(git(root, "show", `${sha}:novo.txt`)).toBe("arquivo novo\n");
    expect(git(root, "ls-tree", "-r", "--name-only", sha)).not.toContain("ignorado.log");
  });

  test("dado stash e índice do dono, quando tira o snapshot, então ficam intactos", () => {
    const root = repoComEstado();
    const antes = { stash: git(root, "stash", "list"), index: git(root, "diff", "--cached", "--name-status"), head: git(root, "rev-parse", "HEAD"), status: git(root, "status", "--porcelain") };
    const sha = snapshotCommit(root, "job-12345678");
    expect(git(root, "stash", "list")).toBe(antes.stash);
    expect(git(root, "diff", "--cached", "--name-status")).toBe(antes.index);
    expect(git(root, "rev-parse", "HEAD")).toBe(antes.head);
    expect(git(root, "status", "--porcelain")).toBe(antes.status);
    expect(git(root, "rev-parse", `${sha}^`).trim()).toBe(antes.head.trim());
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("v2 nao commitado\n");
  });
});
