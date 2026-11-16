// Build remoto do front: retorno de diretório com manifesto e promoção, --fresh, --post-local, sha= no resultado,
// entradas de build declaradas e recusa por memória. Parte pura direto; o resto com o transporte local da fatia 1.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffTree, freshProblem, hashTree, parseManifest, ManifestError, type ManifestFile } from "../../../src/lib/gate-remote/manifest.ts";
import { ProtocolError, isSecretName, validateJob } from "../../../src/lib/gate-remote/protocol.ts";
import { badPassEnv, expandEnv, remoteSpecOf } from "../../../src/lib/gate-remote/warm.ts";
import { BUN, Rig, SKILL, type Env, type Run } from "./lib/rig";

const file = (path: string, sha: string, mtimeMs = 1000): ManifestFile => ({ path, sha256: sha.repeat(64).slice(0, 64), mtimeMs });

describe("manifesto", () => {
  test("dado árvore com subpasta, quando hashTree, então lista só arquivos com sha256 estável", () => {
    const dir = mkdtempSync(join(tmpdir(), "manifesto-"));
    try {
      mkdirSync(join(dir, "a"));
      writeFileSync(join(dir, "a", "x.js"), "x");
      writeFileSync(join(dir, "index.html"), "<html/>");
      const files = hashTree(dir);
      expect(files.map((f) => f.path)).toEqual(["a/x.js", "index.html"]);
      expect(files[0]?.sha256).toBe("2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("dado link simbólico na árvore, quando hashTree, então erro (só arquivo regular volta)", () => {
    const dir = mkdtempSync(join(tmpdir(), "manifesto-"));
    try {
      symlinkSync("/etc/passwd", join(dir, "link"));
      expect(() => hashTree(dir)).toThrow(ManifestError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("diffTree acusa arquivo faltando, checksum diferente e arquivo fora do manifesto", () => {
    const esperado = [file("a", "a"), file("b", "b")];
    expect(diffTree(esperado, esperado)).toEqual([]);
    expect(diffTree(esperado, [file("a", "a")])).toEqual(["faltou b"]);
    expect(diffTree(esperado, [file("a", "a"), file("b", "c")])).toEqual(["checksum diferente: b"]);
    expect(diffTree(esperado, [...esperado, file("c", "c")])).toEqual(["arquivo fora do manifesto: c"]);
  });

  test("freshProblem: mais novo que o início passa; velho e ausente falham", () => {
    const dir = { dir: "/d", files: [file("index.html", "a", 5000), file("velho.html", "b", 100)] };
    expect(freshProblem(dir, "index.html", 5000)).toBeUndefined();
    expect(freshProblem(dir, "velho.html", 5000)).toContain("mais velho");
    expect(freshProblem(dir, "nao.html", 5000)).toContain("não está");
  });

  test("parseManifest recusa formato errado, caminho com .. e checksum curto", () => {
    expect(() => parseManifest("nao json")).toThrow(ManifestError);
    expect(() => parseManifest(JSON.stringify({ v: 2, startedMs: 1, dirs: [] }))).toThrow(ManifestError);
    const mau = { v: 1, startedMs: 1, dirs: [{ dir: "/d", files: [{ path: "../x", sha256: "a".repeat(64), mtimeMs: 1 }] }] };
    expect(() => parseManifest(JSON.stringify(mau))).toThrow(ManifestError);
    const curto = { v: 1, startedMs: 1, dirs: [{ dir: "/d", files: [{ path: "x", sha256: "abc", mtimeMs: 1 }] }] };
    expect(() => parseManifest(JSON.stringify(curto))).toThrow(ManifestError);
  });
});

describe("entradas de build declaradas", () => {
  test("isSecretName casa token, senha, chave de api e credencial; nome público passa", () => {
    for (const name of ["API_TOKEN", "DB_PASSWORD", "MY_SECRET", "OPENAI_API_KEY", "SENHA_X", "AWS_CREDENTIALS", "PRIVATE_KEY"]) expect(isSecretName(name)).toBe(true);
    for (const name of ["PUBLIC_TUNNEL_URL", "NX_BUILD_ENV", "NODE_ENV"]) expect(isSecretName(name)).toBe(false);
  });

  test("badPassEnv devolve o primeiro nome inválido ou de segredo", () => {
    expect(badPassEnv(["PUBLIC_URL", "NODE_ENV"])).toBeUndefined();
    expect(badPassEnv(["PUBLIC_URL", "GH_TOKEN"])).toBe("GH_TOKEN");
    expect(badPassEnv(["minusculo"])).toBe("minusculo");
  });

  test("remoteSpecOf lê passEnv; env do worker continua separado", () => {
    const spec = remoteSpecOf({ remote: { key: ["a"], prepare: ["b"], env: { X: "{cache}" }, passEnv: ["PUBLIC_URL", 3] } });
    expect(spec?.passEnv).toEqual(["PUBLIC_URL"]);
    expect(spec?.env).toEqual({ X: "{cache}" });
  });

  test("expandEnv troca {key}: o cache do nx se separa por chave, repo e slot", () => {
    const env = expandEnv({ NX_CACHE_DIRECTORY: "{cache}/nx/{repo}/{key}/{slot}" }, { cache: "/c", repo: "r", slot: "2", key: "node-nx-abc" });
    expect(env.NX_CACHE_DIRECTORY).toBe("/c/nx/r/node-nx-abc/2");
  });

  const jobBase = (over: Record<string, unknown>): Record<string, unknown> => ({
    v: 1, nonce: "a".repeat(32), id: "job-12345678", repo: "o__r", sha: "b".repeat(40), cwd: "/h/repo", subdir: "", kind: "build", label: "x",
    cost: 1, timeout: 60, priority: 0, step: "", stack: "", argv: ["true"], out: [], warmInline: false, ...over,
  });

  test("validateJob recusa variável com nome de segredo em env e aceita a pública", () => {
    expect(() => validateJob(jobBase({ env: { GH_TOKEN: "x" } }), "/h")).toThrow(ProtocolError);
    expect(validateJob(jobBase({ env: { PUBLIC_URL: "https://x.example" } }), "/h").env).toEqual({ PUBLIC_URL: "https://x.example" });
    expect(validateJob(jobBase({}), "/h").env).toEqual({});
  });

  test("validateJob recusa --fresh com .. ou absoluto", () => {
    expect(() => validateJob(jobBase({ fresh: "../x" }), "/h")).toThrow(ProtocolError);
    expect(() => validateJob(jobBase({ fresh: "/etc/x" }), "/h")).toThrow(ProtocolError);
    expect(validateJob(jobBase({ fresh: "index.html" }), "/h").fresh).toBe("index.html");
  });
});

// --- e2e com transporte local ---

const r = new Rig();
const HOST = "sim-host";
const GE: Env = { HADES_GATE_MEMCAP: "0", HADES_GATE_RESERVE_GB: "0", HADES_GATE_PSI_MAX: "100" };
const SLOW_MS = 60_000;
const DIST = "dist/browser";

let repo = "";
let env: Env = {};
let sshAdulterado = "";
let sshMorto = "";
let sshLimpo = "";

function transport(name: string, body: string): string {
  const path = join(r.T, name);
  const worker = `HOME='${r.H}' HADES_WORK_ROOT='${join(r.T, "work-worker")}' HADES_WORKER_FS_ROOT='${join(r.T, "worker-fs")}' SSH_ORIGINAL_COMMAND="$2"`;
  writeFileSync(path, `#!/bin/bash\nexport ${worker}\n${body.replaceAll("@CLI@", `'${BUN}' '${join(SKILL, "src/cli.ts")}' worker exec`)}\n`);
  chmodSync(path, 0o755);
  return path;
}

const gate = (args: string[], over: Env = {}): Run => r.hades(["gate-lock", "run", ...args], { cwd: repo, env: { ...env, ...over } });
const dist = (): string => join(repo, DIST);
const BUILD = "mkdir -p dist/browser/assets && echo novo > dist/browser/index.html && echo js > dist/browser/assets/app.js";
const frontArgs = (label: string, cmd: string, extra: string[] = []): string[] => ["build", "--label", label, "--where", HOST, "--timeout", "60", "--out", DIST, "--fresh", "index.html", ...extra, "--", "sh", "-c", cmd];

function semeiaAnterior(): void {
  rmSync(dist(), { recursive: true, force: true });
  mkdirSync(dist(), { recursive: true });
  writeFileSync(join(dist(), "index.html"), "anterior\n");
}

const sobras = (): string[] => readdirSync(join(repo, "dist")).filter((n) => n.includes(".hades-"));

beforeAll(() => {
  repo = join(r.H, "repo");
  r.mkrepo("acme/front", repo);
  mkdirSync(join(r.T, "worker-fs"), { recursive: true });
  const ok = transport("ssh-local.sh", "exec @CLI@");
  // o tar do retorno passa por um adulterador: o manifesto saiu do worker certo e o conteúdo muda no caminho
  const adulterado = transport("ssh-adulterado.sh", 'if [[ "$2" == out\\ * ]]; then t=$(mktemp -d); @CLI@ | tar -x -C "$t"; f=$(find "$t" -name index.html | head -1); echo adulterado >> "$f"; tar -c -C "$t" .; rm -rf "$t"; exit 0; fi\nexec @CLI@');
  const morto = transport("ssh-morto.sh", 'if [[ "$2" == exec\\ * ]]; then set -m; @CLI@ & W=$!; (sleep 3; kill -9 -- -$W) 2>/dev/null & wait $W; exit 255; fi\nexec @CLI@');
  // o ssh de verdade não leva o ambiente do cliente: este transporte o limpa para provar o que atravessa pelo job
  sshLimpo = transport("ssh-limpo.sh", "unset PUBLIC_TUNNEL_URL OUTRA_VAR\nexec @CLI@");
  env = { ...GE, HADES_GATE_SSH: ok };
  sshAdulterado = adulterado;
  sshMorto = morto;
  mkdirSync(join(r.T, "stacks", "front-teste"), { recursive: true });
  writeFileSync(join(r.T, "stacks", "front-teste", "stack.json"), JSON.stringify({
    name: "front-teste", steps: {
      build: { cmd: "true", kind: "build", costGb: 1 },
      pesado: { cmd: "true", kind: "build", costGb: 1, remote: { minMemGb: 100000 } },
    },
    remote: { key: ["README.md"], prepare: [], passEnv: ["PUBLIC_TUNNEL_URL"] },
  }));
});
afterAll(() => r.cleanup());

describe("build remoto do front com transporte local", () => {
  test("diretório volta, passa no manifesto e no --fresh e é promovido no lugar do anterior", () => {
    semeiaAnterior();
    const run = gate(frontArgs("front-ok", BUILD));
    expect(run.rc).toBe(0);
    expect(readFileSync(join(dist(), "index.html"), "utf8")).toBe("novo\n");
    expect(readFileSync(join(dist(), "assets", "app.js"), "utf8")).toBe("js\n");
    expect(sobras()).toEqual([]);
  }, SLOW_MS);

  test("manifesto adulterado no caminho: 75 e o diretório anterior fica intocado", () => {
    semeiaAnterior();
    const run = gate(frontArgs("front-adulterado", BUILD), { HADES_GATE_SSH: sshAdulterado });
    expect(run.rc).toBe(75);
    expect(run.err).toContain("manifesto não bate");
    expect(readFileSync(join(dist(), "index.html"), "utf8")).toBe("anterior\n");
    expect(sobras()).toEqual([]);
  }, SLOW_MS);

  test("index.html que o build não regravou: 75 e o anterior fica", () => {
    semeiaAnterior();
    const velho = "mkdir -p dist/browser && echo velho > dist/browser/index.html && touch -d '2 days ago' dist/browser/index.html";
    const run = gate(frontArgs("front-velho", velho));
    expect(run.rc).toBe(75);
    expect(run.err).toContain("mais velho que o início do job");
    expect(readFileSync(join(dist(), "index.html"), "utf8")).toBe("anterior\n");
  }, SLOW_MS);

  test("transporte morto no meio do job: 75 e o anterior fica", () => {
    semeiaAnterior();
    const run = gate(frontArgs("front-morto", `${BUILD}; sleep 8`), { HADES_GATE_SSH: sshMorto });
    expect(run.rc).toBe(75);
    expect(readFileSync(join(dist(), "index.html"), "utf8")).toBe("anterior\n");
  }, SLOW_MS);

  test("oom lá (143): o rc volta igual e o diretório anterior fica", () => {
    semeiaAnterior();
    const run = gate(frontArgs("front-oom", `${BUILD}; exit 143`));
    expect(run.rc).toBe(143);
    expect(readFileSync(join(dist(), "index.html"), "utf8")).toBe("anterior\n");
    expect(sobras()).toEqual([]);
  }, SLOW_MS);

  test("--post-local roda depois da promoção e só no sucesso; o rc dele entra no resultado", () => {
    semeiaAnterior();
    const marca = join(r.T, "post-local.marca");
    rmSync(marca, { force: true });
    const falha = gate(frontArgs("front-post-falha", `${BUILD}; exit 3`, ["--post-local", `touch '${marca}'`]));
    expect(falha.rc).toBe(3);
    expect(existsSync(marca)).toBe(false);
    const ok = gate(frontArgs("front-post-ok", BUILD, ["--post-local", `cat '${join(dist(), "index.html")}' > '${marca}'`]));
    expect(ok.rc).toBe(0);
    // quando o post-local rodou o diretório novo já estava no lugar
    expect(readFileSync(marca, "utf8")).toBe("novo\n");
    const rcPost = gate(frontArgs("front-post-rc", BUILD, ["--post-local", "exit 7"]));
    expect(rcPost.rc).toBe(7);
  }, SLOW_MS);

  test("HADES_GATE_RESULT_FILE ganha sha= com o HEAD do envio", () => {
    semeiaAnterior();
    const resultado = join(r.T, "resultado.txt");
    const head = r.git(repo, "rev-parse", "HEAD").out.trim();
    const run = gate(frontArgs("front-sha", BUILD), { HADES_GATE_RESULT_FILE: resultado });
    expect(run.rc).toBe(0);
    expect(readFileSync(resultado, "utf8")).toContain(`sha=${head}`);
  }, SLOW_MS);

  test("--where <host> sem --step avisa no stderr que o job vai sem stack, e não recusa", () => {
    const run = gate(frontArgs("front-sem-step", "true"));
    expect(run.rc).toBe(0);
    expect(run.err).toContain("sem --step: o job vai sem stack");
  }, SLOW_MS);

  test("--where <host> com --step não avisa de stack", () => {
    const run = gate(["build", "--label", "front-com-step", "--step", "front-teste:build", "--where", HOST, "--timeout", "60", "--", "true"]);
    expect(run.rc).toBe(0);
    expect(run.err).not.toContain("sem --step");
  }, SLOW_MS);

  test("--fresh sem --out é recusado antes de qualquer envio", () => {
    const run = gate(["build", "--label", "front-fresh-solto", "--where", HOST, "--fresh", "index.html", "--", "true"]);
    expect(run.rc).not.toBe(0);
    expect(run.all).toContain("--fresh precisa de --out");
  }, SLOW_MS);

  test("--where <host> recusa quando o worker não tem a memória livre da etapa", () => {
    const run = gate(["build", "--label", "front-mem", "--step", "front-teste:pesado", "--where", HOST, "--timeout", "60", "--", "true"]);
    expect(run.rc).toBe(75);
    expect(run.err).toContain("memória livre do worker abaixo do mínimo");
  }, SLOW_MS);

  test("variável declarada em remote.passEnv atravessa; a não declarada fica de fora", () => {
    const cmd = 'echo "url=${PUBLIC_TUNNEL_URL:-vazio} outra=${OUTRA_VAR:-vazio}"';
    const run = gate(["build", "--label", "front-env", "--step", "front-teste:build", "--where", HOST, "--timeout", "60", "--", "sh", "-c", cmd], {
      PUBLIC_TUNNEL_URL: "https://tunel.example", OUTRA_VAR: "x", HADES_GATE_SSH: sshLimpo,
    });
    expect(run.rc).toBe(0);
    expect(run.out).toContain("url=https://tunel.example outra=vazio");
  }, SLOW_MS);
});
