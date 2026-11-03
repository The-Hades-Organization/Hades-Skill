// Primeira etapa do onboarding: definição única de "completo", aviso de uma linha da CLI e estado aditivo no onboard.json.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BuiltFeature, NOT_VERIFIED, Onboard, onboardLine, onboardProgress } from "../../../src/lib/onboard.ts";

const CLI = join(import.meta.dir, "../../../src/cli.ts");
const CATALOG = ["@a\tFeature A\tdesc", "@b\tFeature B\tdesc", "a\ta1\tPasso A1\tdono\tmanual\t0\t\t\t\tdetalhe", "b\tb1\tPasso B1\thades\tmanual\t0\techo oi\t\t\tdetalhe", ""].join("\n");

const feature = (id: string, choice: BuiltFeature["choice"], states: Array<[string, string]> = []): BuiltFeature => ({
  id, label: `Feature ${id.toUpperCase()}`, desc: "", choice, pending: states.filter(([s]) => s === "pendente").length, done: 0, na: 0,
  steps: states.map(([state, note], i) => ({ id: `${id}${i}`, name: "p", who: "dono", state, note, command: "", interactive: false, doc: "", page: "", detail: "", manual: false, runnable: false })),
});

describe("onboardProgress: definição de completo", () => {
  test("dado nada escolhido, então incompleto e lista as features sem escolha", () => {
    const p = onboardProgress([feature("a", "nova"), feature("b", "nova")], "seen");
    expect(p.complete).toBe(false);
    expect(p.unchosen).toEqual(["Feature A", "Feature B"]);
  });
  test("dado escolhida com passo pendente, então incompleto", () => {
    const p = onboardProgress([feature("a", "selecionada", [["pendente", ""]]), feature("b", "pulada")], "seen");
    expect(p).toMatchObject({ complete: false, pending: 1, pendingFeatures: ["Feature A"] });
  });
  test("dado tudo pulado e tour visto, então completo", () => {
    expect(onboardProgress([feature("a", "pulada"), feature("b", "pulada")], "seen").complete).toBe(true);
  });
  test("dado tudo pulado e tour pulado, então completo; sem tour, incompleto", () => {
    const all = [feature("a", "pulada"), feature("b", "pulada")];
    expect(onboardProgress(all, "skipped").complete).toBe(true);
    expect(onboardProgress(all, undefined)).toMatchObject({ complete: false, tourDone: false });
  });
  test("dado passo pendente de feature pulada ou não verificado pela sonda rápida, então não conta", () => {
    const p = onboardProgress([feature("a", "pulada", [["pendente", ""]]), feature("b", "selecionada", [["pendente", NOT_VERIFIED], ["feito", ""], ["na", "x"]])], "seen");
    expect(p.complete).toBe(true);
  });
  test("a linha do aviso some quando completo e diz o que falta quando não", () => {
    expect(onboardLine(onboardProgress([feature("a", "pulada")], "seen"))).toBe("");
    const line = onboardLine(onboardProgress([feature("a", "nova"), feature("b", "selecionada", [["pendente", ""]])], undefined));
    expect(line).toContain("Feature A");
    expect(line).toContain("1 passo(s) pendente(s) em Feature B");
    expect(line).toContain("o tour do painel");
    expect(line).toContain("/hades env onboard");
    expect(line).toContain("nada muda na máquina sem o seu ok");
  });
});

describe("estado do tour no onboard.json", () => {
  let dir = "";
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "onb-tour-")); writeFileSync(join(dir, "c.tsv"), CATALOG); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("dado arquivo antigo sem tour, então carrega sem tour e valor desconhecido é ignorado", () => {
    const o = new Onboard(dir, join(dir, "c.tsv"));
    writeFileSync(o.stateFile, JSON.stringify({ selected: ["a"], skipped: [], done: [] }));
    expect(o.load().tour).toBeUndefined();
    writeFileSync(o.stateFile, JSON.stringify({ selected: [], skipped: [], done: [], tour: "talvez" }));
    expect(o.load().tour).toBeUndefined();
  });
  test("dado tour gravado, então volta no load e select preserva o tour", () => {
    const o = new Onboard(dir, join(dir, "c.tsv"));
    o.save({ selected: [], skipped: [], done: [], tour: "skipped" });
    expect(o.load().tour).toBe("skipped");
    expect(JSON.parse(readFileSync(o.stateFile, "utf8"))).toMatchObject({ tour: "skipped" });
  });
});

