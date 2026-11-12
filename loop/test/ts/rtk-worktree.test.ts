// Grupo rtk-worktree: o .rtk/filters.toml do worktree com um rtk falso no PATH (gerar, confiar, desligar, ajustar), a trava do
// hook para o agente, o doctor e a categoria rtk-tee da limpeza. reference/rtk.md.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { decide, type HookEnv } from "../../../src/lib/guard-hook";
import { remoteConfigRefusal, rtkTrustState } from "../../../src/panel/routes-core";
import { FILTERS_REL, GENERATED_MARK, applyWorktree, installForWorktree, planWorktree, rtkBinary, rtkSettings, trustState } from "../../../src/lib/rtk-filters";
import { startForWorktree } from "../../../src/lib/rtk-trust";
import { slugOfRemote } from "../../../src/lib/work";
import { Rig, SKILL } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());

const BIN = join(r.T, "rtk-bin");
const NO_RTK_BIN = join(r.T, "sem-rtk-bin");
const LOG = join(r.T, "rtk.log");
const STATE = join(r.T, "rtk.state");
const DATA = join(r.T, "rtk-data");
const FAKE_HOME = join(r.T, "rtk-home");
const OWNER_ENV = { FAKE_RTK_LOG: LOG, FAKE_RTK_STATE: STATE };

/** rtk 1.x falso: --version, `trust --yes` (grava o sha256 do .rtk/filters.toml do cwd) e `trust --list` no formato do rtk. */
const FAKE_RTK = `#!/bin/bash
echo "$PWD $*" >> "$FAKE_RTK_LOG"
case "$1" in
  --version) echo "rtk 1.1.0" ;;
  trust)
    if [[ "$2" == "--list" ]]; then cat "$FAKE_RTK_STATE" 2>/dev/null; exit 0; fi
    f="$(realpath .rtk/filters.toml)"
    printf '%s (trusted 2026-11-04)\\n  sha256:%s\\n' "$f" "$(sha256sum "$f" | cut -d' ' -f1)" >> "$FAKE_RTK_STATE" ;;
esac
`;

