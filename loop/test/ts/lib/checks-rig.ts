// Equipamento dos testes de paridade dos checks do Cerberus: raiz temporária, stubs de `gh` e `devtunnel` no PATH,
// repositórios git de fixture e a execução do check pela CLI (`hades cerberus-check`), comparada com o veredito gravado.
import { afterAll, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Legado } from "./legado";
import { BUN, SKILL } from "./rig";

export interface Cfg { dir: string; ctx?: Record<string, string>; env?: Record<string, string>; momento?: string; args?: string[] }

/** `cabeca`: `porta` (guarda = `porta/<guarda>`) ou `vigilia` (guarda = auditoria|coerencia, argumento = a guarda). */
export function checksRig(g: Legado, cabeca: "porta" | "vigilia") {
  const T = mkdtempSync(join(tmpdir(), "hades-checks-"));
  afterAll(() => rmSync(T, { recursive: true, force: true }));
  const BIN = join(T, "bin");
  const PACKS = join(T, "packs");
  mkdirSync(BIN, { recursive: true });
  mkdirSync(PACKS, { recursive: true });
  let n = 0;
  const next = () => n++;

  function stub(name: string, text: string): void {
    writeFileSync(join(BIN, name), `#!/usr/bin/env bash\n${text}\n`);
    chmodSync(join(BIN, name), 0o755);
  }
  // gh api repos/<slug>/branches/<b> → STUB_PROTEGIDA (true|false|erro); gh api user → STUB_LOGIN; gh pr view → STUB_HEAD; gh pr list → STUB_PRS
  stub("gh", [
    'case "$2" in',
    '  repos/*) [[ "$STUB_PROTEGIDA" == erro ]] && { echo "HTTP 404" >&2; exit 1; }; echo "${STUB_PROTEGIDA:-false}" ;;',
    '  user) [[ -n "$STUB_LOGIN" ]] && { echo "$STUB_LOGIN"; exit 0; }; echo "sem login" >&2; exit 1 ;;',
    '  list) [[ "$STUB_PRS" == erro ]] && { echo "falhou" >&2; exit 1; }; echo "${STUB_PRS:-[]}" ;;',
    '  *) [[ -n "$STUB_HEAD" ]] && { echo "$STUB_HEAD"; exit 0; }; echo "sem pr" >&2; exit 1 ;;',
    "esac",
  ].join("\n"));
  stub("devtunnel", '[[ "$STUB_TUNEL" == erro ]] && { echo "falhou" >&2; exit 1; }; echo "${STUB_TUNEL:-Anonymous  Connect}"');
  // herdr agent list → STUB_HERDR (JSON) ou falha
  stub("herdr", '[[ -z "$STUB_HERDR" ]] && { echo "sem herdr" >&2; exit 1; }; echo "$STUB_HERDR"');

  const git = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", cwd, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return Buffer.from(r.stdout).toString().trim();
  };

  /** Repositório novo com um commit; origin opcional. */
  function repo(origin = "git@github.com:acme/widget.git"): string {
    const d = join(T, `r${next()}`);
    mkdirSync(d);
    git(d, "init", "-q", "-b", "feature");
    git(d, "config", "user.email", "t@t");
    git(d, "config", "user.name", "t");
    if (origin) git(d, "remote", "add", "origin", origin);
    writeFileSync(join(d, "a.txt"), "um\n");
    git(d, "add", "-A");
    git(d, "commit", "-qm", "um");
    return d;
  }

  function run(guard: string, c: Cfg): string {
    const alvo = cabeca === "porta" ? [`cerberus-check`, `porta/${guard}`] : [`cerberus-check`, `vigilia/${guard}`];
    const r = Bun.spawnSync([BUN, join(SKILL, "src/cli.ts"), ...alvo, ...(c.args ?? [])], {
      cwd: c.dir,
      env: {
        HOME: join(T, "home"), PATH: `${BIN}:${process.env.PATH}`, LANG: "C.UTF-8", HADES_PACKS_ROOT: PACKS, HADES_WORK_ROOT: join(T, "work"),
        HADES_CERBERUS_PORTA_TUNEL_HOSTS: "*.devtunnels.ms", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
        CERBERUS_DIR: c.dir, CERBERUS_SKILL: SKILL, CERBERUS_MOMENTO: c.momento ?? "push", CERBERUS_CTX: JSON.stringify(c.ctx ?? {}), ...c.env,
      },
    });
    return `${Buffer.from(r.stdout).toString()}rc=${r.exitCode}\n${Buffer.from(r.stderr).toString()}`;
  }

  // os hashes de commit (completos, de 12 e de 7 dígitos) mudam a cada execução (o instante entra no hash)
  const nz = (s: string) => s.replaceAll(T, "<T>").replace(/\b(?=[0-9a-f]*\d)(?:[0-9a-f]{40}|[0-9a-f]{12}|[0-9a-f]{7})\b/g, "<sha>");
  let seq = 0;
  /** A CLI × o veredito gravado (chave: ordem da chamada, guarda e argumentos). */
  function same(guard: string, c: Cfg, normalize: (s: string) => string = (s) => s): string {
    const chave = `${seq++}:${guard} ${JSON.stringify(c.args ?? [])}`;
    const gravado = g.get<string>(chave);
    expect(normalize(nz(run(guard, c))), `${guard} ${JSON.stringify(c.args ?? [])} ${JSON.stringify(c.ctx ?? {})}`).toBe(gravado);
    return gravado;
  }
  const resultado = (out: string) => (JSON.parse(out.split("\n")[0] as string) as { resultado: string }).resultado;

  return { T, PACKS, next, stub, git, repo, same, resultado, work: join(T, "work") };
}
