// Grupo bun-loop2: segunda fatia do loop (stack-add, project-init, agent). Cada caso roda a CLI numa pasta própria e compara
// saída (stderr junto, caminhos normalizados), código de saída e arquivos de estado com o que foi gravado em
// golden/legado/bun-loop2.json.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { homedir, userInfo } from "node:os";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { legado } from "./lib/legado";
import { BUN, FX, Rig, SKILL, type Env } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const T = r.T;
const g = legado(import.meta.path);
const CLI = `${BUN} ${SKILL}/src/cli.ts`;

const wr = (p: string, s: string) => writeFileSync(p, s);
const mk = (...d: string[]) => { for (const x of d) mkdirSync(x, { recursive: true }); };
const ws = (s: string) => s.split(/\s+/).filter(Boolean);
const git = (...a: string[]) => r.X(["git", ...a]);
const cli = (home: string, env: Env, ...a: string[]) => r.hades(a, { env: { HOME: home, ...env } });
const editJson = (p: string, f: (j: any) => void) => { try { const j = JSON.parse(readFileSync(p, "utf8")); f(j); wr(p, JSON.stringify(j, null, 2) + "\n"); } catch { /* como o jq: sem o arquivo, nada */ } }; // eslint-disable-line @typescript-eslint/no-explicit-any

type Seed = (d: string) => void;

/** bl2_state: lista e soma dos arquivos da pasta, sem o ruído de tempo nem o caminho da skill (o prompt leva o cartão do papel). Dado da máquina fica fora da soma: o usuário de quem aprovou o plano (`<U>`) e o conteúdo de hooks/ e objects/ de repositório git (modelos de hook e compressão dependem da versão do git; os nomes dos objetos, que são o hash do conteúdo, continuam na lista). */
const STATE = String.raw`cd "$1" && find . -type f -not -path '*/.git/*' -not -path './.bun/*' -not -path './.cache/*' -not -path '*/journal/*' -not -name '*.log' | sort | while read -r f; do case "$f" in *.git/hooks/*|*.git/objects/*) h=-;; *) h=$(grep -av '^herdr --version$' "$f" | sed -E "s#$3#<S>#g; s#$1#<D>#g; s#$2#<T>#g; s/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z/<T>/g; s/\"avaliacao\": \"[0-9a-f]{12}\"/<ID>/g; s/\"user\": \"$4\"/\"user\": \"<U>\"/" | md5sum | cut -c1-12);; esac; printf '%s %s\n' "$f" "$h"; done`;
const state = (d: string) => r.X(["bash", "-c", STATE, "_", d, T, SKILL, userInfo().username]).out;