let seq = 0;
/** Repositório novo com nx.json + package.json (stack node-nx) e um commit. */
function nxRepo(): string {
  const dir = join(r.T, `wt-${seq++}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "nx.json"), "{}\n");
  writeFileSync(join(dir, "package.json"), "{}\n");
  for (const args of [["init", "-q"], ["add", "."], ["commit", "-qm", "inicial"]]) r.X(["git", ...args], { cwd: dir });
  return dir;
}
const filtersOf = (wt: string): string => readFileSync(join(wt, FILTERS_REL), "utf8");
const logText = (): string => (existsSync(LOG) ? readFileSync(LOG, "utf8") : "");
const settings = (extra: Record<string, string> = {}) => rtkSettings((key) => extra[key]);
const apply = (wt: string, trust: boolean, extra: Record<string, string> = {}) => applyWorktree(wt, settings(extra), { trust, home: FAKE_HOME });

// o PATH, o HOME e os dados do processo de teste (as funções do rtk-filters leem process.env)
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["PATH", "HOME", "HADES_DATA", "HADES_STACKS_ROOT", "HADES_PACKS_ROOT", ...Object.keys(OWNER_ENV)];
const withRtk = (): void => { process.env.PATH = `${BIN}:${r.env0.PATH}`; };
const withoutRtk = (): void => { process.env.PATH = `${NO_RTK_BIN}:${r.env0.PATH}`; };

beforeAll(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const dir of [BIN, NO_RTK_BIN, DATA, FAKE_HOME, join(r.T, "stacks-vazio")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(BIN, "rtk"), FAKE_RTK, { mode: 0o755 });
  writeFileSync(join(DATA, "env.sh"), "");
  writeFileSync(join(DATA, "config.tsv"), readFileSync(join(SKILL, "kit/config.tsv")));
  process.env.HOME = FAKE_HOME;
  process.env.HADES_DATA = DATA;
  process.env.HADES_STACKS_ROOT = join(r.T, "stacks-vazio");
  process.env.HADES_PACKS_ROOT = join(r.T, "packs");
  Object.assign(process.env, OWNER_ENV);
  withRtk();
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("rtk-worktree: geração do .rtk/filters.toml", () => {
  test("worktree node-nx recebe o arquivo gerado, git status limpo e arquivo no info/exclude", () => {
    const wt = nxRepo();
    const result = apply(wt, false);
    expect(result).toMatchObject({ action: "write", stacks: ["node-nx"], filters: ["node-nx-nx", "node-nx-jest"], trusted: "" });
    expect(filtersOf(wt)).toStartWith(GENERATED_MARK);
    expect(filtersOf(wt)).toContain("[filters.node-nx-nx]");
    expect(r.X(["git", "status", "--porcelain"], { cwd: wt }).out).toBe("");
    expect(readFileSync(join(wt, ".git/info/exclude"), "utf8").split("\n")).toContain(FILTERS_REL);
  });

  test("aplicar duas vezes não repete a linha do exclude nem regrava o arquivo", () => {
    const wt = nxRepo();
    apply(wt, false);
    const before = filtersOf(wt);
    apply(wt, false);
    expect(filtersOf(wt)).toBe(before);
    expect(readFileSync(join(wt, ".git/info/exclude"), "utf8").split("\n").filter((l) => l === FILTERS_REL)).toHaveLength(1);
  });

  test("com trust (caminho do dono) o rtk trust --yes roda no worktree", () => {
    const wt = nxRepo();
    rmSync(LOG, { force: true });
    expect(apply(wt, true).trusted).toBe("sim");
    expect(logText()).toContain(`${wt} trust --yes`);
  });

  test("sem trust o rtk trust não é chamado (o agente nunca confia)", () => {
    const wt = nxRepo();
    rmSync(LOG, { force: true });
    apply(wt, false);
    expect(logText()).not.toMatch(/ trust( --yes)?$/m);
  });

  test("existindo ~/.config/rtk/filters.toml a confiança é pulada (o trust --yes confiaria no global)", () => {
    const wt = nxRepo();
    mkdirSync(join(FAKE_HOME, ".config/rtk"), { recursive: true });
    writeFileSync(join(FAKE_HOME, ".config/rtk/filters.toml"), "schema_version = 1\n");
    rmSync(LOG, { force: true });
    try {
      expect(apply(wt, true).trusted).toBe("pulado");
      expect(logText()).not.toContain("trust --yes");
      expect(installForWorktree(wt, DATA, FAKE_HOME)).toContain("NÃO confiado");
    } finally {
      rmSync(join(FAKE_HOME, ".config/rtk/filters.toml"));
    }
  });

  test("worktree sem stack com filtro não ganha arquivo", () => {
    const wt = join(r.T, "wt-plano");
    mkdirSync(wt, { recursive: true });
    r.X(["git", "init", "-q"], { cwd: wt });
    expect(apply(wt, true)).toMatchObject({ action: "remove", filters: [] });
    expect(existsSync(join(wt, FILTERS_REL))).toBe(false);
  });

  test("stack da skill e stack do dono: a do dono vence o arquivo de filtros", () => {
    const owner = join(r.T, "stacks-dono");
    mkdirSync(join(owner, "node-nx"), { recursive: true });
    writeFileSync(join(owner, "node-nx/stack.json"), JSON.stringify({ schema: "hades.stack/1", name: "node-nx", detect: { files: ["nx.json"] }, steps: {} }));
    writeFileSync(join(owner, "node-nx/rtk-filters.toml"), "schema_version = 1\n\n[filters.dono-nx]\nmatch_command = '^nx\\b'\nstrip_ansi = true\n");
    process.env.HADES_STACKS_ROOT = owner;
    try {
      expect(apply(nxRepo(), false).filters).toEqual(["dono-nx"]);
    } finally {
      process.env.HADES_STACKS_ROOT = join(r.T, "stacks-vazio");
    }
  });
});

describe("rtk-worktree: desligar e ajustar", () => {
  test("HADES_RTK_FILTERS=off remove o arquivo gerado e a pasta .rtk", () => {
    const wt = nxRepo();
    apply(wt, false);
    expect(apply(wt, false, { HADES_RTK_FILTERS: "off" })).toMatchObject({ action: "remove", why: "HADES_RTK_FILTERS=off" });
    expect(existsSync(join(wt, ".rtk"))).toBe(false);
  });

  test("off não apaga arquivo que não é da Hades", () => {
    const wt = nxRepo();
    mkdirSync(join(wt, ".rtk"));
    writeFileSync(join(wt, FILTERS_REL), "schema_version = 1\n# do dono\n");
    expect(apply(wt, false, { HADES_RTK_FILTERS: "off" }).action).toBe("keep");
    expect(filtersOf(wt)).toContain("# do dono");
    expect(apply(wt, false).action).toBe("keep");
    expect(filtersOf(wt)).toContain("# do dono");
  });

  test("arquivo versionado pelo projeto fica como está", () => {
    const wt = nxRepo();
    mkdirSync(join(wt, ".rtk"));
    writeFileSync(join(wt, FILTERS_REL), "schema_version = 1\n# versionado\n");
    for (const args of [["add", "."], ["commit", "-qm", "filtros do projeto"]]) r.X(["git", ...args], { cwd: wt });
    expect(apply(wt, true)).toMatchObject({ action: "keep", trusted: "" });
    expect(filtersOf(wt)).toContain("# versionado");
  });

  test("HADES_RTK_OFF_STACKS tira os filtros da stack (e o arquivo, se nada sobrar)", () => {
    const wt = nxRepo();
    apply(wt, false);
    expect(apply(wt, false, { HADES_RTK_OFF_STACKS: "node-nx" })).toMatchObject({ action: "remove" });
    expect(existsSync(join(wt, FILTERS_REL))).toBe(false);
  });

  test("HADES_RTK_OFF_FILTERS tira só o filtro nomeado", () => {
    const wt = nxRepo();
    expect(apply(wt, false, { HADES_RTK_OFF_FILTERS: "node-nx-jest" }).filters).toEqual(["node-nx-nx"]);
    expect(filtersOf(wt)).not.toContain("node-nx-jest");
    expect(filtersOf(wt)).toContain("node-nx-nx");
  });

  test("sem rtk no PATH nada muda: nenhum arquivo é gerado e o gerado antes sai", () => {
    const wt = nxRepo();
    apply(wt, false);
    withoutRtk();
    try {
      expect(rtkBinary()).toBeUndefined();
      expect(planWorktree(wt, settings(), undefined)).toMatchObject({ action: "remove", why: "rtk ausente" });
      expect(apply(wt, true).action).toBe("remove");
      expect(existsSync(join(wt, FILTERS_REL))).toBe(false);
      expect(installForWorktree(nxRepo(), DATA, FAKE_HOME)).toBe("");
    } finally {
      withRtk();
    }
  });

  test("rtkSettings: valor fora do enum cai em auto e a lista ignora vazios e espaços", () => {
    expect(settings({ HADES_RTK_FILTERS: "talvez" }).mode).toBe("auto");
    expect(settings({ HADES_RTK_OFF_STACKS: " node-nx , ,tauri," }).offStacks).toEqual(["node-nx", "tauri"]);
  });
});

describe("rtk-worktree: confiança", () => {
  test("trustState: gerado e confiado, depois editado, depois sem confiança", () => {
    const wt = nxRepo();
    const rtk = rtkBinary();
    if (!rtk) throw new Error("rtk falso fora do PATH");
    apply(wt, false);
    expect(trustState(wt, rtk)).toBe("nao-confiado");
    apply(wt, true);
    expect(trustState(wt, rtk)).toBe("confiado");
    writeFileSync(join(wt, FILTERS_REL), `${filtersOf(wt)}# editado pelo agente\n`);
    expect(trustState(wt, rtk)).toBe("alterado");
  });

  test("trustState de worktree sem arquivo é vazio", () => {
    const rtk = rtkBinary();
    if (!rtk) throw new Error("rtk falso fora do PATH");
    expect(trustState(join(r.T, "wt-plano"), rtk)).toBe("");
  });

  test("installForWorktree diz o que fez: filtros, stacks e confiança", () => {
    const line = installForWorktree(nxRepo(), DATA, FAKE_HOME);
    expect(line).toContain("2 filtro(s) (node-nx)");
    expect(line).toEndWith("· confiado");
  });
});

