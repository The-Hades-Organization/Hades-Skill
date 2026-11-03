// Correções da 5.15.0: login do devtunnel conferido de verdade, drift que respeita o kit.manifest e o clone da prova como
// artefato descartável do skill-clean.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { DISPOSABLE_DATA } from "../../../src/commands/agent-skill.ts";
import { Rig, SKILL } from "./lib/rig";
import { readFileSync } from "node:fs";

const r = new Rig().setup();
afterAll(() => r.cleanup());

describe("túnel com token GitHub inválido", () => {
  const BB = `${r.T}/bin-dt`, D = `${r.T}/d-dt`;
  mkdirSync(BB, { recursive: true });
  mkdirSync(D, { recursive: true });
  writeFileSync(`${D}/env.sh`, `W="${r.C}"\nD="${D}"\nHADES_ID=""\n`);
  // `user show` lê o perfil local e diz "logged in"; a API (list/create) responde 401 quando o token foi revogado
  const fake = (api: string) => {
    writeFileSync(`${BB}/devtunnel`, `#!/usr/bin/env bash\necho "$*" >> "${D}/dt.log"\ncase $1 in user) echo "Logged in as fulano using GitHub." ;; ${api} esac\nexit 0\n`);
    chmodSync(`${BB}/devtunnel`, 0o755);
  };
  const tunnel = (args: string[]) => r.hades(["tunnel", ...args], { merge: true, env: { PATH: `${BB}:${r.env0.PATH}`, HADES_DATA: D, HADES_TUNNEL_PORT: "3000", HADES_PANEL_PORT: "21220" } });

  test("create com 401 invalid_token: falha e manda o dono refazer o login", () => {
    fake('list) echo "Error: 401 invalid_token" >&2 ;; create) echo "401 invalid_token" >&2 ;;');
    const x = tunnel(["create"]);
    expect(x.rc).toBe(1);
    expect(x.all).toContain("401 invalid_token");
    expect(x.all).toContain("devtunnel user login -g -d");
  });
  test("panel-start e widget-create com o token inválido: mesma mensagem, sem criar túnel", () => {
    fake('list) echo "401 invalid_token" ;;');
    for (const cmd of ["panel-start", "widget-create"]) {
      const x = tunnel([cmd]);
      expect(`${cmd} ${x.rc}`).toBe(`${cmd} 1`);
      expect(x.all).toContain("tunnel.sh login-cmd");
    }
    expect(readFileSync(`${D}/dt.log`, "utf8")).not.toMatch(/^create /m);
  });
  test("token válido: create segue como antes", () => {
    fake('list) cat "' + D + '/names" 2>/dev/null ;; create) echo "$2.reg 0 0" >> "' + D + '/names" ;; port) ;;');
    const x = tunnel(["create"]);
    expect(x.rc).toBe(0);
    expect(x.all).toContain("túnel hades.reg com a porta 3000");
  });
});

describe("drift com instalação de versão anterior", () => {
  const skill = `${r.T}/skill-drift`;
  r.skillCopy(skill);
  const D = `${r.T}/d-drift`;
  const env = { HADES_WT: r.C, HADES_DATA: D, SKIP_SYSTEMD: "1", SKIP_DOCTOR: "1", SKIP_WORKTREE: "1", HADES_PACKS_ROOT: `${r.T}/packs-vazio` };
  mkdirSync(`${r.T}/packs-vazio`, { recursive: true });
  const drift = () => r.hadesIn(skill, ["skill-release", "drift"], { merge: true, env });

  test("arquivo igual ao manifesto, kit mais novo: não é drift, só falta reinstalar; editado à mão continua drift", () => {
    expect(r.X(["bash", `${skill}/kit/install.sh`], { merge: true, env }).rc).toBe(0);
    writeFileSync(`${D}/kit.version`, "0.0.1\n");
    writeFileSync(`${skill}/kit/tunnel.sh`, `${readFileSync(`${skill}/kit/tunnel.sh`, "utf8")}\n# kit andou\n`);
    const novo = drift();
    expect(novo.all).not.toContain("desatualizado em $D");
    expect(novo.all).toContain("falta reinstalar: tunnel.sh");
    expect(novo.all).toContain("drift: nenhum");
    expect(novo.rc).toBe(0);
    writeFileSync(`${D}/tunnel.sh`, `${readFileSync(`${D}/tunnel.sh`, "utf8")}\n# edicao a mao\n`);
    const editado = drift();
    expect(editado.all).toMatch(/desatualizado em \$D: tunnel\.sh/);
    expect(editado.rc).toBe(1);
  });
});

describe("skill-clean e o clone da prova", () => {
  test("clone está entre os artefatos descartáveis", () => expect(DISPOSABLE_DATA).toContain("clone"));
  test("a doc do orchestrate.md lista o clone", () => expect(readFileSync(`${SKILL}/reference/loop/orchestrate.md`, "utf8")).toContain("`clone`"));
});
