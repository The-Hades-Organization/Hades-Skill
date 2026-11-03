// Grupo bun-kit2: segunda fatia do kit pela CLI `hades` (clean, rebuild-branch, watch, tunnel, notify, onboard, doctor): mesma saída, código e arquivos
// de estado que o comportamento de referência gravado em golden/legado, mais as falhas cedo (69) por dependência ausente.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUN, Rig, SKILL, STUBS, lines, writeJson, type Env, type Run, SYS_PATH } from "./lib/rig";
import { legado } from "./lib/legado";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const g = legado(import.meta.path);
const T = r.T, H = r.H;
const K = `${SKILL}/kit`, CLI = `${SKILL}/src/cli.ts`, BIN = `${T}/b2-bin`, NB = `${T}/b2-nodeps`, wt = `${T}/b2-wt`;
const DN = `${T}/b2-dn`;
const NODE_DIR = r.env0.PATH?.split(":")[1] ?? "/usr/bin";
const PATH_STD = `${STUBS}:${NODE_DIR}:${SYS_PATH}`;
const BASH = Bun.which("bash") ?? "bash";

const wr = (p: string, s: string) => writeFileSync(p, s);
const rcLine = (o: Run) => `${o.out}rc=${o.rc}`;
const slurp = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const all = (s: string, from: string, to: string) => s.split(from).join(to);
/** O que o doctor e o onboard leem da máquina (versões das ferramentas, RAM, comando do firewall ativo): fora do golden. */
const FW_CMDS = [
  "sudo ufw allow from 172.18.0.0/16",
  "sudo firewall-cmd --permanent --zone=trusted --add-source=172.18.0.0/16 && sudo firewall-cmd --reload",
  "libere 172.18.0.0/16 -> host no seu firewall (nft/iptables)",
];
const machineMask = (s: string) => FW_CMDS.reduce((acc, fw) => all(acc, fw, "<FW>"), s)
  .replace(/\b(node|bun) \d+\.\d+\.\d+/g, "$1 <VER>").replace(/git version \d[\w.]*/g, "git version <VER>")
  .replace(/bubblewrap \d[\w.]*/g, "bubblewrap <VER>").replace(/RAM \d+M/g, "RAM <N>M").replace(/RAM da máquina \(\d+M\)/g, "RAM da máquina (<N>M)");
const ago = (p: string, days: number) => { const t = new Date(Date.now() - days * 86400_000); utimesSync(p, t, t); };
const mk = (...d: string[]) => { for (const x of d) mkdirSync(x, { recursive: true }); };
const bytesOf = (n: number, ch: string) => ch.repeat(n);
const exe = (p: string, body: string) => { wr(p, body); chmodSync(p, 0o755); };
const nopath = (d: string, names: string[]) => { mk(d); for (const n of names) if (!existsSync(`${d}/${n}`)) symlinkSync(Bun.which(n) ?? `/usr/bin/${n}`, `${d}/${n}`); };
/** O que muda de uma rodada para outra sai do texto: o caminho do $D, do clone, dos worktrees e do /tmp do teste. */
const nrm = (s: string, d: string, c?: string) => all(all(all(c ? all(s, c, "<C>") : s, d, "<D>"), `${T}/b2-wts/${d.split("/").pop()}-`, "<WT>/"), T, "<T>");

/** O texto das units e das chamadas ao systemctl sem o /tmp do teste, a skill e o diretório do node desta máquina. */
const unitNorm = (s: string) => r.norm(all(s, NODE_DIR, "<NODE>"));

/** xx: o $D do lado, com os falsos (docker, gh, systemctl) e a skill do HOME de teste. */
const xx = (d: string, argv: string[], env: Env = {}, merge = true): Run =>
  r.X(argv, { merge, env: { PATH: `${BIN}:${PATH_STD}`, FAKE_DOCKER: `${d}.docker`, FAKE_PRSTATE: `${d}.prs`, FAKE_SYSTEMCTL_DIR: `${d}.sc`, HADES_SKILL_DIR: SKILL, USER: "regressao", ...env } });
/** kx: a CLI no $D (HADES_KIT_DIR), com o ambiente do env.sh dele, como o wrapper antigo fazia. `pre` antecede o comando (timeout…). */
const kx = (d: string, args: string[], env: Env = {}, o: { merge?: boolean; pre?: string[] } = {}): Run =>
  xx(d, ["bash", "-c", `. "$1/env.sh"; ${["env-watch", "notify"].includes(args[0] ?? "") ? "export LOCKS; " : ""}shift; exec "$@"`, "_", d, ...(o.pre ?? []), BUN, CLI, ...args], { HADES_KIT_DIR: d, ...env }, o.merge ?? true);

/** mkd: $D com o env.sh mínimo (as chaves exportadas como o config.sh faria); os arquivos do original (`files`) só no lado dele. */
function mkd(d: string, ...files: string[]): void {
  for (const p of [d, `${d}.docker`, `${d}.prs`, `${d}.sc`, `${d}.work`]) rmSync(p, { recursive: true, force: true });
  mk(`${d}/logs`, `${d}.docker`, `${d}.prs`, `${d}.sc`, `${d}.work/locks`, wt);
  wr(`${d}/env.sh`, `D=$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)
W="${wt}"
LOCKS="${d}.work/locks"
HADES_ID=
HU=hds HSLICE=hades HPROJ=hades
export HADES_WT=$W HADES_DATA=$D HADES_ID HU HSLICE HPROJ
export HADES_CLEAN_LOG_MAX=1M HADES_CLEAN_PRIO_LOG_MAX=1M HADES_CLEAN_PRIO_LOGS='c*' HADES_CLEAN_LOG_TOTAL=100M HADES_CLEAN_LOG_KEEP=2
export HADES_CLEAN_JOBS_KEEP=3 HADES_CLEAN_JOBS_DAYS=14 HADES_CLEAN_CACHE_DAYS=1 HADES_CLEAN_RELEASES_DIR=${d}.rel HADES_CLEAN_RELEASES_KEEP=2
export HADES_CLEAN_TIMER=on HADES_CLEAN_EVERY=6h
source "${K}/config.sh"   # hades_base (o config.tsv do kit não existe aqui: só as funções)
`);
}
/** tree: o que sobra em disco (nomes e tamanhos, sem os arquivos de apoio do teste) */
function tree(d: string, sizes = true): string {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(join(d, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name !== "env.sh" && e.name !== "clean.lock" && !/\.(py|sh)$/.test(e.name)) out.push(`${p.replace(/pr-state-[0-9a-f]{12}/, "pr-state-H")} ${statSync(join(d, p)).size}`);
    }
  };
  walk("");
  return out.sort().map((l) => (sizes ? l : l.replace(/ [0-9]*$/, ""))).join("\n") + "\n";
}

