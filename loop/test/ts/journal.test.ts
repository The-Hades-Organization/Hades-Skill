// Grupo journal: diário de eventos por agente (src/lib/journal.ts, reference/journal.md) — esquema, mascaramento, escrita,
// rotação, retenção, as fontes (guard, watch, gate, cerberus), o registro dos cinco eventos e a leitura (CLI e painel).
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { LOCK_EX, LOCK_UN, sysFlock } from "../../../src/lib/flock";
import { openSync } from "node:fs";
import {
  JOURNAL_VERSION, agentOfCwd, appendEvent, droppedCount, emitJournal, eventOfHook, eventOfSource, journalSettings, journalTarget,
  markBlocked, maskSecrets, parseEvent, parseSince, pruneJournals, readEvents, summarizeCommand, type JournalEvent, type JournalSettings,
} from "../../../src/lib/journal";
import { createJournalRoutes, LIMIT_MAX } from "../../../src/panel/journal";
import { BadRequest } from "../../../src/panel/http";
import { BUN, Rig, SKILL } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());

const NOW = new Date("2026-03-10T12:00:00.000Z");
const ON: JournalSettings = { enabled: true, days: 14, maxBytes: 20 * 1048576 };
const root = `${r.T}/work`;
const lines = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as JournalEvent);
function registerAgent(slug: string, name: string, worktree: string, state = "active") {
  const dir = `${root}/${slug}/orchestration/agents`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/${name}.json`, JSON.stringify({ name, worktree, state }));
}
const cliDir = `${root}/example__monorepo/journal`;
const cliEvent = (kind: string, summary: string, at: Date) => JSON.stringify(eventOfSource("guard", kind, summary, { agent: "ag-cli", session: "s", now: at }));
const hookEvent = (over: Record<string, unknown>) => ({ session_id: "s1", cwd: "/w/a1", ...over });

describe("journal: esquema e resumo", () => {
  test("PreToolUse do Bash leva o comando truncado, sem corpo de heredoc, com v, ts em UTC e Z e a fonte", () => {
    const e = eventOfHook(hookEvent({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `echo ${"x".repeat(400)}` } }), "a1", NOW)!;
    expect(e).toMatchObject({ v: JOURNAL_VERSION, ts: "2026-03-10T12:00:00.000Z", agent: "a1", session: "s1", source: "guard", kind: "tool_pre", tool: "Bash", cwd: "/w/a1" });
    expect(e.summary.length).toBeLessThanOrEqual(200);
    expect(e.summary.endsWith("…")).toBe(true);
    const doc = eventOfHook(hookEvent({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "cat > f <<'EOF'\nsegredo do arquivo\nEOF" } }), "a1", NOW)!;
    expect(doc.summary).not.toContain("segredo do arquivo");
  });

  test("Read/Edit/Write levam o caminho; as outras ferramentas, só o nome; nunca o conteúdo", () => {
    const ev = (tool: string, input: Record<string, unknown>) => eventOfHook(hookEvent({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input }), "a1", NOW)!.summary;
    expect(ev("Read", { file_path: "/w/a1/src/x.ts" })).toBe("/w/a1/src/x.ts");
    expect(ev("Write", { file_path: "/w/a1/y.md", content: "CORPO SECRETO" })).toBe("/w/a1/y.md");
    expect(ev("Edit", { file_path: "/w/a1/z.ts", old_string: "A", new_string: "B" })).toBe("/w/a1/z.ts");
    expect(ev("Grep", { pattern: "senha=hunter2" })).toBe("Grep");
    expect(ev("Agent", { prompt: "prompt inteiro" })).toBe("Agent");
  });

  test("PostToolUse grava ok ou erro, sem a saída", () => {
    const post = (response: unknown) => eventOfHook(hookEvent({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: response }), "a1", NOW)!;
    expect(post({ stdout: "arquivo-secreto.txt" }).summary).toBe("ok: ls");
    expect(post({ is_error: true, stdout: "boom" }).summary).toBe("erro: ls");
    expect(post("texto").kind).toBe("tool_post");
  });

  test("Notification de permissão vira o evento permission com a ferramenta; outra notificação vira notification", () => {
    const n = (message: string, type = "") => eventOfHook(hookEvent({ hook_event_name: "Notification", message, notification_type: type }), "a1", NOW)!;
    expect(n("Claude needs your permission to use Bash")).toMatchObject({ kind: "permission", tool: "Bash", summary: "permissão pendente: Bash" });
    expect(n("qualquer", "permission_prompt")).toMatchObject({ kind: "permission", summary: "permissão pendente" });
    expect(n("Claude is waiting for your input")).toMatchObject({ kind: "notification" });
  });

  test("Stop e UserPromptSubmit: tamanho e início curto do prompt, mascarado", () => {
    expect(eventOfHook(hookEvent({ hook_event_name: "Stop" }), "a1", NOW)).toMatchObject({ kind: "stop" });
    const p = eventOfHook(hookEvent({ hook_event_name: "UserPromptSubmit", prompt: `use o token ghp_${"a".repeat(30)} agora ${"y".repeat(500)}` }), "a1", NOW)!;
    expect(p.kind).toBe("prompt");
    expect(p.summary).toMatch(/^\d+ caracteres: /);
    expect(p.summary).not.toContain("ghp_");
    expect(p.summary.length).toBeLessThan(100);
  });

  test("evento desconhecido não grava", () => {
    expect(eventOfHook(hookEvent({ hook_event_name: "SubagentStop" }), "a1", NOW)).toBeUndefined();
  });

  test("o guard barrou: tool_blocked leva a razão e o comando", () => {
    const pre = eventOfHook(hookEvent({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "sleep 30" } }), "a1", NOW)!;
    const b = markBlocked(pre, "hades-guard: polling barrado (sleep). Esperar por evento\n");
    expect(b.kind).toBe("tool_blocked");
    expect(b.summary).toContain("polling barrado");
    expect(b.summary).toContain("sleep 30");
  });

  test("parseEvent recusa linha cortada e linha fora do formato", () => {
    expect(parseEvent('{"v":1,"ts":"2026-03-10T12:0')).toBeUndefined();
    expect(parseEvent(JSON.stringify({ v: 1, ts: "x", source: "guard", kind: "k", summary: "s" }))).toBeUndefined();
    expect(parseEvent(JSON.stringify({ v: 1, ts: NOW.toISOString(), source: "outra", kind: "k", summary: "s" }))).toBeUndefined();
  });
});

describe("journal: mascaramento de segredo", () => {
  const secrets = [
    `gh auth login --with-token ghp_${"A1b2".repeat(8)}`,
    `curl -H "Authorization: Bearer abcdef0123456789abcdef" https://x`,
    `psql postgres://admin:${"s3nh4forte"}@db:5432/app`,
    "deploy --password hunter2 --force",
    "DB_PASSWORD=hunter2 ./run.sh",
    "export API_TOKEN='um valor com espaço' && ls",
    `aws configure set key AKIA${"Z".repeat(16)}`,
    "curl --api-key=abc123 https://x",
    `echo ${"ey" + "Jhbgcioijiuzi1ni"}.${"ey" + "Jzdwiiojeymzq1"}.abcdefghijk`,
  ];
  test.each(secrets)("%s", (cmd) => {
    const out = summarizeCommand(cmd);
    for (const piece of ["ghp_", "abcdef0123456789abcdef", "s3nh4forte", "hunter2", "um valor com", "AKIA", "abc123", "Jhbgcioijiuzi1ni"]) expect(out).not.toContain(piece);
    expect(out).toContain("***");
  });
  test("comando sem segredo passa intacto", () => {
    expect(summarizeCommand("git status --short")).toBe("git status --short");
  });
  test("o mascaramento vale antes do corte: segredo na borda do truncamento não sobra pela metade", () => {
    const out = summarizeCommand(`${"a ".repeat(95)} --token supersecret123456`);
    expect(out).not.toContain("supersecret");
  });
  test("maskSecrets é idempotente", () => {
    const once = maskSecrets("TOKEN=abc");
    expect(maskSecrets(once)).toBe(once);
  });
});

