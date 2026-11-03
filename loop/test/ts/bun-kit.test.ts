// Grupo bun-kit: json-merge3, keep-both, pr-set, prs, logrotate e linger pela CLI `hades`, com saída, código e arquivos de estado
// iguais aos gravados do comportamento de referência (golden/legado), mais as falhas cedo (69) por dependência ausente.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { BUN, Rig, SKILL, STUBS, kv, type Run, SYS_PATH } from "./lib/rig";
import { legado } from "./lib/legado";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const g = legado(import.meta.path);
const CLI = `${SKILL}/src/cli.ts`;
const BIN = `${r.T}/bk-bin`, FP = `${r.T}/bk-prs`, NB = `${r.T}/bk-nodeps`, wt = `${r.T}/bk-wt`, DN = `${r.T}/bk-dn`;
const NODE_DIR = r.env0.PATH?.split(":")[1] ?? "/usr/bin";
const rcOf = (o: Run) => `${o.out}rc=${o.rc}`;
const bytes = (p: string) => (existsSync(p) ? readFileSync(p).toString("latin1") : "");

for (const d of [BIN, FP, NB, wt]) mkdirSync(d, { recursive: true });
for (const n of ["bash", "awk", "cut", "dirname", "python3"]) if (!existsSync(`${NB}/${n}`)) symlinkSync(Bun.which(n) ?? `/usr/bin/${n}`, `${NB}/${n}`);
writeFileSync(`${BIN}/gh`, `#!/usr/bin/env python3
# gh falso: pr list --author A → author-A.json; --head H --state S → head-H-S.json; pr view N → view-N.json
import os, sys
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
chmodSync(`${BIN}/gh`, 0o755);
{
  const pr = (n: number, head: string, base: string, o: { draft?: boolean; state?: string; title?: string } = {}) =>
    ({ number: n, title: o.title ?? `PR ${n} título`, headRefName: head, baseRefName: base, isDraft: o.draft ?? false, headRefOid: String(n).padStart(4, "0") + "a".repeat(36), state: o.state ?? "OPEN" });
  const a = pr(10, "feat-a", "main"), b = pr(11, "feat-b", "feat-a"), c = pr(20, "feat-c", "feat-b", { title: "ç".repeat(100) }), dr = pr(12, "feat-d", "main", { draft: true });
  const w = (name: string, v: unknown) => writeFileSync(`${FP}/${name}`, JSON.stringify(v));
  w("author-@me.json", [b, a, dr]); w("author-bob.json", [pr(40, "bob-x", "main")]);
  w("view-20.json", c); w("view-10.json", a); w("view-12.json", dr); w("view-50.json", pr(50, "old", "main", { state: "CLOSED" }));
  w("view-30.json", pr(30, "feat-z", "feat-b", { state: "MERGED" }));
  w("head-feat-b-open.json", [b]); w("head-feat-a-open.json", [a]); w("head-feat-b-all.json", [b]);
}
/** $D com o env.sh mínimo. */
function mkd(dir: string): void {
  rmSync(dir, { recursive: true, force: true }); mkdirSync(`${dir}/logs`, { recursive: true });
  writeFileSync(`${dir}/env.sh`, `D=$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)\nW=${wt}\nexport HADES_WT=$W HADES_DATA=$D\n`);
}
/** Roda no $D do lado, com gh falso e a skill do HOME de teste. */
const xx = (s: "kit", argv: string[], env: Record<string, string> = {}, merge = true): Run =>
  r.X(argv, { merge, env: kv({ PATH: `${BIN}:${STUBS}:${NODE_DIR}:${SYS_PATH}`, FAKE_PRS: FP, HADES_BASE_BRANCH: "main", USER: "regressao", FAKE_LINGER: `${r.T}/bk-linger-${s}` }, env) });
/** A CLI no $D do kit (o que o wrapper fazia: HADES_KIT_DIR e o env.sh). */
const hades = (argv: string[], env: Record<string, string> = {}, merge = true): Run => xx("kit", [BUN, CLI, ...argv], { HADES_KIT_DIR: DN, HADES_WT: wt, HADES_DATA: DN, ...env }, merge);
/** Compara com a saída gravada do original; `args` é o subcomando da CLI. */
const sameOut = (label: string, args: string[]) => test(`${label}: saída e código iguais aos gravados`, () => {
  const ref = g.get<string>(label);
  expect(rcOf(hades(args))).toBe(ref);
});

describe("bun-kit", () => {
  describe("pr-set: o conjunto, a ordem, os avisos e o --heads", () => {
    mkd(DN);
    sameOut("pr-set sem prs.list (@me)", ["pr-set"]);
    sameOut("pr-set --heads", ["pr-set", "--heads"]);
    for (const a of ["20 # comentário\n-10\n", "30\n", "50\n12\n", "author:bob\nfoo\n-40\n", "10\n10\n20\n"]) {
      test(`pr-set com prs.list '${a.replaceAll("\n", " ")}': saída e código iguais aos gravados`, () => {
        const ref = g.get<string>(`pr-set prs.list ${a}`);
        writeFileSync(`${DN}/prs.list`, a);
        expect(rcOf(hades(["pr-set"]))).toBe(ref);
      });
    }
    test("pr-set: título cortado em 90 caracteres (não bytes)", () => {
      const o = hades(["pr-set"], {}, false).out;
      expect(Array.from(o.split("\n").map((l) => l.split("\t")).find((f) => f[0] === "20")?.[4] ?? "").length).toBe(90);
    });
    test("pr-set: PR que o gh não acha sai 1", () => {
      writeFileSync(`${DN}/prs.list`, "99\n"); const a = hades(["pr-set"]).rc;
      const n = g.get<number>("pr-set PR inexistente: rc");
      expect(a).toBe(n); rmSync(`${DN}/prs.list`, { force: true });
    });
    test("pr-set sem gh: sai 69 com a instrução do registro", () => {
      const o = r.X([BUN, CLI, "pr-set"], { merge: true, env: { PATH: NB, HADES_BUN: BUN, HADES_WT: wt, HADES_KIT_DIR: DN, HADES_SKILL_DIR: SKILL } });
      expect(`${o.rc} ${o.out.includes("dependência ausente: gh") && o.out.includes("gh auth login") ? "sim" : `não (${o.out})`}`).toBe("69 sim");
    });
  });

  describe("prs: show, set, add, remove, reset, uso (e o arquivo que sobra)", () => {
    for (const [ix, a] of ["show", "set 20 -10 @me", "add 30 -12", "remove 30", "remove 20 -10", "set", "add", "reset", "show", "zzz", ""].entries()) {
      test(`prs ${a || "sem argumento"}`, () => {
        const ref = g.get<{ out: string; list: string }>(`prs ${ix} ${a}`);
        if (a === "show" && !existsSync(`${DN}/prs.list`)) rmSync(`${DN}/prs.list`, { force: true });
        const n = rcOf(hades(["prs", ...a.split(" ").filter(Boolean)]));
        expect(n, "saída e código").toBe(ref.out);
        expect(bytes(`${DN}/prs.list`), "o prs.list fica igual").toBe(ref.list);
      });
    }
    test("prs show com comentário e linha vazia", () => {
      const t = "# nota\n20 # c\n\n10\n";
      const ref = g.get<string>("prs show comentário");
      writeFileSync(`${DN}/prs.list`, t);
      expect(rcOf(hades(["prs", "show"]))).toBe(ref);
    });
    test("prs sem gh: lista as entradas e sai 69 com a instrução", () => {
      const o = r.X([BUN, CLI, "prs", "show"], { merge: true, env: { PATH: NB, HADES_BUN: BUN, HADES_KIT_DIR: DN, HADES_WT: wt, HADES_SKILL_DIR: SKILL } });
      expect(`${o.rc} ${o.out.startsWith("entradas: ") && o.out.includes("dependência ausente: gh") ? "sim" : `não (${o.out})`}`).toBe("69 sim");
      rmSync(`${DN}/prs.list`, { force: true });
    });
  });

  describe("json-merge3 e keep-both: o merge em conflito", () => {
    const mkrepo = (dir: string, ours: string, theirs: string) => {
      rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
      const g = (...a: string[]) => r.X(["git", "-C", dir, ...a], { merge: true });
      g("init", "-q", "-b", "main"); writeFileSync(`${dir}/c.json`, '{\n  "a": 1,\n  "z": 0\n}\n'); g("add", "-A"); g("commit", "-qm", "base");
      g("checkout", "-q", "-b", "theirs"); writeFileSync(`${dir}/c.json`, theirs + "\n"); g("commit", "-qam", "theirs");
      g("checkout", "-q", "main"); writeFileSync(`${dir}/c.json`, ours + "\n"); g("commit", "-qam", "ours"); g("merge", "theirs");
    };
    const state = (dir: string, script: string | undefined, file: string, env: Record<string, string> = {}) => {
      const o = r.X(script === undefined ? [BUN, CLI, "json-merge3", file] : ["python3", script, file], { merge: true, cwd: dir, env });
      const idx = r.X(["git", "ls-files", "-u", file], { cwd: dir }).out.split("\n").filter(Boolean).map((l) => l.split("\t")[0]).join(";") + (r.X(["git", "ls-files", "-u", file], { cwd: dir }).out ? ";" : "");
      return `${o.out}rc=${o.rc}\n${bytes(`${dir}/${file}`)}${idx}`;
    };
    const jm = (nome: string, ours: string, theirs: string) => test(`${nome}: saída, código, arquivo e índice iguais aos gravados`, () => {
      const ref = g.get<string>(nome);
      mkrepo(`${r.T}/bk-jn`, ours, theirs);
      expect(state(`${r.T}/bk-jn`, undefined, "c.json", { HADES_SKILL_DIR: SKILL })).toBe(ref);
    });
    jm("json-merge3: chaves novas dos dois lados", '{\n  "a": 1,\n  "c": "ç",\n  "z": 0\n}', '{\n  "a": 1,\n  "d": {"x": [1, 2]},\n  "z": 0\n}');
    jm("json-merge3: mesma chave mudada de formas diferentes (conflito real)", '{\n  "a": 2,\n  "z": 0\n}', '{\n  "a": 3,\n  "z": 0\n}');
    jm("json-merge3: chave removida de um lado", '{\n  "a": 1\n}', '{\n  "a": 1,\n  "z": 0,\n  "n": {"k": 1}\n}');
    jm("json-merge3: objeto aninhado mudado nos dois lados", '{\n  "a": 1,\n  "z": {"p": 1, "q": 2}\n}', '{\n  "a": 1,\n  "z": {"p": 1, "q": 3}\n}');
    test("json-merge3 fora do merge: sem estágios, sai 0 com {}", () => {
      const run = (dir: string, argv: string[], env: Record<string, string>) => { const o = r.X([...argv, "nada.json"], { merge: true, cwd: dir, env }); return `${o.out}rc=${o.rc}`; };
      const ref = g.get<string>("json-merge3 fora do merge");
      expect(run(`${r.T}/bk-jn`, [BUN, CLI, "json-merge3"], { HADES_SKILL_DIR: SKILL })).toBe(ref);
    });
    test("keep-both: arquivos resultantes iguais byte a byte aos gravados e código igual", () => {
      mkdirSync(`${r.T}/bk-kl`, { recursive: true }); mkdirSync(`${r.T}/bk-kn`, { recursive: true });
      const f = "a\n<<<<<<< HEAD\num\n=======\ndois\n>>>>>>> br\nb\n<<<<<<< x\n1\n=======\n2\n>>>>>>> y\r\nfim\r\nc", sem = "sem conflito\r\nlinha\n";
      for (const d of ["bk-kl", "bk-kn"]) { writeFileSync(`${r.T}/${d}/f.txt`, f); writeFileSync(`${r.T}/${d}/g.txt`, sem); }
      const ref = g.get<string>("keep-both");
      const n = r.X([BUN, CLI, "keep-both", `${r.T}/bk-kn/f.txt`, `${r.T}/bk-kn/g.txt`], { env: { HADES_SKILL_DIR: SKILL } }).rc;
      expect(`${n} ${bytes(`${r.T}/bk-kn/f.txt`)}|${bytes(`${r.T}/bk-kn/g.txt`)}`).toBe(ref);
    });
    test("keep-both: sem argumento sai 0 / arquivo ausente sai 1", () => {
      const k = (argv: string[], env: Record<string, string> = {}) => r.X(argv, { env }).rc;
      const ref = g.get<number>("keep-both arquivo ausente: rc");
      expect(`${k([BUN, CLI, "keep-both"], { HADES_SKILL_DIR: SKILL })} ${k([BUN, CLI, "keep-both", `${r.T}/nao-existe`], { HADES_SKILL_DIR: SKILL })} ${ref}`).toBe("0 1 1");
    });
  });

  describe("logrotate: a pasta de logs, a política por variável, o que sai e o que sobra em disco", () => {
    const mklogs = (dir: string) => {
      rmSync(`${dir}/logs`, { recursive: true, force: true }); mkdirSync(`${dir}/logs`, { recursive: true });
      const fill = (n: string, size: number, ch: string) => writeFileSync(`${dir}/logs/${n}`, ch.repeat(size));
      fill("a.log", 3145728, "a"); fill("b.log", 2097152, "b"); fill("cprio.log", 1500000, "c"); fill("d.log", 100000, "d");
      for (const g of ["g1", "g2", "g3"]) writeFileSync(`${dir}/logs/a.log.${g.slice(1)}.gz`, gzipSync(g, { level: 6 }));
      writeFileSync(`${dir}/logs/solto.txt`, "x");
    };
    let LR: Record<string, string> = { HADES_CLEAN_LOG_MAX: "1M", HADES_CLEAN_PRIO_LOG_MAX: "1M", HADES_CLEAN_LOG_TOTAL: "100M", HADES_CLEAN_LOG_KEEP: "2", HADES_CLEAN_PRIO_LOGS: "c*" };
    const lrn = (args: string[], env: Record<string, string> = {}) => xx("kit", [BUN, CLI, "logrotate", ...args], { ...LR, HADES_DATA: DN, HADES_KIT_DIR: DN, ...env });
    const lsl = (dir: string) => readdirSync(`${dir}/logs`).sort().map((f) => `${f} ${f.endsWith(".gz") ? createHash("md5").update(gunzipSync(readFileSync(`${dir}/logs/${f}`))).digest("hex") : statSync(`${dir}/logs/${f}`).size}`).join("\n");
    /** A saída gravada do original (o $D vira <D>) e a da CLI, cada uma com a pasta de logs nova; o que sobra em disco fica em `<key> disco`. */
    const both = (key: string, args: string[]): [string, string] => {
      const ref = g.get<string>(key);
      mklogs(DN); return [ref, rcOf(lrn(args)).replaceAll(DN, "<D>")];
    };
    for (const a of ["--dry-run", "--dry-run --json", "--json"]) {
      test(`logrotate ${a}: saída igual à gravada`, () => {
        mkd(DN);
        const [l, n] = both(`logrotate ${a}`, a.split(" ")); expect(n).toBe(l);
      });
    }
    test("logrotate: a execução real dá a mesma saída", () => { const [l, n] = both("logrotate real", []); expect(n).toBe(l); });
    test("logrotate: o que sobra em disco é igual (tamanhos e conteúdo descompactado das gerações)", () => { expect(lsl(DN)).toBe(g.get<string>("logrotate real disco")); });
    test("logrotate: teto total, mesma saída", () => {
      LR = { HADES_CLEAN_LOG_MAX: "100M", HADES_CLEAN_PRIO_LOG_MAX: "100M", HADES_CLEAN_LOG_TOTAL: "4M", HADES_CLEAN_LOG_KEEP: "3" };
      const [l, n] = both("logrotate teto", []); expect(n).toBe(l);
    });
    test("logrotate: teto total, o que sobra em disco é igual", () => { expect(lsl(DN)).toBe(g.get<string>("logrotate teto disco")); });
    test("logrotate: aberto sem O_APPEND é pulado (e o arquivo não é truncado), igual ao original", () => {
      LR = { HADES_CLEAN_LOG_MAX: "1M", HADES_CLEAN_LOG_TOTAL: "100M", HADES_CLEAN_LOG_KEEP: "2" };
      // processo que segura o arquivo aberto para escrita sem O_APPEND (fd 9) até ser encerrado
      const hold = (dir: string) => Bun.spawn(["sh", "-c", 'exec 9<>"$1"; exec sleep 60', "sh", `${dir}/logs/a.log`], { stdout: "ignore", stderr: "ignore" });
      const pid = (t: string) => t.replace(/pid [0-9]*/g, "pid N");
      const ref = g.get<string>("logrotate aberto sem O_APPEND");
      mklogs(DN); const h1 = hold(DN);
      try { Bun.sleepSync(300); expect(pid(lrn([]).out).replaceAll(DN, "<D>")).toBe(ref); } finally { h1.kill(); }
    });
    test("logrotate: política inválida falha com mensagem e sai 1 nos dois", () => {
      const ref = g.get<number>("logrotate política inválida: rc");
      expect(`${ref} ${lrn([], { HADES_CLEAN_LOG_MAX: "xx" }).rc}`).toBe("1 1");
    });
    test("logrotate sem pasta logs/: nada a fazer, mesma saída", () => {
      const ref = g.get<string>("logrotate sem logs/");
      rmSync(`${DN}/logs`, { recursive: true, force: true }); mkdirSync(DN, { recursive: true });
      expect(rcOf(lrn([])).replaceAll(DN, "<D>")).toBe(ref);
    });
  });

  describe("linger: state, sync (liga, desliga, marca, migração da marca antiga, falha do loginctl) e uso", () => {
    const lstate = () => `linger=${existsSync(`${r.T}/bk-linger-kit`) ? readFileSync(`${r.T}/bk-linger-kit`, "utf8").replace(/\n+$/, "") : ""} mine=${existsSync(`${DN}/linger.mine`) ? "sim" : "não"} antiga=${existsSync(`${DN}/panel-linger.mine`) ? "sim" : "não"}`;
    const steps = ["state", "sync", "boot sync", "boot state", "boot sync", "login sync", "login state", "login sync", "boot-antiga sync", "zzz", ""];
    for (const [i, step] of steps.entries()) {
      test(`linger ${step || "sem argumento"}${i > 0 && steps.slice(0, i).includes(step) ? " (repetido)" : ""}: saída, código, estado e marcas iguais aos gravados`, () => {
        if (i === 0) { mkd(DN); for (const f of readdirSync(r.T)) if (f.startsWith("bk-linger-")) rmSync(`${r.T}/${f}`); }
        let mode = "login", cmdx = step;
        const sp = step.split(" ");
        if (sp.length > 1) { mode = sp[0] ?? "login"; cmdx = sp.slice(1).join(" "); }
        const antiga = mode === "boot-antiga"; if (antiga) mode = "login";
        const args = cmdx ? cmdx.split(" ") : [];
        const ref = g.get<{ out: string; st: string }>(`linger ${i} ${step}`);
        if (antiga) writeFileSync(`${DN}/panel-linger.mine`, "");
        expect(rcOf(hades(["linger", ...args], { HADES_PANEL_AUTOSTART: mode })), "saída e código").toBe(ref.out);
        expect(lstate(), "estado e marcas").toBe(ref.st);
      });
    }
    test("linger sync com loginctl que falha: mesma mensagem e sai 1", () => {
      const ref = g.get<string>("linger loginctl falha");
      expect(rcOf(hades(["linger", "sync"], { HADES_LOGINCTL: "/bin/false", HADES_PANEL_AUTOSTART: "boot" }))).toBe(ref);
    });
    test("linger sync sem loginctl: sai 69 com a instrução do registro", () => {
      rmSync(`${DN}/linger.mine`, { force: true });
      const o = r.X([BUN, CLI, "linger", "sync"], { merge: true, env: { PATH: NB, HADES_BUN: BUN, HADES_SKILL_DIR: SKILL, HADES_KIT_DIR: DN, HADES_WT: wt, HADES_DATA: DN, USER: "regressao", HADES_PANEL_AUTOSTART: "boot" } });
      expect(`${o.rc} ${o.out.includes("dependência ausente: loginctl") ? "sim" : `não (${o.out})`}`).toBe("69 sim");
    });
    test("linger state sem loginctl: no (o painel e o doctor leem yes|no), sai 0", () => {
      const o = r.X([BUN, CLI, "linger", "state"], { merge: true, env: { PATH: NB, HADES_BUN: BUN, HADES_SKILL_DIR: SKILL, HADES_KIT_DIR: DN, HADES_WT: wt, HADES_DATA: DN, USER: "regressao" } });
      expect(`${o.rc} ${o.out.replace(/\n$/, "")}`).toBe("0 no");
    });
  });
});