describe("clean: categorias, status, list, run, yes, rotate, apply", () => {
  beforeAll(() => {
    mk(BIN, NB, wt);
    nopath(NB, ["bash", "awk", "cut", "dirname", "python3"]);
    exe(`${BIN}/docker`, `#!/usr/bin/env bash
d=\${FAKE_DOCKER:?}; echo "$*" >> "$d/calls.log"
case "$1" in
  info) exit 0 ;;
  container) cut -d' ' -f1 "$d/containers" ;;
  inspect) shift 3; for c in "$@"; do awk -v c="$c" '$1 == c {print $2}' "$d/containers"; done ;;
  images) awk -F'|' '$5 == 1 {print $1}' "$d/images" ;;
  compose) tr ' ' '\\n' < "$d/compose-images" ;;
  image) fmt=$4; id=$5
    line=$(awk -F'|' -v i="$id" '$1 == i || $2 == i || $3 == i {print; exit}' "$d/images"); [[ -n $line ]] || exit 1
    IFS='|' read -r s f t b _ <<< "$line"
    case $fmt in '{{.Id}}') echo "$f" ;; '{{.Size}}') echo "$b" ;; *) echo "\${t:-$f}" ;; esac ;;
  rmi) ! grep -qxF "$2" "$d/rmi-fail" 2>/dev/null || exit 1
    awk -F'|' -v r="$2" '$3 != r && $2 != r' "$d/images" > "$d/images.new"; mv "$d/images.new" "$d/images" ;;
esac
`);
    exe(`${BIN}/gh`, `#!/usr/bin/env bash
[[ "$1 $2" == "pr view" ]] || exit 2
echo "$3 $PWD" >> "\${FAKE_PRSTATE:?}/calls.log"; cat "$FAKE_PRSTATE/$3" 2>/dev/null || exit 1
`);
    exe(`${BIN}/systemctl`, `#!/usr/bin/env bash
# systemctl falso do clean: unit ativa só se existe $FAKE_SYSTEMCTL_DIR/active/<unit>; o resto como o stub comum
d=\${FAKE_SYSTEMCTL_DIR:?}; mkdir -p "$d/enabled"; echo "$*" >> "$d/calls.log"
args=("$@"); [[ \${args[0]:-} == --user ]] && args=("\${args[@]:1}")
cmd=\${args[0]:-}; unit=; for x in "\${args[@]:1}"; do [[ $x == -* || $x == LastTriggerUSec ]] || unit=$x; done
case $cmd in
  is-enabled) [[ -f $d/enabled/$unit ]] || exit 1 ;;
  enable) touch "$d/enabled/$unit" ;;
  disable) rm -f "$d/enabled/$unit" ;;
  is-active) [[ -f $d/active/$unit ]] || exit 3 ;;
  show) [[ -f $d/last ]] && cat "$d/last" ;;
  start|restart) mkdir -p "$d/active"; touch "$d/active/$unit" ;;
esac
exit 0
`);
  });
  /** logs, execuções do painel, cache, dist, pacotes, imagens e worktrees de agente */
  function seedclean(d: string): void {
    wr(`${d}/logs/a.log`, bytesOf(3145728, "a")); wr(`${d}/logs/d.log`, bytesOf(100000, "d"));
    mk(`${d}/logs/panel-jobs`, `${d}/logs/panel-cache`, `${wt}/dist/apps/x`, `${wt}/dist/apps/y`, `${d}.rel`, `${d}.work/orchestration/agents`);
    for (let i = 1; i <= 6; i++) { // 6 execuções (id mais novo = maior); a 3 não tem .rc e a unit dela está ativa
      wr(`${d}/logs/panel-jobs/job${i}.json`, "{}\n"); wr(`${d}/logs/panel-jobs/job${i}.log`, `log${i}\n`); if (i !== 3) wr(`${d}/logs/panel-jobs/job${i}.rc`, "0\n");
    }
    wr(`${d}/logs/panel-jobs/velho.json`, "{}\n"); ago(`${d}/logs/panel-jobs/velho.json`, 30); wr(`${d}/logs/panel-jobs/velho.rc`, "0\n");
    mk(`${d}/logs/panel-jobs-nada`, `${d}.sc/active`); wr(`${d}.sc/active/hds-pjob-job3`, "");
    wr(`${d}/logs/panel-cache/novo.json`, "novo\n"); wr(`${d}/logs/panel-cache/velho.json`, "velho\n"); ago(`${d}/logs/panel-cache/velho.json`, 3);
    mk(`${d}/logs/panel-cache/sub`); wr(`${d}/logs/panel-cache/sub/v2.json`, "v2\n"); ago(`${d}/logs/panel-cache/sub/v2.json`, 5);
    for (const f of ["4.9.0", "4.10.0", "4.2.1", "4.11.0"]) wr(`${d}.rel/hades-skill-v${f}.tar.gz`, bytesOf(Number(`${f.length}0`), "\0")); wr(`${d}.rel/outro.txt`, "x\n");
    wr(`${d}.docker/containers`, "c1 sha256:img-used\nc2 sha256:img-used2\n");
    wr(`${d}.docker/images`, ["aaa|sha256:img-used|app:1|1000|1", "bbb|sha256:img-free|app:2|2048|1", "ccc|sha256:img-compose|app:3|500|0", "ddd|sha256:img-notag||300|1", "eee|sha256:img-used2|app:5|700|1"].join("\n") + "\n");
    wr(`${d}.docker/compose-images`, "app:3 app:missing\n");
    for (let k = 1; k <= 5; k++) { // 1 mergeada limpa, 2 fechada suja, 3 aberta, 4 sem estado do gh, 5 sem diretório
      const w = `${T}/b2-wts/${d.split("/").pop()}-${k}`; rmSync(w, { recursive: true, force: true }); mk(w);
      if (k !== 5) { r.git(w, "init", "-q", "-b", "main"); wr(`${w}/f`, "a\n"); r.git(w, "add", "-A"); r.git(w, "commit", "-qm", "i"); }
      if (k === 2) wr(`${w}/sujo`, "dirty\n");
      wr(`${d}.work/orchestration/agents/ag${k}.json`, `{"worktree": "${w}", "pr": ${k + 100}}\n`);
    }
    wr(`${d}.prs/101`, "MERGED\n"); wr(`${d}.prs/102`, "CLOSED\n"); wr(`${d}.prs/103`, "OPEN\n");
    wr(`${d}.work/orchestration/agents/semwt.json`, '{"worktree": null, "pr": 7}\n');
  }
  const reseed = () => {
    mkd(DN);
    rmSync(`${T}/b2-wts`, { recursive: true, force: true });
    seedclean(DN);
  };
  /** O mesmo comando do clean: a saída gravada do original e a da CLI (saída, código e arquivos de estado vêm nos testes seguintes). */
  const cn = (args: string[], env: Env = {}, merge = true) => nrm(rcLine(kx(DN, ["clean", ...args], env, { merge })), DN);
  const cmpTest = (label: string, args: string[], merge = true) => test(`${label}: iguais aos gravados (saída e código)`, () => {
    const ref = g.get<string>(`clean ${label}`);
    const atual = cn(args, {}, merge); g.fix(`clean ${label}`, atual); expect(atual).toBe(ref);
  });

  beforeAll(reseed);
  cmpTest("clean status", ["status"]);
  cmpTest("clean sem argumento (status)", []);
  cmpTest("clean status --tsv", ["status", "--tsv"]);
  for (const c of ["logs", "panel-jobs", "panel-cache", "dist", "images", "releases", "worktrees"]) cmpTest(`clean list ${c}`, ["list", c]);
  cmpTest("clean list de categoria desconhecida", ["list", "zzz"]);
  cmpTest("clean list sem categoria: mesmo código", ["list"], false);
  cmpTest("clean yes de categoria segura é recusado", ["yes", "logs"]);
  cmpTest("clean yes dist é recusado", ["yes", "dist"]);
  cmpTest("clean run com argumento inválido", ["run", "--zzz"]);
  cmpTest("clean run --yes de categoria segura é recusado", ["run", "--yes", "logs"]);
  cmpTest("clean run --dry-run --yes images --yes releases", ["run", "--dry-run", "--yes", "images", "--yes", "releases"]);
  cmpTest("clean run --dry-run --yes worktrees", ["run", "--dry-run", "--yes", "worktrees"]);
  cmpTest("clean run --quiet (nada liberado fora dos seguros)", ["run", "--quiet", "--dry-run"]);
  test("clean: estado em disco igual depois das simulações", () => { expect(tree(DN, false)).toBe(g.get<string>("clean estado após simulações")); });
  cmpTest("clean status (depois das simulações)", ["status"]);
  cmpTest("clean rotate --dry-run", ["rotate", "--dry-run"]);
  cmpTest("clean run --quiet (uma linha por categoria segura)", ["run", "--quiet"]);
  test("clean run --quiet: o que sobra em disco é igual", () => { expect(tree(DN)).toBe(g.get<string>("clean run --quiet: disco")); });
  test("clean run (execução real, todas as seguras; as com --yes ficam)", () => {
    reseed(); const ref = g.get<string>("clean run real");
    const atual = cn(["run"]); g.fix("clean run real", atual); expect(atual).toBe(ref);
  });
  test("clean run: o que sobra em disco é igual", () => { expect(tree(DN)).toBe(g.get<string>("clean run real: disco")); });
  for (const c of ["run --yes images --yes releases", "yes releases", "yes images", "run --yes worktrees"]) {
    const sobra = (d: string, tag: string) => `${tree(d)}${slurp(`${d}.docker/images`)}${readdirSync(`${T}/b2-wts`).filter((x) => x.includes(tag)).sort().map((x) => x.replace(tag, "")).join("\n")}\n`;
    test(`clean ${c}: iguais aos gravados (saída e código)`, () => {
      reseed();
      wr(`${DN}.docker/rmi-fail`, "app:2\n");
      const ref = g.get<string>(`clean ${c}`);
      const atual = cn(c.split(" ")); g.fix(`clean ${c}`, atual); expect(atual).toBe(ref);
    });
    test(`clean ${c}: o que sobra em disco, no docker e nos worktrees é igual`, () => { expect(sobra(DN, "b2-dn")).toBe(g.get<string>(`clean ${c}: disco`)); });
  }
  // outra limpeza em andamento: o lock é do flock do sistema
  describe("outra limpeza em andamento", () => {
    const hold = (d: string) => Bun.spawn([BASH, "-c", 'exec 7>"$1/clean.lock"; flock -n 7; sleep 5', "_", d], { stdout: "ignore", stderr: "ignore" });
    const hs: ReturnType<typeof hold>[] = [];
    beforeAll(() => {
      mkd(DN);
      hs.push(hold(DN));
      Bun.sleepSync(500);
    });
    cmpTest("clean run com outra limpeza em andamento", ["run"]);
    cmpTest("clean yes releases com outra limpeza em andamento", ["yes", "releases"]);
    afterAll(() => { for (const h of hs) h.kill(); });
  });
  // apply: as units gravadas e as chamadas ao systemctl
  describe("apply", () => {
    const hn = `${T}/b2-hn`;
    const units = (d: string, h: string) => unitNorm(r.X(["bash", "-c", 'cat "$1"/.config/systemd/user/* "$2.sc/calls.log" 2>&1 | grep -v "^--version" | sed "s#$2#<D>#g;s#$1#<H>#g"', "_", h, d]).out);
    beforeAll(() => {
      mkd(DN);
    });
    for (const [i, c] of ["apply", "apply", "apply-mudou", "apply-off"].entries()) {
      test(`clean ${c}: saída e código iguais, units gravadas e chamadas ao systemctl iguais aos gravados`, () => {
        if (c === "apply-mudou") for (const d of [DN]) wr(`${d}/env.sh`, readFileSync(`${d}/env.sh`, "utf8").replace("HADES_CLEAN_EVERY=6h", "HADES_CLEAN_EVERY=2h"));
        if (c === "apply-off") for (const d of [DN]) wr(`${d}/env.sh`, readFileSync(`${d}/env.sh`, "utf8").replace("HADES_CLEAN_TIMER=on", "HADES_CLEAN_TIMER=off"));
        const ref = g.get<{ out: string; units: string }>(`clean ${c} ${i}`);
        const on = nrm(rcLine(kx(DN, ["clean", "apply"], { HOME: hn })), DN);
        expect(on).toBe(ref.out);
        expect(units(DN, hn)).toBe(ref.units);
      });
    }
  });
  // sem docker, gh e systemctl (nada no PATH): o status segue, as imagens e worktrees somem em silêncio; apply falha cedo (69)
  test("clean status sem docker, gh e systemctl: sai 0, timer desligado", () => {
    mkd(DN);
    const o = kx(DN, ["clean", "status", "--tsv"], { PATH: NB, HOME: `${T}/b2-hn` });
    expect(`${o.rc} ${o.out.includes("@timer\tdesligado\t-") && o.out.includes("images\tconfirma\t0\t0\t0") ? "sim" : `não (${o.out})`}`).toBe("0 sim");
  });
  test("clean apply sem systemctl: sai 69 com a instrução do registro", () => {
    const o = kx(DN, ["clean", "apply"], { PATH: NB, HOME: `${T}/b2-hn` });
    expect(`${o.rc} ${o.out.includes("dependência ausente: systemctl") ? "sim" : `não (${o.out})`}`).toBe("69 sim");
  });
});

