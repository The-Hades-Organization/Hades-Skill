// `hades plugins` (hades plugins): os pacotes em <packs>/, pela página Plugins do painel ou pelo terminal. Rode pelo
// plugins.sh, que carrega o env.sh (worktree, $D e as Configurações). A regra está em src/lib/plugins.ts.
import { mkdirSync } from "node:fs";
import type { Dict } from "../lib/cerberus.ts";
import { withFlock } from "../lib/flock.ts";
import { stateDir } from "../lib/kit.ts";
import { EXIT, out, warn } from "../lib/output.ts";
import { pyDumps } from "../lib/pyjson.ts";
import {
  type PluginsCtx, Refused, addApply, addPreview, ctxFromEnv, disable, enable, listPacks, lockFile, remove, updateApply, updatePreview,
} from "../lib/plugins.ts";

const USAGE = `plugins.sh list
     plugins.sh add <url>                          clona fora da pasta de pacotes, valida e mostra a prévia
     plugins.sh add --apply <id> --commit <sha>    move a prévia <id> para a pasta de pacotes e, se é o plugin desta
                                                   instalação, reinstala e reinicia o painel
     plugins.sh update <nome>                      fetch e prévia do que muda no que executa
     plugins.sh update <nome> --apply --commit <sha>
     plugins.sh enable <nome> | disable <nome>     liga ou desliga o plugin desta instalação ($D/plugins.disabled)
     plugins.sh remove <nome> --confirm <nome>     desliga e apaga o pacote (recusa mudança local e commit não publicado)
     --json    saída em JSON; erro = exit 1 e {"ok": false, "code": <código estável>, "error": <mensagem>}
     --check   (apply, enable, disable, remove) só confere; não muda nada. O painel confere antes de lançar a execução
`;

interface Options {
  json?: boolean;
  check?: boolean;
  apply?: boolean;
  commit?: string;
  confirm?: string;
}

/** (comando, posicionais, opções). Valores de opção nunca começam com '-' (nome, sha, id e URL têm padrão próprio). */
function parse(argv: string[]): { cmd: string; pos: string[]; opt: Options } {
  const [cmd, ...rest] = argv;
  if (cmd === undefined) throw new Refused("usage", USAGE);
  const pos: string[] = [];
  const opt: Options = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (a === "--json" || a === "--check" || a === "--apply") opt[a.slice(2) as "json" | "check" | "apply"] = true;
    else if (a === "--commit" || a === "--confirm") opt[a.slice(2) as "commit" | "confirm"] = rest[++i] ?? "";
    else if (a === "--") {
      pos.push(...rest.slice(i + 1));
      break;
    } else if (a.startsWith("-")) throw new Refused("usage", `opção desconhecida: ${a}`);
    else pos.push(a);
  }
  return { cmd, pos, opt };
}

function dispatch(c: PluginsCtx, cmd: string, pos: string[], opt: Options): Dict {
  const check = opt.check ?? false;
  const one = (): string => {
    if (pos.length !== 1) throw new Refused("usage", cmd === "add" && !opt.apply ? "add <url>" : cmd === "add" ? "add --apply <id> --commit <sha>" : `${cmd} <nome>`);
    return pos[0] as string;
  };
  switch (cmd) {
    case "list": return listPacks(c);
    case "add": return opt.apply ? addApply(c, one(), opt.commit, check) : addPreview(c, one());
    case "update": return opt.apply ? updateApply(c, one(), opt.commit, check) : updatePreview(c, one());
    case "enable": return enable(c, one(), check);
    case "disable": return disable(c, one(), check);
    case "remove": return remove(c, one(), opt.confirm, check);
    default: throw new Refused("usage", `comando desconhecido: ${cmd}`);
  }
}

const asList = (value: unknown): Dict[] => (Array.isArray(value) ? (value as Dict[]) : []);
const text = (value: unknown): string => String(value ?? "");
const nested = (value: unknown, key: string): string => text((value as Dict | undefined)?.[key]);

function human(cmd: string, result: Dict): void {
  if (cmd === "list") {
    out(`núcleo ${text(result.version)} · pacotes em ${text(result.packsRoot)} · repo do worktree: ${text(result.repo) || "-"}`);
    for (const p of asList(result.packs)) {
      if (p.error) {
        out(`  ✗ ${text(p.name)}: ${text(p.error)}`);
        continue;
      }
      const flags = [text(p.state), `core ${nested(p.core, "state")}`];
      if (p.dirty) flags.push("mudança local");
      if (p.unpublished) flags.push(`${text(p.unpublished)} não publicado(s)`);
      if (p.behind) flags.push(`${text(p.behind)} a atualizar`);
      out(`  ${text(p.name)}  ${text(p.url) || "(sem git)"}  ${text(p.branch)} @ ${text(p.commit).slice(0, 12)}  [${flags.join(", ")}]`);
    }
    return;
  }
  if (result.runs !== undefined && result.runs !== null && "id" in result) {
    out(`prévia ${text(result.id)}: ${text(result.name)} @ ${text(result.commit)} (${text(result.branch)}) — ${text(result.subject)}`);
    out(`  repo ${text(result.repo)} · core ${nested(result.core, "state")} · ${result.activates ? "ativa nesta instalação" : "não ativa aqui"}`);
    for (const f of asList(result.runs)) out(`  executa: ${text(f.path)} (${text(f.lines)} linhas, sha256 ${text(f.sha256).slice(0, 16)}…)`);
    for (const f of Array.isArray(result.other) ? result.other : []) out(`  vai para o $D: ${text(f)}`);
    out(`  confirmar: plugins.sh add --apply ${text(result.id)} --commit ${text(result.commit)}`);
    return;
  }
  if ("diff" in result) {
    const commits = Array.isArray(result.commits) ? result.commits : [];
    out(`${text(result.name)}: ${text(result.commit).slice(0, 12)} → ${text(result.target).slice(0, 12)} (${commits.length} commit(s))`);
    out(commits.map((c) => `  ${text(c)}`).join("\n"));
    out(text(result.stat));
    out(text(result.diff) || "(nada muda no que executa)");
    out(`  aplicar: plugins.sh update ${text(result.name)} --apply --commit ${text(result.target)}`);
    return;
  }
  out(pyDumps(result));
}

export function pluginsCommand(argv: string[]): number {
  const c = ctxFromEnv(stateDir());
  const asJson = argv.includes("--json");
  let cmd = "";
  let result: Dict;
  try {
    const parsed = parse(argv);
    cmd = parsed.cmd;
    const readOnly = cmd === "list" || ((cmd === "add" || cmd === "update") && !parsed.opt.apply) || parsed.opt.check;
    if (readOnly) result = dispatch(c, cmd, parsed.pos, parsed.opt);
    else {
      // o que muda estado: um por vez na instalação
      mkdirSync(c.data, { recursive: true });
      result = withFlock(lockFile(c), () => dispatch(c, cmd, parsed.pos, parsed.opt));
    }
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    if (asJson) out(pyDumps({ ...(error.preview ?? {}), ok: false, code: error.code, error: error.message }));
    else warn(`plugins: ${error.message}`);
    return error.code === "usage" ? EXIT.usage : EXIT.fail;
  }
  if (asJson) out(pyDumps(result));
  else human(cmd, result);
  return EXIT.ok;
}
