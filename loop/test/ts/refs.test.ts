// Grupo refs: refs, pr.labels e card.create do perfil — pack/ref do resolvedor, validação, card criado pelo script e brief com as regras.
import { afterAll, describe, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Rig, checkText, readJson, writeJson } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());

describe("refs", () => {
  const R = `${r.T}/packs-refs`, pk = `${R}/example-monorepo`;
  cpSync(`${r.T}/packs`, R, { recursive: true });
  mkdirSync(`${pk}/loop`, { recursive: true }); mkdirSync(`${pk}/bin`, { recursive: true });
  writeFileSync(`${pk}/loop/invariants.md`, "# invariantes do exemplo\n"); writeFileSync(`${pk}/loop/review.md`, "# review do exemplo\n");
  writeFileSync(`${pk}/bin/card-create.sh`, '#!/usr/bin/env bash\necho "card-create: $1|$2|$3|assignee=$HADES_ORCH_CLICKUP_ASSIGNEE" >> "$(dirname "$0")/calls.log"\necho SOFTWARE-777\n');
  chmodSync(`${pk}/bin/card-create.sh`, 0o755);
  const prof = readJson(`${pk}/profile.json`);
  prof.refs = { invariants: "loop/invariants.md", review: "loop/review.md" }; prof.card = { ...prof.card, create: "bin/card-create.sh" }; prof.pr = { ...prof.pr, labels: ["backend", "extra"] };
  writeJson(`${pk}/profile.json`, prof);
  const PK = { HADES_PACKS_ROOT: R };

  test("refs.txt e refs-brief.md", () => {
    let out = "";
    for (const q of ["pack", "ref invariants", "ref review", "ref gates", "get pr.labels", "get card.create"]) {
      const p = r.hades(["project", ...q.split(" ")], { cwd: r.C, env: PK, merge: true });
      out += `$ hades project ${q}\n${p.out}rc=${p.rc}\n`;
    }
    const sp = r.hades(["project", "ref", "invariants"], { cwd: r.P, env: PK, merge: true });
    out += `$ hades project ref invariants (repo sem perfil)\n${sp.out}rc=${sp.rc}\n`;
    const v = r.hades(["project", "validate", `${pk}/profile.json`], { cwd: r.C, env: PK, merge: false });
    out += `$ validate\n${v.out}rc=${v.rc}\n`;
    const bad = readJson(`${pk}/profile.json`); bad.refs.gates = "loop/falta.md";
    mkdirSync(`${r.T}/bad`, { recursive: true }); cpSync(pk, `${r.T}/bad/example-monorepo`, { recursive: true });
    writeJson(`${r.T}/bad/example-monorepo/profile.json`, bad);
    const vb = r.hades(["project", "validate", `${r.T}/bad/example-monorepo/profile.json`], { cwd: r.C, env: PK });
    out += `$ validate (ref ausente)\n${vb.out}rc=${vb.rc}\n`;
    const args = "new impl-r --role impl --branch svc/feat/SOFTWARE-777-x --new-card Titulo --tags a,b --desc Descricao";
    const a = r.agent(args.split(" "), { env: { ...PK, HADES_ORCH_CLICKUP_ASSIGNEE: "42" } });
    out += `$ hades agent ${args}\n${a.out}rc=${a.rc}\n${readFileSync(`${pk}/bin/calls.log`, "utf8")}`;
    checkText("refs.txt", r.norm(out));
    checkText("refs-brief.md", r.norm(readFileSync(`${r.T}/agents/impl-r/.design-sync-reports/brief.md`, "utf8")));
  });

  test("refs-nocard.txt", () => {
    const p = readJson(`${pk}/profile.json`); delete p.card; p.card = { provider: "none" }; writeJson(`${pk}/profile.json`, p);
    let out = "";
    for (const args of ["new impl-t --role impl --branch svc/feat/sem-card-x", "new impl-u --role impl --branch svc/feat/y --card X-1"]) {
      const a = r.agent(args.split(" "), { env: PK });
      out += `$ hades agent ${args}\n${a.out}rc=${a.rc}\n`;
    }
    out += `${readJson(`${r.T}/work/example__monorepo/orchestration/agents/impl-t.json`).key}\n`;
    out += r.norm(readFileSync(`${r.T}/agents/impl-t/.design-sync-reports/brief.md`, "utf8")).split("\n")
      .filter((l) => /Título da PR|Modo|Regras do projeto/.test(l)).map((l) => l + "\n").join("");
    checkText("refs-nocard.txt", r.norm(out));
  });
});
