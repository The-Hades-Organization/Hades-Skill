// `hades minos`: prepara as saídas da Hades para quem está fora do painel (reference/minos.md). Publicar num Artifact é
// ação da sessão do Claude, não da CLI: o `publish` grava a página e devolve o que a sessão deve publicar.
import { join, resolve } from "node:path";
import { readText } from "../lib/fs.ts";
import { stateDir } from "../lib/kit.ts";
import { MODELS, isModelId } from "../lib/minos-model.ts";
import { publish } from "../lib/minos-publish.ts";
import { ARTIFACT_HOST, isOutputId, parseArtifactUrl, readOutputs, saveOutput } from "../lib/minos-store.ts";
import { EXIT, out } from "../lib/output.ts";
import { skillRoot } from "../lib/paths.ts";
import { run, which } from "../lib/proc.ts";
import { configValue } from "../lib/work.ts";

export const USAGE = `hades minos list | schema <modelo> | publish <modelo> <fonte> [--html <arquivo>] [--team] | link <saída> <url> | open <saída> [--print]
  list      os modelos e as saídas já preparadas, com o link registrado de cada uma
  schema    o esqueleto JSON de um modelo de documento (explicacao, proposta), para a sessão preencher
  publish   monta a página do modelo, passa o Cerberus e grava; devolve o arquivo que a sessão publica com a ferramenta
            Artifact (e o link já registrado, para atualizar no mesmo lugar). <fonte> é o plano.md (orquestracao) ou o
            JSON de dados (explicacao, proposta). --html grava só o arquivo offline.
            --team é a página do time: recusa enquanto HADES_MINOS_TEAM=0
  link      grava o link devolvido pela ferramenta Artifact (https://${ARTIFACT_HOST}/…/artifact/<id>)
  open      abre o link registrado, ou a página local se não houver link (--print só mostra o destino)`;

const OPEN_TIMEOUT_MS = 5000;
const teamEnabled = (): boolean => configValue("HADES_MINOS_TEAM", "0") === "1";
const usage = (message: string): number => {
  process.stderr.write(`${message}\n${USAGE}\n`);
  return EXIT.usage;
};

function list(): number {
  out("modelos:");
  for (const [id, m] of Object.entries(MODELS)) out(`  ${id}  ${m.source === "plan" ? "<plano.md>" : "<dados.json>"}  ${m.describe}`);
  const outputs = Object.entries(readOutputs(stateDir()));
  out(outputs.length ? "saídas:" : "saídas: nenhuma ainda (hades minos publish orquestracao <plano.md>)");
  for (const [id, o] of outputs) out(`  ${id}  ${o.scope === "team" ? "time" : "pessoal"}  ${o.url ?? "sem link (publique e rode hades minos link)"}  ${o.updatedAt}`);
  return EXIT.ok;
}

function schema(args: string[]): number {
  const [id, ...extra] = args;
  if (id === undefined || extra.length) return usage("schema pede <modelo>");
  if (!isModelId(id)) return usage(`modelo desconhecido: ${id} (${Object.keys(MODELS).join(", ")})`);
  const example = MODELS[id].example;
  if (example === null) return usage(`${id} não sai de JSON: a fonte é o plano.md (hades minos publish ${id} <plano.md>)`);
  out(JSON.stringify(example, null, 2));
  return EXIT.ok;
}

interface PublishArgs { model: string; plan: string; html?: string; team: boolean }

function parsePublish(args: string[]): PublishArgs | string {
  const positional: string[] = [];
  let html: string | undefined;
  let team = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--team") team = true;
    else if (arg === "--html") {
      html = args[++i];
      if (html === undefined) return "--html pede um arquivo";
    } else if (arg.startsWith("--")) return `opção desconhecida: ${arg}`;
    else positional.push(arg);
  }
  const [model, plan] = positional;
  if (positional.length !== 2 || model === undefined || plan === undefined) return "publish pede <modelo> e <fonte> (plano.md ou dados.json)";
  return { model, plan, html, team };
}

function publishCommand(args: string[]): number {
  const parsed = parsePublish(args);
  if (typeof parsed === "string") return usage(parsed);
  if (!isModelId(parsed.model)) return usage(`modelo desconhecido: ${parsed.model} (${Object.keys(MODELS).join(", ")})`);
  const state = stateDir();
  const result = publish({
    model: parsed.model, plan: resolve(parsed.plan), scope: parsed.team ? "team" : "personal", htmlFile: parsed.html, state,
    teamEnabled: teamEnabled(), credentials: readText(join(state, "credenciais.md")), skillRoots: [skillRoot], cwd: process.cwd(),
  });
  if (!result.ok) {
    const head = result.kind === "guard" ? "o Cerberus barrou a publicação (nada foi gerado). Limpe e rode de novo:" : "minos: recusado:";
    out(`${head}\n${result.reasons.map((r) => `  ${r}`).join("\n")}`);
    return result.kind === "input" ? EXIT.usage : EXIT.fail;
  }
  if (result.mode === "offline") {
    out(`arquivo: ${result.file}\nPágina autocontida (sem script nem recurso externo); nada saiu da máquina.`);
    return EXIT.ok;
  }
  out([
    `publique: ${result.file}`,
    `link registrado: ${result.url ?? "nenhum (primeira publicação)"}`,
    `descrição: ${result.description}`,
    `depois: hades minos link ${result.id} <url devolvida pela ferramenta Artifact>`,
  ].join("\n"));
  return EXIT.ok;
}

function link(args: string[]): number {
  const [id, raw, ...extra] = args;
  if (id === undefined || raw === undefined || extra.length) return usage("link pede <saída> e <url>");
  const url = parseArtifactUrl(raw);
  if (!url) return usage(`link: só https://${ARTIFACT_HOST}/artifact/<id> (ou /code/artifact/<id>)`);
  const state = stateDir();
  const current = isOutputId(id) ? readOutputs(state)[id] : undefined;
  if (!current) return usage(`saída desconhecida: ${id} (hades minos list)`);
  saveOutput(state, id, { ...current, url });
  out(`link de ${id} gravado: ${url}`);
  return EXIT.ok;
}

function open(args: string[]): number {
  const printOnly = args.includes("--print");
  const [id, ...extra] = args.filter((a) => a !== "--print");
  if (id === undefined || extra.length) return usage("open pede <saída>");
  const current = isOutputId(id) ? readOutputs(stateDir())[id] : undefined;
  if (!current) return usage(`saída desconhecida: ${id} (hades minos list)`);
  const target = current.url ?? current.file;
  out(target);
  const opener = ["xdg-open", "open"].find((c) => which(c) !== undefined);
  if (!printOnly && opener) run(opener, [target], { timeoutMs: OPEN_TIMEOUT_MS });
  return EXIT.ok;
}

export function minosCommand(args: string[]): number {
  const [sub, ...rest] = args;
  switch (sub) {
    case "list": return list();
    case "schema": return schema(rest);
    case "publish": return publishCommand(rest);
    case "link": return link(rest);
    case "open": return open(rest);
    default: return usage(sub === undefined ? "falta o subcomando" : `subcomando desconhecido: ${sub}`);
  }
}
