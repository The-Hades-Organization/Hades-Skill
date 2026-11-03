// Grupo defeitos-py-fim: defeitos registrados na 4.22.0, cada um com o teste que falhava antes da correção.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { releaseRange } from "../../../src/commands/skill-release.ts";
import { BUN, Rig, SKILL } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());

describe("4a: a fila do gate-lock da regressão da skill é da máquina, não do projeto do worktree", () => {
  test("status de um projeto com remote mostra o gate rodando na fila da máquina", async () => {
    const env = { ...r.env0, HADES_GATE_SCOPE: "maquina", GATE_LOCK_NO_SYSTEMD: "1" };
    const gate = Bun.spawn([BUN, `${SKILL}/src/cli.ts`, "gate-lock", "run", "test", "--label", "regressao-skill", "--", "sleep", "4"], { env, cwd: r.C, stdout: "ignore", stderr: "ignore" });
    try {
      let out = "";
      for (let i = 0; i < 40 && !out.includes("regressao-skill"); i += 1) {
        await Bun.sleep(100);
        out = r.hades(["gate-lock", "status"], { cwd: r.C }).out;
      }
      expect(out).toContain("fila da máquina (_maquina):");
      expect(out).toContain("label=regressao-skill");
      expect(out).not.toContain("nenhum gate");
    } finally { gate.kill(); await gate.exited; }
  });

  test("sem gate nenhum, o status segue dizendo que não há", () => {
    expect(r.hades(["gate-lock", "status"], { cwd: r.P }).out).toContain("nenhum gate na fila nem rodando");
  });
});

describe("4d: drift de instalação numa versão anterior do kit não é edição à mão", () => {
  const data = `${r.T}/drift-data`;
  const drift = () => r.X([BUN, `${SKILL}/src/cli.ts`, "skill-release", "drift"], {
    merge: true, env: { HADES_DATA: data, HADES_WT: r.C, HADES_PACKS_ROOT: `${r.T}/packs-vazio` },
  });
  mkdirSync(data, { recursive: true });
  mkdirSync(`${r.T}/packs-vazio`, { recursive: true });
  writeFileSync(`${data}/env.sh`, `W="${r.C}"\n`);
  writeFileSync(`${data}/clean.sh`, "#!/bin/bash\n# versão antiga\n");

  test("kit.version diferente da VERSION: diz que a instalação está desatualizada e manda reinstalar", () => {
    writeFileSync(`${data}/kit.version`, "0.0.1\n");
    const x = drift();
    expect(x.all).toContain("instalação desatualizada");
    expect(x.all).toContain("reinstale");
    expect(x.all).not.toContain("editado em $D");
    expect(x.rc).toBe(1);
  });

  test("kit.version igual à VERSION: o arquivo diferente segue acusado como editado à mão", () => {
    writeFileSync(`${data}/kit.version`, `${readFileSync(`${SKILL}/VERSION`, "utf8").trim()}\n`);
    const x = drift();
    expect(x.all).toContain("editado em $D");
    expect(x.all).not.toContain("instalação desatualizada");
  });
});

describe("4e: plan-approve de um plano da skill, rodado de um projeto, recusa em vez de registrar na raiz do projeto", () => {
  const plano = `${r.H}/.claude/hades/plans/evolucao.md`;
  mkdirSync(`${r.H}/.claude/hades/plans`, { recursive: true });
  writeFileSync(plano, "# Plano\n\n## Objetivo\nx\n");

  test("cwd de projeto + plano em ~/.claude/hades/plans: recusa e não grava plan.json", () => {
    const x = r.agent(["plan-approve", plano]);
    expect(x.rc).not.toBe(0);
    expect(x.out).toContain("plano de escopo skill");
    expect(existsSync(`${r.T}/work/example__monorepo/orchestration/plan.json`)).toBe(false);
  });
});

describe("4f: o segredo-diff do release recebe o range do que a release leva", () => {
  const G = `${r.T}/skill-range`;
  mkdirSync(G, { recursive: true });
  r.must(r.git(G, "init", "-q", "-b", "main"));
  const commit = (version: string, file: string): string => {
    writeFileSync(`${G}/VERSION`, `${version}\n`); writeFileSync(`${G}/${file}`, `${file}\n`);
    r.must(r.git(G, "add", "-A")); r.must(r.git(G, "commit", "-qm", `c ${file}`));
    return r.git(G, "rev-parse", "HEAD").out.trim();
  };
  const v1 = commit("1.0.0", "a"); const v2 = commit("1.1.0", "b"); commit("1.1.0", "c");

  test("release novo: da última subida de VERSION até o HEAD", () => { expect(releaseRange(G, false)).toBe(`${v2}..HEAD`); });
  test("release same (VERSION já subida): da subida anterior", () => { expect(releaseRange(G, true)).toBe(`${v1}..HEAD`); });
  test("sem nenhuma subida de VERSION: sem range, a Porta decide", () => {
    const vazio = `${r.T}/skill-range-vazio`;
    mkdirSync(vazio, { recursive: true }); r.must(r.git(vazio, "init", "-q", "-b", "main"));
    expect(releaseRange(vazio, false)).toBe("");
  });
});
