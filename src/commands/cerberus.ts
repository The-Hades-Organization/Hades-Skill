import { resolve } from "node:path";
import { EXIT, out, warn } from "../lib/output.ts";
import {
  CABECAS, CTX_MAX, DETAIL_MAX, EVID_MAX, MOMENTOS, Recusa, TEXT_MAX, cfgInt, config, evaluate, findGuard, history, loadExceptions,
  modes, nowIso, openException, parseCtx, readHistory, record, registry, state, store, verdictError, workRoot, type Dict, type Env,
} from "../lib/cerberus.ts";
import { pyDumps, pyRepr } from "../lib/pyjson.ts";

export const USAGE = `  avaliar <momento> [--dir <d>] [--ctx k=v]... [--cabeca <c>] [--json]   exit 0 passa, 1 barra, 2 uso/registro inválido
  registrar --cabeca <c> --guarda <id> --momento <m> --resultado <r> --evidencia "<conferido>|<onde>"... [--detalhe <t>]
            [--efeito <e>] [--ctx k=v]... [--dir <d>]                     veredito de guarda \`emitida\`; exit 2 se recusado
  guardas [--cabeca <c>] [--validar] [--json]                             o registro (--validar: exit 2 com os erros)
  historico [--cabeca <c>] [--efeito <e>] [--limite N] [--json]
  modos [--json]
  excecao listar [--json]
  excecao abrir --cabeca <c> --guarda <id> --momento <m> --motivo "<t>" [--alvo k=v]...   só pelo \`!\` do dono
  estado --json                                                          o que a página do painel mostra`;

const HISTORY_DEFAULT = 50;
const FLAGS = new Set(["--json", "--validar"]);
const MULTI = ["--ctx", "--evidencia", "--alvo"] as const;

interface Parsed {
  pos: string[];
  opt: Record<string, string | true>;
  multi: Record<(typeof MULTI)[number], string[]>;
}