describe("rtk-worktree: trava do hook (o agente não muda a política nem confia)", () => {
  const emitted: string[] = [];
  const env: HookEnv = {
    now: () => 1_000,
    cwd: () => r.T,
    home: () => FAKE_HOME,
    gatePatterns: () => [],
    projectOf: () => undefined,
    cerberusEmit: (guard, checked) => void emitted.push(`${guard}: ${checked}`),
  };
  const hook = (command: string) => decide({ hook_event_name: "PreToolUse", session_id: "s-rtk", cwd: r.T, tool_name: "Bash", tool_input: { command } }, env);

  const barred = [
    "HADES_RTK_FILTERS=off hades rtk apply",
    "export HADES_RTK_OFF_STACKS=node-nx",
    "hades config set HADES_RTK_OFF_FILTERS node-nx-nx",
    "curl -s -X POST localhost:21292/api/config -d 'HADES_RTK_FILTERS=off'",
    "rtk trust --yes",
    "cd wt && rtk trust",
    "git status; rtk untrust",
    "hades rtk apply . --trust",
  ];
  for (const command of barred) {
    test(`barra: ${command}`, () => {
      const before = emitted.length;
      const result = hook(command);
      expect({ command, exit: result.exit }).toEqual({ command, exit: 2 });
      expect(result.stderr).toContain("rtk proxy");
      expect(emitted.length).toBe(before + 1);
      expect(emitted.at(-1)).toStartWith("excecao-so-dono");
    });
  }

  const allowed = [
    "rtk proxy cargo build",
    "rtk gain",
    "rtk recall abc123",
    "hades rtk status",
    "hades rtk apply .",
    "hades config get HADES_RTK_FILTERS",
    "echo 'rtk trust é do dono'",
  ];
  for (const command of allowed) {
    test(`deixa passar: ${command}`, () => {
      expect({ command, exit: hook(command).exit }).toEqual({ command, exit: 0 });
    });
  }
});

