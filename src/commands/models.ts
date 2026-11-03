// `hades models`: aplica o mapa HADES_REVIEW_SUBAGENT_MODELS (Configurações → Modelos por papel) ao `model:` do frontmatter
// de ~/.claude/agents/review-*.md. Só a linha `model:` muda; o resto do arquivo fica como está.
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { EXIT, out } from "../lib/output.ts";
import { listDir, readText } from "../lib/fs.ts";
import { home } from "../lib/paths.ts";

const KEY = "HADES_REVIEW_SUBAGENT_MODELS";
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;
const NAME_WIDTH = 24;
const CUR_WIDTH = 8;

function lastValue(text: string, key: string, separator: string): string | undefined {
  let value: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.startsWith(key + separator)) continue;
    value = separator === "\t" ? (line.split("\t")[1] ?? "") : line.slice(key.length + 1);
  }
  return value;
}

/** Valor da chave: a cópia instalada, depois o catálogo da skill, e o config.env do dono por cima. */
function setting(key: string): string {
  const instance = readText(join(home(), ".claude", "hades", "instance"));
  const data = instance === undefined ? undefined : instance.trim();
  let value: string | undefined;
  const catalogs = [...(data ? [join(data, "config.tsv")] : []), join(home(), ".claude", "skills", "hades", "kit", "config.tsv")];
  for (const file of catalogs) {
    if (value !== undefined) break;
    const text = readText(file);
    if (text !== undefined) value = lastValue(text, key, "\t");
  }
  const own = data ? readText(join(data, "config.env")) : undefined;
  if (own !== undefined) value = lastValue(own, key, "=") ?? value;
  return value ?? "";
}

function parseMap(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of text.split(",")) {
    const eq = part.indexOf("=");
    if (eq >= 0) map.set(part.slice(0, eq), part.slice(eq + 1));
  }
  return map;
}

export function modelsCommand(args: string[]): number {
  const dry = args.includes("--dry-run");
  const models = parseMap(setting(KEY));
  const fallback = models.get("default") ?? "inherit";
  const dir = join(home(), ".claude", "agents");
  for (const name of listDir(dir).filter((n) => n.startsWith("review-") && n.endsWith(".md"))) {
    const file = join(dir, name);
    const text = readText(file);
    const body = text === undefined ? undefined : FRONTMATTER.exec(text)?.[1];
    if (text === undefined || body === undefined) continue;
    const stem = basename(name, ".md");
    const want = models.get(stem) ?? fallback;
    const hasModel = /^model:/m.test(body);
    const next = hasModel ? body.replace(/^model:[^\n]*$/gm, () => `model: ${want}`) : `${body}\nmodel: ${want}`;
    const current = /^model:\s*(\S+)/m.exec(body)?.[1] ?? "—";
    const changed = next !== body;
    if (changed && !dry) writeFileSync(file, text.replace(body, () => next));
    out(`${stem.padEnd(NAME_WIDTH)} ${current.padStart(CUR_WIDTH)} → ${want}${changed ? "" : " (igual)"}`);
  }
  return EXIT.ok;
}
