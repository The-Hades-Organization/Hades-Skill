// Grupo install: kit/install.sh — perfil sem env.pack instala só a máquina; com env.pack o ambiente do pacote é sobreposto ao $D;
// renomeação do pacote (env/renamed.tsv) remove o órfão sem tocar estado nem nome fora da regra.
import { afterAll, describe, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { FX, Rig, SKILL, checkText, cut80, readJson, writeJson } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const I = `${SKILL}/kit/install.sh`;

describe("install", () => {
  const wt = `${r.T}/wt-install`, pk = `${r.T}/packs-env/example-monorepo`;
  r.must(r.git(r.C, "worktree", "add", "-q", "-b", "install/wt", wt));
  for (const d of ["assets", "reference", "infra"]) mkdirSync(`${pk}/env/${d}`, { recursive: true });
  const prof = readJson(`${FX}/packs/example-monorepo/profile.json`); prof.env = { pack: "env" }; writeJson(`${pk}/profile.json`, prof);
  writeFileSync(`${pk}/env/svc.sh`, "#!/usr/bin/env bash\necho svc\n"); writeFileSync(`${pk}/env/infra/gen.sh`, "#!/usr/bin/env bash\necho up\n");
  writeFileSync(`${pk}/env/web.paths`, "apps/front\nlibs\n"); writeFileSync(`${pk}/env/assets/pacote.zip`, "zip\n"); writeFileSync(`${pk}/env/reference/r.md`, "doc\n");
  writeFileSync(`${pk}/env/config.defaults`, "# padrões do ambiente\nHADES_CLEAN_PRIO_LOGS=aa-*,bb\n");
  writeFileSync(`${pk}/env/post-install.sh`, '#!/usr/bin/env bash\necho "post-install: wt=${HADES_WT##*/} asset=$(ls "${BASH_SOURCE%/*}/assets")" > "$HADES_DATA/post.out"\n');
  const inst = (data: string, env: Record<string, string> = {}) =>
    r.X(["bash", I], { merge: true, env: { HADES_WT: wt, HADES_DATA: data, SKIP_SYSTEMD: "1", SKIP_DOCTOR: "1", ...env } }).all.split("\n");
  const keep = (ls: string[], re: RegExp) => ls.filter((l) => re.test(l));

  test("install.txt", () => {
    const sem = keep(inst(`${r.T}/d-sem`), /^aviso|^kit instalado/).filter((l) => !l.includes("não declara `core`")).map((l) => cut80(r, l));
    let out = `$ install.sh (perfil sem env.pack)\n${sem.join("\n")}\n`;
    const has = (p: string) => (existsSync(p) ? "sim" : "não");
    out += `svc.sh: ${has(`${r.T}/d-sem/svc.sh`)} · config.sh: ${has(`${r.T}/d-sem/config.sh`)}\n$ install.sh (com env.pack)\n`;
    const com = keep(inst(`${r.T}/d-com`, { HADES_PACKS_ROOT: `${r.T}/packs-env` }), /^aviso|^kit instalado/)
      .filter((l) => !l.includes("não declara `core`")).map((l) => l.replace(/ \(worktree .*; plugin: /, " (plugin: "));
    out += com.join("\n") + "\n";
    const D = `${r.T}/d-com`;
    for (const n of ["assets", "reference", "post-install.sh"]) if (!existsSync(`${D}/${n}`)) out += `${n}: ausente\n`;
    out += ["svc.sh", "web.paths", "infra/gen.sh", "config.sh", "post.out"].filter((n) => existsSync(`${D}/${n}`)).sort().join("\n") + "\n";
    out += readFileSync(`${D}/post.out`, "utf8");
    out += readFileSync(`${D}/config.env`, "utf8").split("\n").filter((l) => l.startsWith("HADES_CLEAN_PRIO_LOGS")).map((l) => `config.env: ${l}\n`).join("");
    checkText("install.txt", r.norm(out));
  });

  test("install-renamed.txt", () => {
    const R = `${r.T}/d-ren`, penv = { HADES_PACKS_ROOT: `${r.T}/packs-env` };
    writeFileSync(`${pk}/env/novo.sh`, "#!/usr/bin/env bash\necho novo\n");
    writeFileSync(`${pk}/env/renamed.tsv`, "# antigo<TAB>novo\nvelho.sh\tnovo.sh\nroot.env\tnovo.sh\n../fora.sh\tnovo.sh\nsolto.sh\tausente.sh\nsvc.sh\tsvc.sh\n");
    const removed = (ls: string[]) => keep(ls, /^removido/).map((l) => cut80(r, l));
    let out = removed(inst(R, penv)).map((l) => l + "\n").join("");
    out += "$ reinstala com o órfão do release anterior\n";
    writeFileSync(`${R}/velho.sh`, "old\n"); writeFileSync(`${R}/solto.sh`, "old\n"); writeFileSync(`${R}/root.env`, "segredo\n"); writeFileSync(`${r.T}/fora.sh`, "fora\n");
    out += removed(inst(R, penv)).map((l) => l + "\n").join("");
    for (const f of ["velho.sh", "novo.sh", "solto.sh", "root.env", "svc.sh"]) out += `${f}: ${existsSync(`${R}/${f}`) ? "presente" : "ausente"}\n`;
    out += `fora do $D: ${existsSync(`${r.T}/fora.sh`) ? "intacto" : "apagado"}\n$ de novo (idempotente)\n`;
    out += `removidos: ${removed(inst(R, penv)).length}\n`;
    checkText("install-renamed.txt", r.norm(out));
  });
});
