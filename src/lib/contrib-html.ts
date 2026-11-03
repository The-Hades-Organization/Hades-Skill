// O arquivo do caminho "sem acesso": uma página autocontida (sem script, sem recurso externo), clara e escura, a partir de
// `kit/contrib/contrib.html`. Tudo que o dev ou o diff escrevem entra escapado.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { areaOf, type FileDiff, type LeftOut } from "./contrib-diff.ts";
import { listItems, type Meta } from "./contrib-text.ts";
import { skillRoot } from "./paths.ts";

export interface Contribution extends Meta {
  files: FileDiff[];
  diff: string;
  left: LeftOut[];
  repo: string;
  version: string;
}

const BAR_MAX_WIDTH = 300;
const ROW_HEIGHT = 28;
const LABEL_WIDTH = 96;

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (text: string): string => text.replace(/[&<>"']/g, (c) => ESCAPES[c] as string);

export function loadTemplate(): string {
  return readFileSync(join(skillRoot, "kit", "contrib", "contrib.html"), "utf8");
}

const BULLET = /^\s*[-*]\s+/;

/** Blocos separados por linha em branco: parágrafo, ou lista quando todas as linhas do bloco começam com `- `. */
function paragraphs(text: string): string {
  return text.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean).map((block) => {
    const lines = block.split("\n");
    if (lines.every((l) => BULLET.test(l))) return `<ul>${lines.map((l) => `<li>${esc(l.replace(BULLET, ""))}</li>`).join("")}</ul>`;
    return `<p>${esc(block).replace(/\n/g, "<br>")}</p>`;
  }).join("");
}

function diffHtml(diff: string): string {
  return diff.replace(/\n$/, "").split("\n").map((line) => {
    const cls = line.startsWith("diff --git") ? "file" : line.startsWith("@@") ? "hunk" : line.startsWith("+") && !line.startsWith("+++") ? "add"
      : line.startsWith("-") && !line.startsWith("---") ? "del" : "";
    return `<span${cls ? ` class="${cls}"` : ""}>${esc(line)}</span>`;
  }).join("");
}

/** Barras por área do núcleo (linhas postas e tiradas); só quando o diff toca mais de uma área. */
function diagram(files: FileDiff[]): string {
  const areas = new Map<string, { plus: number; minus: number }>();
  for (const f of files) {
    const a = areas.get(areaOf(f.path)) ?? { plus: 0, minus: 0 };
    areas.set(areaOf(f.path), { plus: a.plus + f.plus, minus: a.minus + f.minus });
  }
  if (areas.size < 2) return "";
  const widest = Math.max(...[...areas.values()].map((a) => a.plus + a.minus), 1);
  const rows = [...areas.entries()].map(([name, a], i) => {
    const y = i * ROW_HEIGHT;
    const add = Math.round((a.plus / widest) * BAR_MAX_WIDTH);
    const del = Math.round((a.minus / widest) * BAR_MAX_WIDTH);
    return `<text x="0" y="${y + 17}">${esc(name)}</text>`
      + `<rect class="bar-add" x="${LABEL_WIDTH}" y="${y + 5}" width="${add}" height="16" rx="3"/>`
      + `<rect class="bar-del" x="${LABEL_WIDTH + add}" y="${y + 5}" width="${del}" height="16" rx="3"/>`
      + `<text x="${LABEL_WIDTH + add + del + 8}" y="${y + 17}">+${a.plus} −${a.minus}</text>`;
  });
  const height = areas.size * ROW_HEIGHT;
  return `<section><h2>Onde mexe</h2><svg viewBox="0 0 ${LABEL_WIDTH + BAR_MAX_WIDTH + 90} ${height}" role="img" aria-label="Linhas postas e tiradas por área do núcleo">`
    + `<title>Linhas postas e tiradas por área do núcleo</title>${rows.join("")}</svg></section>`;
}

function leftHtml(left: LeftOut[]): string {
  if (!left.length) return "";
  const items = left.map((l) => `<li><code>${esc(l.path)}</code> — ${esc(l.reason)}</li>`).join("");
  return `<section><h2>Ficou de fora</h2><p>A mudança local tocou mais do que isto; o que segue não faz parte da contribuição.</p><ul>${items}</ul></section>`;
}

export function renderContribHtml(template: string, c: Contribution): string {
  const files = c.files.map((f) => `<tr><td><code>${esc(f.path)}</code></td><td class="num"><span class="plus">+${f.plus}</span> <span class="minus">−${f.minus}</span></td></tr>`).join("");
  const values: Record<string, string> = {
    TITLE: esc(c.title), REPO: esc(c.repo), VERSION: esc(c.version), WHAT: paragraphs(c.what), WHY: paragraphs(c.why),
    GAINS: `<ul>${listItems(c.gains).map((g) => `<li>${esc(g)}</li>`).join("")}</ul>`, PROOF: paragraphs(c.proof),
    DIAGRAM: diagram(c.files), FILES: `<table>${files}</table>`, LEFT: leftHtml(c.left), DIFF: diffHtml(c.diff),
  };
  // uma passada só: o valor inserido nunca é relido como marcador
  return template.replace(/\{\{([A-Z]+)\}\}/g, (all, key: string) => values[key] ?? all);
}
