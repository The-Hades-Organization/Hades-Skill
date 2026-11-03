// Grupo canvas-agent-files-graph: o campo `files` do nó do agente no grafo (`AgentNodeFiles`, só caminhos) entra em
// addAgentFiles sem conversão; o papel sai do nome do arquivo (src/lib/canvas-agent-files.ts).
import { describe, expect, test } from "bun:test";
import { AGENT_FILES_ERRORS, AgentFilesError, addAgentFiles, checkAgentFiles } from "../../../src/lib/canvas-agent-files";
import { sequentialIds } from "../../../src/lib/canvas-clipboard";
import { type CanvasDoc, validateCanvasDoc } from "../../../src/lib/canvas-doc";
import { createHistory, perform, undo } from "../../../src/lib/canvas-history";
import type { AgentNodeFiles } from "../../../src/panel/argos-graph";

const AGENT = "agent:proj:u-terminal";
const doc = (): CanvasDoc =>
  validateCanvasDoc({
    v: 1,
    rev: 1,
    nodes: [{ id: AGENT, type: "agent", x: 0, y: 0, w: 200, h: 80, z: 0, data: {}, locked: false, blurred: false }],
    edges: [],
    groups: [],
  });
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof AgentFilesError ? error.code : "outro-erro";
  }
  return "não lançou";
};

describe("canvas-agent-files: files do grafo (só caminhos)", () => {
  test("dado os caminhos do nó do agente, então cada um ganha o papel do nome do arquivo", () => {
    const files: AgentNodeFiles = [".design-sync-reports/brief.md", ".design-sync-reports/handoff.md"];
    expect(checkAgentFiles(files).files).toEqual([
      { path: ".design-sync-reports/brief.md", role: "brief" },
      { path: ".design-sync-reports/handoff.md", role: "handoff" },
    ]);
  });

  test("dado caminhos, quando cria e desfaz, então o documento volta exatamente ao anterior", () => {
    const original = doc();
    const frozen = structuredClone(original);
    const files: AgentNodeFiles = [".design-sync-reports/report.md", ".design-sync-reports/brief.md"];
    const result = addAgentFiles(original, { agentId: AGENT, files }, sequentialIds(original, "f"));
    if (!result.op) throw new Error("esperava uma operação");
    const done = perform(createHistory(), original, result.op);
    expect(done.doc.nodes.filter((n) => n.type === "agent-file").map((n) => n.data.role)).toEqual(["brief", "report"]);
    expect(undo(done.history, done.doc)?.doc).toEqual(frozen);
  });

  test("dado lista vazia, então não há nada a criar", () => {
    expect(checkAgentFiles([])).toEqual({ files: [], duplicates: [] });
    expect(addAgentFiles(doc(), { agentId: AGENT, files: [] }, sequentialIds(doc())).op).toBeUndefined();
  });

  test("dado nome sem papel conhecido, sem .md ou caminho inválido, então lança agent_files_invalid_file", () => {
    for (const bad of [["notas.md"], ["brief"], ["dir/brief.txt"], [""], ["../brief.md"], ["/abs/brief.md"]]) {
      expect(code(() => checkAgentFiles(bad))).toBe(AGENT_FILES_ERRORS.invalidFile);
    }
  });

  test("dado o mesmo arquivo como caminho e como entrada com papel, então conta como repetido", () => {
    const result = checkAgentFiles(["a/brief.md", { path: "./a/brief.md", role: "brief" }]);
    expect(result).toEqual({ files: [{ path: "a/brief.md", role: "brief" }], duplicates: ["a/brief.md"] });
  });
});