// ---- rebuild-branch: a hades/local reconstruída de um remoto de teste (merge, JSON, conflito, stack desalinhada) ----
describe("rebuild-branch", () => {
  const BIN2 = `${T}/b2-bin2`, RM = `${T}/b2-remote.git`, RS = `${T}/b2-seed`, FP = `${T}/b2-prs`, CL = `${T}/b2-cl`, CN = `${T}/b2-cn`;
  const g2 = (dir: string, ...a: string[]) => r.git(dir, ...a);
  const rb = (branch: string, pr: number, base: string, file: string, content: string) => {
    g2(RS, "checkout", "-q", "-b", branch, base); wr(`${RS}/${file}`, content); g2(RS, "add", "-A"); g2(RS, "commit", "-qm", `pr ${pr}`);
    g2(RS, "push", "-q", "origin", branch); g2(RM, "update-ref", `refs/pull/${pr}/head`, g2(RS, "rev-parse", "HEAD").out.trim());
  };
  const mkclone = (d: string, c: string) => {
    rmSync(c, { recursive: true, force: true }); r.X(["git", "clone", "-q", RM, c]); g2(c, "checkout", "-q", "-b", "hades/local", "origin/develop");
    wr(`${d}/env.sh`, readFileSync(`${d}/env.sh`, "utf8").replace(/^W=.*$/m, `W="${c}"`));
    wr(`${d}/fixups.sh`, '#!/usr/bin/env bash\necho "fixups ${FAKE_TAG:-ok}"\n');
    wr(`${d}/web-overlay.sh`, '#!/usr/bin/env bash\necho "overlay ok"; echo "aviso do overlay" >&2; [[ -z ${FAKE_OVERLAY_FAIL:-} ]]\n');
  };
  const xr = (d: string, argv: string[], env: Env = {}) => xx(d, argv, { PATH: `${BIN2}:${BIN}:${PATH_STD}`, FAKE_PRS: FP, ...env });
  /** o que a reconstrução deixa (relatório, listas, histórico, árvore, estado do git, log do json-merge3) */
  const rstate = (d: string, c: string) => r.X(["bash", "-c", `d=$1; c=$2
    for f in rebuild.report prs.tsv last-build.heads last-build.develop logs/pr-set.warn logs/json-merge3.log; do echo "--$f"; cat "$d/$f" 2>&1; done
    echo '--log'; git -C "$c" log --format='%H %P %s' -30; echo '--status'; git -C "$c" status --porcelain; git -C "$c" ls-files | tr '\\n' ' '
    echo; echo '--en.json'; cat "$c/i18n/en.json" 2>/dev/null; echo '--refs'; git -C "$c" for-each-ref --format='%(refname)' refs/hades | tr '\\n' ' '`, "_", d, c]).out;
  const setup = (d: string, c: string, listpr: string | null) => {
    mkclone(d, c);
    if (listpr) wr(`${d}/prs.list`, listpr.split(" ").join("\n") + "\n");
  };
  /** A saída gravada do original (e o estado que ele deixou, se `st`) e a da CLI, cada uma num $D e num clone novos. */
  const both = (key: string, listpr: string | null, env: Env = {}, st = false) => {
    const ref = g.get<{ out: string; state: string }>(key);
    mkd(DN); setup(DN, CN, listpr);
    const on = nrm(rcLine(kx(DN, ["rebuild-branch"], { PATH: `${BIN2}:${BIN}:${PATH_STD}`, FAKE_PRS: FP, ...env })), DN, CN);
    return { ref, on, state: st ? nrm(rstate(DN, CN), DN, CN) : "" };
  };
  const boot = (s: string) => s.replace(/\([0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:]{8}\)/g, "(<boot>)");

  beforeAll(() => {
    mk(BIN2, FP);
    exe(`${BIN2}/gh`, `#!/usr/bin/env python3
# gh falso do pr-set: pr list --author A → author-A.json; --head H --state S → head-H-S.json; pr view N → view-N.json
import os, sys
if os.environ.get('FAKE_GH_FAIL'):
    print('falha de teste', file=sys.stderr); sys.exit(1)
d, a = os.environ['FAKE_PRS'], sys.argv[1:]
opt = lambda k: a[a.index(k) + 1] if k in a else ''
if a[:2] == ['pr', 'list']:
    f = f"author-{opt('--author')}.json" if '--author' in a else f"head-{opt('--head')}-{opt('--state')}.json"
elif a[:2] == ['pr', 'view']:
    f = f'view-{a[2]}.json'
else:
    sys.exit(2)
p = os.path.join(d, f)
if not os.path.exists(p):
    if a[:2] == ['pr', 'view']:
        print('não encontrada', file=sys.stderr); sys.exit(1)
    print('[]'); sys.exit(0)
sys.stdout.write(open(p).read())
`);
    // remoto: develop com a.txt, c.txt e i18n/en.json; um branch por PR (refs/pull/<n>/head)
    rmSync(RM, { recursive: true, force: true }); rmSync(RS, { recursive: true, force: true });
    r.X(["git", "init", "-q", "--bare", "-b", "develop", RM]); mk(RS); g2(RS, "init", "-q", "-b", "develop"); g2(RS, "remote", "add", "origin", RM);
    mk(`${RS}/i18n`); wr(`${RS}/a.txt`, "um\ndois\n"); wr(`${RS}/c.txt`, "c1\nc2\n"); wr(`${RS}/i18n/en.json`, '{\n  "a": 1,\n  "z": 0\n}\n');
    g2(RS, "add", "-A"); g2(RS, "commit", "-qm", "base"); g2(RS, "push", "-q", "origin", "develop");
    rb("feat-a", 10, "develop", "a.txt", "um\ndois\ntres\n");
    rb("feat-b", 11, "feat-a", "b.txt", "b\n");
    rb("feat-j1", 12, "develop", "i18n/en.json", '{\n  "a": 1,\n  "x": 5,\n  "z": 0\n}\n');
    rb("feat-j2", 13, "develop", "i18n/en.json", '{\n  "a": 1,\n  "y": 6,\n  "z": 0\n}\n');
    rb("feat-k", 14, "develop", "c.txt", "k\nc2\n");
    rb("feat-l", 15, "develop", "c.txt", "l\nc2\n");
    rb("feat-s1", 20, "develop", "s.txt", "one\n");
    rb("feat-s2", 21, "feat-s1", "t.txt", "t\n");
    // feat-s1 reescrita (rebase): a PR 21 ainda carrega o commit antigo dela
    g2(RS, "checkout", "-q", "feat-s1"); g2(RS, "commit", "-q", "--amend", "-m", "pr 20 reescrita"); g2(RM, "update-ref", "refs/pull/20/head", g2(RS, "rev-parse", "HEAD").out.trim());
    rb("feat-s3", 22, "feat-s1", "s.txt", "other\n");
    const pr = (n: number, head: string, base: string) => ({ number: n, title: `PR ${n} título`, headRefName: head, baseRefName: base, isDraft: false, headRefOid: String(n).padStart(4, "0") + "a".repeat(36), state: "OPEN" });
    const P = [pr(10, "feat-a", "develop"), pr(11, "feat-b", "feat-a"), pr(12, "feat-j1", "develop"), pr(13, "feat-j2", "develop"), pr(14, "feat-k", "develop"),
      pr(15, "feat-l", "develop"), pr(20, "feat-s1", "develop"), pr(21, "feat-s2", "feat-s1"), pr(22, "feat-s3", "feat-s1")];
    for (const p of P) { writeJson(`${FP}/view-${p.number}.json`, p); writeJson(`${FP}/head-${p.headRefName}-open.json`, [p]); writeJson(`${FP}/head-${p.headRefName}-all.json`, [p]); }
    writeJson(`${FP}/author-@me.json`, P);
  });

  for (const sc of ["ok|10 11", "json|12 13", "conflito|14 15", "empilhada desalinhada|20 21", "cherry-pick em conflito|20 22", "mistura|10 11 12 13", "conflito depois de PR boa|10 14 15"]) {
    const [name, listpr = ""] = sc.split("|");
    test(`rebuild-branch (${name}): saída e código, relatório, listas, histórico do git e árvore iguais aos gravados`, () => {
      const b = both(`rebuild-branch (${name})`, listpr, {}, true);
      expect(b.on, "saída").toBe(b.ref.out);
      expect(b.state, "estado").toBe(b.ref.state);
    }, 60_000);
  }
  // sem a hades/local, com lock órfão, sem remoto, pr-set que falha, overlay que falha
  test("rebuild-branch fora da hades/local: mesma mensagem, sai 2", () => {
    const ref = g.get<string>("rebuild-branch fora da hades/local");
    mkd(DN); mkclone(DN, CN); g2(CN, "checkout", "-q", "-b", "outra");
    expect(nrm(rcLine(kx(DN, ["rebuild-branch"], { PATH: `${BIN2}:${BIN}:${PATH_STD}`, FAKE_PRS: FP })), DN, CN)).toBe(ref);
  });
  test("rebuild-branch com index.lock: mesma instrução, sai 3", () => {
    const ref = g.get<string>("rebuild-branch index.lock");
    mkd(DN); mkclone(DN, CN); writeFileSync(`${CN}/.git/index.lock`, "");
    expect(boot(nrm(rcLine(kx(DN, ["rebuild-branch"], { PATH: `${BIN2}:${BIN}:${PATH_STD}`, FAKE_PRS: FP })), DN, CN))).toBe(ref);
  });
  test("rebuild-branch sem remoto: git fetch falhou, sai 3", () => {
    const ref = g.get<string>("rebuild-branch sem remoto");
    mkd(DN); mkclone(DN, CN); g2(CN, "remote", "set-url", "origin", `${T}/nao-existe`);
    expect(nrm(rcLine(kx(DN, ["rebuild-branch"], { PATH: `${BIN2}:${BIN}:${PATH_STD}`, FAKE_PRS: FP })), DN, CN)).toBe(ref);
  });
  test("rebuild-branch com pr-set que falha: mensagem e sai 2", () => {
    const b = both("rebuild-branch pr-set falha", null, { FAKE_GH_FAIL: "1" }); // o traceback do Python e a mensagem do TypeScript diferem: vale a primeira linha e o código
    const hl = (s: string) => `${lines(s)[0]} ${lines(s).at(-1)}`;
    expect(hl(b.on)).toBe(hl(b.ref.out));
  });
  test("rebuild-branch com web-overlay que falha: relatório e saída iguais aos gravados", () => {
    const b = both("rebuild-branch web-overlay falha", "10", { FAKE_OVERLAY_FAIL: "1", FAKE_TAG: "x" });
    expect(b.on).toBe(b.ref.out);
  });
  test("rebuild-branch sem git: sai 69 com a instrução do registro", () => {
    const o = r.X([BUN, CLI, "rebuild-branch"], { merge: true, env: { PATH: NB, HADES_BUN: BUN, HADES_SKILL_DIR: SKILL, HADES_WT: CN, HADES_KIT_DIR: DN } });
    expect(`${o.rc} ${o.out.includes("dependência ausente: git") ? "sim" : `não (${o.out})`}`).toBe("69 sim");
  });
});

