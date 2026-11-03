// Grupo plugin: faixa `core` do perfil de um plugin — validate, core-check e recusa do install.sh.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { FX, Rig, SKILL, readJson, writeJson } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());
// o contrato de plugin exige núcleo >=5: o install roda de uma cópia da skill com VERSION 5.0.0 (independe da versão em desenvolvimento)
const SK = `${r.T}/skill-5`;
r.skillCopy(SK); writeFileSync(`${SK}/VERSION`, "5.0.0\n");

describe("rig: prazo de cada processo (um travamento vira falha rápida, nunca um worker preso)", () => {
  const vivo = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  // o neto vive muito mais que qualquer folga razoável: esperar por ele seria o defeito, e a asserção de tempo é relativa a ele, não à carga da máquina
  const VIDA_DO_NETO_S = 60;
  test("processo que não termina lança erro legível dentro do prazo e morre com os netos", () => {
    const pidf = `${r.T}/neto.pid`;
    let msg = "";
    try {
      // o filho (sh) prende o neto (sleep) e espera por ele: matar só o sh deixaria o sleep vivo
      r.X(["sh", "-c", `sleep ${VIDA_DO_NETO_S} & echo $! > '${pidf}'; wait`], { timeoutMs: 700 });
    } catch (e) { msg = (e as Error).message; }
    const neto = Number(readFileSync(pidf, "utf8"));
    const vivoDepois = vivo(neto);
    if (vivoDepois) process.kill(neto, "SIGKILL"); // não vaza o neto se o rig falhar
    expect(msg).toMatch(/processo travou: excedeu 700 ms .*pid \d+, decorridos \d+ ms\): sh -c/);
    const decorridos = Number(/decorridos (\d+) ms/.exec(msg)?.[1]);
    expect(decorridos, "só morre depois do prazo").toBeGreaterThanOrEqual(700);
    expect(decorridos, "falha sem esperar o neto").toBeLessThan((VIDA_DO_NETO_S * 1000) / 2);
    expect(vivoDepois, "o neto não ficou vivo").toBe(false);
  });
  test("processo que termina no prazo devolve rc e saída como antes", () => {
    const o = r.X(["sh", "-c", "echo oi; exit 3"], { timeoutMs: 5000 });
    expect(`${o.rc} ${o.out.trim()}`).toBe("3 oi");
  });
});

