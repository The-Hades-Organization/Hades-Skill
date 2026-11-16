// Toolchain do worker (#126): montagem do PATH com nvm falso, contrato aditivo do status, recusa antes do envio e
// o encaixe de ponta a ponta com o transporte local (ssh não interativo = PATH reduzido, sem nvm).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decide, type Candidate, type DispatchInput, type WorkerStatus } from "../../../src/lib/gate-remote/dispatch.ts";
import { matchVersion, missingTools, pathWithToolchain, probeTools, toolchainDirs, type ToolchainFs } from "../../../src/lib/gate-remote/toolchain.ts";
import { affinityOf, remoteSpecOf } from "../../../src/lib/gate-remote/warm.ts";
import { parseWorkerStatus } from "../../../src/panel/gatewatch-proc.ts";
import { BUN, Rig, SKILL, type Env, type Run } from "./lib/rig";

const HOME = "/home/u";

/** Árvore falsa: caminhos → conteúdo (arquivo) ou null (diretório). */
function fakeFs(tree: Record<string, string | null>): ToolchainFs {
  return {
    exists: (p) => p in tree || Object.keys(tree).some((k) => k.startsWith(`${p}/`)),
    list: (dir) => [...new Set(Object.keys(tree).filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1).split("/")[0] as string))],
    read: (p) => (typeof tree[p] === "string" ? tree[p] : undefined),
  };
}

const NVM = `${HOME}/.nvm/versions/node`;
const nvmTree = {
  [`${NVM}/v20.11.0/bin/node`]: "", [`${NVM}/v22.12.0/bin/node`]: "", [`${NVM}/v22.22.1/bin/node`]: "", [`${NVM}/v24.1.0/bin/node`]: "",
};

