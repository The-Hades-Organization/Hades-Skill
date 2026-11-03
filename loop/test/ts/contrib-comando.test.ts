// Grupo contrib-comando: `hades contrib` de ponta a ponta numa cópia da skill com git próprio e um gh falso (nunca rede).
// Com acesso só prepara e mostra; a PR só abre com --yes; sem acesso grava o .html e nada sai da máquina.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { BUN, Rig, SKILL, kv, SYS_PATH } from "./lib/rig";
import { EMAIL } from "./lib/contrib-amostra";

const r = new Rig();
afterAll(() => r.cleanup());

const S = `${r.T}/skill-copia`, BIN = `${r.T}/bin`, LOG = `${r.T}/gh.log`, REMOTO = `${r.T}/remoto.git`, D = `${r.T}/dados`;
const CONTRIB = `${r.H}/.claude/hades/contrib`;
const SEM_GH = `${r.T}/bin-sem-gh`;
const NODE_DIR = r.env0.PATH?.split(":")[1] ?? "/usr/bin";
const META = ["--title", "feat: guarda compartilhada", "--why", "Quem evolui a skill precisa devolver a melhoria.", "--gains", "Menos retrabalho\nMesma guarda do release",
  "--proof", "bun test: verde"];

// gh falso: anota a chamada; `api` responde FAKE_GH_API (json) com FAKE_GH_API_RC; `repo clone` clona o remoto de teste
const GH = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_GH_LOG"
case "$1 $2" in
  "api repos/"*) [[ -z "\${FAKE_GH_API_ERR:-}" ]] || echo "$FAKE_GH_API_ERR" >&2; printf '%s' "\${FAKE_GH_API:-}"; exit "\${FAKE_GH_API_RC:-0}";;
  "repo clone") git clone -q "$FAKE_GH_REMOTE" "$4"; exit $?;;
  "pr create") echo "https://example.invalid/pr/1"; exit 0;;
