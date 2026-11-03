// hades caronte pack|brief e hades agent park: recusa, guarda de segredo, cifra, manifesto e worktrees (limpa, com commits,
// com não commitado e não rastreado). Tudo em diretórios temporários; o CLI roda de verdade com HOME e raiz de trabalho próprias.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaronteError, decryptPackage, encryptPackage, verifyParts, type Manifest, type Part } from "../../../src/lib/caronte";

const ROOT = mkdtempSync(join(tmpdir(), "caronte-test-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const CLI = join(import.meta.dirname, "..", "..", "..", "src", "cli.ts");
const PASSWORD = "senha de teste 123";
const LOG2N = 14;
const HOME = join(ROOT, "home");
const WORK = join(ROOT, "work", "_skill");
const ORCH = join(WORK, "orchestration");
const PLAN = join(HOME, ".claude", "hades", "plans", "demo.md");
const REPORTS = ".design-sync-reports";
// marcador de segredo montado em partes: o literal não pode existir nos fontes (a varredura do check o procuraria)
const SECRET_VALUE = ["Hds", "!", "abcdef1234"].join("");

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

function write(file: string, text: string): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
}

interface Rig {
  tree: string;
}

/** Plano com um agente `fake-a`, worktree git com base `main` e o registro no estado dado. */
function rig(state: string, withHandoff = true): Rig {
  rmSync(join(ROOT, "work"), { recursive: true, force: true });
  rmSync(join(ROOT, "trees"), { recursive: true, force: true });
  const tree = join(ROOT, "trees", "fake-a");
  mkdirSync(tree, { recursive: true });
  sh(tree, "init", "-b", "main");
  write(join(tree, "a.txt"), "um\n");
  write(join(tree, ".gitignore"), "ignorado.log\n");
  sh(tree, "add", "-A");
  sh(tree, "commit", "-m", "base");
  write(join(tree, REPORTS, "brief.md"), "# brief\n");
  if (withHandoff) write(join(tree, REPORTS, "handoff.md"), "STATUS: PARKED — pausa\nfeito: tudo\n");
  write(PLAN, "# Plano demo\n\n## Estado atual\n- fake-a trabalhando\n\n## Unidades\n| fake-a | impl |\n");
  write(join(PLAN, "..", "demo.log.md"), "histórico\n");
  write(join(ORCH, "plan.json"), JSON.stringify({ path: PLAN, sha: "0".repeat(64), approvedAt: "2026-10-29T10:00:00Z" }));
  write(join(ORCH, "agents", "fake-a.json"), JSON.stringify({
    name: "fake-a", mode: "skill", role: "impl", branch: "main", base: "main", worktree: tree, state, promptedAt: "2020-01-01T00:00:00Z",
  }));
  write(join(ORCH, "agents", "outro.json"), JSON.stringify({ name: "outro", worktree: join(ROOT, "trees", "outro"), state: "working" }));
  write(join(ORCH, "watch", "fake-a.ctx"), "1");
  write(join(ORCH, "watch", "outro.ctx"), "1");
  write(join(WORK, "journal", "fake-a.jsonl"), "{}\n");
  return { tree };
}

const outFile = (name: string): string => join(ROOT, "out", `${name}.caronte`);

function open(file: string): { manifest: Manifest; parts: Part[] } {
  const parts = decryptPackage(readFileSync(file), PASSWORD);
  return { manifest: verifyParts(parts), parts };
}

beforeEach(() => rmSync(join(ROOT, "out"), { recursive: true, force: true }));

describe("caronte pack: recusa", () => {
  test("dado um agente trabalhando, quando empacota, então recusa nomeando o agente e o comando de park", () => {
    rig("working", false);
    const r = hades(["caronte", "pack", PLAN, "--out", outFile("x")]);
    expect(r.rc).toBe(1);
    expect(r.err).toContain("fake-a");
    expect(r.err).toContain("hades agent park fake-a");
    expect(statSync(outFile("x"), { throwIfNoEntry: false })).toBeUndefined();
  });

  test("dado um agente que não é do plano, quando ele trabalha, então não barra o pack", () => {
    rig("parked");
    expect(hades(["caronte", "pack", PLAN, "--out", outFile("x")]).rc).toBe(0);
  });

  test("dado um agente encerrado, quando empacota, então segue", () => {
    rig("done", false);
    expect(hades(["caronte", "pack", PLAN, "--out", outFile("x")]).rc).toBe(0);
  });

  test("dado um handoff PARKED mais novo que o último prompt, quando o registro diz working, então conta como estacionado", () => {
    rig("working");
    expect(hades(["caronte", "pack", PLAN, "--out", outFile("x")]).rc).toBe(0);
  });

  test("dado sem senha e sem tty, quando empacota, então não grava pacote", () => {
    rig("parked");
    const r = hades(["caronte", "pack", PLAN, "--out", outFile("x")], { HADES_CARONTE_PASSWORD: "" });
    expect(r.rc).not.toBe(0);
    expect(r.err).toContain("HADES_CARONTE_PASSWORD");
    expect(statSync(outFile("x"), { throwIfNoEntry: false })).toBeUndefined();
  });

  test("dado --out dentro de um repo, quando empacota, então recusa", () => {
    const { tree } = rig("parked");
    const r = hades(["caronte", "pack", PLAN, "--out", join(tree, "p.caronte")]);
    expect(r.rc).not.toBe(0);
    expect(r.err).toContain("dentro de um repositório");
  });
});

describe("caronte pack: guarda de segredo", () => {
  test("dado .env e credenciais.md no não commitado, quando empacota, então recusa nomeando os arquivos e sem o valor", () => {
    const { tree } = rig("parked");
    write(join(tree, ".env"), `TOKEN=${SECRET_VALUE}\n`);
    write(join(tree, "docs", "credenciais.md"), "usuario: x\n");
    write(join(tree, ".env.example"), "TOKEN=<token>\n");
    const r = hades(["caronte", "pack", PLAN, "--out", outFile("x")]);
    expect(r.rc).toBe(1);
    expect(r.err).toContain("worktrees/fake-a/.env");
    expect(r.err).toContain("worktrees/fake-a/docs/credenciais.md");
    expect(r.err).not.toContain(".env.example");
    expect(r.err).not.toContain(SECRET_VALUE);
    expect(statSync(outFile("x"), { throwIfNoEntry: false })).toBeUndefined();
  });

  test("dado --allow para os dois caminhos, quando empacota, então entra e o manifesto registra a liberação", () => {
    const { tree } = rig("parked");
    write(join(tree, ".env"), "A=1\n");
    write(join(tree, "docs", "credenciais.md"), "x\n");
    const r = hades([
      "caronte", "pack", PLAN, "--out", outFile("x"), "--allow", "worktrees/fake-a/.env", "--allow", "worktrees/fake-a/docs/credenciais.md",
    ]);
    expect(r.rc).toBe(0);
    const { manifest } = open(outFile("x"));
    expect(manifest.allowed.sort()).toEqual(["worktrees/fake-a/.env", "worktrees/fake-a/docs/credenciais.md"]);
  });

  test("dado um padrão de segredo no conteúdo de um commit, quando empacota, então recusa nomeando o arquivo", () => {
    const { tree } = rig("parked");
    write(join(tree, "config.txt"), `senha=${SECRET_VALUE}\n`);
    sh(tree, "checkout", "-b", "feat/z");
    sh(tree, "add", "-A");
    sh(tree, "commit", "-m", "x");
    const r = hades(["caronte", "pack", PLAN, "--out", outFile("x")]);
    expect(r.rc).toBe(1);
    expect(r.err).toContain("worktrees/fake-a/config.txt");
    expect(r.err).not.toContain(SECRET_VALUE);
  });

  test("dado um segredo no handoff, quando --dry-run, então lista o barrado e não pede senha", () => {
    const { tree } = rig("parked");
    write(join(tree, REPORTS, "handoff.md"), `STATUS: PARKED — x\n${SECRET_VALUE}\n`);
    const r = hades(["caronte", "pack", PLAN, "--dry-run"], { HADES_CARONTE_PASSWORD: "" });
    expect(r.rc).toBe(1);
    expect(r.out).toContain("BARRADO reports/fake-a/handoff.md");
    expect(r.out).not.toContain(SECRET_VALUE);
  });
});

describe("caronte: cifra", () => {
  const parts: Part[] = [{ path: "a.txt", data: Buffer.from("conteúdo") }, { path: "b/c.bin", data: Buffer.from([0, 1, 2, 255]) }];

  test("dada a senha certa, quando decifra, então volta o mesmo contêiner", () => {
    const back = decryptPackage(encryptPackage(parts, PASSWORD, LOG2N), PASSWORD);
    expect(back.map((p) => p.path)).toEqual(["a.txt", "b/c.bin"]);
    expect(back[1]?.data.equals(Buffer.from([0, 1, 2, 255]))).toBe(true);
  });

  test("dada a senha errada, quando decifra, então falha com erro claro", () => {
    const sealed = encryptPackage(parts, PASSWORD, LOG2N);
    expect(() => decryptPackage(sealed, "outra")).toThrow(CaronteError);
    expect(() => decryptPackage(sealed, "outra")).toThrow(/senha errada ou pacote adulterado/);
  });

  test("dado um byte do texto cifrado trocado, quando decifra, então o GCM barra", () => {
    const sealed = Buffer.from(encryptPackage(parts, PASSWORD, LOG2N));
    sealed[sealed.length - 20] = (sealed[sealed.length - 20] ?? 0) ^ 1;
    expect(() => decryptPackage(sealed, PASSWORD)).toThrow(/GCM/);
  });

  test("dado um parâmetro do cabeçalho adulterado, quando decifra, então falha (o cabeçalho é autenticado)", () => {
    const sealed = Buffer.from(encryptPackage(parts, PASSWORD, LOG2N));
    const text = sealed.toString("latin1").replace(`"log2n":${LOG2N}`, `"log2n":${LOG2N + 1}`);
    expect(() => decryptPackage(Buffer.from(text, "latin1"), PASSWORD)).toThrow(CaronteError);
  });

  test("dado um arquivo qualquer e um log2n absurdo, quando decifra, então recusa sem derivar a chave", () => {
    expect(() => decryptPackage(Buffer.from("nao sou um pacote, mas tenho tamanho suficiente"), PASSWORD)).toThrow(/não é um pacote/);
    const sealed = Buffer.from(encryptPackage(parts, PASSWORD, LOG2N));
    const text = sealed.toString("latin1").replace(`"log2n":${LOG2N}`, `"log2n":99`);
    expect(() => decryptPackage(Buffer.from(text, "latin1"), PASSWORD)).toThrow(/não suportados/);
  });

  test("dada senha vazia, quando cifra, então recusa", () => {
    expect(() => encryptPackage(parts, "", LOG2N)).toThrow(/sem senha, sem pacote/);
  });
});

describe("caronte pack: o pacote real", () => {
  test("dado um agente estacionado com commit, não commitado e não rastreado, quando --dry-run e pack, então o conteúdo decifrado confere", () => {
    const { tree } = rig("parked");
    write(join(tree, "novo.txt"), "do commit\n");
    sh(tree, "checkout", "-b", "feat/x");
    sh(tree, "add", "-A");
    sh(tree, "commit", "-m", "feat: novo");
    write(join(tree, "a.txt"), "um\ndois\n");
    write(join(tree, "solto.txt"), "não rastreado\n");
    write(join(tree, "ignorado.log"), "ruído\n");
    write(join(ORCH, "agents", "fake-a.json"), JSON.stringify({
      name: "fake-a", mode: "skill", role: "impl", branch: "feat/x", base: "main", worktree: tree, state: "parked",
    }));

    const dry = hades(["caronte", "pack", PLAN, "--dry-run"], { HADES_CARONTE_PASSWORD: "" });
    expect(dry.rc).toBe(0);
    expect(dry.out).toContain("worktrees/fake-a/commits.bundle");
    expect(dry.out).toContain("worktrees/fake-a/uncommitted.patch");
    expect(statSync(join(HOME, ".claude", "hades", "caronte"), { throwIfNoEntry: false })).toBeUndefined();

    const real = hades(["caronte", "pack", PLAN, "--out", outFile("real"), "--with-journal"]);
    expect(real.rc).toBe(0);
    expect(real.out).toContain("senha esquecida perde o pacote");
    expect(statSync(outFile("real")).mode & 0o777).toBe(0o600);
    const { manifest, parts } = open(outFile("real"));
    const paths = parts.map((p) => p.path).sort();
    expect(paths).toEqual([
      "journal/fake-a.jsonl", "manifest.json", "orchestration/agents/fake-a.json", "orchestration/plan.json", "orchestration/watch/fake-a.ctx",
      "plan/demo.log.md", "plan/demo.md", "reports/fake-a/brief.md", "reports/fake-a/handoff.md", "worktrees/fake-a/commits.bundle",
      "worktrees/fake-a/uncommitted.patch",
    ]);
    const patch = parts.find((p) => p.path.endsWith("uncommitted.patch"))?.data.toString("utf8") ?? "";
    expect(patch).toContain("solto.txt");
    expect(patch).toContain("+dois");
    expect(patch).not.toContain("ignorado.log");
    expect(manifest.agents).toEqual(["fake-a"]);
    expect(manifest.worktrees[0]).toMatchObject({ agent: "fake-a", branch: "feat/x", baseRef: "main" });
    expect(manifest.worktrees[0]?.head).toBe(sh(tree, "rev-parse", "HEAD"));
    expect(manifest.plan.approvedSha).toBe("0".repeat(64));
    expect(manifest.workRoot).toBe(WORK);
    expect(manifest.skillVersion).toBe(readFileSync(join(import.meta.dirname, "..", "..", "..", "VERSION"), "utf8").trim());
    expect(manifest.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    // o índice da worktree não foi tocado pelo patch
    expect(sh(tree, "status", "--porcelain")).toContain("?? solto.txt");
    // o bundle abre com a base como pré-requisito
    const bundle = join(ROOT, "check.bundle");
    writeFileSync(bundle, parts.find((p) => p.path.endsWith("commits.bundle"))?.data ?? Buffer.alloc(0));
    expect(sh(tree, "bundle", "verify", bundle)).toContain(sh(tree, "rev-parse", "HEAD"));
  });

  test("dado o pacote, quando o sha256 de uma parte não confere com o manifesto, então verifyParts acusa", () => {
    rig("parked");
    hades(["caronte", "pack", PLAN, "--out", outFile("m")]);
    const parts = decryptPackage(readFileSync(outFile("m")), PASSWORD);
    const plan = parts.find((p) => p.path === "plan/demo.md");
    if (!plan) throw new Error("plano ausente");
    plan.data = Buffer.from("outro texto");
    expect(() => verifyParts(parts)).toThrow(/sha256 não confere: plan\/demo\.md/);
  });

  test("dada a saída padrão, quando sem --out, então grava em ~/.claude/hades/caronte com modo 600", () => {
    rig("parked");
    const r = hades(["caronte", "pack", PLAN]);
    expect(r.rc).toBe(0);
    const file = /pacote gravado: (\S+\.caronte)/.exec(r.out)?.[1] ?? "";
    expect(file.startsWith(join(HOME, ".claude", "hades", "caronte", "demo-"))).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("caronte pack: worktrees", () => {
  test("dada worktree limpa e sem commit próprio, quando empacota, então leva só a referência da base", () => {
    rig("parked");
    hades(["caronte", "pack", PLAN, "--out", outFile("clean")]);
    const { manifest, parts } = open(outFile("clean"));
    expect(parts.some((p) => p.path.startsWith("worktrees/"))).toBe(false);
    expect(manifest.worktrees[0]).toMatchObject({ bundle: null, patch: null });
    expect(manifest.worktrees[0]?.baseSha).toBe(manifest.worktrees[0]?.head);
  });

  test("dada a pasta de relatórios no .gitignore, quando empacota, então o patch sai sem ela e o pack não falha", () => {
    const { tree } = rig("parked");
    write(join(tree, ".gitignore"), `ignorado.log\n${REPORTS}/\n`);
    sh(tree, "add", ".gitignore");
    sh(tree, "commit", "-m", "chore: ignora relatórios");
    write(join(tree, "solto.txt"), "novo\n");
    const r = hades(["caronte", "pack", PLAN, "--out", outFile("ignored")]);
    expect(r.err).not.toContain("git add -A falhou");
    expect(r.rc).toBe(0);
    const { parts } = open(outFile("ignored"));
    const patch = parts.find((p) => p.path.endsWith("uncommitted.patch"))?.data.toString("utf8") ?? "";
    expect(patch).toContain("solto.txt");
    expect(patch).not.toContain(REPORTS);
    expect(parts.some((p) => p.path === "reports/fake-a/brief.md")).toBe(true);
  });

  test("dada worktree só com commits, quando empacota, então leva o bundle e nenhum patch", () => {
    const { tree } = rig("parked");
    write(join(tree, "b.txt"), "dois\n");
    sh(tree, "checkout", "-b", "feat/y");
    sh(tree, "add", "-A");
    sh(tree, "commit", "-m", "feat: b");
    write(join(ORCH, "agents", "fake-a.json"), JSON.stringify({ name: "fake-a", mode: "skill", branch: "feat/y", base: "main", worktree: tree, state: "parked" }));
    hades(["caronte", "pack", PLAN, "--out", outFile("commits")]);
    const { manifest, parts } = open(outFile("commits"));
    expect(manifest.worktrees[0]).toMatchObject({ bundle: "worktrees/fake-a/commits.bundle", patch: null });
    expect(parts.some((p) => p.path.endsWith("uncommitted.patch"))).toBe(false);
  });

  test("dada worktree só com não commitado e um não rastreado, quando empacota, então leva o patch e nenhum bundle", () => {
    const { tree } = rig("parked");
    write(join(tree, "solto.txt"), "novo\n");
    hades(["caronte", "pack", PLAN, "--out", outFile("dirty")]);
    const { manifest, parts } = open(outFile("dirty"));
    expect(manifest.worktrees[0]).toMatchObject({ bundle: null, patch: "worktrees/fake-a/uncommitted.patch" });
    expect(parts.find((p) => p.path.endsWith("uncommitted.patch"))?.data.toString("utf8")).toContain("solto.txt");
  });
});

describe("caronte brief e agent park", () => {
  test("dado um estacionado e um trabalhando, quando brief, então lista só o estacionado e rearma o watch", () => {
    rig("parked");
    write(PLAN, "# Plano demo\n\n## Estado atual\n- x\n\n## Unidades\n| fake-a | impl |\n| outro | impl |\n");
    const r = hades(["caronte", "brief", PLAN]);
    expect(r.rc).toBe(0);
    expect(r.out).toContain("hades agent resume fake-a");
    expect(r.out).not.toContain("hades agent resume outro");
    expect(r.out).toContain("hades watch --next");
    expect(r.out).toContain('"Estado atual"');
  });

  test("dado um agente já estacionado, quando park, então avisa e sai 0", () => {
    rig("parked");
    const r = hades(["agent", "park", "fake-a"]);
    expect(r.rc).toBe(0);
    expect(r.out).toContain("já estacionado");
  });

  test("dado um agente encerrado, quando park, então avisa e sai 0", () => {
    rig("done", false);
    const r = hades(["agent", "park", "fake-a"]);
    expect(r.rc).toBe(0);
    expect(r.out).toContain("já encerrado");
  });
});