function seedStack(d: string): void {
  mk(`${d}/repo/.github/workflows`, `${d}/go`, `${d}/rs`, `${d}/py`, `${d}/vazio`, `${d}/semscripts`, `${d}/pnpm`);
  wr(`${d}/repo/package.json`, '{"name":"d","scripts":{"lint":"eslint .","test":"jest","type-check":"tsc","start":"node .","test:unit":"x"}}\n');
  wr(`${d}/repo/.github/workflows/ci.yml`, "jobs:\n  ci:\n    steps:\n      - run: npm run lint\n      - run: |\n          echo x\n      - run:   npm test  \n    other:\n      run: nada\n");
  wr(`${d}/repo/.github/workflows/leia.txt`, "x\n"); wr(`${d}/repo/.github/workflows/b.yaml`, "jobs: {}\n");
  wr(`${d}/go/go.mod`, "module x\n"); wr(`${d}/rs/Cargo.toml`, "[package]\n"); wr(`${d}/py/requirements.txt`, "x\n"); wr(`${d}/py/pyproject.toml`, "");
  wr(`${d}/semscripts/package.json`, '{"scripts":{"serve":"x"}}\n'); wr(`${d}/pnpm/package.json`, '{"name":"p","scripts":{"build":"tsc"}}\n'); wr(`${d}/pnpm/pnpm-lock.yaml`, ""); wr(`${d}/repo/package-lock.json`, "");
}
const seedStackDraft: Seed = (d) => { seedStack(d); cli(`${d}-home`, {}, "stack-add", "propose", `${d}/repo`, "--stage", `${d}/st`, "--name", "add-npm"); };
/** repos nx e node com remote, mais um sem remote e uma pasta que não é repo */
function seedInit(d: string): void {
  for (const n of ["nx", "node"]) { cpSync(`${FX}/init/${n}`, `${d}/${n}`, { recursive: true }); git("-C", `${d}/${n}`, "init", "-q", "-b", "main"); git("-C", `${d}/${n}`, "remote", "add", "origin", `https://github.com/acme/${n}.git`); }
  cpSync(`${FX}/init/node`, `${d}/semremote`, { recursive: true }); git("-C", `${d}/semremote`, "init", "-q", "-b", "main"); mk(`${d}/semrepo`);
}
/** com rascunhos gravados pelo original e um pacote já salvo para os casos de re-run */
const seedInitDraft: Seed = (d) => {
  seedInit(d);
  for (const n of ["nx", "node"]) cli(`${d}-home`, { HADES_PACKS_ROOT: `${d}/pk` }, "project-init", "draft", `${d}/${n}`, "--stage", `${d}/st`);
  try { cpSync(`${d}/st/widget`, `${d}/st/bad`, { recursive: true }); } catch { /* sem rascunho */ }
  try { const j = JSON.parse(readFileSync(`${d}/st/widget/profile.json`, "utf8")); j.name = "bad"; j.flow = { ...j.flow, kind: "ambos" }; wr(`${d}/st/bad/profile.json`, JSON.stringify(j, null, 2) + "\n"); } catch { /* idem */ }
  wr(`${d}/st/bad2.json`, "{broken\n"); mk(`${d}/st/lixo`); wr(`${d}/st/lixo/profile.json`, "{broken\n");
};
/** pacote widget já salvo e editado (refs, pr, flow.base), mais rascunho antigo */
const seedInitSaved: Seed = (d) => {
  seedInitDraft(d);
  cli(`${d}-home`, { HADES_PACKS_ROOT: `${d}/pk` }, "project-init", "save", `${d}/st/widget`, `${d}/nx`, "--confirmed");
  editJson(`${d}/pk/widget/profile.json`, (j) => { j.refs = { deliver: "loop/deliver.md" }; j.pr = { labels: ["backend"] }; j.flow = { ...j.flow, base: "main" }; });
  mk(`${d}/pk/widget/loop`); wr(`${d}/pk/widget/loop/deliver.md`, "# deliver\n");
};
/** plano com histórico, bloco de código com "## " e um agente registrado na raiz da skill */
const seedAgent: Seed = (d) => {
  const w = `${d}/work/_skill/orchestration/agents`;
  wr(`${d}/plan.md`, "# Plano\n\nintro\n\n## Objetivo\n\nfazer\n\n## Estado atual (26/10)\n\nagora\n\n```\n## Estado atual\n```\n\n## Histórico\n\nvelho\n\n## Notas\n\nmais\n");
  wr(`${d}/plan-curto.md`, "# Plano\n\n## Objetivo\n\nfazer\n"); wr(`${d}/plan-cru.md`, "sem newline final");
  mk(w); wr(`${w}/ag.json`, '{"name":"ag","role":"impl","pane":"p1","mode":"skill"}\n'); wr(`${w}/sp.json`, '{"name":"sp","role":"spec","mode":"skill"}\n');
};
/** clone do projeto (origin local example/monorepo), pacote, worktree de agente com relatórios e registros */
const seedOrch: Seed = (d) => {
  const w = `${d}/work/_skill/orchestration/agents`, p = `${d}/work/example__monorepo/orchestration/agents`, rp = ".design-sync-reports", bare = `${d}/remotes/example/monorepo.git`;
  seedAgent(d);
  git("init", "-q", "--bare", "-b", "develop", bare); git("init", "-q", "-b", "develop", `${d}/src`); wr(`${d}/src/README.md`, "demo\n");
  git("-C", `${d}/src`, "add", "-A"); git("-C", `${d}/src`, "commit", "-qm", "init"); git("-C", `${d}/src`, "push", "-q", bare, "develop");
  git("-C", `${d}/src`, "checkout", "-q", "-b", "svc/feat/rev"); git("-C", `${d}/src`, "commit", "-q", "--allow-empty", "-m", "rev"); git("-C", `${d}/src`, "push", "-q", bare, "svc/feat/rev");
  git("clone", "-q", bare, `${d}/clone`); cpSync(`${FX}/packs`, `${d}/pk`, { recursive: true });
  mk(`${d}/gh`); wr(`${d}/gh/pr-changed-files.txt`, "svc/feat/rev\n"); wr(`${d}/gh/pr-list.json`, '[{"number": 7}]\n');
  mk(`${d}/wt/ag/${rp}`, `${d}/wt/sp/${rp}`, `${d}/wt/rv/${rp}`, p);
  wr(`${d}/wt/ag/${rp}/questions.md`, "## Q1 — primeira\n\nctx\n\n## Q2 — segunda (respondida)\n\n## Q10 — décima\n");
  wr(`${d}/wt/ag/${rp}/report.md`, "STATUS: DONE\n\nfeito\n"); wr(`${d}/wt/ag/${rp}/handoff.md`, "STATUS: PARKED — x\n"); wr(`${d}/wt/ag/${rp}/brief.md`, "# brief\n");
  git("init", "-q", "-b", "main", `${d}/wt/ag`); git("-C", `${d}/wt/ag`, "add", "-A", "-f"); git("-C", `${d}/wt/ag`, "commit", "-qm", "c");
  wr(`${d}/wt/sp/${rp}/report.md`, "sem status\n");
  const reg = (f: string, o: object) => wr(f, JSON.stringify(o, null, 2) + "\n");
  reg(`${w}/ag.json`, { name: "ag", role: "impl", pane: "p1", mode: "skill", worktree: `${d}/wt/ag`, state: "working" });
  reg(`${w}/sp.json`, { name: "sp", role: "spec", pane: "p2", mode: "skill", worktree: `${d}/wt/sp`, state: "done", branch: "skill/sp" });
  reg(`${w}/rv.json`, { name: "rv", role: "review", mode: "review", worktree: `${d}/wt/rv`, state: "archived", branch: "x" });
  reg(`${p}/dl.json`, { name: "dl", role: "impl", pane: "p3", mode: "deliver", worktree: `${d}/wt/ag`, state: "working", branch: "svc/feat/x" });
  mk(`${d}/work/_skill/locks`);
};