// ---- watch: HEADS-CHANGED, CEDE e GATES-CLEAR (o original rodou com um sleep falso de 0,5 s; a CLI com HADES_WATCH_TICK_MS) ----
describe("watch", () => {
  const BIN2 = `${T}/b2-bin2`, RM = `${T}/b2-remote.git`, FP = `${T}/b2-prs`, CL = `${T}/b2-cl`, CN = `${T}/b2-cn`, SL = `${T}/b2-sleep`;
  const q = (d: string) => `${d}.work/locks/gate-queue`;
  beforeAll(() => {
    mk(SL); // o ticket sai de dentro do sleep falso (entre dois passos do laço): remover em paralelo corre com o grep do original
  });
  /** wmk: $D com o plantão, o pr-set, um last-build.heads atrasado e gates esperando */
  const wmk = (d: string, c: string) => {
    mkd(d, "watch.sh", "pr-set.py");
    rmSync(c, { recursive: true, force: true }); r.X(["git", "clone", "-q", RM, c]); r.git(c, "checkout", "-q", "-b", "hades/local", "origin/develop");
    wr(`${d}/env.sh`, readFileSync(`${d}/env.sh`, "utf8").replace(/^W=.*$/m, `W="${c}"`));
    wr(`${d}/last-build.heads`, "10\t0010aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n99\tvelho\n");
    mk(q(d));
    wr(`${q(d)}/t1.t`, "state=waiting\nkind=gate\nlabel=agente-x\nsince=2020-01-01T00:00:00Z\n");
    wr(`${q(d)}/t2.t`, "state=waiting\nkind=gate\nlabel=hades-proprio\nsince=2020-01-01T00:00:00Z\n");
    wr(`${q(d)}/t3.t`, "state=waiting\nkind=build\nlabel=outro\nsince=2020-01-01T00:00:00Z\n");
  };
  /** wrun: roda o plantão 3,5 s (a fila esvazia em 1,2 s) e devolve a saída e o last-diff */
  const wrun = async (d: string, cede: string) => {
    const rm = Bun.spawn([BASH, "-c", '/usr/bin/sleep 1.2; rm -f "$1"', "_", `${q(d)}/t1.t`], { stdout: "ignore", stderr: "ignore" }); // o kit tolera ticket que some entre a listagem e a leitura
    rmSync(`${q(d)}/.ticks`, { force: true });
    const o = kx(d, ["env-watch"], { FAKE_WATCH_QDIR: q(d), PATH: `${BIN2}:${BIN}:${PATH_STD}`, FAKE_PRS: FP, HADES_WATCH_PR_EVERY: "600", HADES_CEDE: cede, HADES_CEDE_AVAIL_MB: "100000000", HADES_WATCH_TICK_MS: "500" }, { pre: ["timeout", "3.5"] });
    await rm.exited;
    return `${o.out.replace(/MemAvailable [0-9]+ MB/g, "MemAvailable N MB")}last-diff: ${slurp(`${d}/logs/watch.last-diff`)}\n`;
  };
  test("watch: HEADS-CHANGED, CEDE e GATES-CLEAR iguais aos gravados", async () => {
    wmk(DN, CN);
    const ol = await g.get<string>("watch cede=1"), on = await wrun(DN, "1");
    expect(nrm(on, DN)).toBe(ol);
    const n = (re: RegExp) => lines(on).filter((l) => re.test(l)).length;
    expect(`${n(/^HEADS-CHANGED/)} ${n(/^CEDE agente-x/)} ${n(/^GATES-CLEAR/)}`, "os três eventos").toBe("1 1 1");
  }, 30_000);
  test("watch com HADES_CEDE=0: igual aos gravados (sem CEDE)", async () => {
    wmk(DN, CN);
    const ol = await g.get<string>("watch cede=0"), on = await wrun(DN, "0");
    expect(nrm(on, DN)).toBe(ol);
    expect(lines(on).filter((l) => l.startsWith("CEDE")).length, "nada de CEDE").toBe(0);
  }, 30_000);
  test("watch com cede.disabled: igual aos gravados", async () => {
    wmk(DN, CN);
    wr(`${DN}/cede.disabled`, "");
    const ol = await g.get<string>("watch cede.disabled"), on = await wrun(DN, "1");
    expect(nrm(on, DN)).toBe(ol);
    expect(lines(on).filter((l) => l.startsWith("CEDE")).length, "nada de CEDE").toBe(0);
  }, 30_000);
});

