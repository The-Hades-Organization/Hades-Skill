// Gate remoto de ponta a ponta com transporte local: HADES_GATE_SSH aponta para um script que roda `hades worker exec`
// como o ssh rodaria (comando em SSH_ORIGINAL_COMMAND), com outra fila e outro prefixo físico de arquivos. O "worker" é
// a mesma máquina; o protocolo, o envio por git e o retorno de rc e de arquivos são os de produção.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { BUN, Rig, SKILL, type Env, type Run } from "./lib/rig";

const r = new Rig();
const HOST = "sim-host";
const GE: Env = { HADES_GATE_MEMCAP: "0", HADES_GATE_RESERVE_GB: "0", HADES_GATE_PSI_MAX: "100" };
const SLOW_MS = 60_000;

let repo = "";
let env: Env = {};
let sshMorto = "";

/** `<script> <host> <comando>`: o ssh entrega o comando como um argumento só; quem o recebe o põe em SSH_ORIGINAL_COMMAND. */
function transport(name: string, body: string): string {
  const path = join(r.T, name);
  const worker = `HOME='${r.H}' HADES_WORK_ROOT='${join(r.T, "work-worker")}' HADES_WORKER_FS_ROOT='${join(r.T, "worker-fs")}' SSH_ORIGINAL_COMMAND="$2"`;
  writeFileSync(path, `#!/bin/bash\nexport ${worker}\n${body.replaceAll("@CLI@", `'${BUN}' '${join(SKILL, "src/cli.ts")}' worker exec`)}\n`);
  chmodSync(path, 0o755);
  return path;
}

beforeAll(() => {
  repo = join(r.H, "repo");
  r.mkrepo("acme/api", repo);
  mkdirSync(join(r.T, "worker-fs"), { recursive: true });
  const ok = transport("ssh-local.sh", "exec @CLI@");
  // conexão que cai no meio do job: derruba o processo do worker e todo o grupo dele depois de 3 s
  const morto = transport("ssh-morto.sh", 'if [[ "$2" == exec\\ * ]]; then set -m; @CLI@ & W=$!; (sleep 3; kill -9 -- -$W) 2>/dev/null & wait $W; exit 255; fi\nexec @CLI@');
  env = { ...GE, HADES_GATE_SSH: ok };
  sshMorto = morto;
});
afterAll(() => r.cleanup());

const gate = (args: string[], over: Env = {}): Run => r.hades(["gate-lock", "run", ...args], { cwd: repo, env: { ...env, ...over } });

function journalLines(label: string): string[] {
  const file = join(r.T, "work", "acme__api", "locks", "gate-journal.tsv");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l.includes("done") && l.includes(label)) : [];
}

describe("gate remoto com transporte local", () => {
  test("lint remoto: rc 0 e journal com host", () => {
    const run = gate(["lint", "--label", "e2e-lint", "--where", HOST, "--timeout", "60", "--", "true"]);
    expect(run.rc).toBe(0);
    const [done] = journalLines("e2e-lint");
    expect(done).toContain("rc=0");
    // o host do journal é a identidade que o worker reporta no trailer (aqui a mesma máquina), não o alias de --where
    expect(done).toContain(`host=${hostname()}`);
  }, SLOW_MS);

  test("teste que falha: rc, stdout e stderr iguais aos locais", () => {
    const cmd = ["--", "sh", "-c", "echo saida; echo erro >&2; exit 3"];
    const local = gate(["test", "--label", "e2e-falha-local", "--timeout", "60", ...cmd]);
    const remoto = gate(["test", "--label", "e2e-falha", "--where", HOST, "--timeout", "60", ...cmd]);
    expect(local.rc).toBe(3);
    expect(remoto.rc).toBe(local.rc);
    expect(remoto.out).toBe(local.out);
    expect(remoto.err).toContain("erro");
    expect(journalLines("e2e-falha")[0]).toContain("rc=3");
  }, SLOW_MS);

  test("mudança não commitada e arquivo novo chegam ao worker, sem tocar índice nem HEAD do dono", () => {
    writeFileSync(join(repo, "README.md"), "editado sem commit\n");
    writeFileSync(join(repo, "novo.txt"), "arquivo novo\n");
    const antes = r.git(repo, "status", "--porcelain").out + r.git(repo, "rev-parse", "HEAD").out + r.git(repo, "stash", "list").out;
    const run = gate(["lint", "--label", "e2e-sujo", "--where", HOST, "--timeout", "60", "--", "sh", "-c", "cat README.md novo.txt"]);
    expect(run.rc).toBe(0);
    expect(run.out).toBe("editado sem commit\narquivo novo\n");
    expect(r.git(repo, "status", "--porcelain").out + r.git(repo, "rev-parse", "HEAD").out + r.git(repo, "stash", "list").out).toBe(antes);
  }, SLOW_MS);

  test("--out traz o arquivo declarado de volta", () => {
    const alvo = join(repo, "saida", "junit.xml");
    const run = gate(["test", "--label", "e2e-out", "--where", HOST, "--timeout", "60", "--out", alvo, "--", "sh", "-c", "mkdir -p saida && echo '<ok/>' > saida/junit.xml"]);
    expect(run.rc).toBe(0);
    expect(readFileSync(alvo, "utf8")).toBe("<ok/>\n");
  }, SLOW_MS);

  test("--out que o job não produziu vira 75, nunca 0", () => {
    const alvo = join(repo, "saida", "ausente.xml");
    const run = gate(["test", "--label", "e2e-out-falta", "--where", HOST, "--timeout", "60", "--out", alvo, "--", "true"]);
    expect(run.rc).toBe(75);
    expect(journalLines("e2e-out-falta")[0]).toContain("rc=75");
  }, SLOW_MS);

  test("transporte morto no meio do job sai 75 com motivo remoto perdido", () => {
    const run = gate(["lint", "--label", "e2e-morto", "--where", HOST, "--timeout", "60", "--", "sleep", "8"], { HADES_GATE_SSH: sshMorto });
    expect(run.rc).toBe(75);
    expect(run.err).toContain("remoto perdido");
    const [done] = journalLines("e2e-morto");
    expect(done).toContain("rc=75");
    expect(done).toContain("reason=remoto perdido");
  }, SLOW_MS);

  test("--where com host que parece opção do ssh é recusado antes de qualquer envio", () => {
    const run = gate(["lint", "--label", "e2e-opcao", "--where", "-oProxyCommand=id", "--", "true"]);
    expect(run.rc).not.toBe(0);
    expect(journalLines("e2e-opcao")).toEqual([]);
  }, SLOW_MS);
});
