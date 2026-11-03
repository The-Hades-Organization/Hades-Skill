// Grupo canvas-agent-files: nós e ligações de brief/report/questions/handoff de um agente (src/lib/canvas-agent-files.ts) —
// empilhamento, idempotência, validação de caminho, tetos e a ida e volta exata pelo desfazer. Lógica pura.
import { describe, expect, test } from "bun:test";
import {
  addAgentFiles,
  AGENT_FILE_EDGE_KIND,
  AGENT_FILE_LAYOUT,
  AGENT_FILE_LIMITS,
  AGENT_FILE_NODE_TYPE,
  AGENT_FILES_ERRORS,
  AgentFilesError,
  agentFileNodes,
  checkAgentFiles,
  normalizeAgentFilePath,
  removeAgentFiles,
} from "../../../src/lib/canvas-agent-files";
import { sequentialIds } from "../../../src/lib/canvas-clipboard";
import { CANVAS_LIMITS, type CanvasDoc, type CanvasNode, validateCanvasDoc } from "../../../src/lib/canvas-doc";
import { createHistory, type CanvasOp, perform, redo, undo } from "../../../src/lib/canvas-history";

const AGENT = "agent:proj:u-terminal";
const node = (id: string, over: Partial<CanvasNode> = {}): CanvasNode => ({ id, type: "note", x: 0, y: 0, w: 100, h: 60, z: 0, data: {}, locked: false, blurred: false, ...over });

const doc = (): CanvasDoc =>
  validateCanvasDoc({
    v: 1,
    rev: 3,
    nodes: [node(AGENT, { type: "agent", x: 100, y: 200, w: 200, h: 80, z: 2 }), node("n1", { x: 900 }), node("n2", { x: 1100 })],
    edges: [{ id: "e1", from: "n1", to: "n2", kind: "link" }],
    groups: [{ id: "g1", label: "g", members: ["n1", "n2"] }],
  });

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof AgentFilesError ? error.code : "outro-erro";
  }
  return "não lançou";
};

/** Aplica pela pilha, confere o documento válido, que desfazer devolve o original e que refazer devolve o aplicado. */
function run(original: CanvasDoc, op: CanvasOp | undefined): CanvasDoc {
  if (!op) throw new Error("esperava uma operação");
  const frozen = structuredClone(original);
  const done = perform(createHistory(), original, op);
  expect(validateCanvasDoc(done.doc)).toEqual(done.doc);
  expect(original).toEqual(frozen);
  const back = undo(done.history, done.doc);
  expect(back?.doc).toEqual(frozen);
  if (back) expect(redo(back.history, back.doc)?.doc).toEqual(done.doc);
  return done.doc;
}

const files = [
  { path: ".design-sync-reports/report.md", role: "report" },
  { path: ".design-sync-reports/brief.md", role: "brief" },
  { path: ".design-sync-reports/questions.md", role: "questions" },
  { path: ".design-sync-reports/handoff.md", role: "handoff" },
] as const;

describe("normalizeAgentFilePath", () => {
  test("aceita relativo e normaliza ./ e barras repetidas", () => {
    expect(normalizeAgentFilePath("a/b.md")).toBe("a/b.md");
    expect(normalizeAgentFilePath("./a//b.md")).toBe("a/b.md");
  });

  test("recusa vazio, absoluto, .., barra invertida, unidade, controle e comprimento acima do teto", () => {
    for (const bad of ["", "/etc/passwd", "../x", "a/../../x", "a\\b", "C:\\x", "C:x", "a\u0000b", "a\nb", ".", "./", "x".repeat(AGENT_FILE_LIMITS.pathChars + 1)]) {
      expect(normalizeAgentFilePath(bad)).toBeUndefined();
    }
    expect(normalizeAgentFilePath("x".repeat(AGENT_FILE_LIMITS.pathChars))).toBeDefined();
  });

  test("valor que não é texto é recusado", () => {
    expect(normalizeAgentFilePath(undefined as unknown as string)).toBeUndefined();
  });
});