// ---- tunnel: front, painel e widget (devtunnel, journalctl, systemd-run falsos; chamadas comparadas com as gravadas do original) ----
describe("tunnel", () => {
  const BIN2 = `${T}/b2-bin2`, TB = `${T}/b2-tb`;
  beforeAll(() => {
    mk(BIN2, TB);
    exe(`${TB}/devtunnel`, `#!/usr/bin/env bash
echo "$*" >> "$FAKE_DT_LOG"
case $1 in
  --version) echo "devtunnel 1.0.0"; echo "segunda linha" ;;
  list) cat "$FAKE_DT_LOG.names" 2>/dev/null ;;
  create) echo "$2.reg 0 0" >> "$FAKE_DT_LOG.names" ;;
  show) [[ -n \${FAKE_DT_NOSHOW:-} ]] && exit 0; for p in 3000 21220 21221 21222 21223 21299; do echo "  https://rnd\$p-\$p.brs.devtunnels.ms"; done ;;
  user) if [[ -n \${FAKE_DT_NOLOGIN:-} ]]; then echo "Not logged in." >&2; exit 1; fi; echo "Logged in as regressao using GitHub." ;;
  access) [[ $2 == list ]] && printf 'cabecalho\\nregra 1\\nregra 2\\n' ;;
esac
exit 0
`);
    exe(`${TB}/journalctl`, '#!/usr/bin/env bash\n[[ ${FAKE_JOURNAL:-} == none ]] && exit 0\necho "linha antiga https://velha-3000.x.devtunnels.ms"; echo "https://a-3000.x.devtunnels.ms https://b-21220.y.devtunnels.ms https://w-21221.z.devtunnels.ms"\n');
    exe(`${TB}/systemd-run`, '#!/usr/bin/env bash\necho "$*" >> "$FAKE_SDR_LOG"\n');
    exe(`${TB}/curl`, '#!/usr/bin/env bash\nwhile [[ $# -gt 0 ]]; do [[ $1 == -o ]] && { shift; echo bin > "$1"; }; shift; done\n');
    // skill falsa do original: a real por links, com o Cerberus trocado por um que registra os argumentos e sai com FAKE_CERB
  });
  /** tmk: $D do túnel, sem estado */
  const tmk = () => {
    for (const d of [DN]) { mkd(d, "tunnel.sh"); mk(`${d}/panel`, `${d}.home`); for (const s of ["", ".names", "sdr", "cerb"]) rmSync(`${d}.${s || "dt"}`, { force: true }); rmSync(`${d}.dt.names`, { force: true }); }
  };
  const TAIL = String.raw`
echo '--estado'; (cd "$d" && for f in tunnel.id tunnel.url panel-tunnel.id panel-tunnel.url widget-tunnel.id widget-tunnel.url widget-tunnel.expires; do [[ -e $f ]] && echo "$f: $(sed -E 's/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z/<ts>/' "$f")"; done; [[ -s panel/remote.key ]] && echo "remote.key: $(stat -c %a panel/remote.key) $(( $(wc -c < panel/remote.key) >= 15 ))")
echo '--chamadas'; for f in "$d.dt" "$d.sdr" "$d.cerb" "$d.sc/calls.log"; do echo "$(sed 's/.*\.//' <<< "$f"):"; grep -vx -e '--version' "$f" 2>/dev/null; done`;
  const SCRIPT_N = `d=$1; shift\n( . "$d/env.sh"; HADES_KIT_DIR="$d" exec ${BUN} ${CLI} tunnel "$@" ) 2>&1; echo "rc=$?"${TAIL}`;
  const penv = (d: string, pre: string, env: Env): Env => ({
    PATH: `${pre}${TB}:${BIN2}:${BIN}:${PATH_STD}`, HOME: `${d}.home`, FAKE_DT_LOG: `${d}.dt`, FAKE_SDR_LOG: `${d}.sdr`, FAKE_CERB_LOG: `${d}.cerb`,
    HADES_PANEL_PORT: "21220", HADES_TUNNEL_POLL_MS: "10", ...env });
  // o Cerberus do original era um falso; a CLI chama o de verdade (modo da porta: off passa, barra barra). Ficam de fora a saída dele e o registro de argumentos do falso.
  const sideN = (d: string, env: Env, args: string[]) => xx(d, ["bash", "-c", SCRIPT_N, "_", d, ...args], { ...penv(d, "", env), HADES_CERBERUS_PORTA: env.FAKE_CERB === "1" ? "barra" : "off" }).out;
  const nocerb = (s: string) => s.replace(/^ {2}✗ barra .*\n/gm, "").replace(/^cerberus tunel: .*\n/gm, "").replace(/^cerb:\n[\s\S]*?^log:/m, "cerb:\nlog:");
  const ts = (s: string) => s.replace(/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z/g, "<ts>");
  /** tcmp: o mesmo comando; saída, código, estado do $D e chamadas externas iguais às gravadas (o instante de validade tem resolução de segundo) */
  const tcmp = (label: string, env: Env, args: string[], pre?: () => void) => test(`tunnel ${label}: saída, código, estado e chamadas iguais aos gravados`, () => {
    pre?.();
    const a = g.get<string>(`tunnel ${label}`);
    const b = sideN(DN, env, args);
    // o `devtunnel show` (host real da porta para o Cerberus) não existia quando os goldens foram gravados
    // idem as chamadas `user show` e `list` da checagem de login na API (tunnel.ts devtunnelLoggedIn), que não dão para tirar por regex: o
    // número de `user show` já gravado varia por comando. Só a seção `dt:` dos goldens é regravada (LEGADO_REGRAVA=1, g.fix), o resto fica como gravado.
    const atual = ts(nrm(b, DN)).replace(/^show.*\n/gm, "");
    const dt = (x: string) => /^dt:\n[\s\S]*?(?=^sdr:)/m.exec(x)?.[0] ?? "";
    g.fix(`tunnel ${label}`, a.replace(dt(a), () => dt(atual)));
    expect(nocerb(atual)).toBe(nocerb(a));
  }, 30_000);
  const P = { HADES_TUNNEL_PORT: "3000" };
  tcmp("sem argumento (uso)", {}, [], tmk);
  tcmp("comando desconhecido", {}, ["zzz"]);
  tcmp("login-cmd", {}, ["login-cmd"]);
  tcmp("stop-cmd", {}, ["stop-cmd"]);
  tcmp("install com o devtunnel presente", {}, ["install"]);
  tcmp("create sem porta", {}, ["create"]);
  tcmp("create", P, ["create"]);
  tcmp("create de novo (o túnel já existe)", P, ["create"]);
  tcmp("publish-cmds", { ...P, HADES_TUNNEL_ANON_TTL: "2d" }, ["publish-cmds"]);
  tcmp("publish-cmds barrado pelo Cerberus", { ...P, HADES_TUNNEL_ANON_TTL: "2d", FAKE_CERB: "1" }, ["publish-cmds"]);
  tcmp("url", P, ["url"]);
  tcmp("publish-cmds sem tunnel.id", { ...P, HADES_TUNNEL_ANON_TTL: "1d" }, ["publish-cmds"], tmk);
  tcmp("url com gen-env.sh e tunnel-after.txt", P, ["url"], () => {
    for (const d of [DN]) { wr(`${d}/gen-env.sh`, '#!/usr/bin/env bash\necho gen-env "$(cat "$0.url" 2>/dev/null)" >> "$(dirname "$0")/gen-env.out"\n'); wr(`${d}/tunnel-after.txt`, "serviço a\nserviço b\n"); }
  });
  tcmp("url sem URL no journal", { ...P, FAKE_JOURNAL: "none" }, ["url"]);
  tcmp("url sem porta", {}, ["url"]);
  tcmp("status sem porta", {}, ["status"]);
  tcmp("status", P, ["status"]);
  tcmp("panel-start deslogado", { FAKE_DT_NOLOGIN: "1" }, ["panel-start"], tmk);
  tcmp("panel-start", {}, ["panel-start"], () => { for (const d of [DN]) wr(`${d}/panel/remote.key`, "chave\n"); });
  tcmp("panel-start com a unit ativa (sem Cerberus)", {}, ["panel-start"]);
  tcmp("panel-start barrado pelo Cerberus", { FAKE_CERB: "1" }, ["panel-start"]);
  tcmp("panel-start sem URL no journal (espera e falha)", { FAKE_JOURNAL: "none" }, ["panel-start"]);
  tcmp("panel-url", {}, ["panel-url"]);
  tcmp("panel-status", {}, ["panel-status"]);
  tcmp("panel-stop", {}, ["panel-stop"]);
  tcmp("panel-start gera a chave de acesso (modo e tamanho)", {}, ["panel-start"], tmk);
  tcmp("widget-publish-cmds sem túnel", {}, ["widget-publish-cmds"], tmk);
  tcmp("widget-start sem túnel", {}, ["widget-start"]);
  tcmp("widget-create deslogado", { FAKE_DT_NOLOGIN: "1" }, ["widget-create"]);
  tcmp("widget-create", {}, ["widget-create"]);
  tcmp("widget-publish-cmds", { HADES_WIDGET_TUNNEL_TTL: "2d" }, ["widget-publish-cmds"]);
  tcmp("widget-renew-cmds", {}, ["widget-renew-cmds"]);
  tcmp("widget-publish-cmds barrado pelo Cerberus", { FAKE_CERB: "1" }, ["widget-publish-cmds"]);
  tcmp("widget-stamp (30d)", {}, ["widget-stamp"]);
  tcmp("widget-stamp (48h)", { HADES_WIDGET_TUNNEL_TTL: "48h" }, ["widget-stamp"]);
  tcmp("widget-stamp inválido", { HADES_WIDGET_TUNNEL_TTL: "abc" }, ["widget-stamp"]);
  tcmp("widget-start", {}, ["widget-start"]);
  tcmp("widget-start barrado pelo Cerberus", { FAKE_CERB: "1" }, ["widget-start"]);
  tcmp("widget-url", {}, ["widget-url"]);
  tcmp("widget-status", {}, ["widget-status"]);
  tcmp("widget-stop", {}, ["widget-stop"]);
  tcmp("widget-start sem URL (espera e falha)", { FAKE_JOURNAL: "none" }, ["widget-start"]);
  // (i) o host que o Cerberus confere é o que o `devtunnel show` mostra (aleatório), nunca o montado `<nome>-<porta>.<cluster>`
  test("tunnel panel-start: host real da porta (devtunnel show) permitido passa; o montado não vale", () => {
    const env = { FAKE_CERB: "1", FAKE_JOURNAL_URL: "https://a-21220.x.devtunnels.ms" };
    const real = sideN(DN, { ...env, HADES_CERBERUS_PORTA_TUNEL_HOSTS: "rnd21220-21220.brs.devtunnels.ms" }, ["panel-start"]);
    expect(real).not.toContain("o Cerberus barrou");
    const montado = sideN(DN, { ...env, HADES_CERBERUS_PORTA_TUNEL_HOSTS: "hades-panel-21220.reg.devtunnels.ms" }, ["panel-start"]);
    expect(montado).toContain("o Cerberus barrou o túnel painel");
  }, 30_000);
  test("tunnel publish-cmds: sem URL da porta no devtunnel show o túnel é barrado, sem cair no host montado", () => {
    const o = sideN(DN, { ...P, HADES_TUNNEL_ANON_TTL: "2d", FAKE_DT_NOSHOW: "1" }, ["publish-cmds"]);
    expect(o).toContain("não li a URL da porta 3000");
    expect(o).not.toContain("host=");
    expect(o).not.toContain("! devtunnel access create");
  }, 30_000);
  // sem devtunnel no PATH: a criação falha cedo com a instrução do registro
  test("tunnel create sem devtunnel: sai 69 com a instrução do registro", () => {
    const o = r.X([BUN, CLI, "tunnel", "create"], { merge: true, env: { PATH: NB, HADES_BUN: BUN, HADES_SKILL_DIR: SKILL, HOME: `${DN}.home`, HADES_TUNNEL_PORT: "3000", HADES_KIT_DIR: DN, HADES_WT: wt, HADES_DATA: DN } });
    expect(o.rc).toBe(69);
  });
});