describe("rtk-worktree: painel remoto", () => {
  test("as chaves HADES_RTK_* só se mudam pelo painel local", () => {
    for (const key of ["HADES_RTK_FILTERS", "HADES_RTK_OFF_STACKS", "HADES_RTK_OFF_FILTERS"]) {
      expect(remoteConfigRefusal([key])).toBe("a política dos filtros do rtk só se muda pelo painel local");
    }
  });

  test("chave de outro assunto continua liberada no painel remoto", () => {
    expect(remoteConfigRefusal(["HADES_CLEAN_CACHE_DAYS"])).toBeUndefined();
  });
});

describe("rtk-worktree: rota do painel", () => {
  const url = "git@github.com:org/painel.git";
  const clone = nxRepo();
  const panelEnv = { worktree: clone } as Parameters<typeof rtkTrustState>[0];
  let at = 0;

  test("conta as worktrees de agente sem confiança e traz o comando de cada uma; confiada, zero", () => {
    r.sh(`git -C ${clone} remote add origin ${url}`);
    const agents = join(r.T, "work", slugOfRemote(url), "orchestration", "agents");
    mkdirSync(agents, { recursive: true });
    const wt = nxRepo();
    writeFileSync(join(agents, "ag.json"), JSON.stringify({ name: "ag", worktree: wt }));
    apply(wt, false);
    process.env.HADES_WORK_ROOT = join(r.T, "work");
    try {
      at += 60_000;
      expect(rtkTrustState(panelEnv, at)).toEqual({ available: true, count: 1, more: 0, shown: [{ dir: wt, state: "nao-confiado", command: `cd ${wt} && rtk trust` }] });
      apply(wt, true);
      at += 60_000;
      expect(rtkTrustState(panelEnv, at)).toMatchObject({ available: true, count: 0 });
    } finally {
      delete process.env.HADES_WORK_ROOT;
    }
  });

  test("sem rtk: indisponível (o card não aparece)", () => {
    withoutRtk();
    try {
      at += 60_000;
      expect(rtkTrustState(panelEnv, at)).toMatchObject({ available: false, count: 0 });
    } finally {
      withRtk();
    }
  });
});