interface Ctx { seed?: Seed; extra?: string[]; cwd?: string }
/** skill-clean lista as unidades reais de ~/.claude/hades/skill-dev da máquina: cada linha vira um molde sem nome de unidade. Pastas de relatório (`.design-sync-reports`) de uma unidade em curso não fazem parte do comportamento. */
const unitMolds = (s: string) => new Set(s.split("\n").filter((l) => !l.includes(".design-sync-reports")).map((l) => l.replace(/skill-dev\/[\w.-]+/g, "skill-dev/<u>").replace(/skill\/[\w.-]+/g, "skill/<u>").replace(/^== [\w.-]+ /, "== <u> ")
  .replace(/_arquivo\/[\w.-]+/g, "_arquivo/<u>").replace(/recusado: .*/, "recusado: <motivo>")));
/** o commit da base (`base main em <sha>`) é o HEAD do repo da máquina, não do comportamento */
const semHash = (s: string) => s.replace(/(base \S+ em )[0-9a-f]{7,40}/g, "$1<H>");
/** bl2: a CLI numa pasta própria; saída, código e estado iguais ao gravado. `@D@` vira a pasta. */
/** O cabeçalho do `npm run`, o carimbo do update-notifier e a frase de comando inexistente do `sh` e a de "fora de repositório" do git mudam com a máquina (versão do npm, sh = dash ou bash, git novo ou antigo, /tmp no mesmo sistema de arquivos que /): fora do golden. */
const npmQuiet = (s: string): string => s.replace(/^npm notice run .*\n/gm, "").replace(/^\n?> .*\n(?:> .*\n)*\n?/gm, "").replace(/^\.\/\.npm\/_update-notifier-last-checked .*\n/gm, "")
  .replace(/^fatal: not a git repository \(or any of the parent directories\): \.git$/gm, "fatal: not a git repository (or any parent up to mount point /)\nStopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).")
  .replace(/^sh: (?:line )?1: (\S+): (?:command )?not found$/gm, "sh: line 1: $1: command not found"); // o dash (ubuntu) e o bash escrevem "não achou" de jeitos diferentes