esac
exit 0
`;
const PUSH = JSON.stringify({ default_branch: "main", permissions: { push: true } });
const SEM_PUSH = JSON.stringify({ default_branch: "main", permissions: { push: false } });

const hades = (args: string[], e: Record<string, string> = {}, semGh = false) =>
  r.X([BUN, `${S}/src/cli.ts`, "contrib", ...args], { merge: true, env: kv({
    PATH: semGh ? SEM_GH : `${BIN}:${NODE_DIR}:${SYS_PATH}`, HADES_DATA: D, HADES_WT: r.C, HADES_PACKS_ROOT: `${r.T}/packs-vazio`, FAKE_GH_LOG: LOG,
    FAKE_GH_API: PUSH, FAKE_GH_REMOTE: REMOTO, HADES_VERSION_CHECK_REPO: "Dono/Skill", NO_COLOR: "1" }, e) });
const chamadas = () => (existsSync(LOG) ? readFileSync(LOG, "utf8").split("\n").filter(Boolean) : []);
const limpa = () => { rmSync(LOG, { force: true }); rmSync(CONTRIB, { recursive: true, force: true }); };
const htmls = () => (existsSync(CONTRIB) ? readdirSync(CONTRIB).filter((f) => f.endsWith(".html")) : []);

let BASE = "";
function commit(msg: string): void { r.must(r.git(S, "add", "-A")); r.must(r.git(S, "commit", "-qm", msg)); }

beforeAll(() => {
  mkdirSync(BIN, { recursive: true }); mkdirSync(`${r.T}/packs-vazio`, { recursive: true }); mkdirSync(D, { recursive: true });
  // PATH sem gh: só o git (o gh real da máquina não pode aparecer)
  mkdirSync(SEM_GH, { recursive: true }); symlinkSync(Bun.which("git") ?? "/usr/bin/git", `${SEM_GH}/git`);
  writeFileSync(`${BIN}/gh`, GH); chmodSync(`${BIN}/gh`, 0o755);
  // remoto da skill: um commit na main, de onde a contribuição parte
  const semente = `${r.T}/semente`;
  mkdirSync(semente, { recursive: true });
  r.must(r.X(["git", "init", "-q", "-b", "main", semente]));
  writeFileSync(`${semente}/README.md`, "skill\n");
  r.must(r.git(semente, "add", "-A")); r.must(r.git(semente, "commit", "-qm", "init"));
  r.must(r.X(["git", "clone", "-q", "--bare", semente, REMOTO]));
  // cópia da skill: base com VERSION 5.1.0 e, em cima, a evolução (núcleo + pacote + README)
  mkdirSync(S, { recursive: true });
  for (const d of ["kit", "src"]) cpSync(`${SKILL}/${d}`, `${S}/${d}`, { recursive: true });
  mkdirSync(`${S}/reference`, { recursive: true }); mkdirSync(`${S}/packs/acme`, { recursive: true });
  writeFileSync(`${S}/VERSION`, "5.1.0\n"); writeFileSync(`${S}/SKILL.md`, "# skill\n"); writeFileSync(`${S}/README.md`, "leia\n");
  r.must(r.X(["git", "init", "-q", "-b", "main", S]));
  commit("chore: VERSION 5.1.0");
  BASE = r.git(S, "rev-parse", "HEAD").out.trim();
  writeFileSync(`${S}/reference/novo.md`, "# Novo\n\nTexto neutro.\n");
  writeFileSync(`${S}/kit/novo.sh`, "#!/usr/bin/env bash\necho ok\n");
  writeFileSync(`${S}/packs/acme/env.sh`, "echo pacote\n"); writeFileSync(`${S}/README.md`, "leia mais\n");
  commit("feat: evolução");
});

describe("hades contrib", () => {
  test("com acesso: prepare mostra branch, título, corpo e diff, e não abre nada", () => {
    limpa();
    const a = hades(["prepare", "--base", BASE, "--slug", "guarda", ...META]);
    expect(a.rc, a.out).toBe(0);
    expect(a.out).toContain("branch: contrib/guarda");
    expect(a.out).toContain("destino: Dono/Skill (main)");
    expect(a.out).toContain("título: feat: guarda compartilhada");
    for (const s of ["## O que é", "## Por quê", "## Ganhos", "## Prova", "reference/novo.md", "kit/novo.sh", "diff --git a/kit/novo.sh b/kit/novo.sh"]) expect(a.out).toContain(s);
    expect(a.out).toContain("ficou de fora");
    expect(a.out).toContain("packs/acme/env.sh");
    expect(a.out).not.toContain("diff --git a/packs");
    expect(chamadas()).toEqual(["api repos/Dono/Skill"]);
    expect(htmls()).toEqual([]);
  });

  test("pr sem confirmação (não interativo, sem --yes) não clona, não empurra e não abre", () => {
    limpa();
    const a = hades(["pr", "--base", BASE, "--slug", "guarda", ...META]);
    expect(a.rc).not.toBe(0);
    expect(a.out).toContain("não aberta");
    expect(a.out).toContain("--yes");
    expect(chamadas().filter((l) => !l.startsWith("api "))).toEqual([]);
    expect(r.X(["git", "-C", REMOTO, "branch", "--list", "contrib/*"]).out.trim()).toBe("");
  });

  test("pr --yes: empurra a branch só com o núcleo e abre a PR contra a branch padrão", () => {
    limpa();
    const a = hades(["pr", "--yes", "--base", BASE, "--slug", "guarda", ...META]);
    expect(a.rc, a.out).toBe(0);
    const pr = chamadas().filter((l) => l.startsWith("pr create"));
    expect(pr).toHaveLength(1);
    expect(pr[0]).toContain("--repo Dono/Skill");
    expect(pr[0]).toContain("--base main");
    expect(pr[0]).toContain("--head contrib/guarda");
    expect(a.out).toContain("example.invalid/pr/1");
    expect(a.out).toContain("fecha a PR citando a versão");
    const arquivos = r.X(["git", "-C", REMOTO, "ls-tree", "-r", "--name-only", "contrib/guarda"]).out.split("\n");
    expect(arquivos).toContain("kit/novo.sh");
    expect(arquivos).toContain("reference/novo.md");
    expect(arquivos.some((f) => f.startsWith("packs/"))).toBe(false);
    expect(arquivos).not.toContain("src/cli.ts");
  });

  test("sem acesso (push false): grava o .html, imprime o caminho e nada é aberto nem enviado", () => {
    limpa();
    const a = hades(["suggest", "--base", BASE, "--slug", "guarda", ...META], { FAKE_GH_API: SEM_PUSH });
    expect(a.rc, a.out).toBe(0);
    expect(a.out).toContain(`${CONTRIB}/guarda.html`);
    expect(a.out).toContain("nada saiu da máquina");
    expect(htmls()).toEqual(["guarda.html"]);
    expect(chamadas()).toEqual(["api repos/Dono/Skill"]);
    const html = readFileSync(`${CONTRIB}/guarda.html`, "utf8");
    expect(html).toContain("kit/novo.sh");
    expect(html).not.toMatch(/<script|https?:\/\//i);
  });

  test("sem gh no PATH: o mesmo caminho sem acesso, sem erro e sem chamar nada", () => {
    limpa();
    const a = hades(["suggest", "--base", BASE, "--slug", "semgh", ...META], {}, true);
    expect(a.rc, a.out).toBe(0);
    expect(htmls()).toEqual(["semgh.html"]);
    expect(chamadas()).toEqual([]);
  });

  test("sem login: caminho sem acesso", () => {
    limpa();
    const a = hades(["suggest", "--base", BASE, "--slug", "semlogin", ...META], { FAKE_GH_API_RC: "4", FAKE_GH_API: "", FAKE_GH_API_ERR: "gh auth login" });
    expect(a.rc, a.out).toBe(0);
    expect(htmls()).toEqual(["semlogin.html"]);
  });

  test("com acesso, suggest só prepara: nenhuma escrita remota e nenhum html", () => {
    limpa();
    const a = hades(["suggest", "--base", BASE, "--slug", "guarda", ...META]);
    expect(a.rc, a.out).toBe(0);
    expect(a.out).toContain("branch: contrib/guarda");
    expect(a.out).toContain("hades contrib pr");
    expect(chamadas()).toEqual(["api repos/Dono/Skill"]);
    expect(htmls()).toEqual([]);
  });

  test("html força o arquivo mesmo com acesso", () => {
    limpa();
    const a = hades(["html", "--base", BASE, "--slug", "forcado", ...META]);
    expect(a.rc, a.out).toBe(0);
    expect(htmls()).toEqual(["forcado.html"]);
    expect(chamadas()).toEqual([]);
  });

  test("varredura barra: lista arquivo:linha e não gera nada (nem html, nem PR)", () => {
    limpa();
    writeFileSync(`${S}/reference/vaza.md`, `a\ncontato ${EMAIL}\n`);
    commit("docs: vaza");
    for (const sub of ["suggest", "prepare", "pr", "html"]) {
      const a = hades([sub, "--yes", "--base", BASE, "--slug", "vaza", ...META]);
      expect(a.rc, `${sub}: ${a.out}`).toBe(1);
      expect(a.out).toContain("reference/vaza.md:2  e-mail");
    }
    expect(htmls()).toEqual([]);
    expect(chamadas().filter((l) => !l.startsWith("api "))).toEqual([]);
    r.must(r.git(S, "reset", "-q", "--hard", "HEAD~1"));
  });

  test("só pacote de projeto no diff: nada a sugerir", () => {
    limpa();
    const base = r.git(S, "rev-parse", "HEAD").out.trim();
    writeFileSync(`${S}/packs/acme/outro.sh`, "echo\n");
    commit("feat: só pacote");
    const a = hades(["suggest", "--base", base, ...META]);
    expect(a.rc, a.out).toBe(0);
    expect(a.out).toContain("nada a sugerir");
    expect(htmls()).toEqual([]);
  });

  test("faltando título, por quê, ganhos ou prova: erro de uso que diz o que falta", () => {
    limpa();
    const a = hades(["suggest", "--base", BASE, "--title", "feat: x"]);
    expect(a.rc).toBe(2);
    for (const f of ["--why", "--gains", "--proof"]) expect(a.out).toContain(f);
    expect(chamadas()).toEqual([]);
  });

  test("a base padrão é o commit que subiu a versão instalada", () => {
    limpa();
    writeFileSync(`${D}/kit.version`, "5.1.0\n");
    const a = hades(["prepare", "--slug", "guarda", ...META]);
    expect(a.rc, a.out).toBe(0);
    expect(a.out).toContain("reference/novo.md");
  });
});
