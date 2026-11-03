// Grupo skill-release: o `hades skill-release check` roda a regressão pela fila de gates, pula quando o HEAD limpo já tem
// regressão verde registrada (fora do repo), roda de novo com a árvore suja, e a guarda de segredo pega o marcador montado
// em partes. A "skill" é uma cópia mínima com git próprio e uma regressão de um teste só.
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { BUN, GATE_ENV, Rig, SKILL } from "./lib/rig";

// cada check roda uma regressão (bun test) dentro do teste: com a suíte em paralelo passa dos 5 s padrão
setDefaultTimeout(30_000);

const r = new Rig().setup();
afterAll(() => r.cleanup());

const REGISTRO = `${r.T}/work/_skill/regressao-verde.json`;
const FILA = `${r.T}/fila.txt`;
// a regressão da cópia: um teste que pergunta à fila o que está rodando (prova que o check passou por ela)
const TESTE_MINIMO = `import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
test("fila", () => {
  const s = spawnSync(process.execPath, [process.env.CLI_DA_SKILL as string, "gate-lock", "status"], { encoding: "utf8" });
  writeFileSync(process.env.FILA_SAIDA as string, s.stdout);
  expect(s.status).toBe(0);
});
`;

function skillMinima(dir: string): void {
  mkdirSync(`${dir}/loop/test/ts`, { recursive: true });
  mkdirSync(`${dir}/reference`, { recursive: true });
  for (const d of ["kit", "src"]) cpSync(`${SKILL}/${d}`, `${dir}/${d}`, { recursive: true });
  for (const d of ["bin", "hooks", "cerberus", "schema"]) cpSync(`${SKILL}/loop/${d}`, `${dir}/loop/${d}`, { recursive: true });
  writeFileSync(`${dir}/loop/test/ts/minimo.test.ts`, TESTE_MINIMO);
  for (const f of ["SKILL.md", "CHANGELOG.md", "package.json", "tsconfig.json", ".gitignore"]) cpSync(`${SKILL}/${f}`, `${dir}/${f}`);
  writeFileSync(`${dir}/VERSION`, "9.9.9\n"); writeFileSync(`${dir}/reference/evolving.md`, "# evolving\n");
  r.must(r.git(dir, "init", "-q", "-b", "main")); r.must(r.git(dir, "add", "-A")); r.must(r.git(dir, "commit", "-qm", "base"));
}

function check(dir: string, ...extra: string[]) {
  const rd = `${r.T}/rel-data`;
  mkdirSync(rd, { recursive: true });
  writeFileSync(`${rd}/env.sh`, `W="${r.C}"\n`);
  return r.X([BUN, `${dir}/src/cli.ts`, "skill-release", "check", ...extra], {
    merge: true,
    env: { HADES_DATA: rd, HADES_WT: r.C, HADES_PACKS_ROOT: `${r.T}/packs-vazio`, CLI_DA_SKILL: `${dir}/src/cli.ts`, FILA_SAIDA: FILA, ...GATE_ENV },
  });
}