// ---- notify: send, test, topic, status, apply, restart e o vigia (watch) ----
describe("notify", () => {
  // notify-send falso (anota os argumentos) e servidor ntfy falso (anota método, caminho, cabeçalhos e corpo; status em $NTS)
  const NTL = `${T}/b2-ntfy.log`, NTP = `${T}/b2-ntfy.port`, NTS = `${T}/b2-ntfy.status`;
  let srv: ReturnType<typeof Bun.spawn>, NTURL = "", NCFG: string[] = [];
  beforeAll(() => {
    exe(`${BIN}/notify-send`, '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "${FAKE_NS_LOG:?}"\n');
    for (const f of [NTL, NTP, NTS]) rmSync(f, { force: true });
    wr(NTS, "200\n");
    srv = Bun.spawn(["python3", "-c", `import http.server, sys
log, portf, statf = sys.argv[1:]
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0))).decode()
        with open(log, 'a') as f:
            f.write(f"{self.command} {self.path} Title={self.headers.get('Title')} Priority={self.headers.get('Priority')} Tags={self.headers.get('Tags')} body={body}\\n")
        self.send_response(int(open(statf).read().strip())); self.end_headers()
    def log_message(self, *a): pass
s = http.server.HTTPServer(('127.0.0.1', 0), H)
open(portf, 'w').write(str(s.server_port))
s.serve_forever()
`, NTL, NTP, NTS], { stdout: "ignore", stderr: "ignore" });
    for (let i = 0; i < 10 && !(existsSync(NTP) && statSync(NTP).size > 0); i++) Bun.sleepSync(300);
    NTURL = `http://127.0.0.1:${readFileSync(NTP, "utf8").trim()}`;
    NCFG = ["HADES_NOTIFY=1", "HADES_NOTIFY_DESKTOP=1", "HADES_NOTIFY_NTFY=1", `HADES_NOTIFY_NTFY_URL=${NTURL}`];
  });
  afterAll(() => { srv?.kill(); });
  /** A saída sem o que muda por rodada: caminhos, a porta do ntfy falso e o tópico sorteado. */
  const nn2 = (s: string, d: string) => all(nrm(s, d), NTURL, "<NTFY>").replace(/hades-[A-Za-z0-9_-]{24}/g, "<TOPIC>");
  /** mkn: $D com o notify, a config e o catálogo */
  const mkn = (d: string, ...cfg: string[]) => {
    mkd(d); copyFileSync(`${K}/config.tsv`, `${d}/config.tsv`); wr(NTL, "");
    wr(`${d}/config.env`, cfg.length ? cfg.map((c) => `${c}\n`).join("") : "\n"); wr(`${d}/ns.log`, ""); rmSync(`${d}/notify`, { recursive: true, force: true }); rmSync(`${d}/ntfy.topic`, { force: true });
  };
  const nnN = (d: string, argv: string[], env: Env = {}) => kx(d, ["notify", ...argv], { FAKE_NS_LOG: `${d}/ns.log`, DISPLAY: ":0", HOME: `${d}.home`, ...env });
  /** nstate: estado depois do comando (histórico, dedupe sem ts, tópico normalizado, notify-send, ntfy) */
  const nstate = (d: string) => r.X(["bash", "-c", String.raw`d=$1; ntl=$2; top=$(cat "$d/ntfy.topic" 2>/dev/null)
echo "-- history"; sed -E 's/"ts": [0-9]+/"ts": N/g; s/[0-9][0-9]:[0-9][0-9]\)/HH:MM)/g' "$d/notify/history.jsonl" 2>/dev/null
echo "-- dedupe"; sed -E 's/"ts": [0-9.]+/"ts": N/g' "$d/notify/dedupe.json" 2>/dev/null; echo
echo "-- topic"; if [[ -n $top ]]; then echo "$top" | sed -E 's/^hades-[A-Za-z0-9_-]{24}$/<T>/'; stat -c %a "$d/ntfy.topic"; fi
echo "-- notify-send"; sed -E 's/[0-9][0-9]:[0-9][0-9]\)/HH:MM)/' "$d/ns.log"
echo "-- ntfy"; sed -E "s#/hades-[A-Za-z0-9_-]{24} #/<T> #; s/[0-9][0-9]:[0-9][0-9]\)/HH:MM)/" "$ntl"`, "_", d, NTL]).out;
  const oneN = (argv: string[]) => { wr(NTL, ""); const o = nnN(DN, argv); return `${rcLine(o)}\n${nstate(DN)}`; };
  const reset = (...cfg: string[]) => () => {
    mkn(DN, ...cfg);
  };
  /** ncase: o comando (estado comum já montado por `setup`); saída, código e estado iguais aos gravados */
  const ncase = (label: string, setup: () => void, argv: string[]) => test(`notify ${label}: saída, código e estado iguais aos gravados`, () => {
    setup(); const ol = g.get<string>(`notify ${label}`); expect(nn2(oneN(argv), DN)).toBe(ol);
  }, 30_000);
  const ncmp = (label: string, argv: string[]) => ncase(label, () => {}, argv);
  const first = () => reset(...NCFG)();
  ncase("sem argumento (uso)", first, []);
  ncmp("comando desconhecido", ["zzz"]);
  ncmp("send incompleto", ["send", "gate", "error"]);
  ncmp("send gate (desktop e celular)", ["send", "gate", "error", "falhou o gate", "--obj", "PR 7", "--state", "s1"]);
  ncmp("send repetido na janela", ["send", "gate", "error", "falhou o gate", "--obj", "PR 7", "--state", "s1"]);
  ncmp("send com estado novo", ["send", "gate", "error", "falhou o gate", "--obj", "PR 7", "--state", "s2"]);
  ncmp("send info sem --obj (o objeto é o evento)", ["send", "pr", "info", "review novo"]);
  ncmp("send com severidade inválida (info)", ["send", "agent", "bogus", "x"]);
  ncmp("send evento fora do catálogo (both)", ["send", "outro", "warn", "evento novo", "--obj", "ç ã"]);
  ncmp("send com URL, e-mail, token, home e texto longo", ["send", "gate", "warn", `veja https://x.test/a?b=1 de ana@x.test com tokenzzzzzzzzzzzzzzzzzzzzzzzzzzzz em ${H}/proj ${"palavra ".repeat(40)}`, "--obj", "obj"]);
  ncmp("send com título acentuado (cabeçalho latin-1)", ["send", "snapshot", "error", "ação ✓ falhou", "--obj", "ç"]);
  ncmp("test", ["test"]);
  ncase("send com HADES_NOTIFY desligado", () => reset(...NCFG, "HADES_NOTIFY=0")(), ["send", "gate", "error", "x"]);
  ncmp("test com HADES_NOTIFY desligado (ignora a chave)", ["test"]);
  ncase("send com o evento desligado", () => reset(...NCFG, "HADES_NOTIFY_EV_GATE=off")(), ["send", "gate", "error", "x"]);
  ncase("send só celular dentro do silêncio", () => reset(...NCFG, "HADES_NOTIFY_EV_GATE=phone", "HADES_NOTIFY_QUIET=00:00-23:59")(), ["send", "gate", "error", "x"]);
  ncmp("test dentro do silêncio (ignora)", ["test"]);
  ncase("send só desktop com o desktop desligado", () => reset(...NCFG, "HADES_NOTIFY_EV_GATE=desktop", "HADES_NOTIFY_DESKTOP=0")(), ["send", "gate", "error", "x"]);
  ncase("ntfy responde 500", () => { wr(NTS, "500\n"); reset(...NCFG)(); }, ["send", "gate", "error", "x"]);
  ncmp("test com o ntfy em 500: sai 1", ["test"]);
  ncase("ntfy fora do ar: falhou URLError", () => reset(...NCFG, "HADES_NOTIFY_NTFY_URL=http://127.0.0.1:1")(), ["send", "gate", "error", "x"]);
  test("notify topic: tópico criado com modo 600, no formato hades- + 24 caracteres", () => {
    wr(NTS, "200\n"); reset(...NCFG)();
    const m = (d: string) => (statSync(`${d}/ntfy.topic`).mode & 0o777).toString(8);
    const ref = g.get<string>("notify topic: modo");
    nnN(DN, ["topic"]);
    expect(`${ref} ${m(DN)}`, "modo").toBe("600 600");
    expect(/^hades-[A-Za-z0-9_-]{24}$/.test(slurp(`${DN}/ntfy.topic`).trim()), "formato").toBe(true);
  });
  ncmp("topic show", ["topic", "show"]);
  test("notify topic rotate: tópico novo, diferente, no mesmo formato e modo 600", () => {
    const antes = slurp(`${DN}/ntfy.topic`).trim();
    const t = nnN(DN, ["topic", "rotate"]).out.trim();
    expect(t !== antes && t === slurp(`${DN}/ntfy.topic`).trim() && /^hades-[A-Za-z0-9_-]{24}$/.test(t) && (statSync(`${DN}/ntfy.topic`).mode & 0o777) === 0o600).toBe(true);
  });
  ncmp("status", ["status"]);
  ncmp("status --json", ["status", "--json"]);
  ncmp("status --json --reveal", ["status", "--json", "--reveal"]);
  // restart e apply: as units gravadas e as chamadas ao systemctl
  describe("apply e restart", () => {
    const hn = `${T}/b2-hn`;
    const unitsX = (d: string, h: string) => unitNorm(r.X(["bash", "-c", 'cat "$1"/.config/systemd/user/* "$2.sc/calls.log" 2>&1 | grep -v "^--version" | sed "s#$2#<D>#g;s#$1#<H>#g"', "_", h, d]).out);
    beforeAll(reset(...NCFG));
    for (const [i, ap] of ["apply", "apply", "restart", "mudou", "off"].entries()) {
      test(`notify ${ap}: saída, código, unit gravada e chamadas ao systemctl iguais aos gravados`, () => {
        const sub = ap === "restart" ? "restart" : "apply";
        if (ap === "mudou") for (const d of [DN]) appendFileSync(`${d}/config.env`, "HADES_NOTIFY_QUIET=22:00-07:00\n");
        if (ap === "off") for (const d of [DN]) wr(`${d}/config.env`, readFileSync(`${d}/config.env`, "utf8").replace("HADES_NOTIFY=1", "HADES_NOTIFY=0"));
        const novo = !(ap === "apply" && existsSync(`${DN}.sc/enabled`));
        if (novo) { for (const p of [hn, `${DN}.sc`]) rmSync(p, { recursive: true, force: true }); mk(`${DN}.sc`); }
        const ref = g.get<{ out: string; units: string }>(`notify ${ap} ${i}`);
        expect(nn2(rcLine(kx(DN, ["notify", sub], { HOME: hn })), DN), "saída").toBe(ref.out);
        expect(unitsX(DN, hn), "units").toBe(ref.units);
      });
    }
    test("notify apply: com o ntfy ligado gera o tópico", () => {
      const has = (d: string) => (existsSync(`${d}/ntfy.topic`) && statSync(`${d}/ntfy.topic`).size > 0 ? "sim" : "");
      expect(has(DN)).toBe(g.get<string>("notify apply: tópico"));
    });
    test("notify apply sem systemctl: sai 69 com a instrução do registro", () => {
      const o = kx(DN, ["notify", "apply"], { PATH: NB, HOME: hn });
      expect(`${o.rc} ${o.out.includes("dependência ausente: systemctl") ? "sim" : `não (${o.out})`}`).toBe("69 sim");
    });
  });
  // vigia: fila de gate parada, falha no journal e o heartbeat; encerra no SIGTERM (timeout)
  test("notify watch: gates (fila parada e journal), histórico, notify-send, ntfy e heartbeat iguais aos gravados", () => {
    const nwatch = (d: string) => {
      mkn(d, ...NCFG, "HADES_NOTIFY_EV_RESTART=off", "HADES_NOTIFY_EV_HEALTH=off", "HADES_NOTIFY_EV_PR=off", "HADES_NOTIFY_EV_AGENT=off", "HADES_NOTIFY_EV_DOCTOR=off", "HADES_NOTIFY_GATE_WAIT_MIN=5");
      mk(`${d}.work/locks/gate-queue`, `${d}/notify`);
      wr(`${d}.work/locks/gate-queue/a.t`, "state=waiting\nlabel=agente-x\nsince=2020-01-01T00:00:00Z\n");
      wr(`${d}.work/locks/gate-queue/b.t`, "state=running\nlabel=agente-y\nsince=2020-01-01T00:00:00Z\n");
      wr(`${d}.work/locks/gate-journal.tsv`, "t0\tstart\tgate\tag\tx\ty\t\n"); wr(`${d}/notify/heartbeat.json`, '{"gate_off": 0}\n');
      appendFileSync(`${d}.work/locks/gate-journal.tsv`, "t1\tdone\tgate\tagente-z\tx\ty\trc=2\nt2\tdone\ttest\tagente-w\tx\ty\trc=0\nt3\tdone\tbuild\tagente-v\tx\ty\trc=1\n");
      wr(NTL, "");
      const env = { FAKE_NS_LOG: `${d}/ns.log`, DISPLAY: ":0", HOME: `${d}.home`, LOCKS: `${d}.work/locks` };
      const o = { out: `rc=${kx(d, ["notify", "watch"], env, { pre: ["timeout", "7"] }).rc}\n` };
      const hb = r.X(["bash", "-c", `jq -cS . "$1/notify/heartbeat.json" | sed -E 's/"ts":[0-9]+/"ts":N/g; s/"pid":[0-9]+/"pid":N/'`, "_", d]).out;
      return `${o.out}${nstate(d)}-- heartbeat\n${hb}`;
    };
    const ol = g.get<string>("notify watch");
    expect(nn2(nwatch(DN), DN)).toBe(ol);
  }, 60_000);
});