describe("journal: escrita, rotação e falhas", () => {
  const ev = (summary: string, at = NOW): JournalEvent => eventOfSource("gate", "gate.done", summary, { agent: "a1", session: "", cwd: "/w", now: at });

  test("uma linha JSON por evento, append", () => {
    const target = `${r.T}/j1/a1.jsonl`;
    expect(appendEvent(ev("um"), target, ON, NOW)).toBe(true);
    expect(appendEvent(ev("dois"), target, ON, NOW)).toBe(true);
    expect(lines(target).map((e) => e.summary)).toEqual(["um", "dois"]);
  });

  test("diário desligado não grava nem cria pasta", () => {
    const target = `${r.T}/j-off/a1.jsonl`;
    expect(appendEvent(ev("x"), target, { ...ON, enabled: false }, NOW)).toBe(false);
    expect(existsSync(`${r.T}/j-off`)).toBe(false);
  });

  test("no teto o arquivo gira para <agente>.1.jsonl e o anterior sai", () => {
    const target = `${r.T}/j-rot/a1.jsonl`;
    const small = { ...ON, maxBytes: 600 };
    for (let i = 0; i < 12; i += 1) appendEvent(ev(`evento ${i} ${"x".repeat(30)}`), target, small, NOW);
    const names = readdirSync(`${r.T}/j-rot`).filter((n) => n.endsWith(".jsonl")).sort();
    expect(names).toEqual(["a1.1.jsonl", "a1.jsonl"]);
    expect(statSync(target).size).toBeLessThan(900);
    const last = lines(target).at(-1)!;
    expect(last.summary).toContain("evento 11");
  });

  test("disco com erro: não lança, devolve false e conta a perda", () => {
    writeFileSync(`${r.T}/arquivo-comum`, "x");
    const before = droppedCount();
    expect(() => appendEvent(ev("x"), `${r.T}/arquivo-comum/sub/a1.jsonl`, ON, NOW)).not.toThrow();
    expect(appendEvent(ev("x"), `${r.T}/arquivo-comum/sub/a1.jsonl`, ON, NOW)).toBe(false);
    expect(droppedCount()).toBe(before + 2);
  });

  test("lock ocupado por outro: não espera mais que alguns ms, não lança e conta", () => {
    const dir = `${r.T}/j-lock`;
    mkdirSync(dir, { recursive: true });
    const flock = sysFlock();
    const fd = openSync(`${dir}/.lock`, "a");
    expect(flock(fd, LOCK_EX)).toBe(0);
    const before = droppedCount();
    const t0 = performance.now();
    expect(appendEvent(ev("preso"), `${dir}/a1.jsonl`, ON, NOW)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(100);
    expect(droppedCount()).toBe(before + 1);
    expect(existsSync(`${dir}/a1.jsonl`)).toBe(false);
    flock(fd, LOCK_UN);
    expect(appendEvent(ev("livre"), `${dir}/a1.jsonl`, ON, NOW)).toBe(true);
  });

  test("duas gravações concorrentes não misturam linhas", async () => {
    const target = `${r.T}/j-conc/a1.jsonl`;
    const worker = (tag: string) => Bun.spawn([BUN, "-e", `
      import { appendEvent, eventOfSource } from "${SKILL}/src/lib/journal.ts";
      const on = { enabled: true, days: 14, maxBytes: 1e9 };
      for (let i = 0; i < 100; i++) { for (let k = 0; k < 5; k++) if (appendEvent(eventOfSource("gate", "gate.done", "${tag} " + i, { agent: "a1", now: new Date() }), "${target}", on)) break; }
    `], { stdout: "pipe", stderr: "pipe" });
    await Promise.all([worker("A").exited, worker("B").exited]);
    const all = readFileSync(target, "utf8").split("\n").filter(Boolean);
    expect(all.length).toBeGreaterThan(150);
    for (const l of all) expect(() => JSON.parse(l)).not.toThrow();
  });

  test("linha enorme é encurtada para caber numa escrita atômica", () => {
    const target = `${r.T}/j-big/a1.jsonl`;
    const big = { ...ev("x"), summary: "y".repeat(10_000) };
    expect(appendEvent(big, target, ON, NOW)).toBe(true);
    expect(Buffer.byteLength(readFileSync(target, "utf8"))).toBeLessThan(4096);
  });
});

describe("journal: configuração", () => {
  test("padrões e valores fora do intervalo", () => {
    expect(journalSettings(() => undefined)).toEqual({ enabled: true, days: 14, maxBytes: 20 * 1048576 });
    expect(journalSettings((k) => ({ HADES_JOURNAL: "0", HADES_JOURNAL_DAYS: "3", HADES_JOURNAL_MAX_MB: "5" })[k])).toEqual({ enabled: false, days: 3, maxBytes: 5 * 1048576 });
    expect(journalSettings((k) => ({ HADES_JOURNAL_DAYS: "0", HADES_JOURNAL_MAX_MB: "abc" })[k])).toMatchObject({ days: 14, maxBytes: 20 * 1048576 });
  });
});

describe("journal: agente da sessão", () => {
  test("o cwd dentro da worktree registrada dá o agente; agente done e cwd de fora não casam", () => {
    registerAgent("example__monorepo", "ag-ativo", `${r.T}/wt/ativo`);
    registerAgent("example__monorepo", "ag-done", `${r.T}/wt/done`, "done");
    expect(agentOfCwd(`${r.T}/wt/ativo/src/x`, root)).toEqual({ agent: "ag-ativo", dir: `${root}/example__monorepo/journal` });
    expect(agentOfCwd(`${r.T}/wt/ativo`, root)?.agent).toBe("ag-ativo");
    expect(agentOfCwd(`${r.T}/wt/ativo-outro`, root)).toBeUndefined();
    expect(agentOfCwd(`${r.T}/wt/done`, root)).toBeUndefined();
    expect(agentOfCwd("", root)).toBeUndefined();
  });

  test("a unidade skill grava em _skill/journal; sem agente a sessão vai para _sessions/<session_id>", () => {
    registerAgent("_skill", "un-skill", `${r.T}/wt/skill`);
    const home = agentOfCwd(`${r.T}/wt/skill`, root);
    const e = eventOfSource("guard", "tool_pre", "x", { agent: "un-skill", now: NOW });
    expect(journalTarget(e, home, root)).toBe(`${root}/_skill/journal/un-skill.jsonl`);
    const orphan = eventOfSource("guard", "tool_pre", "x", { session: "sess/../1", now: NOW });
    expect(journalTarget(orphan, undefined, root)).toBe(`${root}/_maquina/journal/_sessions/sess1.jsonl`);
  });
});

describe("journal: retenção", () => {
  test("arquivo parado há mais que os dias some; o vivo perde só as linhas velhas; rodar de novo não muda nada", () => {
    const dir = `${r.T}/j-ret/p/journal`;
    mkdirSync(`${dir}/_sessions`, { recursive: true });
    const old = new Date("2026-02-01T00:00:00Z"), fresh = new Date("2026-03-09T00:00:00Z");
    const mk = (summary: string, at: Date) => JSON.stringify(eventOfSource("gate", "gate.done", summary, { agent: "a1", now: at }));
    writeFileSync(`${dir}/parado.jsonl`, `${mk("velho", old)}\n`);
    utimesSync(`${dir}/parado.jsonl`, old, old);
    writeFileSync(`${dir}/_sessions/s9.jsonl`, `${mk("sessao velha", old)}\n`);
    utimesSync(`${dir}/_sessions/s9.jsonl`, old, old);
    writeFileSync(`${dir}/vivo.jsonl`, `${mk("velho", old)}\n${mk("novo", fresh)}\nlinha cortada\n`);
    const plan = pruneJournals(14, NOW, `${r.T}/j-ret`, true);
    expect(plan).toMatchObject({ removed: 2, rewritten: 1 });
    expect(existsSync(`${dir}/parado.jsonl`)).toBe(true);
    const done = pruneJournals(14, NOW, `${r.T}/j-ret`);
    expect(done).toMatchObject({ removed: 2, rewritten: 1 });
    expect(existsSync(`${dir}/parado.jsonl`)).toBe(false);
    expect(existsSync(`${dir}/_sessions/s9.jsonl`)).toBe(false);
    expect(readFileSync(`${dir}/vivo.jsonl`, "utf8")).not.toContain("velho");
    expect(readFileSync(`${dir}/vivo.jsonl`, "utf8")).toContain("novo");
    expect(pruneJournals(14, NOW, `${r.T}/j-ret`)).toMatchObject({ removed: 0, rewritten: 0 });
  });
});

describe("journal: leitura", () => {
  const dir = `${r.T}/j-read/p/journal`;
  test("filtros since, kind e limit; linha corrompida é pulada; ordem do tempo", () => {
    mkdirSync(dir, { recursive: true });
    const at = (m: number) => new Date(NOW.getTime() - m * 60_000);
    const e = (kind: string, m: number) => JSON.stringify({ ...eventOfSource("gate", kind, kind, { agent: "a1", now: at(m) }) });
    writeFileSync(`${dir}/a1.jsonl`, `${e("gate.admit", 50)}\n{"quebrada"\n${e("tool_pre", 20)}\n${e("tool_post", 10)}\n${e("gate.done", 5)}\n`);
    writeFileSync(`${dir}/outro.jsonl`, `${e("tool_pre", 1)}\n`);
    const q = (extra: object) => readEvents({ agent: "a1", limit: 100, ...extra }, `${r.T}/j-read`).map((x) => x.kind);
    expect(q({})).toEqual(["gate.admit", "tool_pre", "tool_post", "gate.done"]);
    expect(q({ sinceMs: parseSince("30m", NOW) })).toEqual(["tool_pre", "tool_post", "gate.done"]);
    expect(q({ kind: "tool" })).toEqual(["tool_pre", "tool_post"]);
    expect(q({ kind: "gate" })).toEqual(["gate.admit", "gate.done"]);
    expect(q({ limit: 2 })).toEqual(["tool_post", "gate.done"]);
    expect(readEvents({ limit: 100 }, `${r.T}/j-read`)).toHaveLength(5);
  });
  test("parseSince: duração, ISO com fuso; sem fuso ou lixo é recusado", () => {
    expect(parseSince("2h", NOW)).toBe(NOW.getTime() - 7_200_000);
    expect(parseSince("2026-03-10T00:00:00Z", NOW)).toBe(Date.parse("2026-03-10T00:00:00Z"));
    expect(parseSince("2026-03-10T00:00:00", NOW)).toBeUndefined();
    expect(parseSince("ontem", NOW)).toBeUndefined();
  });
});

describe("journal: o hook de verdade (src/hook.ts)", () => {
  const wt = `${r.T}/wt-hook`;
  mkdirSync(wt, { recursive: true });
  registerAgent("example__monorepo", "ag-hook", wt);
  const file = `${root}/example__monorepo/journal/ag-hook.jsonl`;
  const call = (input: Record<string, unknown>, env: Record<string, string> = {}) =>
    r.X([BUN, `${SKILL}/src/hook.ts`], { stdin: JSON.stringify({ session_id: "sh1", cwd: wt, ...input }), env });

  test("cada um dos cinco eventos grava uma linha no diário do agente; o hook sai 0 e responde igual", () => {
    expect(call({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo oi" } }).rc).toBe(0);
    expect(call({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "echo oi" }, tool_response: {} }).rc).toBe(0);
    expect(call({ hook_event_name: "Notification", message: "Claude needs your permission to use Edit" }).rc).toBe(0);
    expect(call({ hook_event_name: "Stop" }).rc).toBe(0);
    expect(call({ hook_event_name: "UserPromptSubmit", prompt: "faça isto" }).rc).toBe(0);
    const got = lines(file);
    expect(got.map((e) => e.kind)).toEqual(["tool_pre", "tool_post", "permission", "stop", "prompt"]);
    expect(got.every((e) => e.agent === "ag-hook" && e.source === "guard" && e.session === "sh1" && e.cwd === wt)).toBe(true);
    expect(got[2]).toMatchObject({ tool: "Edit", summary: "permissão pendente: Edit" });
  });

  test("o guard barra polling como antes (exit 2) e o diário registra tool_blocked", () => {
    const o = call({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "sleep 30" } });
    expect(o.rc).toBe(2);
    expect(o.err).toContain("polling barrado");
    expect(lines(file).find((x) => x.kind === "tool_blocked")).toMatchObject({ source: "guard", tool: "Bash" });
  });

  test("ferramenta fora do Bash entra no diário mas o guard não decide nela (Write em área do Cerberus sai 0)", () => {
    const o = call({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: `${r.T}/work/_maquina/cerberus/x.json`, content: "SEGREDO" } });
    expect(o.rc).toBe(0);
    expect(o.out).toBe("");
    const last = lines(file).at(-1)!;
    expect(last).toMatchObject({ kind: "tool_pre", tool: "Write" });
    expect(readFileSync(file, "utf8")).not.toContain("SEGREDO");
  });

  test("sessão que não casa com agente vai para _sessions/<session_id>", () => {
    expect(call({ hook_event_name: "Stop", cwd: r.T, session_id: "livre-7" }).rc).toBe(0);
    expect(lines(`${root}/_maquina/journal/_sessions/livre-7.jsonl`)[0]).toMatchObject({ agent: "", kind: "stop", session: "livre-7" });
  });

  test("HADES_JOURNAL=0 na instalação: nada é gravado, o hook responde igual", () => {
    const data = `${r.T}/data-off`;
    mkdirSync(data, { recursive: true });
    writeFileSync(`${data}/config.tsv`, "HADES_JOURNAL\t1\n");
    writeFileSync(`${data}/config.env`, "HADES_JOURNAL=0\n");
    mkdirSync(`${r.H}/.claude/hades`, { recursive: true });
    writeFileSync(`${r.H}/.claude/hades/instance`, data);
    const before = readFileSync(file, "utf8");
    expect(call({ hook_event_name: "Stop" }).rc).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(before);
    writeFileSync(`${r.H}/.claude/hades/instance`, "");
  });

  test("disco com erro no diário não muda a resposta do hook", () => {
    const bad = `${r.T}/work-ruim`;
    writeFileSync(bad, "não é pasta");
    const o = call({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "sleep 30" } }, { HADES_WORK_ROOT: bad });
    expect(o.rc).toBe(2);
    expect(o.err).toContain("polling barrado");
  });
});

