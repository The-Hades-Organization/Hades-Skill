// Contexto do Argos para o agente de um terminal (reference/argos.md §Contexto do agente no Argos): em que canvas e em que
// área ele está, o papel, a quem responde, as notas e a equipe. A CLI imprime em `hades canvas context` e no fim do `join`
// do próprio pane; o texto fixo (comandos e regras da Hades) vem de `kit/panel/argos/argos-context.md`. Lógica pura.
import { areaIndex, areaLook } from "./canvas-areas.ts";
import type { CanvasDoc, CanvasNode } from "./canvas-doc.ts";
import { directNotesOf } from "./canvas-note.ts";
import { isOrchestrator, nodeName, recruiterOf, recruitsOf } from "./canvas-recruit.ts";
import { containerOf } from "./canvas-space.ts";

/** Membros da área listados pelo nome; passando disso, a linha diz quantos faltam. */
export const CONTEXT_MEMBERS_SHOWN = 20;

export interface ArgosContextInput {
  canvas: string;
  doc: CanvasDoc;
  node: CanvasNode;
  /** Bloco "PR pronta" das Configurações, quando o terminal abre PR ou é orquestrador. */
  prReady?: string;
}

const dataOf = (node: CanvasNode): Record<string, unknown> => (typeof node.data === "object" && node.data !== null ? node.data : {});

const noteLabel = (doc: CanvasDoc, id: string): string => {
  const node = doc.nodes.find((n) => n.id === id);
  const note = node ? dataOf(node).note : undefined;
  return typeof note === "string" && note ? note : id;
};

/** A área do nó (pela lista de membros, senão pela geometria) com título e membros, ou `undefined`. */
export function areaOfNode(doc: CanvasDoc, node: CanvasNode): { id: string; title: string; members: CanvasNode[] } | undefined {
  const area = containerOf(doc, node);
  if (area === undefined) return undefined;
  const index = areaIndex(doc);
  return { id: area.id, title: areaLook(area).title, members: doc.nodes.filter((n) => index.get(n.id) === area.id) };
}

/** As linhas do contexto, na ordem em que o agente as lê. */
export function argosContext(input: ArgosContextInput): string[] {
  const { doc, node } = input;
  const role = dataOf(node).role;
  const recruiter = recruiterOf(node);
  const boss = recruiter === undefined ? undefined : doc.nodes.find((n) => n.id === recruiter);
  const lines = [
    `Argos: canvas ${input.canvas}; você é ${nodeName(node)} (nó ${node.id}).`,
    [
      `Papel: ${typeof role === "string" && role ? role : "sem papel definido"}`,
      ...(isOrchestrator(node) ? ["orquestrador (recruta, cria nota e desenho, dispensa)"] : []),
      ...(boss ? [`recruta de ${nodeName(boss)}: responda a ele pelas notas`] : []),
    ].join("; ") + ".",
  ];
  const area = areaOfNode(doc, node);
  if (area === undefined) lines.push("Fora de área: o que você criar pela CLI nasce perto de você, sem área.");
  else {
    const others = area.members.filter((n) => n.id !== node.id);
    const shown = others.slice(0, CONTEXT_MEMBERS_SHOWN).map((n) => `${n.type === "note" ? noteLabel(doc, n.id) : nodeName(n)} (${n.type})`);
    const rest = others.length - shown.length;
    lines.push(`Área: ${area.title} (${area.id}). Também nela: ${shown.length ? shown.join(", ") : "ninguém"}${rest > 0 ? ` e mais ${rest}` : ""}.`);
    lines.push("O que você criar pela CLI nasce nesta área; cheia, ela cresce e afasta o que estiver no caminho. Não mexa em nó de outra área.");
  }
  const notes = directNotesOf(doc, node.id).map((id) => noteLabel(doc, id));
  lines.push(notes.length ? `Notas ligadas a você: ${notes.join(", ")} (\`hades canvas note read <nota>\`).` : "Nenhuma nota ligada a você.");
  if (isOrchestrator(node)) {
    const team = recruitsOf(doc, node.id).map(nodeName);
    lines.push(team.length ? `Seus recrutas: ${team.join(", ")}.` : "Nenhum recruta por enquanto.");
  }
  if (input.prReady) lines.push(input.prReady);
  lines.push("Comandos e regras da Hades neste canvas: `hades canvas context --rules`.");
  return lines;
}