function bl2(lbl: string, cmd: string, args: string[], c: Ctx): void {
  test(lbl, () => {
    const run = () => {
      const d = `${T}/bl2-b`; rmSync(d, { recursive: true, force: true }); rmSync(`${d}-home`, { recursive: true, force: true });
      mk(d, `${d}-home/.claude/hades`); c.seed?.(d);
      const sub = (s: string) => s.split("@D@").join(d);
      const env: Env = { HOME: `${d}-home` };
      for (const e of c.extra ?? []) { const i = e.indexOf("="); env[e.slice(0, i)] = sub(e.slice(i + 1)); }
      const o = r.X([...ws(cmd), ...args.map(sub)], { cwd: `${d}/${c.cwd ?? ""}`, env, merge: true });
      const text = npmQuiet(`${o.out}rc=${o.rc}`).split(d).join("<D>").split(T).join("<T>").split(homedir()).join("<H>");
      return `${text}\n${npmQuiet(state(d))}${npmQuiet(state(`${d}-home`))}`;
    };
    if (args.includes("--merged")) {
      const got = unitMolds(run()), want = unitMolds(g.get<string>(lbl));
      expect([...got].filter((l) => !want.has(l))).toEqual([]);
    } else { const atual = run(); g.fix(lbl, atual); expect(semHash(atual)).toBe(semHash(g.get(lbl))); }
  }, 60_000);
}
const cases = (prefix: string, cmd: string, list: string[], c: Ctx, suffix = ": CLI igual ao gravado") => {
  for (const s of list) bl2(`${prefix}${s || "sem argumento"}${suffix}`, cmd, ws(s), c);
};

describe("stack-add", () => {
  const SA = `${CLI} stack-add`;
  cases("stack-add.py ", SA, ["propose @D@/repo --stage @D@/st --name Meu-App", "propose @D@/go --stage @D@/st", "propose @D@/rs --stage @D@/st --name RS_x!", "propose @D@/py --stage @D@/st",
    "propose @D@/pnpm --stage @D@/st", "propose @D@/vazio --stage @D@/st", "propose @D@/semscripts --stage @D@/st", "propose @D@/nao-existe", "propose", "propose @D@/repo", "", "bogus",
    "save @D@/nada --confirmed", "save @D@/nada", "save", "measure a b"], { seed: seedStack });
  cases("stack-add.py ", SA, ["save @D@/st/add-npm --confirmed", "measure @D@/st/add-npm @D@/repo inexistente", "measure @D@/st/add-npm @D@/repo lint --timeout 20"],
    { seed: seedStackDraft, extra: ["HADES_GATE_MEMCAP=0", "HADES_GATE_RESERVE_GB=0", "HADES_GATE_PSI_MAX=100", "HADES_STACKS_ROOT=@D@/stk"] });
});

