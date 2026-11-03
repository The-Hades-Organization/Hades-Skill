// hades caronte unpack: ida e volta pack → unpack entre duas raízes de trabalho, dois diretórios de planos e dois de worktrees,
// as recusas (nada é tocado), o dry-run e o desfazer depois de uma falha no meio. O CLI roda de verdade com HOME própria.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptPackage, encryptPackage, manifestPart, sha256, verifyParts, type Manifest, type Part } from "../../../src/lib/caronte";

const ROOT = mkdtempSync(join(tmpdir(), "caronte-unpack-test-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const CLI = join(import.meta.dirname, "..", "..", "..", "src", "cli.ts");
const PASSWORD = "senha de teste 123";
const LOG2N = 14;
const HOME = join(ROOT, "home");
const WORK = join(ROOT, "work", "_skill");
const WORK2 = join(ROOT, "work2");
const PLAN = join(HOME, ".claude", "hades", "plans", "demo.md");
const PLANS2 = join(ROOT, "plans2");
const SRC = join(ROOT, "src-clone");
const TREE = join(ROOT, "trees", "fake-a");
const TREES2 = join(ROOT, "trees2");
const DEST_TREE = join(TREES2, "fake-a");
const DEST_CLONE = join(ROOT, "dest-clone");
const FILE = join(ROOT, "out", "demo.caronte");
const REPORTS = ".design-sync-reports";
const BINARY = Buffer.from([0, 1, 2, 3, 255, 254, 0, 9]);

function sh(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function hades(args: string[], extra: Record<string, string> = {}): { rc: number; out: string; err: string } {
  const env = {
    PATH: process.env.PATH ?? "", HOME, HADES_WORK_ROOT: join(ROOT, "work"), HADES_CARONTE_SCRYPT_LOG2N: String(LOG2N),
    HADES_CARONTE_PASSWORD: PASSWORD, ...extra,
  };
  const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
  return { rc: r.status ?? -1, out: r.stdout, err: r.stderr };
}

function write(file: string, text: string | Buffer): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
}

/** Origem: clone com a base, worktree com commit próprio, alteração não commitada, arquivo não rastreado e binário; destino: clone da base. */
function rig(): void {
  for (const dir of ["work", "work2", "plans2", "trees", "trees2", "src-clone", "dest-clone", "out", "home"]) rmSync(join(ROOT, dir), { recursive: true, force: true });
  mkdirSync(SRC, { recursive: true });
  sh(SRC, "init", "-b", "main");
  write(join(SRC, "a.txt"), "um\n");
  write(join(SRC, ".gitignore"), `ignorado.log\n${REPORTS}/\n`);
  sh(SRC, "add", "-A");
  sh(SRC, "commit", "-m", "base");
  sh(ROOT, "clone", "-q", SRC, DEST_CLONE);
  sh(SRC, "worktree", "add", "-q", "-b", "feat/x", TREE, "main");
  write(join(TREE, "novo.txt"), "do commit\n");
  sh(TREE, "add", "-A");
  sh(TREE, "commit", "-m", "feat: novo");
  write(join(TREE, "a.txt"), "um\ndois\n");
  write(join(TREE, "solto.txt"), "não rastreado\n");
  write(join(TREE, "bin.dat"), BINARY);
  write(join(TREE, "ignorado.log"), "ruído\n");
  write(join(TREE, REPORTS, "brief.md"), "# brief\n");
  write(join(TREE, REPORTS, "handoff.md"), "STATUS: PARKED — pausa\nfeito: tudo\n");
  write(PLAN, "# Plano demo\n\n## Estado atual\n- fake-a estacionado\n\n## Unidades\n| fake-a | impl |\n");
  write(join(PLAN, "..", "demo.log.md"), "histórico\n");
  write(join(WORK, "orchestration", "plan.json"), JSON.stringify({ path: PLAN, sha: "0".repeat(64), approvedAt: "2026-10-29T10:00:00Z" }));
  write(join(WORK, "orchestration", "agents", "fake-a.json"), JSON.stringify({
    name: "fake-a", mode: "skill", role: "impl", branch: "feat/x", base: "main", worktree: TREE, pane: "p1", state: "parked",
  }));
  write(join(WORK, "orchestration", "watch", "fake-a.ctx"), `${TREE}\n`);
  const packed = hades(["caronte", "pack", PLAN, "--out", FILE]);
  if (packed.rc !== 0) throw new Error(`pack falhou: ${packed.err}`);
}

const unpackArgs = (...extra: string[]): string[] => [
  "caronte", "unpack", FILE, "--work-root", WORK2, "--plans", PLANS2, "--worktrees", TREES2, "--clone", DEST_CLONE, ...extra,
];

/** Reescreve o pacote com a mudança dada: devolve nada, grava em FILE. */
function repack(mutate: (parts: Part[], manifest: Manifest) => void): void {
  const parts = decryptPackage(readFileSync(FILE), PASSWORD);
  const manifest = verifyParts(parts);
  const rest = parts.slice(1);
  mutate(rest, manifest);
  rmSync(FILE);
  writeFileSync(FILE, encryptPackage([manifestPart(manifest), ...rest], PASSWORD, LOG2N));
}

const untouched = (): void => {
  expect(existsSync(WORK2)).toBe(false);
  expect(existsSync(PLANS2)).toBe(false);
  expect(existsSync(DEST_TREE)).toBe(false);
  expect(sh(DEST_CLONE, "branch", "--list", "feat/x")).toBe("");
};

beforeEach(rig);

describe("caronte unpack: ida e volta", () => {
  test("dado o pacote de um agente estacionado, quando abre em outras raízes, então HEAD, diff, não rastreado e relatórios conferem", () => {
    const r = hades(unpackArgs());
    expect(r.rc).toBe(0);
    expect(sh(DEST_TREE, "rev-parse", "HEAD")).toBe(sh(TREE, "rev-parse", "HEAD"));
    expect(sh(DEST_TREE, "branch", "--show-current")).toBe("feat/x");
    expect(sh(DEST_TREE, "diff")).toBe(sh(TREE, "diff"));
    expect(readFileSync(join(DEST_TREE, "solto.txt"), "utf8")).toBe("não rastreado\n");
    expect(readFileSync(join(DEST_TREE, "bin.dat")).equals(BINARY)).toBe(true);
    expect(existsSync(join(DEST_TREE, "ignorado.log"))).toBe(false);
    expect(readFileSync(join(DEST_TREE, REPORTS, "handoff.md"), "utf8")).toContain("STATUS: PARKED");
    expect(readFileSync(join(DEST_TREE, REPORTS, "brief.md"), "utf8")).toBe("# brief\n");
    expect(readFileSync(join(PLANS2, "demo.md"), "utf8")).toBe(readFileSync(PLAN, "utf8"));
    expect(existsSync(join(PLANS2, "demo.log.md"))).toBe(true);

    const record: Record<string, unknown> = JSON.parse(readFileSync(join(WORK2, "_skill", "orchestration", "agents", "fake-a.json"), "utf8"));
    expect(record.state).toBe("parked");
    expect(record.worktree).toBe(DEST_TREE);
    expect(record).not.toHaveProperty("pane");
    expect(readFileSync(join(WORK2, "_skill", "orchestration", "watch", "fake-a.ctx"), "utf8")).toBe(`${DEST_TREE}\n`);
    const approval: Record<string, unknown> = JSON.parse(readFileSync(join(WORK2, "_skill", "orchestration", "plan.json"), "utf8"));
    expect(approval.path).toBe(join(PLANS2, "demo.md"));
    expect(existsSync(join(WORK2, "_skill", "journal"))).toBe(false);
  });

  test("dada a aprovação que não confere com o plano, quando abre, então avisa do plan-approve", () => {
    const r = hades(unpackArgs());
    expect(r.err).toContain("plan-approve");
  });

  test("dado o fim do unpack, quando imprime, então traz o start do herdr, adopt e resume por agente e o prompt do brief", () => {
    const r = hades(unpackArgs());
    expect(r.out).toContain("herdr agent start fake-a");
    expect(r.out).toContain("hades agent adopt fake-a && hades agent resume fake-a");
    expect(r.out).toContain("hades watch --next");
    expect(r.out).toContain(join(PLANS2, "demo.md"));
  });

  test("dado o pacote de uma worktree limpa e sem commit, quando abre, então a branch nasce na base", () => {
    sh(TREE, "checkout", "-q", "--", "a.txt");
    rmSync(join(TREE, "solto.txt"));
    rmSync(join(TREE, "bin.dat"));
    sh(TREE, "reset", "-q", "--hard", "main");
    expect(hades(["caronte", "pack", PLAN, "--out", join(ROOT, "out", "clean.caronte")]).rc).toBe(0);
    const r = hades(["caronte", "unpack", join(ROOT, "out", "clean.caronte"), "--work-root", WORK2, "--plans", PLANS2, "--worktrees", TREES2, "--clone", DEST_CLONE]);
    expect(r.rc).toBe(0);
    expect(sh(DEST_TREE, "rev-parse", "HEAD")).toBe(sh(DEST_CLONE, "rev-parse", "main"));
    expect(sh(DEST_TREE, "status", "--porcelain")).toBe("");
  });
});

describe("caronte unpack: dry-run", () => {
  test("dado --dry-run, quando abre, então mostra o mapa e não escreve nada", () => {
    const r = hades(unpackArgs("--dry-run"));
    expect(r.rc).toBe(0);
    expect(r.out).toContain(`${TREE}  →  ${DEST_TREE}`);
    expect(r.out).toContain(`${WORK}  →  ${join(WORK2, "_skill")}`);
    expect(r.out).toContain("nada foi gravado");
    untouched();
  });

  test("dado --dry-run sem senha e sem tty, quando abre, então pede a senha e para", () => {
    const r = hades(unpackArgs("--dry-run"), { HADES_CARONTE_PASSWORD: "" });
    expect(r.rc).not.toBe(0);
    expect(r.err).toContain("HADES_CARONTE_PASSWORD");
  });
});

describe("caronte unpack: recusas (nada é tocado)", () => {
  test("dada a senha errada, quando abre, então recusa", () => {
    const r = hades(unpackArgs(), { HADES_CARONTE_PASSWORD: "outra senha" });
    expect(r.rc).toBe(1);
    expect(r.err).toContain("senha errada ou pacote adulterado");
    untouched();
  });

  test("dada uma parte com o sha adulterado, quando abre, então recusa nomeando a parte", () => {
    repack((parts) => {
      const plan = parts.find((p) => p.path === "plan/demo.md");
      if (plan) plan.data = Buffer.from("outro texto");
    });
    const r = hades(unpackArgs());
    expect(r.rc).toBe(1);
    expect(r.err).toContain("sha256 não confere: plan/demo.md");
    untouched();
  });

  test("dado um format maior que o do leitor, quando abre, então recusa", () => {
    repack((_parts, manifest) => void (manifest.format = 2));
    const r = hades(unpackArgs());
    expect(r.rc).toBe(1);
    expect(r.err).toContain("mais novo");
    untouched();
  });

  test("dado um skillVersion de outro major, quando abre, então recusa", () => {
    repack((_parts, manifest) => void (manifest.skillVersion = "99.0.0"));
    const r = hades(unpackArgs());
    expect(r.rc).toBe(1);
    expect(r.err).toContain("major diferente");
    untouched();
  });

  test("dado um skillVersion com outro minor, quando abre, então avisa e segue", () => {
    repack((_parts, manifest) => void (manifest.skillVersion = `${manifest.skillVersion.split(".")[0]}.99.0`));
    const r = hades(unpackArgs());
    expect(r.rc).toBe(0);
    expect(r.err).toContain("minor diferente");
  });

  test("dado um plano existente com outro sha, quando abre, então recusa", () => {
    write(join(PLANS2, "demo.md"), "# outro plano\n");
    const r = hades(unpackArgs());
    expect(r.rc).toBe(1);
    expect(r.err).toContain("já existe com outro conteúdo");
    expect(readFileSync(join(PLANS2, "demo.md"), "utf8")).toBe("# outro plano\n");
    expect(existsSync(DEST_TREE)).toBe(false);
    expect(existsSync(WORK2)).toBe(false);
  });

  test("dado um plano existente com o mesmo sha, quando abre, então segue sem sobrescrever", () => {
    write(join(PLANS2, "demo.md"), readFileSync(PLAN, "utf8").replace("- fake-a estacionado", "- estado só deste lado"));
    const before = readFileSync(join(PLANS2, "demo.md"), "utf8");
    const r = hades(unpackArgs());
    expect(r.rc).toBe(0);
    expect(readFileSync(join(PLANS2, "demo.md"), "utf8")).toBe(before);
  });

  test("dada a worktree de destino já existente, quando abre, então recusa sem criar mais nada", () => {
    mkdirSync(DEST_TREE, { recursive: true });
    const r = hades(unpackArgs());
    expect(r.rc).toBe(1);
    expect(r.err).toContain("já existe");
    expect(existsSync(WORK2)).toBe(false);
    expect(existsSync(PLANS2)).toBe(false);
    expect(readdirSync(DEST_TREE)).toEqual([]);
  });

  test("dada a branch já existente no clone, quando abre, então recusa", () => {
    sh(DEST_CLONE, "branch", "feat/x");
    const r = hades(unpackArgs());
    expect(r.rc).toBe(1);
    expect(r.err).toContain("a branch feat/x já existe");
    expect(existsSync(WORK2)).toBe(false);
    expect(existsSync(DEST_TREE)).toBe(false);
  });

  test("dado um registro de agente já existente, quando abre, então recusa sem criar a worktree", () => {
    write(join(WORK2, "_skill", "orchestration", "agents", "fake-a.json"), "{}");
    const r = hades(unpackArgs());
    expect(r.rc).toBe(1);
    expect(r.err).toContain("já existe no destino");
    expect(existsSync(DEST_TREE)).toBe(false);
    expect(existsSync(PLANS2)).toBe(false);
  });

  test("dado um clone ausente, quando abre sem --clone, então recusa com o git clone do remote", () => {
    repack((_parts, manifest) => void (manifest.repo = { remote: "https://example.test/org/projeto.git", clone: join(ROOT, "nao-existe") }));
    const r = hades(["caronte", "unpack", FILE, "--work-root", WORK2, "--plans", PLANS2, "--worktrees", TREES2]);
    expect(r.rc).toBe(1);
    expect(r.err).toContain("git clone https://example.test/org/projeto.git");
    untouched();
  });

  test("dada uma base fora do clone e sem origin, quando abre, então recusa com o comando de fetch", () => {
    rmSync(DEST_CLONE, { recursive: true, force: true });
    mkdirSync(DEST_CLONE, { recursive: true });
    sh(DEST_CLONE, "init", "-b", "main");
    sh(DEST_CLONE, "commit", "--allow-empty", "-m", "outro");
    const r = hades(unpackArgs());
    expect(r.rc).toBe(1);
    expect(r.err).toContain(`git -C ${DEST_CLONE} fetch origin main`);
    expect(existsSync(DEST_TREE)).toBe(false);
    expect(existsSync(WORK2)).toBe(false);
    expect(sh(DEST_CLONE, "branch", "--list", "feat/x")).toBe("");
  });

  test("dado o clone que não é repositório, quando abre com --clone, então recusa", () => {
    const r = hades(["caronte", "unpack", FILE, "--work-root", WORK2, "--plans", PLANS2, "--worktrees", TREES2, "--clone", join(ROOT, "out")]);
    expect(r.rc).toBe(1);
    expect(r.err).toContain("não é um repositório git");
  });
});

describe("caronte unpack: campos do manifesto que viram argumento do git", () => {
  const field = (name: "baseSha" | "head" | "baseRef", value: string): void => {
    repack((_parts, manifest) => {
      const entry = manifest.worktrees[0];
      if (entry) entry[name] = value;
    });
  };

  test("dado um baseSha que não é um sha, quando abre, então recusa nomeando o agente", () => {
    field("baseSha", "--upload-pack=x");
    const r = hades(unpackArgs());
    expect(r.rc).toBe(1);
    expect(r.err).toContain("fake-a: baseSha inválido");
    untouched();
  });

  test("dado um head que não é um sha, quando abre, então recusa nomeando o agente", () => {
    field("head", "main");
    const r = hades(unpackArgs());
    expect(r.rc).toBe(1);
    expect(r.err).toContain("fake-a: head inválido");
    untouched();
  });

  test("dado um baseRef começando por hífen, quando abre, então recusa nomeando o agente", () => {
    field("baseRef", "--upload-pack=x");
    const r = hades(unpackArgs());
    expect(r.rc).toBe(1);
    expect(r.err).toContain("fake-a: baseRef inválido");
    untouched();
  });

  test("dado um baseRef que não é nome de ref, quando abre, então recusa nomeando o agente", () => {
    field("baseRef", "a..b");
    const r = hades(unpackArgs());
    expect(r.rc).toBe(1);
    expect(r.err).toContain("fake-a: baseRef inválido");
    untouched();
  });
});

describe("caronte unpack: falha no meio", () => {
  test("dado um patch que não aplica, quando abre, então desfaz plano, worktree e branch que criou", () => {
    repack((parts, manifest) => {
      const patch = parts.find((p) => p.path === "worktrees/fake-a/uncommitted.patch");
      if (!patch) throw new Error("patch ausente");
      patch.data = Buffer.from("diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -9,1 +9,1 @@\n-nada\n+nunca\n");
      const entry = manifest.parts.find((p) => p.path === patch.path);
      if (entry) entry.sha256 = sha256(patch.data);
    });
    const r = hades(unpackArgs());
    expect(r.rc).toBe(1);
    expect(r.err).toContain("aplicar uncommitted.patch");
    untouched();
    expect(sh(DEST_CLONE, "worktree", "list")).not.toContain("trees2");
  });

  test("dado o plano que já existia, quando o unpack falha no meio, então o plano e o clone ficam como estavam", () => {
    const same = readFileSync(PLAN, "utf8");
    write(join(PLANS2, "demo.md"), same);
    repack((parts, manifest) => {
      const patch = parts.find((p) => p.path === "worktrees/fake-a/uncommitted.patch");
      if (!patch) throw new Error("patch ausente");
      patch.data = Buffer.from("lixo\n");
      const entry = manifest.parts.find((p) => p.path === patch.path);
      if (entry) entry.sha256 = sha256(patch.data);
    });
    expect(hades(unpackArgs()).rc).toBe(1);
    expect(readFileSync(join(PLANS2, "demo.md"), "utf8")).toBe(same);
    expect(existsSync(DEST_TREE)).toBe(false);
    expect(sh(DEST_CLONE, "branch", "--list", "feat/x")).toBe("");
  });
});
