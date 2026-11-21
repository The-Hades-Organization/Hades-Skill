// `hades provider print-argv`: o argv de print do provedor ativo, para binários que não carregam o provedor (Moirai --deep em Rust, Caronte).
// Mesma resolução do `--deep` do TS (commands/moirai.ts): provedor, modelo, binário e timeout vêm das Configurações.
//
// Uso: hades provider print-argv [--role R] [--no-read-only] [--allow-tools "A B"]... [--prompt T | --prompt-stdin]
import { readFileSync } from "node:fs";
import { activeProvider } from "../lib/agent-provider.ts";
import { die, EXIT, out } from "../lib/output.ts";
import { home, skillRoot } from "../lib/paths.ts";
import { configValue } from "../lib/work.ts";

const USAGE = `uso: hades provider print-argv [--role R] [--no-read-only] [--allow-tools "A B"]... [--prompt T | --prompt-stdin]
  devolve {"bin","args","cwd","timeout_s"}: o argv de print do provedor ativo, com modelo, binário e timeout das Configurações
  --role           papel cujo HADES_MODEL_<PAPEL> escolhe o modelo (padrão ORCHESTRATOR)
  --no-read-only   tira o modo somente leitura (padrão: ligado)
  --allow-tools    ferramentas liberadas, repetível (padrão: "Read Grep Glob")
  --prompt         prompt no argv; --prompt-stdin lê do stdin; sem nenhum dos dois o argv sai sem prompt
  timeout_s        HADES_MOIRAI_DEEP_TIMEOUT_S (180, mínimo 1)`;

const DEFAULT_ROLE = "ORCHESTRATOR";
const DEFAULT_TOOLS = "Read Grep Glob";
const DEFAULT_TIMEOUT_S = 180;
const DEFAULT_MODEL = "claude-opus-5-5";

export interface PrintArgvRequest {
  role: string;
  readOnly: boolean;
  allowedTools: string[];
  prompt?: string;
}

export interface PrintArgvSpec {
  bin: string;
  args: string[];
  cwd: string;
  timeout_s: number;
}

function timeoutS(): number {
  const raw = configValue("HADES_MOIRAI_DEEP_TIMEOUT_S", String(DEFAULT_TIMEOUT_S));
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) die(`HADES_MOIRAI_DEEP_TIMEOUT_S=${raw}: esperava um inteiro maior ou igual a zero`);
  return Math.max(1, value);
}

export function printArgvSpec(req: PrintArgvRequest): PrintArgvSpec {
  const readCfg = (key: string): string | undefined => configValue(key, "") || undefined;
  const provider = activeProvider(req.role, readCfg);
  const rawModel = configValue(`HADES_MODEL_${req.role}`, DEFAULT_MODEL);
  const model = provider.id === "claude" ? rawModel : provider.resolveModel(rawModel, req.role, readCfg);
  const bin = provider.id === "claude" ? (configValue("HADES_CHAT_BIN", "") || "claude") : (provider.resolveBinary(readCfg, (cmd) => cmd, home()) ?? "agy");
  const argv = provider.buildPrintArgv({
    bin,
    ...(req.prompt === undefined ? {} : { prompt: req.prompt }),
    model,
    readOnly: req.readOnly,
    allowedTools: req.allowedTools,
    readConfig: readCfg,
  });
  return { bin, args: argv.slice(1), cwd: skillRoot, timeout_s: timeoutS() };
}

function parse(args: string[]): PrintArgvRequest | null {
  const req: PrintArgvRequest = { role: DEFAULT_ROLE, readOnly: true, allowedTools: [] };
  const value = (i: number, flag: string): string => args[i] ?? die(`${flag} pede um valor`);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "-h" || arg === "--help") return null;
    else if (arg === "--role") req.role = value(++i, arg).toUpperCase();
    else if (arg === "--read-only") req.readOnly = true;
    else if (arg === "--no-read-only") req.readOnly = false;
    else if (arg === "--allow-tools") req.allowedTools.push(value(++i, arg));
    else if (arg === "--prompt") req.prompt = value(++i, arg);
    else if (arg === "--prompt-stdin") req.prompt = readFileSync(0, "utf8");
    else die(`opção desconhecida: ${arg}\n${USAGE}`);
  }
  if (req.allowedTools.length === 0) req.allowedTools.push(DEFAULT_TOOLS);
  return req;
}

export function providerCommand(args: string[]): number {
  const [sub, ...rest] = args;
  if (sub !== "print-argv") {
    out(USAGE);
    return sub === "-h" || sub === "--help" ? EXIT.ok : EXIT.usage;
  }
  const req = parse(rest);
  if (req === null) {
    out(USAGE);
    return EXIT.ok;
  }
  out(JSON.stringify(printArgvSpec(req)));
  return EXIT.ok;
}