describe("project-init", () => {
  const PIN = `${CLI} project-init`;
  const ex = ["HADES_PACKS_ROOT=@D@/pk"];
  cases("project-init.py ", PIN, ["draft @D@/nx --dry-run", "draft @D@/nx --stage @D@/st", "draft @D@/node --dry-run --name outro", "draft @D@/nx --dry-run --slug zeta/projeto --gh-user fulano",
    "draft @D@/semremote --dry-run", "draft @D@/semrepo --dry-run", "draft @D@/nao-existe", "draft", "", "bogus", "save", "save @D@/st/x", "draft @D@/nx --bogus"], { seed: seedInit, extra: ex });
  cases("project-init.py ", PIN, ["save @D@/st/widget @D@/nx", "save @D@/st/widget @D@/nx --confirmed", "save @D@/st/bad @D@/nx --confirmed", "save @D@/st/widget @D@/node --confirmed",
    "save @D@/st/tiny @D@/node --confirmed", "save @D@/nada @D@/nx --confirmed", "save @D@/st/widget @D@/semrepo --confirmed"], { seed: seedInitDraft, extra: ex });
  // re-run sobre perfil existente: diff, preservados, nada a gravar, --force
  cases("project-init.py re-run ", PIN, ["draft @D@/nx --stage @D@/st2", "save @D@/st/widget @D@/nx --confirmed", "save @D@/st2/widget @D@/nx --confirmed", "save @D@/st2/widget @D@/nx --confirmed --force"],
    { seed: seedInitSaved, extra: ex });
});

