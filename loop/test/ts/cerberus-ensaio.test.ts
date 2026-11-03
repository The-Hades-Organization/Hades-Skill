// Guarda plugin-ensaio-isolado (reference/cerberus/limiar.md): o código executável do plugin roda num bubblewrap com uma
// cópia descartável do $D; o $D real nunca é tocado. Cada caso monta um pacote git local e chama a guarda pela CLI.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUN, SKILL } from "./lib/rig";

const HAS_BWRAP = Bun.which("bwrap") !== null;
const bw = HAS_BWRAP ? test : test.skip;
const T = mkdtempSync(join(tmpdir(), "hades-ensaio-"));
afterAll(() => rmSync(T, { recursive: true, force: true }));

interface Verdict { resultado: string; evidencia: { conferido: string; onde: string }[]; detalhe?: string }
interface Pack { pack: string; commit: string; data: string; home: string }

const git = (cwd: string, ...a: string[]) =>
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd, encoding: "utf8" });

let n = 0;
/** Pacote git com o env/ dado ({caminho: conteúdo}); devolve a pasta, o commit e um $D e um HOME descartáveis. */
function mkPack(files: Record<string, string>, pluginJson: object = { name: "ens" }): Pack {
  const root = join(T, `c${++n}`);
  const pack = join(root, "pack"), data = join(root, "D"), home = join(root, "home");
  for (const d of [pack, data, home, join(pack, "env")]) mkdirSync(d, { recursive: true });
  git(pack, "init", "-q", "-b", "main");
  writeFileSync(join(pack, "profile.json"), JSON.stringify({ name: "ens", env: { pack: "env" } }));
  writeFileSync(join(pack, "env/plugin.json"), JSON.stringify(pluginJson));
  for (const [rel, body] of Object.entries(files)) {
    const p = join(pack, "env", rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(p, 0o755);
  }
  git(pack, "add", "-A"); git(pack, "commit", "-qm", "v1");
  return { pack, commit: git(pack, "rev-parse", "HEAD").stdout.trim(), data, home };
}

function ensaio(p: Pack, env: Record<string, string> = {}): Verdict {
  const r = spawnSync(BUN, [join(SKILL, "src/cli.ts"), "cerberus-check", "limiar", "ensaio"], {
    cwd: p.pack, encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "", HOME: p.home, HADES_DATA: p.data, CERBERUS_SKILL: SKILL, CERBERUS_MOMENTO: "plugin",
      CERBERUS_CTX: JSON.stringify({ plugin: "ens", commit: p.commit, op: "enable", pack_dir: p.pack }), ...env,
    },
  });
  return JSON.parse(r.stdout) as Verdict;
}
const texto = (v: Verdict) => v.evidencia.map((e) => `${e.conferido} @ ${e.onde}`).join("\n");

