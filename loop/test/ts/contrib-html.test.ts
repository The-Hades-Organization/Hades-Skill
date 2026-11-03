// Grupo contrib-html: o arquivo do caminho "sem acesso" é autocontido (sem script, sem recurso externo), claro/escuro, com o
// diff embutido e escapado.
import { describe, expect, test } from "bun:test";
import { parseDiff, diffText } from "../../../src/lib/contrib-diff";
import { loadTemplate, renderContribHtml } from "../../../src/lib/contrib-html";
import { edita, novo } from "./lib/contrib-amostra";

const DIFF = novo("kit/contrib/a.sh", ["if [[ $a < $b && $c > 1 ]]; then echo \"<b>x</b>\"; fi"]) + edita("src/lib/b.ts", 3, "const a = 1;", "const a: Array<string> = [];")
  + novo("reference/c.md", ["texto"]);
const files = parseDiff(DIFF);
const c = { title: "feat: contrib <novo> & cia", what: "O que é & como", why: "Por quê <b>", gains: "Ganho 1\nGanho 2", proof: "bun test ok", files, diff: diffText(files), left: [{ path: "packs/x/y", reason: "pacote de projeto" }], repo: "Dono/Skill", version: "5.1.0" };
const html = renderContribHtml(loadTemplate(), c);

describe("contrib-html", () => {
  test("sem script, sem recurso externo e sem URL", () => {
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/<link|<img|<iframe|<object|<embed|@import|url\(|\ssrc=|\shref=/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });

  test("o diff entra escapado (< > & aspas) e nada dele vira marcação", () => {
    expect(html).toContain("$a &lt; $b &amp;&amp; $c &gt; 1");
    expect(html).toContain("echo &quot;&lt;b&gt;x&lt;/b&gt;&quot;");
    expect(html).toContain("Array&lt;string&gt;");
    expect(html).not.toContain("<b>x</b>");
  });

  test("título, o quê e por quê também são escapados", () => {
    expect(html).toContain("feat: contrib &lt;novo&gt; &amp; cia");
    expect(html).toContain("Por quê &lt;b&gt;");
    expect(html).not.toContain("<b>");
  });

  test("claro e escuro pelo esquema do sistema, com fundo explícito", () => {
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toMatch(/body\s*\{[^}]*background/);
  });

  test("lista os arquivos tocados, o que ficou de fora e os ganhos", () => {
    for (const p of ["kit/contrib/a.sh", "src/lib/b.ts", "reference/c.md"]) expect(html).toContain(p);
    expect(html).toContain("packs/x/y");
    expect(html).toContain("Ganho 1");
    expect(html).toContain("Ganho 2");
  });

  test("o diagrama em SVG inline aparece quando o diff toca mais de uma área", () => {
    expect(html).toContain("<svg");
    expect(html).toContain("kit");
    expect(html).toContain("src");
  });

  test("uma área só: sem diagrama", () => {
    const f = parseDiff(novo("src/a.ts", ["a"]));
    expect(renderContribHtml(loadTemplate(), { ...c, files: f, diff: diffText(f) })).not.toContain("<svg");
  });

  test("bloco de linhas com `- ` vira lista, sem o marcador", () => {
    const h = renderContribHtml(loadTemplate(), { ...c, what: "- primeiro\n- segundo <i>" });
    expect(h).toContain("<li>primeiro</li><li>segundo &lt;i&gt;</li>");
  });

  test("viewport e charset para abrir no celular", () => {
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain("viewport");
  });
});