describe("hades-agent.sh", () => {
  const AG = `${CLI} agent`;
  // subcomandos portados (plan-approve, plan-trim, start-cmd). O start-cmd consulta o herdr (pane morto → workspace novo): sempre o stub do PATH do caso,
  // com as chamadas em herdr.calls (entra no estado comparado), nunca o herdr da máquina.
  cases("hades-agent.sh ", AG, ["plan-approve @D@/plan.md", "plan-approve @D@/plan-curto.md", "plan-approve @D@/plan-cru.md", "plan-trim @D@/plan.md", "plan-trim @D@/plan-curto.md", "plan-trim @D@/plan-cru.md",
    "start-cmd ag", "start-cmd sp", "start-cmd nada"], { seed: seedAgent, extra: ["HADES_WORK_ROOT=@D@/work", "FAKE_HERDR_LOG=@D@/herdr.calls"] });
  cases("hades-agent.sh ", AG, ["plan-approve @D@/plan.md", "start-cmd ag"], { seed: seedAgent, extra: ["HADES_WORK_ROOT=@D@/work", "HADES_PLAN_ORIGIN=painel", "HADES_MODEL_IMPL=claude-x", "HADES_EFFORT_IMPL=high", "FAKE_HERDR_LOG=@D@/herdr.calls"] },
    " (painel, modelo e esforço): CLI igual ao gravado");
  bl2("hades-agent.sh plan-approve com origem inválida: CLI igual ao gravado", AG, ["plan-approve", "@D@/plan.md"], { seed: seedAgent, extra: ["HADES_WORK_ROOT=@D@/work", "HADES_PLAN_ORIGIN=outro"] });
  // o resto dos subcomandos, com herdr e gh de mentira (stubs), clone com origin local e registros gravados
  const FA = 'FAKE_HERDR_AGENTS={"result":{"agents":[{"name":"ag","agent_status":"idle","pane_id":"p1"},{"name":"sp","agent_status":"working","pane_id":"p2"}]}}';
  const orch = { seed: seedOrch, cwd: "clone", extra: ["HADES_WORK_ROOT=@D@/work", "HADES_PACKS_ROOT=@D@/pk", "HADES_PLAN_REQUIRED=0", "HADES_ORCH_WORKTREE_ROOT=@D@/agents", "HADES_ORCH_REPORTS_DIR=.design-sync-reports",
    "HADES_MODEL_IMPL=modelo-impl", "HADES_EFFORT_IMPL=alto", "FAKE_GH_DIR=@D@/gh", "FAKE_HERDR_LOG=@D@/herdr.calls", FA] };
  cases("hades-agent.sh ", AG, ["prompt ag", "prompt ag texto-livre", "prompt nada", "answer ag Q1 sim", "answer ag Q3 sim", "answer ag Q10 outra", "answer ag Q2 de-novo", "phase ag impl", "phase ag review",
    "resume ag", "resume sp", "resume nada", "escalate ag motivo-x", "escalate nada x", "status", "status ag", "status sp", "list", "list --all", "list --json", "list --all --json",
    "done ag", "done ag --keep-pane", "done sp", "done rv", "done nada", "adopt ag", "adopt nada", "adopt ag --for deliver", "adopt ag --for bogus",
    "new x1 --role impl --branch svc/feat/x1 --dry-run", "new x1 --role impl --branch svc/feat/x1", "new x2 --role bogus --branch b", "new ag --role impl --branch svc/feat/y",
    "review rv2 --pr 7 --dry-run", "review rv2 --pr 7", "review rv2", "review rv2 --pr 99", "bogus"], orch);
  // divergência aceita: argumento faltando (o bash morria com "unbound variable", rc=1) vira "hades: faltou <x>", rc=2
  for (const a of ["prompt", "answer ag", "phase ag", "escalate ag", "done", "adopt", "new", "skill-new", "status nada"]) {
    test(`hades-agent.sh ${a} sem argumento: sai 2 com a instrução`, () => {
      const m = `${T}/bl2-m`; rmSync(m, { recursive: true, force: true }); rmSync(`${m}-home`, { recursive: true, force: true }); mk(m, `${m}-home/.claude/hades`); seedOrch(m);
      const o = r.hades(["agent", ...ws(a)], { cwd: `${m}/clone`, merge: true, env: { HOME: `${m}-home`, HADES_WORK_ROOT: `${m}/work`, HADES_PACKS_ROOT: `${m}/pk` } });
      expect(`${o.rc} ${(o.out.split("\n")[0] ?? "").split(" ")[0]}`).toBe("2 hades:");
    }, 30_000);
  }
  bl2("hades-agent.sh new sem plano aprovado: CLI igual ao gravado", AG, ["new", "x1", "--role", "impl", "--branch", "svc/feat/x1"], { seed: seedOrch, cwd: "clone",
    extra: ["HADES_WORK_ROOT=@D@/work", "HADES_PACKS_ROOT=@D@/pk", "HADES_PLAN_REQUIRED=1", "HADES_ORCH_WORKTREE_ROOT=@D@/agents", "HADES_ORCH_REPORTS_DIR=.design-sync-reports", "FAKE_GH_DIR=@D@/gh"] });
  // skill-new e skill-clean só em --dry-run e nunca contra o repo real da skill; a CLI roda de uma cópia git sem remote, para o
  // caminho e o aviso de push não dependerem de onde mora (ou se tem origin) o clone que roda a suíte
  const SKC = `${T}/bl2-skill`;
  beforeAll(() => r.skillCopy(SKC));
  const AGC = `${BUN} ${SKC}/src/cli.ts agent`;
  cases("hades-agent.sh ", AGC, ["skill-new u1 --dry-run", "skill-new u1 --dry-run --port 21299", "skill-new Bad_Nome --dry-run", "skill-new u1 --role bogus --dry-run", "skill-clean --dry-run",
    "skill-clean nada --dry-run", "skill-clean --merged --dry-run"], { seed: seedOrch, extra: ["HADES_WORK_ROOT=@D@/work", "HADES_SKILL_DIR=@D@/skill"] });
  bl2("hades-agent.sh skill-new com a faixa de portas esgotada: CLI igual ao gravado", AGC, ["skill-new", "u1", "--dry-run"], { seed: seedOrch,
    extra: ["HADES_WORK_ROOT=@D@/work", "HADES_SKILL_DIR=@D@/skill", "HADES_SKILL_PORT_MIN=21290", "HADES_SKILL_PORT_MAX=21290", "FAKE_SS_PORTS=21290"] });
});