describe("checkAgentFiles", () => {
  test("separa repetidos (o primeiro vale) e normaliza o caminho", () => {
    const result = checkAgentFiles([{ path: "./a.md", role: "brief" }, { path: "a.md", role: "report" }]);
    expect(result.files).toEqual([{ path: "a.md", role: "brief" }]);
    expect(result.duplicates).toEqual(["a.md"]);
  });

  test("lista vazia é válida", () => {
    expect(checkAgentFiles([])).toEqual({ files: [], duplicates: [] });
  });

  test("entrada inválida lança agent_files_invalid_file", () => {
    for (const bad of [undefined, "x", {}, [null], [{ path: "a" }], [{ path: "a", role: "outro" }], [{ role: "brief" }], [{ path: 3, role: "brief" }], [{ path: "../a", role: "brief" }]]) {
      expect(code(() => checkAgentFiles(bad))).toBe(AGENT_FILES_ERRORS.invalidFile);
    }
  });

  test("acima do teto de arquivos lança agent_files_limit_exceeded", () => {
    const many = Array.from({ length: AGENT_FILE_LIMITS.files + 1 }, (_, i) => ({ path: `f${i}.md`, role: "brief" }));
    expect(code(() => checkAgentFiles(many))).toBe(AGENT_FILES_ERRORS.limitExceeded);
    expect(checkAgentFiles(many.slice(0, AGENT_FILE_LIMITS.files)).files).toHaveLength(AGENT_FILE_LIMITS.files);
  });
});

describe("addAgentFiles", () => {
  test("cria um nó por arquivo, empilhado à direita do agente, na ordem dos papéis, com ligações do agente", () => {
    const original = doc();
    const result = addAgentFiles(original, { agentId: AGENT, files }, sequentialIds(original, "f"));
    const done = run(original, result.op);
    const created = done.nodes.filter((n) => n.type === AGENT_FILE_NODE_TYPE);
    expect(created.map((n) => n.data.role)).toEqual(["brief", "report", "questions", "handoff"]);
    const x = 100 + 200 + AGENT_FILE_LAYOUT.gapX;
    created.forEach((n, i) => expect([n.x, n.y, n.w, n.h, n.z]).toEqual([x, 200 + i * (AGENT_FILE_LAYOUT.h + AGENT_FILE_LAYOUT.gapY), AGENT_FILE_LAYOUT.w, AGENT_FILE_LAYOUT.h, 2]));
    expect(created[0]?.data).toEqual({ path: ".design-sync-reports/brief.md", role: "brief", agent: AGENT, label: "brief.md" });
    const links = done.edges.filter((e) => e.kind === AGENT_FILE_EDGE_KIND);
    expect(links.map((e) => [e.from, e.to])).toEqual(created.map((n) => [AGENT, n.id]));
    expect(result.nodeIds).toEqual(created.map((n) => n.id));
    expect(result.edgeIds).toHaveLength(4);
  });

  test("não toca o resto do documento (nós, ligações e grupos originais seguem iguais)", () => {
    const original = doc();
    const done = run(original, addAgentFiles(original, { agentId: AGENT, files }, sequentialIds(original, "f")).op);
    expect(done.nodes.slice(0, 3)).toEqual(original.nodes);
    expect(done.edges[0]).toEqual(original.edges[0]);
    expect(done.groups).toEqual(original.groups);
  });

  test("é idempotente: repetir não cria de novo e lista os caminhos que já existiam", () => {
    const original = doc();
    const first = run(original, addAgentFiles(original, { agentId: AGENT, files }, sequentialIds(original, "f")).op);
    const again = addAgentFiles(first, { agentId: AGENT, files }, sequentialIds(first, "f"));
    expect(again.op).toBeUndefined();
    expect(again.existing.sort()).toEqual(files.map((f) => f.path).sort());
    expect(again.nodeIds).toEqual([]);
  });

  test("arquivo novo depois de outros continua a pilha abaixo do último nó", () => {
    const original = doc();
    const first = run(original, addAgentFiles(original, { agentId: AGENT, files: [files[1]!] }, sequentialIds(original, "f")).op);
    const second = addAgentFiles(first, { agentId: AGENT, files: [files[0]!, files[1]!] }, sequentialIds(first, "g"));
    expect(second.existing).toEqual([files[1]!.path]);
    const done = run(first, second.op);
    const [brief, report] = agentFileNodes(done, AGENT);
    expect(report?.y).toBe((brief?.y ?? 0) + AGENT_FILE_LAYOUT.h + AGENT_FILE_LAYOUT.gapY);
  });

  test("nó existente sem ligação (apagada pelo usuário) não é refeito", () => {
    const original = doc();
    const first = run(original, addAgentFiles(original, { agentId: AGENT, files: [files[1]!] }, sequentialIds(original, "f")).op);
    const unlinked: CanvasDoc = { ...first, edges: first.edges.filter((e) => e.kind !== AGENT_FILE_EDGE_KIND) };
    const result = addAgentFiles(unlinked, { agentId: AGENT, files: [files[1]!] }, sequentialIds(unlinked, "g"));
    expect(result.op).toBeUndefined();
    expect(result.existing).toEqual([files[1]!.path]);
  });

  test("caminhos repetidos na entrada criam um nó só e voltam em duplicates", () => {
    const original = doc();
    const result = addAgentFiles(original, { agentId: AGENT, files: [files[1]!, { path: "./.design-sync-reports/brief.md", role: "report" }] }, sequentialIds(original, "f"));
    expect(result.nodeIds).toHaveLength(1);
    expect(result.duplicates).toEqual([files[1]!.path]);
  });

  test("lista vazia não gera operação", () => {
    const original = doc();
    expect(addAgentFiles(original, { agentId: AGENT, files: [] }, sequentialIds(original)).op).toBeUndefined();
  });

  test("agente fora do documento e nó que não é agente têm códigos próprios", () => {
    const original = doc();
    expect(code(() => addAgentFiles(original, { agentId: "agent:x", files }, sequentialIds(original)))).toBe(AGENT_FILES_ERRORS.unknownAgent);
    expect(code(() => addAgentFiles(original, { agentId: "n1", files }, sequentialIds(original)))).toBe(AGENT_FILES_ERRORS.notAgent);
  });

  test("arquivo inválido na lista recusa tudo, sem operação parcial", () => {
    const original = doc();
    const bad = [files[0]!, { path: "../fora", role: "brief" as const }];
    expect(code(() => addAgentFiles(original, { agentId: AGENT, files: bad }, sequentialIds(original)))).toBe(AGENT_FILES_ERRORS.invalidFile);
  });

  test("id novo inválido ou já usado é recusado", () => {
    const original = doc();
    expect(code(() => addAgentFiles(original, { agentId: AGENT, files: [files[0]!] }, () => "id inválido!"))).toBe(AGENT_FILES_ERRORS.invalidId);
    expect(code(() => addAgentFiles(original, { agentId: AGENT, files: [files[0]!] }, () => "n1"))).toBe(AGENT_FILES_ERRORS.duplicateId);
  });

  test("passar do teto de nós do documento é recusado", () => {
    const crowded = doc();
    crowded.nodes.push(...Array.from({ length: CANVAS_LIMITS.nodes - crowded.nodes.length }, (_, i) => node(`x${i}`, { x: i })));
    expect(crowded.nodes).toHaveLength(CANVAS_LIMITS.nodes);
    expect(code(() => addAgentFiles(crowded, { agentId: AGENT, files: [files[0]!] }, sequentialIds(crowded)))).toBe(AGENT_FILES_ERRORS.limitExceeded);
  });

  test("agente tão à direita que o nó sairia do limite de coordenadas é recusado", () => {
    const edge = doc();
    const agent = edge.nodes[0]!;
    agent.x = CANVAS_LIMITS.coordinate - 100;
    expect(code(() => addAgentFiles(edge, { agentId: AGENT, files: [files[0]!] }, sequentialIds(edge)))).toBe(AGENT_FILES_ERRORS.invalidNumber);
  });
});

