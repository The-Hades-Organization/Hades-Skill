// Doctor: "painel no ar sem servidor herdr" (aviso) com herdr e systemctl falsos; nenhum herdr nem unit reais.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { Rig } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const data = `${r.T}/data-doctor-herdr`;
mkdirSync(data, { recursive: true });
writeFileSync(`${data}/env.sh`, `W="${r.C}"\n`);

/** PATH com o herdr falso (no ar, fora ou ausente) e um systemctl falso que dá a unit do painel como ativa ou não. */
function cenario(nome: string, opts: { ativa: boolean; herdr: "no-ar" | "fora" | "ausente" }): string {
  const dir = `${r.T}/dh-${nome}`;
  mkdirSync(dir, { recursive: true });
  for (const n of ["jq", "unzip", "git", "node", "bash"]) symlinkSync(Bun.which(n) ?? `/usr/bin/${n}`, `${dir}/${n}`);
  const active = opts.ativa ? 'echo active' : "echo inactive; exit 3";
  writeFileSync(`${dir}/systemctl`, `#!/usr/bin/env bash\ncase " $* " in *" is-active "*-panel*) ${active} ;; *" is-enabled "*) echo disabled; exit 1 ;; esac\nexit 0\n`);
  chmodSync(`${dir}/systemctl`, 0o755);
  if (opts.herdr !== "ausente") {
    const script = opts.herdr === "no-ar" ? "echo '{}'" : "echo 'no herdr server is running at /x/herdr.sock; run `herdr` to start or attach it' >&2; exit 1";
    writeFileSync(`${dir}/herdr`, `#!/usr/bin/env bash\n${script}\n`);
    chmodSync(`${dir}/herdr`, 0o755);
  }
  return r.hades(["doctor", "--quick", "--json"], { env: { PATH: dir, HADES_DATA: data } }).out;
}
function item(doctor: string, id: string): { level: string; msg: string } | undefined {
  const parsed = JSON.parse(doctor) as { items?: { id: string; level: string; msg: string }[] } | { id: string; level: string; msg: string }[];
  const items = Array.isArray(parsed) ? parsed : (parsed.items ?? []);
  return items.find((i) => i.id === id);
}

describe("doctor: servidor do herdr", () => {
  test("painel ativo e socket sem resposta: aviso, não erro", () => {
    const found = item(cenario("aviso", { ativa: true, herdr: "fora" }), "herdr-servidor");
    expect(found?.level).toBe("warn");
    expect(found?.msg).toContain("painel no ar sem servidor herdr");
  });
  test("painel ativo e servidor respondendo: ok", () => {
    expect(item(cenario("ok", { ativa: true, herdr: "no-ar" }), "herdr-servidor")?.level).toBe("ok");
  });
  test("painel parado: sem a linha (nada a acusar)", () => {
    expect(item(cenario("parado", { ativa: false, herdr: "fora" }), "herdr-servidor")).toBeUndefined();
  });
});