// ---- onboard: status, show, select, skip, done, run, pick, reset ----
describe("onboard", () => {
  beforeAll(() => { exe(`${BIN}/devtunnel`, '#!/usr/bin/env bash\n[[ $1 $2 == "user show" ]] && { [[ -f ${FAKE_DEVTUNNEL:-/nao} ]] && echo "Logged in as fulano using GitHub." || echo "Not logged in." >&2; }\n'); });
  /** mko: $D com o onboard, o catálogo do plugin e as checagens do plugin */
  const mko = (d: string, ...kv: string[]) => {
    mkd(d); rmSync(`${d}.home`, { recursive: true, force: true }); rmSync(`${d}/onboard.json`, { force: true }); mk(`${d}/plugin`, `${d}/checks`);
    for (const f of ["onboard.tsv", "lib-checks.sh", "config.tsv"]) copyFileSync(`${K}/${f}`, `${d}/${f}`);
    wr(`${d}/plugin/onboard.tsv`, [
      "@testes\tTestes\tFeature só do teste",
      "testes\tt-ok\tPasso ok\thades\tmanual\t0\techo oi\t\t\tdetalhe {D}",
      "testes\tt-falha\tPasso que falha\thades\tmanual\t0\techo antes; exit 3\t\t\t",
      "testes\tt-dono\tPasso do dono\tdono\tmanual\t1\techo dono\treference/x.md\tconfig\t",
      "testes\tt-semcmd\tSem comando\thades\tmanual\t0\t\t\t\t",
      "testes\tpc-feito\tPlugin feito\tdono\tpc-feito\t0\t\t\t\t",
      "testes\tpc-erro\tPlugin sai 1\tdono\tpc-erro\t0\t\t\t\t",
      "testes\tpc-vazio\tPlugin vazio\tdono\tpc-vazio\t0\t\t\t\t",
      "testes\tpc-nada\tPlugin sem script\tdono\tpc-nada\t0\t\t\t\t",
      "testes\tpanel-tunnel\tRepetido\tdono\tmanual\t0\t\t\t\t",
    ].join("\n") + "\n");
    exe(`${d}/checks/pc-feito.sh`, "#!/usr/bin/env bash\necho feito com nota\n"); exe(`${d}/checks/pc-erro.sh`, "#!/usr/bin/env bash\necho feito\nexit 1\n"); exe(`${d}/checks/pc-vazio.sh`, "#!/usr/bin/env bash\ntrue\n");
    for (const x of kv) appendFileSync(`${d}/env.sh`, `export ${x}\n`);
  };
  const ooN = (d: string, argv: string[]) => kx(d, ["onboard", ...argv], { HOME: `${d}.home`, FAKE_LINGER: `${d}.linger`, FAKE_DEVTUNNEL: `${d}.devtunnel` });
  const ostate = (d: string) => r.X(["bash", "-c", `sed -E 's/"updated": [0-9]+/"updated": N/' "$1/onboard.json" 2>/dev/null; stat -c %a "$1/onboard.json" 2>/dev/null; ls -a "$1" | grep -c '^\\.onboard\\.'`, "_", d]).out;
  const oneN = (d: string, argv: string[]) => { const o = ooN(d, argv); return machineMask(nrm(`${o.out.replace(/"time": [0-9]+/g, '"time": N')}rc=${o.rc}\n${ostate(d)}`, d)); };
  /** ocmp: o mesmo comando: saída, código e onboard.json iguais aos gravados (a hora sai normalizada) */
  const ocmp = (label: string, argv: string[], pre?: () => void) => test(`onboard ${label}: saída, código e estado iguais aos gravados`, () => {
    pre?.(); const ol = g.get<string>(`onboard ${label}`); const atual = oneN(DN, argv); g.fix(`onboard ${label}`, atual); expect(atual).toBe(ol);
  }, 30_000);
  const fresh = (...kv: string[]) => () => {
    mko(DN, ...kv);
  };
  ocmp("status (nada feito, sem docker/devtunnel conhecidos)", ["status"], fresh());
  ocmp("sem argumento (status)", []);
  ocmp("status --quick", ["status", "--quick"]);
  ocmp("status --brief", ["status", "--brief"]);
  ocmp("status --doctor", ["status", "--doctor"]);
  ocmp("status --json", ["status", "--json"]);
  for (const c of ["remoto", "notificacoes", "automatico", "contas", "testes"]) ocmp(`show ${c}`, ["show", c]);
  ocmp("show desconhecido", ["show", "zzz"]);
  ocmp("show sem feature", ["show"]);
  ocmp("comando desconhecido", ["zzz"]);
  ocmp("--quick sozinho (comando inválido)", ["--quick"]);
  ocmp("--help", ["--help"]);
  ocmp("select desconhecido", ["select", "zzz"]);
  ocmp("select sem feature", ["select"]);
  ocmp("select", ["select", "remoto", "contas"]);
  ocmp("skip", ["skip", "contas", "notificacoes"]);
  ocmp("status --doctor depois do select", ["status", "--doctor"]);
  ocmp("status --brief depois do select", ["status", "--brief"]);
  ocmp("done", ["done", "pwa"]);
  ocmp("done passo desconhecido", ["done", "zzz"]);
  ocmp("undone sem passo", ["undone"]);
  ocmp("show remoto (pwa marcado)", ["show", "remoto"]);
  ocmp("undone", ["undone", "pwa"]);
  ocmp("pick sem terminal", ["pick"]);
  ocmp("run passo desconhecido", ["run", "zzz"]);
  ocmp("run sem passo", ["run"]);
  ocmp("run de passo do dono", ["run", "t-dono"]);
  ocmp("run de passo sem comando", ["run", "t-semcmd"]);
  ocmp("run de passo da Hades (marca como feito)", ["run", "t-ok"]);
  ocmp("run de passo que falha (sai 3)", ["run", "t-falha"]);
  ocmp("show testes (passo feito, plugin)", ["show", "testes"]);
  ocmp("reset", ["reset"]);
  // ambiente com tudo no ar: units ativas, notificações, devtunnel logado, linger, firewall com infra, remote.key
  const noAr = () => {
    const kv = ["HADES_NOTIFY=1", "HADES_NOTIFY_NTFY=1", "HADES_PANEL_AUTOSTART=boot", "HADES_CHAT=0", "HADES_FW_PROBE=ctr-x:5432", `HADES_LOGINCTL=${STUBS}/loginctl`];
    fresh(...kv)();
    for (const d of [DN]) {
      mk(`${d}.sc/active`, `${d}.sc/enabled`, `${d}/panel`);
      for (const u of ["active/hds-panel-tunnel", "active/hds-devtunnel", "active/hds-notify", "enabled/hds-panel"]) wr(`${d}.sc/${u}`, "");
      wr(`${d}/panel/remote.key`, "k\n"); wr(`${d}.linger`, "yes\n"); wr(`${d}.devtunnel`, ""); mk(`${d}.home/.claude/clickup`); wr(`${d}.home/.claude/clickup/config.json`, "{}\n");
    }
  };
  ocmp("status com o ambiente no ar (units, notificações, linger, devtunnel, clickup)", ["status", "--json"], noAr);
  ocmp("status --quick com o ambiente no ar", ["status", "--quick"]);
  ocmp("show automatico (firewall e linger)", ["show", "automatico"]);
  ocmp("status com devtunnel deslogado, linger off e vigia parado", ["status"], () => {
    for (const d of [DN]) { rmSync(`${d}.devtunnel`, { force: true }); wr(`${d}.linger`, "no\n"); rmSync(`${d}.sc/active/hds-notify`, { force: true }); }
  });
  ocmp("status com HADES_RUN_TUNNEL=0 e autostart off", ["status"], fresh("HADES_RUN_TUNNEL=0", "HADES_PANEL_AUTOSTART=off"));
  // sem docker, devtunnel, gh, herdr e systemctl no PATH: as checagens dizem pendente/na, sem falhar
  test("onboard status sem as ferramentas externas: sai 0", () => {
    mko(DN); const o = kx(DN, ["onboard", "status", "--brief"], { PATH: NB, HOME: `${DN}.home` });
    expect(o.rc).toBe(0);
    for (const d of [DN]) for (const s of ["", ".docker", ".prs", ".sc", ".work", ".rel", ".home", ".linger", ".devtunnel"]) rmSync(`${d}${s}`, { recursive: true, force: true });
    rmSync(`${T}/b2-wts`, { recursive: true, force: true });
  });
});