describe("plugin-ensaio-isolado", () => {
  bw("post-install que só escreve no $D passa e o $D real fica intacto", () => {
    const p = mkPack({ "post-install.sh": 'touch "$HADES_DATA/ran"' });
    const v = ensaio(p);
    expect(v.resultado).toBe("ok");
    expect(texto(v)).toContain("post-install.sh: ensaiado");
    expect(existsSync(join(p.data, "ran"))).toBe(false);
  });

  bw("escrita no HOME fora do $D barra e nomeia o caminho", () => {
    const p = mkPack({ "post-install.sh": 'echo x > "$HOME/fora.txt"' });
    const v = ensaio(p);
    expect(v.resultado).toBe("barra");
    expect(texto(v)).toContain(join(p.home, "fora.txt"));
    expect(existsSync(join(p.home, "fora.txt"))).toBe(false);
  });

  bw("escrita em pasta irmã do $D (sob /tmp) barra com o caminho", () => {
    const p = mkPack({ "post-install.sh": 'echo x > "$HADES_DATA/../solto.txt"' });
    const v = ensaio(p);
    expect(v.resultado).toBe("barra");
    expect(texto(v)).toContain("solto.txt");
    expect(existsSync(join(p.data, "..", "solto.txt"))).toBe(false);
  });

  bw("rede sem declaração barra", () => {
    const p = mkPack({ "post-install.sh": "exec 3<>/dev/tcp/127.0.0.1/9" });
    const v = ensaio(p);
    expect(v.resultado).toBe("barra");
    expect(texto(v)).toMatch(/rede/);
  });

  bw("rede declarada no plugin.json passa e registra o motivo", () => {
    const srv = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    try {
      const p = mkPack({ "post-install.sh": `exec 3<>/dev/tcp/127.0.0.1/${srv.port}` },
        { name: "ens", ensaio: { rede: [{ item: "post-install.sh", motivo: "baixa o asset do simulador" }] } });
      const v = ensaio(p);
      expect(v.resultado).toBe("ok");
      expect(texto(v)).toContain("rede liberada por declaração");
      expect(texto(v)).toContain("baixa o asset do simulador");
    } finally { srv.stop(true); }
  });

  bw("script que falha no ensaio barra", () => {
    const p = mkPack({ "post-install.sh": "exit 3" });
    const v = ensaio(p);
    expect(v.resultado).toBe("barra");
    expect(texto(v)).toContain("post-install.sh");
    expect(texto(v)).toContain("saiu com 3");
  });

  bw("script que chama docker não é ensaiado e não barra", () => {
    const p = mkPack({ "post-install.sh": "docker compose up -d" });
    const v = ensaio(p);
    expect(v.resultado).toBe("ok");
    expect(texto(v)).toContain("não ensaiado (docker)");
  });

  bw("doctor.sh e checks/ também são ensaiados", () => {
    const p = mkPack({ "doctor.sh": 'ok G x "tudo"', "checks/a.sh": 'echo feito' });
    const v = ensaio(p);
    expect(v.resultado).toBe("ok");
    expect(texto(v)).toContain("doctor.sh: ensaiado");
    expect(texto(v)).toContain("checks/a.sh: ensaiado");
  });

  describe("escrita declarada em ensaio.escrita[]", () => {
    const mkWt = (): string => {
      const wt = join(T, `wt${++n}`);
      mkdirSync(join(wt, "tools"), { recursive: true });
      writeFileSync(join(wt, "tools/velho.txt"), "v");
      return wt;
    };
    const decl = (caminho: string) => ({ name: "ens", ensaio: { escrita: [{ item: "post-install.sh", caminho, motivo: "extrai o simulador" }] } });

    bw("escrita no worktree sem declaração barra com o caminho", () => {
      const wt = mkWt();
      const v = ensaio(mkPack({ "post-install.sh": 'echo x > "$HADES_WT/tools/novo.txt"' }), { HADES_WT: wt });
      expect(v.resultado).toBe("barra");
      expect(texto(v)).toContain(join(wt, "tools/novo.txt"));
    });

    bw("escrita no caminho declarado passa, registra o motivo e o worktree real fica intacto", () => {
      const wt = mkWt();
      const p = mkPack({ "post-install.sh": 'echo x > "$HADES_WT/tools/novo.txt"; test -f "$HADES_WT/tools/velho.txt"' }, decl("tools"));
      const v = ensaio(p, { HADES_WT: wt });
      expect(v.resultado).toBe("ok");
      expect(texto(v)).toContain("escrita liberada por declaração");
      expect(texto(v)).toContain("tools");
      expect(texto(v)).toContain("extrai o simulador");
      expect(existsSync(join(wt, "tools/novo.txt"))).toBe(false);
    });

    bw("o caminho declarado não abre o resto do worktree", () => {
      const wt = mkWt();
      const v = ensaio(mkPack({ "post-install.sh": 'echo x > "$HADES_WT/outro.txt"' }, decl("tools")), { HADES_WT: wt });
      expect(v.resultado).toBe("barra");
      expect(texto(v)).toContain("outro.txt");
    });

    bw("caminho declarado que sai do worktree é ignorado e a escrita barra", () => {
      const wt = mkWt();
      const v = ensaio(mkPack({ "post-install.sh": 'echo x > "$HADES_WT/tools/novo.txt"' }, decl("../tools")), { HADES_WT: wt });
      expect(v.resultado).toBe("barra");
    });

    bw("a declaração vale só para o item nomeado", () => {
      const wt = mkWt();
      const p = mkPack({ "checks/a.sh": 'echo x > "$HADES_WT/tools/novo.txt"' }, decl("tools"));
      const v = ensaio(p, { HADES_WT: wt });
      expect(v.resultado).toBe("barra");
    });
  });

  // connect() num socket Unix não é barrado por montagem somente leitura nem por --unshare-net: o ensaio esconde /run, /tmp e afins
  const HAS_DOCKER_SOCK = existsSync("/var/run/docker.sock") && Bun.which("curl") !== null;
  (HAS_BWRAP && HAS_DOCKER_SOCK ? test : test.skip)("curl no docker.sock do host não alcança o daemon dentro do ensaio", () => {
    const p = mkPack({ "post-install.sh": "curl -fsS --max-time 5 --unix-socket /var/run/docker.sock http://x/version >/dev/null" });
    const v = ensaio(p);
    expect(v.resultado).toBe("barra");
    expect(texto(v)).toContain("post-install.sh: barrado");
  });

  (HAS_BWRAP && Bun.which("curl") !== null ? test : test.skip)("socket Unix do host fora do $D não alcança o servidor dentro do ensaio", () => {
    // o servidor é outro processo: o ensaio roda com spawnSync, que pararia o laço de eventos deste
    const sock = join(T, `host-${++n}.sock`), hitsFile = `${sock}.hits`;
    const srv = Bun.spawn([BUN, "-e", `import {appendFileSync} from "node:fs"; Bun.serve({unix: ${JSON.stringify(sock)}, fetch() { appendFileSync(${JSON.stringify(hitsFile)}, "x"); return new Response("ok"); }}); setInterval(() => {}, 1000);`]);
    try {
      for (let i = 0; i < 100 && !existsSync(sock); i++) Bun.sleepSync(50);
      expect(existsSync(sock)).toBe(true);
      const p = mkPack({ "post-install.sh": `curl -fsS --max-time 5 --unix-socket ${sock} http://x/ >/dev/null` });
      const v = ensaio(p);
      expect(v.resultado).toBe("barra");
      expect(existsSync(hitsFile)).toBe(false);
    } finally { srv.kill(); }
  });

  test("sem bwrap no PATH vira aviso com como instalar", () => {
    const p = mkPack({ "post-install.sh": "true" });
    const bin = join(T, "bin-sem-bwrap");
    mkdirSync(bin, { recursive: true });
    symlinkSync(Bun.which("git") as string, join(bin, "git")); // a guarda lê o commit com o git; só o bwrap falta
    const v = ensaio(p, { PATH: bin });
    expect(v.resultado).toBe("aviso");
    expect(texto(v)).toContain("bubblewrap");
    expect(texto(v)).toContain("não ensaiado");
  });

  test("plugin sem código executável ensaiável passa dizendo o que não havia", () => {
    const p = mkPack({});
    const v = ensaio(p);
    expect(v.resultado).toBe("ok");
    expect(texto(v)).toContain("nada a ensaiar");
  });

  test("a guarda está registrada no momento plugin", () => {
    expect(existsSync(join(SKILL, "loop/cerberus/limiar/plugin-ensaio-isolado.json"))).toBe(true);
  });
});