describe("journal: as outras fontes", () => {
  registerAgent("example__monorepo", "ag-fonte", `${r.C}`);
  const file = `${root}/example__monorepo/journal/ag-fonte.jsonl`;
  const get = () => undefined;

  test("watch: o evento vai para o diário do agente citado, mesmo com o cwd fora da worktree", () => {
    expect(emitJournal("watch", "watch.question", "QUESTION ag-fonte 2", { agent: "ag-fonte", cwd: r.T, get, now: NOW, root })).toBe(true);
    expect(lines(file).at(-1)).toMatchObject({ source: "watch", kind: "watch.question", agent: "ag-fonte", summary: "QUESTION ag-fonte 2" });
  });

  test("sem agente registrado a fonte cai em _sessions/_<fonte>, nunca solta", () => {
    emitJournal("watch", "watch.done", "DONE fantasma", { agent: "fantasma", cwd: r.T, get, now: NOW, root });
    expect(lines(`${root}/_maquina/journal/_sessions/_watch.jsonl`).at(-1)).toMatchObject({ kind: "watch.done", agent: "" });
  });

  test("gate-lock: enqueue, admit e done (com o código de saída) no diário do agente do label", () => {
    const env = { HADES_GATE_MEMCAP: "0", HADES_GATE_RESERVE_GB: "0", HADES_GATE_PSI_MAX: "100" };
    expect(r.hades(["gate-lock", "run", "lint", "--label", "ag-fonte", "--timeout", "30", "--", "sh", "-c", "exit 3"], { cwd: r.C, merge: true, env }).rc).toBe(3);
    const gate = lines(file).filter((e) => e.source === "gate");
    expect(gate.map((e) => e.kind)).toEqual(["gate.enqueue", "gate.admit", "gate.done"]);
    expect(gate[2]!.summary).toContain("rc=3");
    expect(gate.every((e) => e.agent === "ag-fonte")).toBe(true);
  });

  test("cerberus: barra e aviso entram no diário; o ok não", () => {
    const reg = (resultado: string) => r.hades(["cerberus", "registrar", "--cabeca", "vigilia", "--guarda", "gate-lock-admissao", "--momento", "continuo", "--resultado", resultado,
      "--ctx", "label=ag-fonte", "--evidencia", "gate lint não admitido em 5s: enfileirado não é verde|fila do gate-lock"], { cwd: r.C, merge: true });
    reg("aviso");
    reg("ok");
    const cer = lines(file).filter((e) => e.source === "cerberus");
    expect(cer.map((e) => e.kind)).toEqual(["cerberus.aviso"]);
    expect(cer[0]!.summary).toContain("vigilia/gate-lock-admissao");
  });
});