describe("rtk-worktree: start do agente", () => {
  const OWNER = "! herdr agent start ag --kind claude --pane w1:p1";

  test("worktree com filtro gerado e não confiado: o comando do dono leva o rtk trust antes, e a sessão não o executa", () => {
    const wt = nxRepo();
    apply(wt, false);
    rmSync(LOG, { force: true });
    expect(startForWorktree(OWNER, wt)).toBe(`! (cd ${wt} && rtk trust) && ${OWNER.slice(2)}`);
    expect(logText()).not.toMatch(/ trust( --yes)?$/m);
  });

  test("confiada, sem filtro ou comando do orquestrador (sem `! `): o comando fica como veio", () => {
    const trusted = nxRepo();
    apply(trusted, true);
    expect(startForWorktree(OWNER, trusted)).toBe(OWNER);
    expect(startForWorktree(OWNER, nxRepo())).toBe(OWNER);
    expect(startForWorktree(OWNER.slice(2), trusted)).toBe(OWNER.slice(2));
    expect(startForWorktree(OWNER, "")).toBe(OWNER);
  });

  test("sem rtk no PATH, o comando fica como veio", () => {
    const wt = nxRepo();
    apply(wt, false);
    withoutRtk();
    try {
      expect(startForWorktree(OWNER, wt)).toBe(OWNER);
    } finally {
      withRtk();
    }
  });
});

describe("rtk-worktree: doctor", () => {
  const wtDoctor = nxRepo();
  const doctor = (path: string, extra: Record<string, string> = {}) => {
    const p = r.hades(["doctor", "--quick", "--json"], { env: { PATH: path, HADES_DATA: DATA, HADES_WT: wtDoctor, HOME: FAKE_HOME, ...OWNER_ENV, ...extra } });
    const items = (JSON.parse(p.out) as { items: { group: string; id: string; level: string; msg: string; fix: string }[] }).items;
    return Object.fromEntries(items.filter((i) => i.group === "Resumidores (rtk)").map((i) => [i.id, i]));
  };
  const withBin = `${BIN}:${r.env0.PATH}`;

  test("sem rtk: aviso com o caminho para instalar, e nada mais do grupo", () => {
    const got = doctor(`${NO_RTK_BIN}:${r.env0.PATH}`);
    expect(Object.keys(got)).toEqual(["rtk"]);
    expect(got.rtk).toMatchObject({ level: "warn" });
    expect(got.rtk?.msg).toContain("rtk não encontrado");
  });

  test("filtros previstos e arquivo ausente: aviso com o comando de aplicar", () => {
    const got = doctor(withBin);
    expect(got["rtk-filtros"]).toMatchObject({ level: "warn" });
    expect(got["rtk-filtros"]?.msg).toContain("filtros previstos (node-nx: node-nx-nx,node-nx-jest)");
    expect(got["rtk-filtros"]?.fix).toContain("hades rtk apply");
  });

  test("arquivo gerado e não confiado: aviso com `rtk trust`; confiado: ok; editado: aviso de novo", () => {
    apply(wtDoctor, false);
    const nao = doctor(withBin)["rtk-filtros"];
    expect(nao).toMatchObject({ level: "warn" });
    expect(nao?.msg).toContain("ainda não confiado");
    expect(nao?.fix).toContain("rtk trust");
    apply(wtDoctor, true);
    expect(doctor(withBin)["rtk-filtros"]).toMatchObject({ level: "ok" });
    writeFileSync(join(wtDoctor, FILTERS_REL), `${filtersOf(wtDoctor)}# mexido\n`);
    expect(doctor(withBin)["rtk-filtros"]?.msg).toContain("mudou depois de confiado");
  });

  test("rtk-trust: worktree de agente com filtro gerado e não confiado é aviso com o comando; confiada, ok", () => {
    const url = "git@github.com:org/proj.git";
    r.sh(`git -C ${wtDoctor} remote add origin ${url}`);
    const agents = join(r.T, "work", slugOfRemote(url), "orchestration", "agents");
    mkdirSync(agents, { recursive: true });
    const agentWt = nxRepo();
    writeFileSync(join(agents, "ag.json"), JSON.stringify({ name: "ag", worktree: agentWt }));
    apply(agentWt, false);
    const aviso = doctor(withBin)["rtk-trust"];
    expect(aviso).toMatchObject({ level: "warn" });
    expect(aviso?.msg).toContain(agentWt);
    expect(aviso?.fix).toContain(`cd ${agentWt} && rtk trust`);
    apply(agentWt, true);
    expect(doctor(withBin)["rtk-trust"]).toMatchObject({ level: "ok" });
    rmSync(join(agents, "ag.json"));
  });

  test("HADES_RTK_FILTERS=off: com o arquivo ainda lá é aviso; sem ele, ok", () => {
    writeFileSync(join(DATA, "config.env"), "HADES_RTK_FILTERS=off\n");
    try {
      expect(doctor(withBin)["rtk-filtros"]).toMatchObject({ level: "warn" });
      rmSync(join(wtDoctor, ".rtk"), { recursive: true });
      const off = doctor(withBin)["rtk-filtros"];
      expect(off).toMatchObject({ level: "ok" });
      expect(off?.msg).toContain("filtros desligados");
    } finally {
      rmSync(join(DATA, "config.env"));
    }
  });

  test("RTK_RECALL_DB e RTK_TEE_DIR dentro dos dados da instância: ok; fora: aviso com o que exportar", () => {
    expect(doctor(withBin)["rtk-recall"]).toMatchObject({ level: "warn" });
    expect(doctor(withBin)["rtk-recall"]?.fix).toContain(`RTK_RECALL_DB=${DATA}/rtk/recall.db`);
    const ok = doctor(withBin, { RTK_RECALL_DB: join(DATA, "rtk/recall.db"), RTK_TEE_DIR: join(DATA, "rtk/tee") });
    expect(ok["rtk-recall"]).toMatchObject({ level: "ok" });
  });

  test("política: sem config do rtk o doctor recomenda; com tudo ajustado, ok (e nunca grava)", () => {
    const recommended = doctor(withBin)["rtk-politica"];
    expect(recommended).toMatchObject({ level: "warn" });
    expect(recommended?.msg).toContain('"diff"');
    mkdirSync(join(FAKE_HOME, ".config/rtk"), { recursive: true });
    const config = join(FAKE_HOME, ".config/rtk/config.toml");
    const tuned = '[hooks]\nexclude_commands = ["diff", "ps -p"]\n[limits]\ngrep_max_results = 1000\ngrep_max_per_file = 100\n[display]\nmax_width = 240\n';
    writeFileSync(config, tuned);
    try {
      expect(doctor(withBin)["rtk-politica"]).toMatchObject({ level: "ok" });
      expect(readFileSync(config, "utf8")).toBe(tuned);
    } finally {
      rmSync(config);
    }
  });

  test("o ajuste do dono aparece no doctor", () => {
    writeFileSync(join(DATA, "config.env"), "HADES_RTK_OFF_STACKS=tauri\nHADES_RTK_OFF_FILTERS=node-nx-jest\n");
    try {
      expect(doctor(withBin)["rtk-ajuste"]?.msg).toBe("ajuste do dono: stacks fora tauri · filtros fora node-nx-jest");
    } finally {
      rmSync(join(DATA, "config.env"));
    }
  });
});

