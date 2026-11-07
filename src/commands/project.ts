// `hades project`: o projeto ativo e o que o perfil declara (reference/projects.md).
import { CLI_ERRORS } from "../lib/human-errors.ts";
import { EXIT, die, out, warn } from "../lib/output.ts";
import { need } from "../lib/deps.ts";
import { packOf, packsRoot, resolutionJson, resolveProject, type Resolution } from "../lib/project.ts";
import {
  activeStacks,
  coreCheck,
  detectStacks,
  domainTerms,
  getField,
  jsonText,
  loadProfile,
  nameTerms,
  pyRepr,
  refPath,
  stepOf,
  vocabulary,
} from "../lib/profile.ts";
import { installedFiles, isProfileWithoutCore, validateFile } from "../lib/validate.ts";

const USAGE = `Projeto ativo da Hades: repo do diretório → perfil em <raiz dos pacotes>/<projeto>/ (reference/projects.md).
  hades project resolve [<dir>]                 JSON {project, profile, repo, root, packs}; sai 3 = repo sem perfil,
                                                4 = fora de repo com remote.origin.url (mensagem em stderr)
  hades project get <campo.a.b> [<padrão>] [--dir <d>]   campo do perfil ativo (sai 1 se ausente)
  hades project pack [<dir>]                    pasta do pacote do projeto ativo (sai 1 sem perfil)
  hades project ref <nome> [--dir <d>]          referência do projeto (refs.<nome> do perfil), caminho absoluto; sai 1 se ausente
  hades project packs                           a raiz dos pacotes
  hades project names                           perfil<TAB>termos da guarda de nome (nome, repo, owner, aliases)
  hades project patterns                        ERE do vocabulário do projeto (identity.vocabulary), um por linha
  hades project domain [allow]                  ERE do vocabulário de domínio (domainTerms de cada perfil), um por linha;
                                                \`allow\`: os globs de arquivos do núcleo ainda acoplados (linhas @allow)
  hades project validate [<arquivo>…]           valida perfis, stacks, catálogo e choices.tsv (padrão: os instalados)
  hades project core-check [--dir <d>] [--version <v>]   o \`core\` do perfil ativo contra a VERSION do núcleo:
                                                estado<TAB>projeto<TAB>core<TAB>núcleo<TAB>mensagem; estado ok · sem-core ·
                                                fora · invalido · sem-perfil. Sai 0 ok/sem-core, 1 fora/invalido, 3 sem perfil
  hades project stacks [<dir>]                  stacks que valem no diretório (perfil → stacks; sem perfil, todas as instaladas)
  hades project step <stack>:<etapa>            "<kind> <costGb> <parallel> <measuredAt>" da etapa (a fila lê o custo daqui)
  hades project detect [<dir>]                  stacks instaladas cuja detecção (detect.files) casa com o repo
Raiz dos pacotes: HADES_PACKS_ROOT > ~/.claude/hades/packs-root (uma linha) > ~/.claude/hades/packs. Stacks:
HADES_STACKS_ROOT > ~/.claude/hades/stacks, depois <skill>/stacks.
`;

const NEEDS_GIT = new Set(["resolve", "get", "pack", "ref", "core-check", "stacks", "detect"]);

/** `--dir <d>` fora dos demais argumentos; undefined em dir se não veio. */
function takeDir(args: string[]): { rest: string[]; dir: string | undefined; broken: boolean } {
  const rest = [...args];
  const at = rest.indexOf("--dir");
  if (at < 0) return { rest, dir: undefined, broken: false };
  const dir = rest[at + 1];
  rest.splice(at, 2);
  return { rest, dir, broken: dir === undefined };
}

function usageError(): number {
  out(USAGE);
  return EXIT.usage;
}

function resolveCmd(args: string[]): number {
  const resolution = resolveProject(args[0] || process.cwd());
  out(resolutionJson(resolution));
  if (resolution.message) warn(resolution.message);
  return resolution.code;
}