describe("journal: registro dos cinco eventos no settings.json", () => {
  const group = (matcher: string | undefined, command: string) => ({ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: "command", command }] });
  const read = (f: string) => JSON.parse(readFileSync(f, "utf8")) as { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> };
  const register = (f: string) => r.hades(["guard", "register"], { merge: true, env: { HADES_CLAUDE_SETTINGS: f } });
  const ours = (f: string, event: string) => read(f).hooks[event]!.flatMap((g) => g.hooks.map((h) => h.command)).filter((c) => c.includes("src/hook.ts"));

  test("instalação antiga (só Pre com Bash e Post): ganha Notification, Stop e UserPromptSubmit, e o Pre passa a casar *", () => {
    const f = `${r.T}/j-set1.json`;
    const OLD = `${BUN} ${SKILL}/src/hook.ts`;
    writeFileSync(f, JSON.stringify({ hooks: { PreToolUse: [group("Bash", OLD)], PostToolUse: [group("*", OLD)], Stop: [group(undefined, "echo fim")] } }));
    expect(register(f).rc).toBe(0);
    const doc = read(f);
    expect(doc.hooks.PreToolUse).toHaveLength(1);
    expect(doc.hooks.PreToolUse![0]!.matcher).toBe("*");
    for (const event of ["PreToolUse", "PostToolUse", "Notification", "Stop", "UserPromptSubmit"]) expect(ours(f, event)).toHaveLength(1);
    expect(doc.hooks.Stop!.flatMap((g) => g.hooks.map((h) => h.command))).toContain("echo fim");
  });

  test("hook nosso dividindo grupo com hook de outro: sai para um grupo próprio com *, o do outro fica", () => {
    const f = `${r.T}/j-set2.json`;
    writeFileSync(f, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo outro" }, { type: "command", command: `${BUN} ${SKILL}/src/hook.ts` }] }] } }));
    register(f);
    const pre = read(f).hooks.PreToolUse!;
    expect(pre.find((g) => g.hooks.some((h) => h.command === "echo outro"))).toMatchObject({ matcher: "Bash", hooks: [{ command: "echo outro" }] });
    expect(pre.filter((g) => g.matcher === "*" && g.hooks.some((h) => h.command.includes("src/hook.ts")))).toHaveLength(1);
  });

  test("idempotente: rodar de novo não muda o arquivo e não duplica nenhum dos cinco", () => {
    const f = `${r.T}/j-set3.json`;
    register(f);
    const before = readFileSync(f, "utf8");
    const again = register(f);
    expect(again.out).toContain("já registrado");
    expect(readFileSync(f, "utf8")).toBe(before);
    for (const event of ["PreToolUse", "PostToolUse", "Notification", "Stop", "UserPromptSubmit"]) expect(ours(f, event)).toHaveLength(1);
  });
});