describe("rtk-worktree: limpeza rtk-tee", () => {
  const tee = join(DATA, "rtk/tee");
  const clean = (...args: string[]) => r.hades(["clean", ...args], { env: { HADES_DATA: DATA, HADES_WT: r.C, HADES_CLEAN_CACHE_DAYS: "1", HOME: FAKE_HOME } });
  const age = (path: string, days: number): void => {
    const when = new Date(Date.now() - days * 86_400_000);
    utimesSync(path, when, when);
  };

  test("a categoria aparece no status como segura, com os arquivos de mais de HADES_CLEAN_CACHE_DAYS a liberar", () => {
    mkdirSync(tee, { recursive: true });
    writeFileSync(join(tee, "velho.log"), "x".repeat(100));
    writeFileSync(join(tee, "novo.log"), "y".repeat(50));
    age(join(tee, "velho.log"), 3);
    const line = clean("status", "--tsv").out.split("\n").find((l) => l.startsWith("rtk-tee\t"));
    expect(line).toBeDefined();
    expect(line).toContain("seguro");
    expect(clean("list", "rtk-tee").out).toContain("velho.log");
    expect(clean("list", "rtk-tee").out).not.toContain("novo.log");
  });

  test("run remove só o velho e deixa o recente; pasta ausente não é erro", () => {
    clean("run", "--quiet");
    expect(existsSync(join(tee, "velho.log"))).toBe(false);
    expect(existsSync(join(tee, "novo.log"))).toBe(true);
    rmSync(tee, { recursive: true });
    expect(clean("run", "--quiet").rc).toBe(0);
  });
});

describe("rtk-worktree: o que o teste nunca toca", () => {
  test("nada foi escrito no HOME real nem em ~/.config/rtk", () => {
    expect(FAKE_HOME).not.toBe(homedir());
    expect(existsSync(join(FAKE_HOME, ".config/rtk/filters.toml"))).toBe(false);
  });
});
