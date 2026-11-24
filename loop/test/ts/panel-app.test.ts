// `hades panel app`: abre o hades-panel-app (stub no PATH ou em HADES_PANEL_APP_BIN) desacoplado, com HADES_DATA e o projeto;
// sem binário sai 69 com o comando de instalação. O doctor diz, sem aviso, se o app está instalado e a versão.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { Rig } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const data = `${r.T}/data-panel-app`;
const proj = `${r.T}/proj-panel-app`;
mkdirSync(data, { recursive: true });
mkdirSync(proj, { recursive: true });
writeFileSync(`${data}/env.sh`, `W="${r.C}"\n`);
const WAIT_MS = 10_000;
const STEP_MS = 50;

/** Pasta com o stub `hades-panel-app` (grava cwd e HADES_DATA em `marca`) ou sem ele. */
function binDir(nome: string, comApp: boolean, marca = ""): string {
  const dir = `${r.T}/pa-${nome}`;
  mkdirSync(dir, { recursive: true });
  for (const n of ["jq", "unzip", "git", "node", "bash"]) symlinkSync(Bun.which(n) ?? `/usr/bin/${n}`, `${dir}/${n}`);
  if (comApp) {
    writeFileSync(`${dir}/hades-panel-app`, `#!/usr/bin/env bash\n[[ $1 == --version ]] && { echo "hades-panel-app 0.9.1"; exit 0; }\nprintf '%s\\n%s\\n' "$PWD" "$HADES_DATA" > "${marca}"\n`);
    chmodSync(`${dir}/hades-panel-app`, 0o755);
  }
  return dir;
}

async function esperaArquivo(p: string): Promise<string> {
  for (let t = 0; t < WAIT_MS && !existsSync(p); t += STEP_MS) await Bun.sleep(STEP_MS);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

function itemDoctor(path: string): { level: string; msg: string } | undefined {
  const out = r.hades(["doctor", "--quick", "--json"], { env: { PATH: path, HADES_DATA: data } }).out;
  const parsed = JSON.parse(out) as { items?: { id: string; level: string; msg: string }[] };
  return (parsed.items ?? []).find((i) => i.id === "painel-app");
}

describe("hades panel app", () => {
  test("abre o binário do PATH, desacoplado, com HADES_DATA e o projeto atual", async () => {
    const marca = `${r.T}/marca-path`;
    const o = r.hades(["panel", "app"], { cwd: proj, merge: true, env: { PATH: binDir("path", true, marca), HADES_DATA: data } });
    expect(o.rc).toBe(0);
    expect(o.out).toContain("painel gpui aberto");
    expect((await esperaArquivo(marca)).split("\n").slice(0, 2)).toEqual([proj, data]);
  });
  test("HADES_PANEL_APP_BIN vence o PATH", async () => {
    const marca = `${r.T}/marca-bin`;
    const bin = `${binDir("bin", true, marca)}/hades-panel-app`;
    const o = r.hades(["panel", "app"], { cwd: proj, merge: true, env: { PATH: binDir("bin-vazio", false), HADES_DATA: data, HADES_PANEL_APP_BIN: bin } });
    expect(o.rc).toBe(0);
    expect(await esperaArquivo(marca)).toContain(data);
  });
  test("sem binário: rc 69 e o comando de instalação", () => {
    const o = r.hades(["panel", "app"], { cwd: proj, merge: true, env: { PATH: binDir("sem", false), HADES_DATA: data } });
    expect(o.rc).toBe(69);
    expect(o.out).toContain("cargo install --git https://github.com/The-Hades-Organization/Hades-Panel hades-panel-app");
  });
});

describe("doctor: painel-app", () => {
  test("instalado: ok com a versão", () => {
    const found = itemDoctor(binDir("doc-com", true, `${r.T}/marca-doc`));
    expect(found?.level).toBe("ok");
    expect(found?.msg).toContain("hades-panel-app 0.9.1");
  });
  test("ausente: ok (opcional), nunca aviso nem erro", () => {
    const found = itemDoctor(binDir("doc-sem", false));
    expect(found?.level).toBe("ok");
    expect(found?.msg).toContain("não instalado");
  });
});