describe("journal: hades journal (CLI)", () => {
  mkdirSync(cliDir, { recursive: true });
  writeFileSync(`${cliDir}/ag-cli.jsonl`, [
    cliEvent("tool_pre", "ls", new Date(Date.now() - 3 * 3_600_000)), cliEvent("tool_pre", "git status", new Date(Date.now() - 60_000)), cliEvent("stop", "fim do turno", new Date()),
  ].join("\n") + "\n");
  const cli = (...args: string[]) => r.hades(["journal", ...args], { merge: true });

  test("tail mostra os últimos; --since e --kind filtram; --json é uma linha por evento", () => {
    const all = cli("tail", "ag-cli");
    expect(all.rc).toBe(0);
    expect(all.out.split("\n").filter(Boolean)).toHaveLength(3);
    expect(cli("tail", "ag-cli", "--since", "1h").out).not.toContain(" ls");
    expect(cli("show", "ag-cli", "--kind", "stop").out).toContain("fim do turno");
    const json = cli("tail", "ag-cli", "--json", "--limit", "1").out.trim();
    expect(JSON.parse(json)).toMatchObject({ v: 1, kind: "stop", agent: "ag-cli" });
  });

  test("list traz um item por agente com o último instante", () => {
    const list = JSON.parse(cli("list", "--json").out) as { agent: string; events: number; last: string }[];
    expect(list.find((x) => x.agent === "ag-cli")).toMatchObject({ events: 3 });
  });

  test("entrada inválida: nome, --since e --limit fora do formato saem 2", () => {
    expect(cli("tail", "../x").rc).toBe(2);
    expect(cli("tail", "ag-cli", "--since", "ontem").rc).toBe(2);
    expect(cli("tail", "ag-cli", "--limit", "999999").rc).toBe(2);
    expect(cli("tail").rc).toBe(2);
  });
});