describe("rig: contrato do X (espera síncrona sem o laço do Bun.spawnSync)", () => {
  test("stdin chega ao processo", () => expect(r.X(["cat"], { stdin: "abc\ndef" }).out).toBe("abc\ndef"));
  test("sem stdin o processo vê o fim do arquivo, não um terminal", () => expect(r.X(["sh", "-c", "cat; echo fim"]).out).toBe("fim\n"));
  test("stdout e stderr vêm separados; com merge, juntos e na ordem", () => {
    const sep = r.X(["sh", "-c", "echo a; echo b >&2"]);
    expect([sep.out, sep.err, sep.all]).toEqual(["a\n", "b\n", "a\nb\n"]);
    const mer = r.X(["sh", "-c", "echo a; echo b >&2; echo c"], { merge: true });
    expect([mer.out, mer.err, mer.all]).toEqual(["a\nb\nc\n", "", "a\nb\nc\n"]);
  });
  test("cwd e env valem só para o processo e o ambiente do rig é fechado", () => {
    const o = r.X(["sh", "-c", 'pwd; echo "$K"; echo "${HOME}"'], { cwd: r.T, env: { K: "v" } });
    expect(o.out).toBe(`${r.T}\nv\n${r.H}\n`);
    expect(r.X(["sh", "-c", 'echo "[$K]"']).out).toBe("[]\n");
  });
  test("saída muito maior que o buffer de um pipe volta inteira", () => {
    const o = r.X(["sh", "-c", "head -c 400000 /dev/zero | tr '\\0' x; head -c 400000 /dev/zero | tr '\\0' y >&2"]);
    expect([o.out.length, o.err.length]).toEqual([400000, 400000]);
  });
  test("rc do processo, inclusive o de comando inexistente; morte por sinal nunca vira sucesso", () => {
    expect(r.X(["sh", "-c", "exit 7"]).rc).toBe(7);
    expect(r.X(["comando-que-nao-existe-hades"]).rc).toBe(127);
    expect(r.X(["sh", "-c", "kill -9 $$"]).rc).not.toBe(0);
  });
  test("o `timeout` do próprio teste devolve 124 sem virar travamento", () => expect(r.X(["timeout", "0.3", "sleep", "5"]).rc).toBe(124));
  test("filhos assíncronos do próprio worker que terminam durante a espera não atrapalham", async () => {
    // o painel em processo dos outros arquivos dispara `gh` assim (Bun.spawn com stdout em pipe) e o worker segue chamando X
    const ass = Array.from({ length: 6 }, () => Bun.spawn(["sh", "-c", "exit 0"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" }));
    const rcs = Array.from({ length: 40 }, () => r.X(["sh", "-c", "sleep 0.01; exit 0"]).rc);
    expect(rcs.every((c) => c === 0)).toBe(true);
    expect(await Promise.all(ass.map((p) => p.exited))).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe("plugin", () => {
  const PK = `${r.T}/packs-plugin`, CL = `${r.T}/clone/plugin-proj`, ID = `${r.T}/plugin-data`;
  mkdirSync(`${PK}/plugin-proj`, { recursive: true }); r.mkrepo("acme/plugin-proj", CL);
  const E = { HADES_PACKS_ROOT: PK };
  /** Grava o perfil do plugin com (ou sem, "-") `core`. */
  const setcore = (c: string) => {
    const p = readJson(`${FX}/packs/example-monorepo/profile.json`);
    p.name = "plugin-proj"; p.identity = { repo: "acme/plugin-proj" }; delete p.refs; delete p.domainTerms; if (p.card) delete p.card.create;
    if (c !== "-") p.core = c;
    writeJson(`${PK}/plugin-proj/profile.json`, p);
  };
  const cc = (v: string) => r.hades(["project", "core-check", "--dir", CL, "--version", v], { env: E, merge: true });
  const validate = () => r.hades(["project", "validate", `${PK}/plugin-proj/profile.json`], { env: E, merge: true });
  const version = Bun.file(`${SK}/VERSION`).text();
  const install = (data: string) => r.X(["bash", `${SK}/kit/install.sh`], { merge: true, env: { ...E, HADES_WT: CL, HADES_DATA: data, SKIP_SYSTEMD: "1", SKIP_WORKTREE: "1", SKIP_DOCTOR: "1" } });

  test("core que aceita núcleo <5 é recusado (core_out_of_range, contrato api.ts)", () => {
    setcore(">=4.3 <5"); const o = cc("4.3.0");
    expect(o.rc === 1 && o.out.startsWith("fora\tplugin-proj\t") && o.out.includes("anterior à 5.0.0") && o.out.includes("api.ts"), `rc=${o.rc}: ${o.out}`).toBe(true);
  });
  test("núcleo dentro da faixa passa", () => {
    setcore(">=5 <6"); const o = cc("5.0.0");
    expect(o.rc === 0 && o.out.startsWith("ok\tplugin-proj\t"), `rc=${o.rc}: ${o.out}`).toBe(true);
  });
  test("limite superior ainda dentro", () => expect(cc("5.9.2").rc).toBe(0));
  test("núcleo acima da faixa é recusado, com as duas versões", () => {
    const o = cc("6.0.0");
    expect(o.rc === 1 && o.out.includes("pede o núcleo >=5 <6") && o.out.includes("instalado é o 6.0.0") && /git -C .* pull/.test(o.out), `rc=${o.rc}: ${o.out}`).toBe(true);
  });
  test("núcleo abaixo da faixa é recusado", () => expect(cc("4.2.0").rc).toBe(1));
  test("5.3.x aceita 5.3.7 e recusa 5.4.0", () => {
    setcore("5.3.x");
    expect(cc("5.3.7").rc, "plugin: 5.3.x aceita 5.3.7").toBe(0);
    expect(cc("5.4.0").rc, "plugin: 5.3.x recusa 5.4.0").toBe(1);
  });
  test("sintaxe inválida no core é recusada", () => {
    setcore(">=5 <"); const o = cc("5.0.0");
    expect(o.rc === 1 && o.out.includes("invalido\t"), `rc=${o.rc}: ${o.out}`).toBe(true);
  });
  test("validate recusa a sintaxe inválida", () => {
    const v = validate(); expect(v.out.startsWith("✗") && v.out.includes("$.core")).toBe(true);
  });
  test("validate aceita a faixa e não avisa", () => {
    setcore(">=5"); const v = validate(); expect(v.out.startsWith("ok") && !v.out.includes("aviso"), v.out).toBe(true);
  });
  test("perfil sem core segue (exit 0) e avisa", () => {
    setcore("-"); const o = cc("5.0.0");
    expect(o.rc === 0 && o.out.includes("sem-core\t") && o.out.includes("aviso:"), `rc=${o.rc}: ${o.out}`).toBe(true);
  });
  test("validate de perfil sem core passa com aviso", () => {
    const v = validate();
    expect(v.rc === 0 && v.out.includes("ok ") && /aviso:.*sem `core`/.test(v.out), `rc=${v.rc}: ${v.out}`).toBe(true);
  });
  test("repo sem perfil sai 3", () => expect(r.hades(["project", "core-check", "--dir", r.P], { env: E, merge: true }).rc).toBe(3));

  test("install recusa núcleo fora da faixa, sem instalar", async () => {
    setcore(">=9"); const o = install(ID);
    const ver = (await version).split("\n")[0];
    expect(o.rc !== 0 && o.out.includes("pede o núcleo >=9") && o.out.includes(`o núcleo instalado é o ${ver}`) && !existsSync(`${ID}/env.sh`), `rc=${o.rc}: ${o.out}`).toBe(true);
  });
  test("install com o núcleo na faixa instala", async () => {
    setcore(`>=${(await version).split("\n")[0]}`); const o = install(ID);
    expect(o.rc === 0 && existsSync(`${ID}/env.sh`), `rc=${o.rc}: ${o.out}`).toBe(true);
  });
  test("install de perfil sem core só avisa", () => {
    setcore("-"); const o = install(`${r.T}/plugin-data2`);
    expect(o.rc === 0 && /aviso:.*core/.test(o.out), `rc=${o.rc}: ${o.out}`).toBe(true);
  });
});