// ---- doctor: diagnóstico completo (ss, docker e systemctl falsos; o plugin roda no shim) ----
describe("doctor", () => {
  beforeAll(() => {
    exe(`${BIN}/ss`, '#!/usr/bin/env bash\ncat "${FAKE_SS:-/dev/null}"\nexit "${FAKE_SS_RC:-0}"\n');
    // O espaço livre real do /tmp muda com a máquina e muda a linha de disco (e o nível) do golden: 7 GB fixos, em KiB como o df -Pk.
    exe(`${BIN}/df`, '#!/usr/bin/env bash\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted\\n"\nprintf "fake 8388608 1048576 %s 13%% %s\\n" "${FAKE_DF_AVAIL_KIB:-7340032}" "${!#}"\n'); });
  /** mkdoc: $D com config.tsv real, versão do kit, instance e as chaves pedidas */
  const mkdoc = (d: string, ...kv: string[]) => {
    mkd(d); rmSync(`${d}.home`, { recursive: true, force: true }); rmSync(`${d}/plugin`, { recursive: true, force: true }); mk(`${d}.home/.claude/hades/instances`, `${d}/plugin`);
    for (const f of ["config.tsv", "lib-checks.sh"]) copyFileSync(`${K}/${f}`, `${d}/${f}`); wr(`${d}/kit.version`, "4.0.0\n");
    wr(`${d}.home/.claude/hades/instance`, `${d}\n`); wr(`${d}.home/.claude/hades/work-root`, `${d}.work\n`); wr(`${d}.ss`, "total  0\n");
    for (const x of kv) appendFileSync(`${d}/env.sh`, `export ${x}\n`);
  };
  /** A versão e o caminho da skill são desta máquina e desta versão: saem do texto. */
  const dnorm = (s: string, d: string) => machineMask(all(r.norm(nrm(s, d)), readFileSync(`${SKILL}/VERSION`, "utf8").trim(), "<V>"));
  const both = (...kv: string[]) => {
    mkdoc(DN, ...kv);
  };
  const ddN = (d: string, argv: string[]) => { const o = kx(d, ["doctor", ...argv], { HOME: `${d}.home`, FAKE_SS: `${d}.ss`, FAKE_DEVTUNNEL: `${d}.devtunnel`, TZ: "UTC" }); return dnorm(`${o.out.replace(/"time": [0-9]+/g, '"time": N')}rc=${o.rc}`, d); };
  /** dcmp: o mesmo diagnóstico: saída, código e (JSON) tudo igual ao gravado, menos a hora */
  const dcmp = (label: string, argv: string[], pre?: () => void) => test(`doctor ${label}: saída e código iguais aos gravados`, () => {
    pre?.(); const atual = ddN(DN, argv); g.fix(`doctor ${label}`, atual); expect(atual).toBe(g.get<string>(`doctor ${label}`));
  }, 30_000);
  const Q = ["--quick", "--json"];
  dcmp("tabela rápida", ["--quick"], () => both());
  dcmp("JSON rápido", Q);
  dcmp("JSON completo (devtunnel sem login)", ["--json"]);
  dcmp("ajuda", ["--help"]);
  dcmp("argumento inválido", ["--zzz"]);
  dcmp("porta do painel ocupada por outro e vizinho na faixa", Q, () => {
    both("HADES_PORT_RANGE=3990-4000");
    const s = 'LISTEN 0 4096 127.0.0.1:21220 0.0.0.0:* users:(("outro",pid=1,fd=3))\nLISTEN 0 4096 0.0.0.0:3999 0.0.0.0:* users:(("vizinho",pid=1,fd=4))\n';
    wr(`${DN}.ss`, s);
  });
  dcmp("só vizinho na faixa: aviso", Q, () => {
    const s = 'LISTEN 0 4096 0.0.0.0:3999 0.0.0.0:* users:(("vizinho",pid=1,fd=4))\n';
    wr(`${DN}.ss`, s);
  });
  // O ss falso só vale no Linux: no macOS a listagem é do /usr/sbin/netstat
  test.if(process.platform === "linux")("doctor: ss que falha vira aviso de portas não verificadas, não \"sem conflito\", e a rede segue conferida", () => {
    both("HADES_DOCTOR_SUBNET=10.99.0.0/24");
    wr(`${DN}.ss`, 'LISTEN 0 4096 127.0.0.1:21220 0.0.0.0:* users:(("outro",pid=1,fd=3))\n');
    const o = kx(DN, ["doctor", "--quick"], { HOME: `${DN}.home`, FAKE_SS: `${DN}.ss`, FAKE_SS_RC: "1", FAKE_DEVTUNNEL: `${DN}.devtunnel`, TZ: "UTC" });
    expect(o.out).toContain("o ss falhou ou não respondeu, portas não verificadas");
    expect(o.out).not.toContain("ocupada(s) por outro processo");
    expect(o.out).not.toContain("sem conflito");
    expect(o.out).toContain("10.99.0.0/24");
  }, 30_000);
  for (const kv of ["HADES_SLICE_MAX=999T", "HADES_SLICE_MAX=1K", "HADES_SLICE_MAX=abc", "HADES_PANEL_AUTOSTART=boot", "HADES_PANEL_AUTOSTART=login", "HADES_PANEL_AUTOSTART=zzz",
    "HADES_NOTIFY=1", "HADES_CLEAN_TIMER=off", "HADES_DOCTOR_NODE_BINS=nada,tsc", "HADES_DOCTOR_DISK_MIN_GB=99999999"]) {
    dcmp(`com ${kv}`, Q, () => {
      both(kv);
      wr(`${DN}.ss`, "");
    });
  }
  dcmp("notify ligado sem canal, unit enabled e parada, timer de boot sobrando", Q, () => {
    both("HADES_NOTIFY=1", "HADES_NOTIFY_DESKTOP=0", "HADES_NOTIFY_NTFY=0");
    for (const d of [DN]) { mk(`${d}.sc/enabled`, `${d}.sc/active`); for (const u of ["hds-notify", "hds-panel", "hds-boot.timer", "hds-logrotate.timer"]) wr(`${d}.sc/enabled/${u}`, ""); }
  });
  dcmp("notify ativo", Q, () => {
    wr(`${DN}.sc/active/hds-notify`, "");
  });
  // plugin: doctor.sh do projeto (no mesmo diagnóstico), instance sem registro e kit com outra versão
  dcmp("plugin doctor.sh, kit desatualizado e instance quebrada", Q, () => {
    both();
    for (const d of [DN]) {
      wr(`${d}/plugin/doctor.sh`, 'warn $G pc-um "primeira" "corrija"\nok $G pc-dois "segunda"\nhave jq && err $G pc-tres "terceira" "conserte"\n[[ $QUICK == 1 ]] && ok $G pc-quick "rápido"\n');
      wr(`${d}/kit.version`, "4.0.0\n"); wr(`${d}.home/.claude/hades/instance`, "/nao/existe\n");
    }
  });
  dcmp("plugin doctor.sh na tabela", ["--quick"]);
  dcmp("plugin doctor.sh que termina com erro", Q, () => { for (const d of [DN]) wr(`${d}/plugin/doctor.sh`, "return 3\n"); });
  dcmp("sem instance, sem work-root e sem kit.version", Q, () => {
    for (const d of [DN]) { rmSync(`${d}.home/.claude/hades/instance`, { recursive: true, force: true }); rmSync(`${d}.home/.claude/hades/work-root`, { recursive: true, force: true }); rmSync(`${d}/kit.version`, { force: true }); }
  });
  test("doctor sem bun no PATH (hades-ts.sh): sai 69 com a instrução do registro", () => {
    const o = r.X(["bash", `${K}/hades-ts.sh`, "doctor", "--quick"], { merge: true, env: { PATH: NB, HADES_BUN: "", HADES_SKILL_DIR: SKILL, HOME: `${DN}.home`, HADES_KIT_DIR: DN } });
    expect(o.rc).toBe(69);
  });
});