describe("removeAgentFiles", () => {
  test("remove os nós de arquivo e as ligações, deixa o agente, e desfazer volta ao anterior", () => {
    const original = doc();
    const added = run(original, addAgentFiles(original, { agentId: AGENT, files }, sequentialIds(original, "f")).op);
    const result = removeAgentFiles(added, AGENT);
    expect(result.nodeIds).toHaveLength(4);
    const done = run(added, result.op);
    expect(done).toEqual({ ...original });
  });

  test("só remove os arquivos do agente pedido", () => {
    const original = doc();
    original.nodes.push(node("agent:proj:outro", { type: "agent", x: 0, y: 900 }));
    const a = run(original, addAgentFiles(original, { agentId: AGENT, files: [files[0]!] }, sequentialIds(original, "a")).op);
    const b = run(a, addAgentFiles(a, { agentId: "agent:proj:outro", files: [files[1]!] }, sequentialIds(a, "b")).op);
    const done = run(b, removeAgentFiles(b, AGENT).op);
    expect(agentFileNodes(done, AGENT)).toEqual([]);
    expect(agentFileNodes(done, "agent:proj:outro")).toHaveLength(1);
  });

  test("agente sem arquivos não gera operação", () => {
    const original = doc();
    expect(removeAgentFiles(original, AGENT)).toEqual({ op: undefined, nodeIds: [] });
  });

  test("grupo que fica com menos de dois membros se desfaz junto", () => {
    const original = doc();
    const added = run(original, addAgentFiles(original, { agentId: AGENT, files: [files[0]!] }, sequentialIds(original, "f")).op);
    const grouped: CanvasDoc = { ...added, groups: [...added.groups, { id: "g2", label: "arq", members: [added.nodes[3]!.id, "n1"] }] };
    const done = run(grouped, removeAgentFiles(grouped, AGENT).op);
    expect(done.groups.map((g) => g.id)).toEqual(["g1"]);
  });
});