function parseArgs(argv: string[]): Parsed {
  const pos: string[] = [];
  const opt: Parsed["opt"] = {};
  const multi: Parsed["multi"] = { "--ctx": [], "--evidencia": [], "--alvo": [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const multiKey = MULTI.find((k) => k === arg);
    if (FLAGS.has(arg)) opt[arg] = true;
    else if (arg.startsWith("--")) {
      const value = argv[i + 1];
      if (value === undefined) throw new Recusa(`${arg} pede um valor`);
      if (multiKey) multi[multiKey].push(value);
      else opt[arg] = value;
      i++;
    } else pos.push(arg);
  }
  return { pos, opt, multi };
}

const str = (opt: Parsed["opt"], key: string): string | undefined => {
  const value = opt[key];
  return typeof value === "string" ? value : undefined;
};

function evidenceArgs(items: string[]): { conferido: string; onde: string }[] {
  return items.map((item) => {
    const bar = item.lastIndexOf("|");
    if (bar < 0) throw new Recusa(`--evidencia ${pyRepr(item)}: "<conferido>|<onde>"`);
    return { conferido: item.slice(0, bar).trim(), onde: item.slice(bar + 1).trim() };
  });
}

const MARK: Record<string, string> = { ok: "✓", aviso: "!", liberado: "~", barra: "✗" };

function printEval(r: ReturnType<typeof evaluate>): void {
  if (r.vereditos.length === 0) return; // nada avaliado: quem chama segue sem ruído na saída dele
  for (const v of r.vereditos) {
    const exc = v.excecao as Dict | undefined;
    const note = exc ? ` [exceção ${String(exc.id)}: ${String(exc.motivo)}]` : "";
    const first = ((v.evidencia as Dict[])[0] as Dict).conferido;
    out(`  ${MARK[String(v.efeito)]} ${String(v.efeito).padEnd(8)} ${String(v.cabeca)}/${String(v.guarda)}: ${String(v.detalhe || first)}${note}`);
  }
  const off = r.ignoradas.length > 0 ? ` (cabeça em off: ${r.ignoradas.join(", ")})` : "";
  out(`cerberus ${r.momento}: ${r.resultado} — ${r.vereditos.length} veredito(s), ${r.barras} barra(m), ${r.avisos} aviso(s)${off}`);
}

function need(opt: Parsed["opt"], what: string, keys: string[]): void {
  for (const key of keys) if (!str(opt, key)) throw new Recusa(`${what} pede ${key}`);
}

function run(argv: string[]): number {
  const [cmd = "", ...rest] = argv;
  const { pos, opt, multi } = parseArgs(rest);
  const asJson = opt["--json"] === true;
  const env: Env = process.env;
  if (cmd === "avaliar") {
    if (pos.length !== 1) throw new Recusa("avaliar <momento>");
    const result = evaluate(pos[0] as string, parseCtx(multi["--ctx"]), resolve(str(opt, "--dir") || process.cwd()), { only: str(opt, "--cabeca") });
    if (asJson) out(pyDumps(result));
    else printEval(result);
    return result.resultado === "barra" ? EXIT.fail : EXIT.ok;
  }
  if (cmd === "registrar") {
    need(opt, "registrar", ["--cabeca", "--guarda", "--momento", "--resultado"]);
    record(str(opt, "--cabeca") as string, str(opt, "--guarda") as string, str(opt, "--momento") as string, str(opt, "--resultado") as string,
      evidenceArgs(multi["--evidencia"]), { detalhe: str(opt, "--detalhe"), efeito: str(opt, "--efeito"), ctx: parseCtx(multi["--ctx"]), cwd: str(opt, "--dir") });
    return EXIT.ok;
  }
  if (cmd === "guardas") {
    const { guardas, erros } = registry();
    const cab = str(opt, "--cabeca");
    const shown = guardas.filter((g) => !cab || g.cabeca === cab);
    if (asJson) out(pyDumps({ guardas: shown, erros }));
    else {
      for (const g of shown) out(`${g.cabeca.padEnd(8)} ${g.id.padEnd(28)} ${g.tipo.padEnd(8)} ${g.momentos.join(",").padEnd(20)} ${g.titulo}`);
      for (const e of erros) warn(`✗ ${e}`);
    }
    return erros.length > 0 && opt["--validar"] === true ? EXIT.usage : EXIT.ok;
  }
  if (cmd === "historico") {
    const limit = str(opt, "--limite");
    if (limit !== undefined && !(/^[0-9]+$/.test(limit) && Number(limit) > 0)) throw new Recusa("--limite: inteiro positivo");
    const rows = history(str(opt, "--cabeca"), str(opt, "--efeito"), limit ? Number(limit) : HISTORY_DEFAULT);
    if (asJson) out(pyDumps(rows));
    else {
      for (const r of rows) {
        const first = ((Array.isArray(r.evidencia) && r.evidencia[0]) || {}) as Dict;
        out(`${String(r.ts)} ${String(r.efeito).padEnd(8)} ${String(r.cabeca)}/${String(r.guarda)} @${String(r.momento)}: ${String(r.detalhe || first.conferido || "")}`);
      }
    }
    return EXIT.ok;
  }
  if (cmd === "modos") {
    const m = modes(config(env));
    out(asJson ? pyDumps(m) : Object.entries(m).map(([c, v]) => `${c.padEnd(8)} ${v}`).join("\n"));
    return EXIT.ok;
  }
  if (cmd === "excecao") {
    if (pos[0] === "abrir") {
      // só pelo `!` do dono: o hook barra este comando vindo das ferramentas do Claude (reference/cerberus.md §Exceção)
      need(opt, "excecao abrir", ["--cabeca", "--guarda", "--momento", "--motivo"]);
      const cfg = config(env);
      const exc = openException(str(opt, "--cabeca") as string, str(opt, "--guarda") as string, str(opt, "--momento") as string,
        str(opt, "--motivo") as string, { alvo: parseCtx(multi["--alvo"]), origem: "terminal", ttlS: cfgInt(cfg, "HADES_CERBERUS_EXC_TTL_H", 1, 720) * 3600 });
      out(asJson ? pyDumps(exc) : `exceção ${exc.id} aberta: ${exc.cabeca}/${exc.guarda} @${exc.momento}, uso único, até ${nowIso(exc.expira as number)}`);
      return EXIT.ok;
    }
    if (pos[0] !== "listar") {
      throw new Recusa('excecao listar [--json] | excecao abrir --cabeca <c> --guarda <id> --momento <m> --motivo "<t>" [--alvo k=v]');
    }
    const list = loadExceptions();
    if (asJson) out(pyDumps(list));
    else {
      const now = Date.now() / 1000;
      for (const e of list) {
        const expira = typeof e.expira === "number" ? e.expira : 0;
        const status = e.usada ? `usada em ${String(e.usada)}` : expira <= now ? "expirada" : "aberta";
        const alvo = e.alvo && Object.keys(e.alvo).length > 0 ? pyRepr(e.alvo) : "";
        out(`${String(e.id)} ${status.padEnd(20)} ${String(e.cabeca)}/${String(e.guarda)} @${String(e.momento)} ${alvo}: ${String(e.motivo)}`);
      }
    }
    return EXIT.ok;
  }
  if (cmd === "estado") {
    out(pyDumps(state(config(env))));
    return EXIT.ok;
  }
  throw new Recusa(`comando desconhecido: ${cmd}`);
}

// Ponte do módulo Python (hades cerberus, fachada até a bun-painel): `rpc <op>` lê {"args": [...], "kwargs": {...}} do
// stdin e imprime {"ok": valor} | {"recusa": msg} | {"oserror": msg}. Nada aqui decide regra: só chama a lib.
type Op = (args: unknown[], kwargs: Dict) => unknown;
const opt = <T>(value: unknown): T | undefined => (value === null || value === undefined ? undefined : (value as T));

const RPC: Record<string, Op> = {
  config: ([env]) => config(opt<Env>(env)),
  cfg_int: ([cfg, key, lo, hi]) => cfgInt(cfg as Record<string, string>, String(key), Number(lo), Number(hi)),
  modes: ([cfg]) => modes(cfg as Record<string, string>),
  work_root: () => workRoot(),
  store: () => store(),
  now_iso: ([t]) => nowIso(Number(t)),
  registry: () => {
    const { guardas, erros } = registry();
    return [guardas, erros];
  },
  find_guard: ([cab, id]) => findGuard(registry().guardas, String(cab), String(id)) ?? null,
  parse_ctx: ([pairs]) => parseCtx(pairs as string[]),
  verdict_error: ([v, cab, id, momento]) => verdictError(v, String(cab), String(id), String(momento)) ?? null,
  evaluate: ([momento, ctx, cwd], kw) =>
    evaluate(String(momento), ctx as Record<string, string>, String(cwd), { only: opt(kw.only), cfg: opt(kw.cfg), now: opt(kw.now) }),
  record: ([cab, id, momento, resultado, evidencia], kw) =>
    record(String(cab), String(id), String(momento), String(resultado), evidencia, {
      detalhe: opt(kw.detalhe), efeito: opt(kw.efeito), ctx: opt(kw.ctx), cwd: opt(kw.cwd), cfg: opt(kw.cfg), now: opt(kw.now),
    }),
  history: ([cab, ef, limit]) => history(opt(cab), opt(ef), opt(limit)),
  read_history: () => readHistory(),
  state: ([cfg]) => state(opt(cfg)),
  load_exceptions: () => loadExceptions(),
  open_exception: ([cab, id, momento, motivo], kw) =>
    openException(String(cab), String(id), String(momento), String(motivo), {
      alvo: opt(kw.alvo), por: opt(kw.por), origem: String(kw.origem), ttlS: Number(kw.ttl_s), now: opt(kw.now),
    }),
  constants: () => ({
    CABECAS: [...CABECAS], MOMENTOS: [...MOMENTOS], EVID_MAX, TEXT_MAX, DETAIL_MAX, CTX_MAX,
  }),
};

async function rpc(op: string): Promise<number> {
  const handler = RPC[op];
  if (!handler) throw new Recusa(`operação desconhecida: ${op}`);
  const input = JSON.parse(await Bun.stdin.text()) as { args?: unknown[]; kwargs?: Dict };
  try {
    out(pyDumps({ ok: handler(input.args ?? [], input.kwargs ?? {}) ?? null }));
  } catch (error) {
    if (error instanceof Recusa) out(pyDumps({ recusa: error.message }));
    else if (error instanceof Error && "code" in error) out(pyDumps({ oserror: error.message }));
    else throw error;
  }
  return EXIT.ok;
}

export async function cerberusCommand(args: string[]): Promise<number> {
  const [first] = args;
  if (first === undefined || first === "-h" || first === "--help") {
    process.stdout.write(`${USAGE}\n`);
    return first === undefined ? EXIT.usage : EXIT.ok;
  }
  try {
    if (first === "rpc") return await rpc(args[1] ?? "");
    return run(args);
  } catch (error) {
    if (!(error instanceof Recusa)) throw error;
    warn(`cerberus: ${error.message}`);
    return EXIT.usage;
  }
}
