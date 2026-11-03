// Paleta Ctrl+K do painel (issue 5): o grupo "Ir para" existe sem snapshot e a busca olha a descrição da página, sem acento.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const UI = join(import.meta.dir, "../../../kit/panel/ui");
const read = (rel: string): string => readFileSync(join(UI, rel), "utf8");
const palette = (): string => {
  const app = read("app.tsx");
  const start = app.indexOf("function CommandPalette(");
  return app.slice(start, app.indexOf("\n}\n", start));
};

describe("paleta Ctrl+K do painel", () => {
  test("dado snapshot ausente, então só Ambiente e Serviços somem; Ir para continua", () => {
    const src = palette();
    expect(src).not.toContain("if (!d) return []");
    expect(src).toContain("...(d ? [");
    expect(src).toContain("(d?.services ?? [])");
    expect(src.indexOf("group: 'Ir para'")).toBeLessThan(src.indexOf("...(d ? ["));
  });
  test("dado uma busca, então casa grupo, rótulo e descrição da página, sem acento e por todos os termos", () => {
    const src = palette();
    expect(src).toContain("desc: n.desc");
    expect(src).toContain("cfgNorm(`${i.group} ${i.label} ${i.desc ?? ''}`)");
    expect(src).toContain("terms.every((t) => hay.includes(t))");
  });
  test("dado o Argos, então a paleta própria recebe a descrição de cada página", () => {
    expect(read("pages/argos.tsx")).toContain("({ id: n.id, label: n.label, desc: n.desc })");
  });
  test("dadas as páginas citadas na issue, então a descrição tem a palavra que se busca", () => {
    const app = read("app.tsx");
    const desc = (id: string): string => app.match(new RegExp(`\\{ id: '${id}'[^\\n]*desc: '([^']*)'`))?.[1] ?? "";
    expect(desc("thanatos").toLowerCase()).toContain("post-mortem");
    expect(desc("usage").toLowerCase()).toContain("tokens");
    expect(desc("remote")).toContain("túnel");
  });
});