describe("montagem do PATH do worker", () => {
  test("matchVersion: prefixo escolhe a maior que casa; formato estranho não casa", () => {
    const installed = ["v20.11.0", "v22.12.0", "v22.22.1", "v24.1.0"];
    expect(matchVersion(installed, "22")).toBe("v22.22.1");
    expect(matchVersion(installed, "v22.12")).toBe("v22.12.0");
    expect(matchVersion(installed, "22.22.1")).toBe("v22.22.1");
    expect(matchVersion(installed, "2")).toBeUndefined();
    expect(matchVersion(installed, "lts/*")).toBeUndefined();
  });

  test("nvm com .nvmrc do repo: usa a versão pedida", () => {
    const fs = fakeFs({ ...nvmTree, "/r/.nvmrc": "22.12\n", [`${HOME}/.nvm/alias/default`]: "20" });
    expect(toolchainDirs({ home: HOME, env: {}, repoDir: "/r", fs })).toEqual([`${NVM}/v22.12.0/bin`]);
  });

  test("nvm sem .nvmrc: alias default; sem alias, a maior instalada", () => {
    const comAlias = fakeFs({ ...nvmTree, [`${HOME}/.nvm/alias/default`]: "20" });
    expect(toolchainDirs({ home: HOME, env: {}, fs: comAlias })).toEqual([`${NVM}/v20.11.0/bin`]);
    expect(toolchainDirs({ home: HOME, env: {}, fs: fakeFs(nvmTree) })).toEqual([`${NVM}/v24.1.0/bin`]);
  });

  test(".nvmrc que nenhuma versão instalada atende cai no padrão (melhor um node do que nenhum)", () => {
    const fs = fakeFs({ ...nvmTree, "/r/.nvmrc": "18\n", [`${HOME}/.nvm/alias/default`]: "20" });
    expect(toolchainDirs({ home: HOME, env: {}, repoDir: "/r", fs })).toEqual([`${NVM}/v20.11.0/bin`]);
  });

  test("NVM_DIR vale mais que ~/.nvm; ~/.local/bin, ~/.bun/bin e ~/.cargo/bin entram só se existem", () => {
    const fs = fakeFs({ "/opt/nvm/versions/node/v22.1.0/bin/node": "", [`${HOME}/.bun/bin/bun`]: "", [`${HOME}/.local/bin/x`]: "" });
    expect(toolchainDirs({ home: HOME, env: { NVM_DIR: "/opt/nvm" }, fs })).toEqual(["/opt/nvm/versions/node/v22.1.0/bin", `${HOME}/.bun/bin`, `${HOME}/.local/bin`]);
  });

  test("fnm, volta, asdf e mise entram quando existem", () => {
    const fs = fakeFs({
      [`${HOME}/.local/share/fnm/node-versions/v22.5.0/installation/bin/node`]: "", [`${HOME}/.volta/bin/node`]: "",
      [`${HOME}/.asdf/shims/node`]: "", [`${HOME}/.local/share/mise/shims/node`]: "",
    });
    expect(toolchainDirs({ home: HOME, env: {}, fs })).toEqual([
      `${HOME}/.local/share/fnm/node-versions/v22.5.0/installation/bin`, `${HOME}/.volta/bin`, `${HOME}/.asdf/shims`, `${HOME}/.local/share/mise/shims`,
    ]);
  });

  test("HADES_WORKER_PATH_PREPEND vai na frente; só absoluto e existente", () => {
    const fs = fakeFs({ "/opt/node/bin/node": "", "/opt/outro/x": "" });
    expect(toolchainDirs({ home: HOME, env: { HADES_WORKER_PATH_PREPEND: "/opt/node/bin:relativo:/nao/existe:/opt/outro" }, fs })).toEqual(["/opt/node/bin", "/opt/outro"]);
  });

  test("pathWithToolchain põe a toolchain na frente e não repete entrada", () => {
    expect(pathWithToolchain("/usr/bin:/bin", ["/a", "/usr/bin"])).toBe("/a:/usr/bin:/bin");
    expect(pathWithToolchain("", ["/a"])).toBe("/a");
  });

  test("probeTools: achada traz a versão, ausente vira null, nome inválido é ignorado", () => {
    const report = probeTools(["sh", "ferramenta-que-nao-existe", "../x"], "/usr/bin:/bin");
    expect(report["ferramenta-que-nao-existe"]).toBeNull();
    expect(typeof report.sh).toBe("string");
    expect(Object.keys(report)).not.toContain("../x");
  });

  test("missingTools: só null conta; relatório ausente ou sem a chave = não sabe, não recusa", () => {
    expect(missingTools({ node: "v22", npm: null }, ["node", "npm"])).toEqual(["npm"]);
    expect(missingTools(undefined, ["node", "npm"])).toEqual([]);
    expect(missingTools({ node: "v22" }, ["node", "npm"])).toEqual([]);
  });
});

function status(over: Partial<WorkerStatus> = {}): WorkerStatus {
  return { host: "w", labels: [], memFreeGb: 10, memTotalGb: 16, cpus: 4, queue: 0, warm: { k: "ready" }, ...over };
}
const candidate = (host: string, s: WorkerStatus): Candidate => ({ spec: { host, labels: [] }, status: s });
const input = (over: Partial<DispatchInput>): DispatchInput => ({
  where: { mode: "auto" }, waitedS: 300, autoAfterS: 120, kind: "build", affinity: { labels: [], minMemGb: 0, requires: ["node", "npm"] }, warmKey: "k", workers: [], ...over,
});

describe("contrato do status e despacho", () => {
  test("stack declara remote.requires e a afinidade a carrega", () => {
    expect(remoteSpecOf({ remote: { requires: ["node", "npm", 3] } })?.requires).toEqual(["node", "npm"]);
    expect(affinityOf({ remote: { requires: ["node"] }, steps: { build: {} } }, "build").requires).toEqual(["node"]);
    expect(affinityOf(undefined, "build").requires).toEqual([]);
  });

  test("auto: worker sem npm não é elegível; o que tem, ou o antigo sem o campo, é", () => {
    const semNpm = candidate("sem-npm", status({ tools: { node: "v22.1.0", npm: null } }));
    const comTudo = candidate("com-tudo", status({ tools: { node: "v22.1.0", npm: "10.9.0" }, memFreeGb: 4 }));
    const antigo = candidate("antigo", status({ memFreeGb: 2 }));
    expect(decide(input({ workers: [semNpm] })).target).toBe("local");
    expect(decide(input({ workers: [semNpm, comTudo] })).host).toBe("com-tudo");
    expect(decide(input({ workers: [semNpm, antigo] })).host).toBe("antigo");
  });

  test("painel: parseWorkerStatus aceita status com e sem tools e descarta valor fora do contrato", () => {
    const base = { host: "w", labels: [], memFreeGb: 1, memTotalGb: 2, cpus: 1, queue: 0, warm: {} };
    expect(parseWorkerStatus(JSON.stringify(base))?.tools).toBeUndefined();
    expect(parseWorkerStatus(JSON.stringify({ ...base, tools: { node: "v22", npm: null, lixo: 3 } }))?.tools).toEqual({ node: "v22", npm: null });
    expect(parseWorkerStatus(JSON.stringify({ ...base, tools: [1] }))?.tools).toBeUndefined();
  });
});

