// Avisos falsos do doctor: herdr do PATH contra servidor novo, node_modules sem node-modules.sh, front-tunnel com plugin desligado.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { herdr, herdrProtocolMismatch } from "../../../src/lib/herdr";
import { Rig } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());

const MISMATCH = "protocol_mismatch: client protocol 20 is older than server protocol 22";
const fakeHerdr = (path: string, body: string): void => {
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
};

describe("herdr(): binário do painel", () => {
  test("dado HADES_HERDR_BIN, então herdr() chama esse binário e não o do PATH", () => {
    const bin = `${r.T}/herdr-configurado`;
    fakeHerdr(bin, "echo configurado");
    const antes = process.env.HADES_HERDR_BIN;
    process.env.HADES_HERDR_BIN = bin;
    try {
      expect(herdr(["x"]).stdout.trim()).toBe("configurado");
    } finally {
      if (antes === undefined) delete process.env.HADES_HERDR_BIN;
      else process.env.HADES_HERDR_BIN = antes;
    }
  });
  test("dado HADES_HERDR_BIN inválido, então falha alto com a mensagem, sem cair no PATH", () => {
    const antes = process.env.HADES_HERDR_BIN;
    process.env.HADES_HERDR_BIN = "relativo/herdr";
    try {
      const res = herdr(["x"]);
      expect(res.status).toBe(127);
      expect(res.stderr).toContain("HADES_HERDR_BIN inválido");
    } finally {
      if (antes === undefined) delete process.env.HADES_HERDR_BIN;
      else process.env.HADES_HERDR_BIN = antes;
    }
  });
  test("o texto do protocol_mismatch é reconhecido", () => {
    expect(herdrProtocolMismatch(MISMATCH)).toBe(true);
    expect(herdrProtocolMismatch("no herdr server is running at /x")).toBe(false);
  });
});

function instancia(nome: string, extra: { herdr?: string; semNodeModulesSh?: boolean; desligado?: boolean } = {}): { data: string; path: string } {
  const data = `${r.T}/data-${nome}`;
  mkdirSync(data, { recursive: true });
  writeFileSync(`${data}/env.sh`, `W="${r.C}"\n`);
  copyFileSync(`${import.meta.dir}/../../../kit/onboard.tsv`, `${data}/onboard.tsv`);
  if (extra.desligado) writeFileSync(`${data}/plugins.disabled`, "plugin-x\n");
  const dir = `${r.T}/bin-${nome}`;
  mkdirSync(dir, { recursive: true });
  for (const n of ["jq", "unzip", "git", "node", "bash"]) symlinkSync(Bun.which(n) ?? `/usr/bin/${n}`, `${dir}/${n}`);
  writeFileSync(`${dir}/systemctl`, `#!/usr/bin/env bash\ncase " $* " in *" is-active "*-panel*) echo active ;; *" is-enabled "*) echo disabled; exit 1 ;; esac\nexit 0\n`);
  chmodSync(`${dir}/systemctl`, 0o755);
  if (extra.herdr) fakeHerdr(`${dir}/herdr`, extra.herdr);
  return { data, path: dir };
}
type Item = { id: string; level: string; msg: string; fix?: string };
const items = (out: string): Item[] => {
  const parsed = JSON.parse(out) as { items?: Item[] } | Item[];
  return Array.isArray(parsed) ? parsed : (parsed.items ?? []);
};

describe("doctor: herdr-servidor", () => {
  test("dado protocol_mismatch, então avisa cliente incompatível e aponta HADES_HERDR_BIN", () => {
    const i = instancia("mismatch", { herdr: `echo '${MISMATCH}' >&2; exit 1` });
    const found = items(r.hades(["doctor", "--quick", "--json"], { env: { PATH: i.path, HADES_DATA: i.data } }).out).find((x) => x.id === "herdr-servidor");
    expect(found?.level).toBe("warn");
    expect(found?.msg).toContain("herdr incompatível");
    expect(found?.msg).not.toContain("sem servidor herdr");
    expect(found?.fix).toContain("HADES_HERDR_BIN");
  });
  test("dado HADES_HERDR_BIN com herdr compatível e o do PATH velho, então ok", () => {
    const i = instancia("bin", { herdr: `echo '${MISMATCH}' >&2; exit 1` });
    const bom = `${r.T}/herdr-novo`;
    fakeHerdr(bom, "echo '{}'");
    const found = items(r.hades(["doctor", "--quick", "--json"], { env: { PATH: i.path, HADES_DATA: i.data, HADES_HERDR_BIN: bom } }).out).find((x) => x.id === "herdr-servidor");
    expect(found?.level).toBe("ok");
  });
});

describe("doctor: node_modules", () => {
  const run = (nome: string, extra: Parameters<typeof instancia>[1]): Item | undefined => {
    const i = instancia(nome, extra);
    return items(r.hades(["doctor", "--quick", "--json"], { env: { PATH: i.path, HADES_DATA: i.data, HADES_DOCTOR_NODE_BINS: "vite" } }).out).find((x) => x.id === "node_modules");
  };
  test("dado plugin desligado e sem node-modules.sh, então ok com o motivo", () => {
    const found = run("nm-off", { desligado: true });
    expect(found?.level).toBe("ok");
    expect(found?.msg).toContain("plugin do projeto desligado");
  });
  test("dado plugin desligado mesmo com node-modules.sh no $D, então ok", () => {
    const i = instancia("nm-off-script", { desligado: true });
    writeFileSync(`${i.data}/node-modules.sh`, "#!/usr/bin/env bash\n");
    const found = items(r.hades(["doctor", "--quick", "--json"], { env: { PATH: i.path, HADES_DATA: i.data, HADES_DOCTOR_NODE_BINS: "vite" } }).out).find((x) => x.id === "node_modules");
    expect(found?.level).toBe("ok");
  });
  test("dado sem node-modules.sh e plugin ligado, então ok sem sugerir script inexistente", () => {
    const found = run("nm-sem", {});
    expect(found?.level).toBe("ok");
    expect(found?.fix ?? "").not.toContain("node-modules.sh");
  });
});

describe("onboard: front-tunnel", () => {
  const estado = (nome: string, desligado: boolean): { state: string } | undefined => {
    const i = instancia(nome, { desligado });
    const out = r.hades(["onboard", "status", "--json", "--quick"], { env: { PATH: i.path, HADES_DATA: i.data } }).out;
    const doc = JSON.parse(out) as { features?: { steps: { id: string; state: string }[] }[] };
    return (doc.features ?? []).flatMap((f) => f.steps).find((s) => s.id === "front-tunnel");
  };
  test("dado plugin desligado, então front-tunnel é na", () => {
    expect(estado("ft-off", true)?.state).toBe("na");
  });
  test("dado plugin ligado e HADES_RUN_TUNNEL desligado, então segue pendente", () => {
    expect(estado("ft-on", false)?.state).toBe("pendente");
  });
});