function getCmd(args: string[]): number {
  const { rest, dir, broken } = takeDir(args);
  if (rest.length === 0 || broken) {
    die("get <campo> [<padrão>] [--dir <d>]", EXIT.usage, CLI_ERRORS.projectFieldMissing);
  }
  const resolution = resolveProject(dir || process.cwd());
  const value = getField(loadProfile(resolution), rest[0] as string, rest[1]);
  if (value === undefined) return EXIT.fail;
  out(value);
  return EXIT.ok;
}

function refCmd(args: string[]): number {
  const { rest, dir } = takeDir(args);
  if (rest.length !== 1) {
    die("ref <nome> [--dir <d>]", EXIT.usage, CLI_ERRORS.projectFieldMissing);
  }
  const path = refPath(resolveProject(dir || process.cwd()), rest[0] as string);
  if (path === undefined) return EXIT.fail;
  out(path);
  return EXIT.ok;
}

function coreCheckCmd(args: string[]): number {
  let dir: string | undefined;
  let version: string | undefined;
  for (let i = 0; i < args.length; i += 2) {
    const value = args[i + 1];
    if (args[i] === "--dir" && value !== undefined) dir = value;
    else if (args[i] === "--version" && value !== undefined) version = value;
    else return usageError();
  }
  const r = coreCheck(dir, version);
  out([r.state, r.project, r.core, r.version, r.message].join("\t"));
  if (r.state === "fora" || r.state === "invalido") warn(`hades: ${r.message}`);
  else if (r.state === "sem-core") warn(`aviso: ${r.message}`);
  return r.state === "fora" || r.state === "invalido" ? EXIT.fail : r.state === "sem-perfil" ? EXIT.noProfile : EXIT.ok;
}

function validateCmd(args: string[]): number {
  let bad = 0;
  for (const file of args.length > 0 ? args : installedFiles()) {
    const errors = validateFile(file);
    out(`${errors.length === 0 ? "ok" : "✗"}  ${file}`);
    for (const error of errors) out(`     ${error}`);
    if (errors.length === 0 && isProfileWithoutCore(file)) {
      warn(`aviso: ${file}: sem \`core\` (faixa de versões do núcleo; reference/projects.md §Plugin)`);
    }
    if (errors.length > 0) bad += 1;
  }
  return bad > 0 ? EXIT.fail : EXIT.ok;
}

function stepCmd(ref: string): number {
  const step = stepOf(ref);
  if (!step) {
    warn(`hades: etapa ${pyRepr(ref)} não existe nas stacks instaladas`);
    return EXIT.fail;
  }
  out(`${jsonText(step.kind)}\t${jsonText(step.costGb)}\t${jsonText(step.parallel)}\t${jsonText(step.measuredAt)}`);
  return EXIT.ok;
}

function lines(items: string[]): void {
  out(items.join("\n"));
}

export function projectCommand(args: string[]): number {
  const [first, ...rest] = args;
  const sub = first || "resolve";
  if (NEEDS_GIT.has(sub)) need("git");
  switch (sub) {
    case "resolve":
      return resolveCmd(rest);
    case "get":
      return getCmd(rest);
    case "pack": {
      const pack = packOf(resolveProject(rest[0] || process.cwd()));
      // o `dirname | echo` do script em bash deixa uma linha em branco depois do caminho
      if (pack) out(`${pack}\n`);
      return pack ? EXIT.ok : EXIT.fail;
    }
    case "ref":
      return refCmd(rest);
    case "core-check":
      return coreCheckCmd(rest);
    case "validate":
      return validateCmd(rest);
    case "names":
      for (const { name, terms } of nameTerms()) out(`${name}\t${terms.join("\t")}`);
      return EXIT.ok;
    case "packs":
      out(packsRoot());
      return EXIT.ok;
    case "patterns":
      lines(vocabulary());
      return EXIT.ok;
    case "domain":
      lines(domainTerms()[rest[0] === "allow" ? "allow" : "terms"]);
      return EXIT.ok;
    case "stacks":
      for (const name of activeStacks(rest[0]).keys()) out(name);
      return EXIT.ok;
    case "step":
      return rest.length === 1 ? stepCmd(rest[0] as string) : usageError();
    case "detect":
      for (const name of detectStacks(rest[0])) out(name);
      return EXIT.ok;
    default:
      return usageError();
  }
}
