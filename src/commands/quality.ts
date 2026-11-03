// `hades quality`: catálogo de qualidade (reference/quality.md). Mesma saída do hades quality / hades quality;
// a lógica está em src/lib/quality.ts.
import { EXIT, out, warn } from "../lib/output.ts";
import { need } from "../lib/deps.ts";
import { type JsonObject, pyJson } from "../lib/profile.ts";
import {
  GROUPS,
  LEVELS,
  QualityError,
  catalog,
  conflictsSection,
  effective,
  inject,
  packDefs,
  packMembers,
  packs,
  reset,
  resolved,
  setState,
  userDir,
  validateCatalog,
} from "../lib/quality.ts";

const USAGE = `Catálogo de qualidade da Hades: regras globais que o usuário liga e desliga e que entram nos briefs e nas fases.

Formatos em reference/projects.md §Catálogo; uso e precedência em reference/quality.md.
  hades quality list [--group <g>] [--pack <p>] [--on|--off] [--json]    regras, com o estado efetivo
  hades quality on|off <id|prefixo.>… [--group <g>] [--pack <p>] [--all]  liga/desliga e grava choices.tsv (só o que difere do padrão)
  hades quality packs [--json]                               pacotes, com o estado (ligado, desligado, parcial)
  hades quality validate                                     ids únicos e todo id de pacote existe no catálogo
  hades quality reset [<id>…]                                volta ao padrão do catálogo (sem id: todas)
  hades quality inject [--phase brief|deliver|inbox|review] [--dir <d>]   bloco markdown das regras ligadas ("" se nenhuma)
  hades quality conflicts [--dir <d>]                        seção "Conflitos de qualidade" do relatório ("" se nenhum)
  hades quality state [--dir <d>]                            JSON para o painel: regras, grupos, conflitos
Catálogo: <skill>/quality/*.json, depois ~/.claude/hades/quality/*.json (mesmo id: o do usuário vence), com regras
(\`rules\`) e pacotes (\`packs\`). Escolhas: ~/.claude/hades/quality/choices.tsv. Pacote não tem estado próprio: ligar ou
desligar um grava a escolha de cada regra dele, então a escolha mais recente (de regra ou de pacote) vence e o estado do
pacote sai das regras. Perfil do projeto (rules.quality) só sobe severidade ou declara contradição.
`;

const VALUE_FLAGS = new Set(["--group", "--phase", "--dir", "--pack"]);
const LIST_WIDTHS = { severity: 10, group: 9, id: 40, text: 70 };
const PACK_LABEL: Record<string, string> = { on: "ligado", off: "desligado", partial: "parcial" };

interface Options {
  flags: Map<string, string | true>;
  rest: string[];
}

function parseArgs(argv: string[]): Options {
  const flags = new Map<string, string | true>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (VALUE_FLAGS.has(a)) {
      flags.set(a.slice(2), argv[i + 1] ?? "");
      i += 1;
    } else if (a.startsWith("--")) flags.set(a.slice(2), true);
    else rest.push(a);
  }
  return { flags, rest };
}

const text = (o: Options, name: string): string | undefined => {
  const v = o.flags.get(name);
  return typeof v === "string" && v !== "" ? v : undefined;
};

function s(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function list(o: Options): number {
  const pack = text(o, "pack");
  const member = pack ? new Set(packMembers(pack, catalog())) : undefined;
  const group = text(o, "group");
  const rows = effective().filter(
    (r) =>
      (!group || r.group === group) &&
      (member === undefined || member.has(s(r.id))) &&
      !(o.flags.has("on") && r.state !== "on") &&
      !(o.flags.has("off") && r.state !== "off"),
  );
  if (o.flags.has("json")) {
    out(pyJson(rows));
    return EXIT.ok;
  }
  for (const r of rows) {
    const head = `${r.state === "on" ? "on " : "off"}  ${s(r.severity).padEnd(LIST_WIDTHS.severity)} ${s(r.group).padEnd(LIST_WIDTHS.group)}`;
    out(`${head} ${s(r.id).padEnd(LIST_WIDTHS.id)} ${[...s(r.text)].slice(0, LIST_WIDTHS.text).join("")}`);
  }
  return EXIT.ok;
}

function packsCmd(o: Options): number {
  const rows = packs();
  if (o.flags.has("json")) {
    out(pyJson(rows));
    return EXIT.ok;
  }
  for (const k of rows) {
    const missing = Array.isArray(k.missing) ? k.missing.length : 0;
    const miss = missing > 0 ? `  (${missing} id(s) desconhecido(s))` : "";
    out(`${(PACK_LABEL[s(k.state)] ?? "").padEnd(10)} ${s(k.on).padStart(3)}/${s(k.total).padEnd(3)} ${s(k.id).padEnd(16)} ${s(k.title)}${miss}`);
  }
  return EXIT.ok;
}

function stateCmd(o: Options): number {
  const { rules, conflicts, project } = resolved(text(o, "dir"));
  const doc: JsonObject = {
    rules,
    conflicts: conflicts.map((c) => ({ ...c })),
    project,
    groups: GROUPS,
    levels: LEVELS,
    packs: packs(rules),
    choices: `${userDir()}/choices.tsv`,
  };
  out(pyJson(doc));
  return EXIT.ok;
}

function run(cmd: string, o: Options): number | undefined {
  switch (cmd) {
    case "list":
      return list(o);
    case "on":
    case "off": {
      const n = setState(cmd, o.rest, text(o, "group"), o.flags.has("all"), text(o, "pack"));
      out(`ok (${n} escolha(s) em ${userDir()}/choices.tsv)`);
      return EXIT.ok;
    }
    case "reset":
      reset(o.rest);
      out("ok");
      return EXIT.ok;
    case "packs":
      return packsCmd(o);
    case "validate": {
      const errors = validateCatalog();
      for (const e of errors) out(e);
      if (errors.length === 0) out(`catálogo ok: ${catalog().length} regras, ${packDefs().length} pacotes`);
      return errors.length > 0 ? EXIT.fail : EXIT.ok;
    }
    case "inject":
      process.stdout.write(inject(text(o, "phase") ?? "brief", text(o, "dir")));
      return EXIT.ok;
    case "conflicts":
      process.stdout.write(conflictsSection(text(o, "dir")));
      return EXIT.ok;
    case "state":
      return stateCmd(o);
    default:
      return undefined;
  }
}

export function qualityCommand(args: string[]): number {
  const [cmd = "", ...rest] = args;
  if (["inject", "conflicts", "state"].includes(cmd)) need("git");
  try {
    const code = run(cmd, parseArgs(rest));
    if (code !== undefined) return code;
  } catch (error) {
    if (!(error instanceof QualityError)) throw error;
    warn(`hades-quality: ${error.message}`);
    return EXIT.usage;
  }
  process.stderr.write(USAGE);
  return EXIT.usage;
}