describe("journal: rotas do painel", () => {
  const routes = createJournalRoutes(() => root);
  test("list: filtra por agente e kind, e o teto de limit é imposto (acima dele é recusado)", () => {
    const got = routes.list({ agent: "ag-cli", kind: "tool", limit: "10" }, new Date()) as { events: JournalEvent[]; count: number };
    expect(got.events.every((x) => x.kind.startsWith("tool"))).toBe(true);
    expect(() => routes.list({ limit: String(LIMIT_MAX + 1) })).toThrow(BadRequest);
    expect(() => routes.list({ limit: "0" })).toThrow(BadRequest);
    expect(() => routes.list({ limit: "x" })).toThrow(BadRequest);
    expect(() => routes.list({ agent: "../../etc/passwd" })).toThrow(BadRequest);
    expect(() => routes.list({ since: "ontem" })).toThrow(BadRequest);
    expect(() => routes.list({ kind: "a b" })).toThrow(BadRequest);
  });

  test("stream exige agent válido e responde SSE com o evento novo", async () => {
    expect(routes.stream(new Request("http://x/api/journal/stream"), {}).status).toBe(400);
    expect(routes.stream(new Request("http://x/api/journal/stream?agent=..%2Fx"), { agent: "../x" }).status).toBe(400);
    const ctl = new AbortController();
    const res = routes.stream(new Request("http://x/api/journal/stream?agent=ag-cli", { signal: ctl.signal }), { agent: "ag-cli" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const pump = (async () => {
      while (!text.includes("evento ao vivo")) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
    })();
    await Bun.sleep(1300);
    appendFileSync(`${cliDir}/ag-cli.jsonl`, `${cliEvent("tool_pre", "evento ao vivo", new Date())}\n`);
    await Promise.race([pump, Bun.sleep(5000)]);
    ctl.abort();
    expect(text).toContain("retry:");
    expect(text).toMatch(/id: \d+\ndata: \{.*evento ao vivo/);
    expect(text).not.toContain("git status");
  });

  test("stream: acima do teto de conexões abertas responde 429 com Retry-After", () => {
    const ctls: AbortController[] = [];
    let last: Response | undefined;
    for (let i = 0; i < 25; i += 1) {
      const c = new AbortController();
      ctls.push(c);
      last = routes.stream(new Request("http://x/s", { signal: c.signal }), { agent: "ag-cli" });
    }
    expect(last!.status).toBe(429);
    expect(last!.headers.get("retry-after")).not.toBeNull();
    for (const c of ctls) c.abort();
  });
});
