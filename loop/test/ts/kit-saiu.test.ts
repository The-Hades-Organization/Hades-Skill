// Grupo kit-saiu: arquivo que saiu do kit some do $D na reinstalação (pelo manifesto kit.manifest), nunca o editado à mão nem o
// estado, e o drift acusa "saiu do kit". Sem manifesto anterior, código antigo do $D só vira aviso.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Rig } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());

describe("kit-saiu", () => {
  const skill = `${r.T}/skill-saiu`;
  r.skillCopy(skill);
  const kit = (rel: string) => `${skill}/kit/${rel}`;
  const put = (path: string, text: string) => { mkdirSync(path.replace(/\/[^/]*$/, ""), { recursive: true }); writeFileSync(path, text); };
  const env = (data: string) => ({ HADES_WT: r.C, HADES_DATA: data, SKIP_SYSTEMD: "1", SKIP_DOCTOR: "1", SKIP_WORKTREE: "1" });
  const install = (data: string) => r.X(["bash", kit("install.sh")], { merge: true, env: env(data) });
  const drift = (data: string) => r.hadesIn(skill, ["skill-release", "drift"], { merge: true, env: { ...env(data), HADES_PACKS_ROOT: `${r.T}/packs-vazio` } });
  mkdirSync(`${r.T}/packs-vazio`, { recursive: true });

  test("arquivo que saiu do kit e está igual ao instalado: some do $D", () => {
    const D = `${r.T}/d-saiu`;
    put(kit("zz-antigo.sh"), "#!/usr/bin/env bash\necho antigo\n");
    put(kit("panel/ui/zz-pagina.js"), "export {};\n");
    expect(install(D).rc).toBe(0);
    expect(existsSync(`${D}/zz-antigo.sh`) && existsSync(`${D}/panel/ui/zz-pagina.js`)).toBe(true);
    put(`${D}/config.env`, "HADES_X=1\n");
    rmSync(kit("zz-antigo.sh")); rmSync(kit("panel/ui/zz-pagina.js"));
    const x = install(D);
    expect(x.rc).toBe(0);
    expect(x.all).toContain("removido do kit: zz-antigo.sh");
    expect(existsSync(`${D}/zz-antigo.sh`)).toBe(false);
    expect(existsSync(`${D}/panel/ui/zz-pagina.js`)).toBe(false);
    expect(readFileSync(`${D}/config.env`, "utf8")).toBe("HADES_X=1\n");
  });

  test("arquivo que saiu do kit mas foi editado no $D: fica, com aviso, e o drift lista 'saiu do kit'", () => {
    const D = `${r.T}/d-editado`;
    put(kit("zz-editado.sh"), "#!/usr/bin/env bash\necho a\n");
    expect(install(D).rc).toBe(0);
    writeFileSync(`${D}/zz-editado.sh`, "#!/usr/bin/env bash\necho minha edicao\n");
    rmSync(kit("zz-editado.sh"));
    const x = install(D);
    expect(x.all).toContain("aviso: zz-editado.sh saiu do kit mas foi editado");
    expect(readFileSync(`${D}/zz-editado.sh`, "utf8")).toContain("minha edicao");
    expect(drift(D).all).toContain("saiu do kit:");
  });

  test("drift lista o arquivo que saiu do kit e ainda está no $D (instalado antes, kit sem ele)", () => {
    const D = `${r.T}/d-drift`;
    put(kit("zz-drift.sh"), "#!/usr/bin/env bash\necho d\n");
    expect(install(D).rc).toBe(0);
    rmSync(kit("zz-drift.sh"));
    const x = drift(D);
    expect(x.all).toMatch(/saiu do kit:\s+zz-drift\.sh/);
    expect(x.rc).toBe(1);
  });

  test("primeira instalação com manifesto: código antigo do $D (*.py, panel/ui) só é listado, nunca apagado", () => {
    const D = `${r.T}/d-primeira`;
    put(`${D}/env.sh`, `W="${r.C}"\nD="${D}"\nHADES_ID=""\n`);
    put(`${D}/server.py`, "antigo\n");
    put(`${D}/panel/ui/pages/velha.js`, "antigo\n");
    put(`${D}/seed/dados.py`, "estado\n");
    const x = install(D);
    expect(x.rc).toBe(0);
    expect(x.all).toContain("aviso: server.py não está mais no kit");
    expect(x.all).toContain("aviso: panel/ui/pages/velha.js não está mais no kit");
    expect(x.all).not.toContain("seed/dados.py");
    expect(existsSync(`${D}/server.py`) && existsSync(`${D}/panel/ui/pages/velha.js`) && existsSync(`${D}/seed/dados.py`)).toBe(true);
    expect(install(D).all).not.toContain("não está mais no kit");
  });
});