// --- ponta a ponta: o "ssh" do worker sobe com PATH reduzido, como o não interativo de verdade ---

const r = new Rig();
const HOST = "sim-host";
const GE: Env = { HADES_GATE_MEMCAP: "0", HADES_GATE_RESERVE_GB: "0", HADES_GATE_PSI_MAX: "100" };
const SLOW_MS = 60_000;
const FAKE = "hades-fake-tool";
let repo = "";
let env: Env = {};

function gate(args: string[]): Run {
  return r.hades(["gate-lock", "run", ...args], { cwd: repo, env });
}

beforeAll(() => {
  repo = join(r.H, "repo");
  r.mkrepo("acme/tool", repo);
  mkdirSync(join(r.T, "worker-fs"), { recursive: true });
  const script = join(r.T, "ssh-pobre.sh");
  const worker = `HOME='${r.H}' HADES_WORK_ROOT='${join(r.T, "work-worker")}' HADES_WORKER_FS_ROOT='${join(r.T, "worker-fs")}' SSH_ORIGINAL_COMMAND="$2"`;
  // PATH do ssh não interativo: só o do sistema e o diretório do bun; nada de nvm
  writeFileSync(script, `#!/bin/bash\nexport ${worker}\nexport PATH='/usr/bin:/bin:${join(BUN, "..")}'\nexec '${BUN}' '${join(SKILL, "src/cli.ts")}' worker exec\n`);
  chmodSync(script, 0o755);
  env = { ...GE, HADES_GATE_SSH: script };
  mkdirSync(join(r.T, "stacks", "tool-teste"), { recursive: true });
  writeFileSync(join(r.T, "stacks", "tool-teste", "stack.json"), JSON.stringify({
    name: "tool-teste", steps: { build: { cmd: "true", kind: "build", costGb: 1 } },
    remote: { key: ["README.md"], requires: [FAKE], prepare: [] },
  }));
});
afterAll(() => r.cleanup());

const ARGS = (label: string): string[] => ["build", "--label", label, "--step", "tool-teste:build", "--where", HOST, "--timeout", "60", "--", "true"];

describe("recusa antes do envio e toolchain carregada no worker", () => {
  test("ferramenta fora do PATH do ssh: 75 com motivo claro e o código nem chega ao espelho", () => {
    const run = gate(ARGS("tool-ausente"));
    expect(run.rc).toBe(75);
    expect(run.err).toContain(`worker sem ferramenta no PATH do ssh não interativo: falta ${FAKE}`);
    expect(run.err).toContain("gate-remoto-worker.md §Toolchain");
    expect(existsSync(join(r.T, "worker-fs", r.H, ".cache", "hades-worker"))).toBe(false);
  }, SLOW_MS);

  test("com a ferramenta no nvm do usuário o worker a acha sozinho e o job roda", () => {
    const bin = join(r.H, ".nvm", "versions", "node", "v22.1.0", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, FAKE), "#!/bin/sh\necho fake 1.0\n");
    chmodSync(join(bin, FAKE), 0o755);
    const run = gate(ARGS("tool-nvm"));
    expect(run.rc).toBe(0);
    expect(existsSync(join(r.T, "worker-fs", r.H, ".cache", "hades-worker"))).toBe(true);
  }, SLOW_MS);
});