describe("skill-release check", () => {
  const S = `${r.T}/skill-min`;
  skillMinima(S);
  mkdirSync(`${r.T}/packs-vazio`, { recursive: true });
  const head = () => r.git(S, "rev-parse", "HEAD").out.trim();

  test("a regressão roda pela fila e, verde com a árvore limpa, grava o registro fora do repo", () => {
    const a = check(S);
    expect(a.out, a.out).toContain("regressão do núcleo: bun test loop/test/ts, pela fila de gates");
    expect(a.out).not.toContain("falhou");
    expect(a.out).toContain("check: ok");
    expect(readFileSync(FILA, "utf8"), "a fila viu o gate rodando").toContain("skill-release");
    const reg = JSON.parse(readFileSync(REGISTRO, "utf8"));
    expect(reg.head).toBe(head());
    expect(existsSync(`${S}/regressao-verde.json`)).toBe(false);
  });

  test("segunda rodada no mesmo HEAD pula a regressão e diz de qual registro", () => {
    rmFila();
    const b = check(S);
    expect(b.out).toContain(`regressão: pulada — o HEAD ${head().slice(0, 12)} já tem regressão verde (registro ${REGISTRO}`);
    expect(b.out).not.toContain("pela fila de gates");
    expect(existsSync(FILA), "nada rodou na fila").toBe(false);
    expect(b.rc).toBe(0);
  });

  test("árvore suja não pula nem grava", () => {
    writeFileSync(`${S}/sujo.txt`, "x\n");
    const c = check(S);
    expect(c.out).toContain("árvore suja");
    expect(c.out).not.toContain("pulada");
    expect(c.out).toContain("pela fila de gates");
    rmSync(`${S}/sujo.txt`);
  });

  test("--regressao força mesmo com o HEAD verde registrado", () => {
    const d = check(S, "--regressao");
    expect(d.out).not.toContain("pulada");
    expect(d.out).toContain("pela fila de gates");
  });

  test("regressão vermelha falha o check e não grava o registro", () => {
    const V = `${r.T}/skill-vermelha`;
    skillMinima(V);
    writeFileSync(`${V}/loop/test/ts/minimo.test.ts`, 'import { expect, test } from "bun:test";\ntest("quebra", () => { expect(1).toBe(2); });\n');
    r.must(r.git(V, "commit", "-qam", "vermelho"));
    rmSync(REGISTRO, { force: true });
    const e = check(V);
    expect(e.rc).toBe(1);
    expect(e.out).toContain("regressão do núcleo falhou");
    expect(existsSync(REGISTRO)).toBe(false);
  });

  test("a guarda de segredo pega o marcador montado em partes, mesmo com o HEAD já registrado verde", () => {
    const G = `${r.T}/skill-segredo`;
    skillMinima(G);
    writeFileSync(`${G}/vazou.txt`, `-----BEGIN ${"R"}SA PRIVATE KEY-----\n`);
    r.must(r.git(G, "add", "-A")); r.must(r.git(G, "commit", "-qm", "vaza"));
    mkdirSync(`${r.T}/work/_skill`, { recursive: true });
    writeFileSync(REGISTRO, JSON.stringify({ head: r.git(G, "rev-parse", "HEAD").out.trim(), at: "2026-01-01T00:00:00Z", nucleo: "x", pacotes: [] }));
    const f = check(G);
    expect(f.out).toContain("vazou.txt");
    expect(f.out).toContain("SEGREDO/IDENTIDADE no pacote");
    expect(f.rc).toBe(1);
  });

  test("segredo plantado reprova antes da regressão: a regressão cara nem entra na fila", () => {
    const G = `${r.T}/skill-segredo-cedo`;
    skillMinima(G);
    writeFileSync(`${G}/vazou.txt`, `-----BEGIN ${"R"}SA PRIVATE KEY-----\n`);
    r.must(r.git(G, "add", "-A")); r.must(r.git(G, "commit", "-qm", "vaza antes da regressão"));
    rmFila();
    const f = check(G);
    expect(f.out).toContain("SEGREDO/IDENTIDADE no pacote");
    expect(f.out).not.toContain("pela fila de gates");
    expect(existsSync(FILA), "nada rodou na fila").toBe(false);
    expect(f.rc).toBe(1);
  });

  test("guard em report com `| head -1` sai 0: o relatório inteiro vai numa escrita só (sem SIGPIPE)", () => {
    const dir = `${r.T}/guard-head`;
    mkdirSync(dir, { recursive: true });
    for (const f of ["a", "b", "c"]) writeFileSync(`${dir}/${f}_GUARD.md`, "WEB_GUARD_URL\n");
    const packs = `${r.T}/packs-head/guard-proj`;
    mkdirSync(packs, { recursive: true });
    writeFileSync(`${packs}/profile.json`, JSON.stringify({ name: "guard-proj", identity: { repo: "acme/guard-proj", aliases: ["guard"] } }));
    const cli = `${SKILL}/src/cli.ts`;
    const run = r.sh(`${BUN} ${cli} skill-release guard ${dir} 2>&1 | head -1; echo "rc=\${PIPESTATUS[0]}"`,
      { env: { HADES_NAME_GUARD: "report", HADES_PACKS_ROOT: `${r.T}/packs-head` } });
    expect(run.out).toContain("citam projeto");
    expect(run.out).toContain("rc=0");
  });

  test("a cópia limpa, sem o marcador, passa na mesma guarda", () => {
    const H = `${r.T}/skill-limpa`;
    skillMinima(H);
    writeFileSync(`${r.T}/work/_skill/regressao-verde.json`, JSON.stringify({ head: r.git(H, "rev-parse", "HEAD").out.trim(), at: "2026-01-01T00:00:00Z", nucleo: "x", pacotes: [] }));
    const g = check(H);
    expect(g.out).not.toContain("SEGREDO");
    expect(g.rc).toBe(0);
  });
});

function rmFila(): void { rmSync(FILA, { force: true }); }
