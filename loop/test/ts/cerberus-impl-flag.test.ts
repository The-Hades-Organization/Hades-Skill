// HADES_CERBERUS_IMPL: `rust` delega `hades cerberus` e `hades cerberus-check` ao binário (argv, stdin, saída e código
// repassados), o hook registra pelo `cerberus registrar`, e a ponte `rpc` fica no TS; `ts` e o padrão não mudam.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../../../src/cli.ts");
const root = mkdtempSync(join(tmpdir(), "cerberus-flag-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const stub = join(root, "cerberus");
writeFileSync(stub, '#!/bin/sh\necho "argv:$*"\nread l; echo "stdin:$l"\necho "erro" >&2\nexit 7\n');
chmodSync(stub, 0o755);

const gravado = join(root, "registrar.txt");
const stubRegistro = join(root, "cerberus-registro");
writeFileSync(stubRegistro, `#!/bin/sh\nprintf '%s\\n' "$@" > '${gravado}'\n`);
chmodSync(stubRegistro, 0o755);

function hades(args: string[], env: Record<string, string>, input = "") {
  const home = join(root, "home");
  const r = Bun.spawnSync([process.execPath, CLI, ...args], {
    stdin: new TextEncoder().encode(input),
    env: { PATH: process.env.PATH ?? "", HOME: home, HADES_HOME: home, ...env },
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("HADES_CERBERUS_IMPL", () => {
  test("dado rust e binário em HADES_CERBERUS_BIN, então argv, stdin, saída, erro e código passam", () => {
    const r = hades(["cerberus", "historico", "--json"], { HADES_CERBERUS_IMPL: "rust", HADES_CERBERUS_BIN: stub }, "oi\n");
    expect(r.out).toBe("argv:historico --json\nstdin:oi\n");
    expect(r.err).toBe("erro\n");
    expect(r.code).toBe(7);
  });

  test("dado rust, então cerberus-check <alvo> vira cerberus check <alvo>", () => {
    const r = hades(["cerberus-check", "porta-push", "--x"], { HADES_CERBERUS_IMPL: "rust", HADES_CERBERUS_BIN: stub }, "j\n");
    expect(r.out).toBe("argv:check porta-push --x\nstdin:j\n");
    expect(r.code).toBe(7);
  });

  test("dado rust e cerberus só no PATH, então o do PATH roda nos dois comandos", () => {
    const bin = join(root, "pathbin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "cerberus"), readFileSync(stub));
    chmodSync(join(bin, "cerberus"), 0o755);
    const env = { HADES_CERBERUS_IMPL: "rust", PATH: `${bin}:${process.env.PATH}` };
    expect(hades(["cerberus", "modos"], env, "a\n").out).toBe("argv:modos\nstdin:a\n");
    expect(hades(["cerberus-check", "g"], env, "b\n").out).toBe("argv:check g\nstdin:b\n");
  });

  test("dado rust sem binário, então 69 com mensagem clara e sem cair no TS", () => {
    for (const args of [["cerberus", "modos"], ["cerberus-check", "g"]]) {
      const r = hades(args, { HADES_CERBERUS_IMPL: "rust", PATH: "/nonexistent" });
      expect(r.code).toBe(69);
      expect(r.err).toContain("HADES_CERBERUS_IMPL=rust");
      expect(r.out).toBe("");
    }
  });

  test("dado valor inválido, então 2", () => {
    const r = hades(["cerberus", "modos"], { HADES_CERBERUS_IMPL: "go" });
    expect(r.code).toBe(2);
    expect(r.err).toContain("ts ou rust");
  });

  test("dado rust, então a ponte rpc fica no TS e o binário não roda", () => {
    const r = hades(["cerberus", "rpc", "operacao-inexistente"], { HADES_CERBERUS_IMPL: "rust", HADES_CERBERUS_BIN: stub }, "{}\n");
    expect(r.out).not.toContain("argv:");
    expect(r.err).not.toContain("HADES_CERBERUS_IMPL");
  });

  test("dado o padrão ou ts, então o TS responde e o stub não roda", () => {
    for (const env of [{} as Record<string, string>, { HADES_CERBERUS_IMPL: "ts" }]) {
      const r = hades(["cerberus"], { ...env, HADES_CERBERUS_BIN: stub });
      expect(r.out).not.toContain("argv:");
      expect(r.code).toBe(2);
    }
  });
});

describe("hook com HADES_CERBERUS_IMPL", () => {
  const entrada = (command: string) =>
    JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", session_id: "s1", cwd: root, tool_input: { command } });

  test("dado rust e um bloqueio, então o hook barra e registra pelo cerberus registrar", () => {
    rmSync(gravado, { force: true });
    const r = hades(["guard"], { HADES_CERBERUS_IMPL: "rust", HADES_CERBERUS_BIN: stubRegistro }, entrada("hades cerberus excecao abrir --x"));
    expect(r.code).toBe(2);
    expect(readFileSync(gravado, "utf8").split("\n").slice(0, 9)).toEqual([
      "registrar", "--cabeca", "vigilia", "--guarda", "excecao-so-dono", "--momento", "continuo", "--resultado", "barra",
    ]);
    expect(readFileSync(gravado, "utf8")).toContain("--evidencia\nbarrado: abrir exceção do Cerberus|Bash da sessão s1\n--dir\n");
  });

  test("dado rust sem binário, então o hook barra igual e não registra", () => {
    rmSync(gravado, { force: true });
    const r = hades(["guard"], { HADES_CERBERUS_IMPL: "rust", PATH: "/nonexistent" }, entrada("hades cerberus excecao abrir --x"));
    expect(r.code).toBe(2);
    expect(existsSync(gravado)).toBe(false);
  });

  test("dado cerberus excecao abrir direto ou pelo caminho do binário, então barra", () => {
    for (const command of ["cerberus excecao abrir --cabeca porta", "/opt/bin/cerberus excecao abrir", "x; cerberus excecao abrir"]) {
      const r = hades(["guard"], { HADES_CERBERUS_IMPL: "rust", HADES_CERBERUS_BIN: stubRegistro }, entrada(command));
      expect(r.code).toBe(2);
      expect(r.err).toContain("abrir exceção do Cerberus");
    }
  });

  test("dado um comando que só cita cerberus no nome, então não barra pela regra da exceção", () => {
    for (const command of ["ls hades-rust/cerberus-app", "my-cerberus excecao abrir", "echo excecao abrir"]) {
      const r = hades(["guard"], { HADES_CERBERUS_IMPL: "rust", HADES_CERBERUS_BIN: stubRegistro }, entrada(command));
      expect(r.err).not.toContain("abrir exceção do Cerberus");
    }
  });
});