describe("CLI: onboard status --line, tour e reset", () => {
  let dir = "";
  const cli = (...args: string[]) => {
    const r = Bun.spawnSync(["bun", CLI, "onboard", ...args], { env: { ...process.env, HADES_DATA: dir, ONBOARD_CATALOG: join(dir, "c.tsv") }, stdout: "pipe", stderr: "pipe" });
    return { out: r.stdout.toString().trim(), err: r.stderr.toString().trim(), rc: r.exitCode };
  };
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "onb-cli-")); writeFileSync(join(dir, "c.tsv"), CATALOG); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("dado instalação nova, então o aviso aparece e aponta /hades env onboard", () => {
    const r = cli("status", "--line", "--quick");
    expect(r.rc).toBe(0);
    expect(r.out).toContain("Onboarding: falta");
    expect(r.out).toContain("/hades env onboard");
  });
  test("dado tudo pulado mas sem tour, então o aviso diz só o tour; com tour pulado, o aviso some", () => {
    expect(cli("skip", "a", "b").rc).toBe(0);
    expect(cli("status", "--line", "--quick").out).toContain("o tour do painel");
    expect(cli("tour", "skip").rc).toBe(0);
    expect(cli("status", "--line", "--quick").out).toBe("");
  });
  test("dado tour inválido, então uso inválido (2)", () => {
    expect(cli("tour", "talvez").rc).toBe(2);
  });
  test("a API do status --json só ganha campos (aditiva)", () => {
    const j = JSON.parse(cli("status", "--json", "--quick").out);
    for (const k of ["version", "time", "asked", "features", "pending"]) expect(j).toHaveProperty(k);
    expect(j).toMatchObject({ complete: true, tour: "skipped" });
    expect(j.progress).toMatchObject({ complete: true, unchosen: [], pending: 0, tourDone: true });
  });
  test("o --doctor mantém a 1ª linha e acrescenta a do aviso", () => {
    cli("reset");
    const lines = cli("status", "--doctor", "--quick").out.split("\n");
    expect(lines[0]).toMatch(/^0\t\t0$/);
    expect(lines[1]).toContain("Onboarding: falta");
  });
  test("reset esquece escolha e tour", () => {
    cli("skip", "a", "b"); cli("tour", "seen"); cli("reset");
    expect(cli("status", "--line", "--quick").out).toContain("escolher o que preparar");
    expect(JSON.parse(cli("status", "--json", "--quick").out).tour).toBeNull();
  });
});

describe("catálogo do kit: comandos usam o placeholder {D}", () => {
  test("dado o onboard.tsv do kit, então nenhum comando cita $D (o bash -c do run não o recebe e vira /config.sh)", () => {
    const kitCatalog = readFileSync(join(import.meta.dir, "../../../kit/onboard.tsv"), "utf8");
    const commands = kitCatalog.split("\n").filter((line) => line && !line.startsWith("#") && !line.startsWith("@")).map((line) => line.split("\t")[6] ?? "");
    expect(commands.filter((command) => /\$D\b|\$\{D\}/.test(command))).toEqual([]);
  });
});

describe("CLI: onboard run relê as Configurações", () => {
  let dir = "";
  const STEP = ["@c\tFeature C\tdesc", "c\tc1\tPasso C1\thades\tmanual\t0\techo \"[${HADES_ONB_X-}]\" > {D}/visto\t\t\tdetalhe", ""].join("\n");
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "onb-run-"));
    writeFileSync(join(dir, "c.tsv"), STEP);
    writeFileSync(join(dir, "config.tsv"), "HADES_ONB_X\tpadrao\n");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("dado chave das Configurações exportada no processo, então o comando do passo não a herda (o script relê o config.env)", () => {
    const r = Bun.spawnSync(["bun", CLI, "onboard", "run", "c1"], { env: { ...process.env, HADES_DATA: dir, ONBOARD_CATALOG: join(dir, "c.tsv"), HADES_ONB_X: "valor-velho" }, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(dir, "visto"), "utf8").trim()).toBe("[]");
  });
});
