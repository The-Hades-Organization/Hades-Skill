// Grupo bun-base: CLI hades em TypeScript e registro único de dependências (reference/cli.md). Os casos que passam pelos wrappers em bash
// (dep_need do lib.sh, hades-instance.sh sem Bun) estão em parity-bun-base.test.ts.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { BUN, Rig, SKILL, STUBS, kv, SYS_PATH } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const CLI = `${SKILL}/src/cli.ts`, REGF = `${SKILL}/src/deps/registry.tsv`;
const NB = `${r.T}/bb-nobun`, BB = `${r.T}/bb-bin`, SC = `${r.T}/bb-sc`, wt = `${r.T}/wt-bb`, D = `${r.T}/bb-d`;
const OB = `${r.T}/bb-onlybun`;
const NODE_DIR = r.env0.PATH?.split(":")[1] ?? "/usr/bin";
const sim = (b: boolean) => (b ? "sim" : "não");
const deps = (args: string[], PATH?: string) => r.X([BUN, CLI, "deps", ...args], { merge: true, env: PATH ? { PATH } : {} });

describe("bun-base", () => {
  if (!Bun.which("bun") && !existsSync(BUN)) throw new Error("bun instalado (o registro manda instalar: curl -fsSL https://bun.sh/install | bash)");
  // sem Bun no PATH nem em ~/.bun/bin (HOME isolado)
  mkdirSync(OB, { recursive: true }); symlinkSync(BUN, `${OB}/bun`);

  describe("o registro: contrato do --json e uma linha do doctor por dependência sem checagem própria", () => {
    const out = JSON.parse(r.X([BUN, CLI, "deps", "--json"]).out) as { version: number; items: { id: string; found: boolean }[] };
    test("deps --json: versão 1, uma entrada por dependência do registro", () => {
      // a 8ª coluna (sistema) tira do Linux as linhas só do macOS (launchctl)
      const n = readFileSync(REGF, "utf8").split("\n").filter((l) => l && !l.startsWith("#") && l.split("\t")[7] !== "macos").length;
      expect(`${out.version} ${out.items.length}`).toBe(`1 ${n}`);
    });
    test("deps --json: o bun aparece como encontrado", () => { expect(String(out.items.find((i) => i.id === "bun")?.found)).toBe("true"); });
  });

  describe("dependência ausente: falha cedo (69) com a instrução do registro", () => {
    const miss = deps(["need", "herdr"], OB);
    test("deps need herdr sem herdr no PATH: sai 69", () => { expect(miss.rc).toBe(69); });
    test("deps need: a mensagem diz a dependência e como instalar", () => {
      expect(/^hades: dependência ausente: herdr \(.*\)\. Como instalar: .*herdr/s.test(miss.out.trim()), miss.out).toBe(true);
    });
    test("deps need de id fora do registro: erro de uso, não passa calado", () => {
      const o = deps(["need", "inexistente"], OB);
      expect(`${o.rc} ${sim(/fora do registro|não está no registro/.test(o.out))}`, o.out).toBe("1 sim");
    });
    test("deps need de dependência presente: sai 0 sem imprimir", () => {
      expect(`${deps(["need", "git"]).rc} ${deps(["need", "git"]).out}`).toBe("0 ");
    });
  });

  describe("install com Bun diz qual usa; o doctor mostra as do registro que faltam (e só as sem checagem própria)", () => {
    mkdirSync(BB, { recursive: true }); mkdirSync(SC, { recursive: true });
    symlinkSync(Bun.which("node") ?? "/usr/bin/node", `${BB}/node`); symlinkSync(`${STUBS}/systemctl`, `${BB}/systemctl`);
    // o bun pode morar em /usr/bin junto do herdr: no PATH "sem herdr" ele entra por uma pasta só com o link dele
    mkdirSync(`${r.T}/bb-bun`, { recursive: true }); symlinkSync(BUN, `${r.T}/bb-bun/bun`);
    const PB = `${BB}:${STUBS}:${NODE_DIR}:${SYS_PATH}`, PN = `${BB}:${r.T}/bb-bun:${r.T}/bb-sem-herdr`;
    // o herdr real pode morar em /usr/bin: o PATH "sem herdr" é uma cópia de links das ferramentas do sistema, menos ele
    mkdirSync(`${r.T}/bb-sem-herdr`, { recursive: true });
    // existsSync segue o link: um link quebrado de /usr/bin some dele e o de /bin (o mesmo diretório no merged-usr) colide
    const linked = new Set<string>();
    for (const dir of ["/usr/bin", "/bin"]) for (const f of readdirSync(dir)) if (f !== "herdr" && !linked.has(f)) { linked.add(f); symlinkSync(`${dir}/${f}`, `${r.T}/bb-sem-herdr/${f}`); }
    r.must(r.git(r.C, "worktree", "add", "-q", "-b", "bb/wt", wt));
    const doctor = (PATH: string) => JSON.parse(r.X(["bash", `${D}/doctor.sh`, "--quick", "--json"], { env: { PATH, HADES_SKILL_DIR: SKILL } }).out).items as { id: string; level: string; fix?: string }[];
    test("install.sh: confere o Bun e diz a versão", () => {
      const o = r.X(["bash", `${SKILL}/kit/install.sh`], { merge: true, env: kv({ PATH: PB, HADES_WT: wt, HADES_DATA: D, FAKE_SYSTEMCTL_DIR: SC, HADES_LOGINCTL: `${STUBS}/loginctl`,
        FAKE_LINGER: `${r.T}/bb-linger`, SKIP_WORKTREE: "1", SKIP_DOCTOR: "1" }) });
      expect(o.out.split("\n").filter((l) => l.startsWith("bun: ")).length).toBe(1);
    });
    test("doctor: dependência do registro ausente (herdr) vira aviso com a instrução", () => {
      const h = doctor(PN).find((i) => i.id === "herdr");
      expect(`${h?.level} ${sim(/herdr/.test(h?.fix ?? ""))}`).toBe("warn sim");
    });
    test("doctor: dependência do registro presente (bun, git) vira ok", () => {
      const it = doctor(PN); expect(`${it.find((i) => i.id === "bun")?.level} ${it.find((i) => i.id === "git")?.level}`).toBe("ok ok");
    });
    test("doctor: nenhum id repetido (as de checagem própria não duplicam)", () => {
      const ids = doctor(PN).map((i) => i.id).sort(); expect(ids.filter((id, k) => ids[k + 1] === id && ids[k - 1] !== id).join(" ")).toBe("");
    });
    test("doctor: com o herdr no PATH a linha dele é ok", () => { expect(doctor(PB).find((i) => i.id === "herdr")?.level).toBe("ok"); });
  });

  test("install.sh sem Bun: sai 69 antes de instalar qualquer coisa", () => {
    mkdirSync(NB, { recursive: true });
    for (const t of ["bash", "awk", "cut", "dirname"]) if (!existsSync(`${NB}/${t}`)) symlinkSync(Bun.which(t) ?? `/usr/bin/${t}`, `${NB}/${t}`);
    chmodSync(NB, 0o755);
    const o = r.X(["bash", `${SKILL}/kit/install.sh`], { merge: true, env: { PATH: NB, HADES_BUN: "", HADES_DATA: `${r.T}/bb-d2` } });
    expect(`${o.rc} ${sim(o.out.includes("dependência ausente: bun"))} ${existsSync(`${r.T}/bb-d2`) ? "sim" : "não"}`, o.out).toBe("69 sim não");
  });
});
