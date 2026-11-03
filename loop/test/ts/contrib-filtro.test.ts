// Grupo contrib-filtro: o que de um diff de evolução da skill pode voltar ao repositório dela (só o núcleo).
import { describe, expect, test } from "bun:test";
import { parseDiff, splitCore, diffText } from "../../../src/lib/contrib-diff";
import { edita, novo, renomeia } from "./lib/contrib-amostra";

const NUCLEO = novo("kit/contrib/modelo.html", ["a", "b"]) + edita("src/lib/x.ts", 10, "velho", "novo") + edita("SKILL.md", 5, "x", "y")
  + novo("reference/y.md", ["z"]) + novo("loop/bin/w.sh", ["w"]);

describe("contrib-filtro", () => {
  test("lê caminho, linhas postas (com o número no arquivo novo) e contagem de cada arquivo", () => {
    const [kit, src] = parseDiff(NUCLEO);
    expect(kit?.path).toBe("kit/contrib/modelo.html");
    expect(kit?.plus).toBe(2);
    expect(src?.added).toEqual([{ line: 11, text: "novo" }]);
    expect(src?.minus).toBe(1);
  });

  test("só núcleo (kit, src, reference, loop, SKILL.md): tudo entra e nada fica de fora", () => {
    const s = splitCore(parseDiff(NUCLEO));
    expect(s.core.map((f) => f.path)).toEqual(["kit/contrib/modelo.html", "src/lib/x.ts", "SKILL.md", "reference/y.md", "loop/bin/w.sh"]);
    expect(s.left).toEqual([]);
  });

  test("diff misto: o núcleo entra e o resto fica de fora com o motivo", () => {
    const s = splitCore(parseDiff(NUCLEO + novo("packs/acme/profile.json", ["{}"]) + edita("env/up.sh", 1, "a", "b")
      + edita("README.md", 1, "a", "b") + edita("VERSION", 1, "5.1.0", "5.2.0")));
    expect(s.core).toHaveLength(5);
    expect(s.left.map((l) => l.path)).toEqual(["packs/acme/profile.json", "env/up.sh", "README.md", "VERSION"]);
    expect(s.left[0]?.reason).toContain("pacote de projeto");
    expect(s.left[1]?.reason).toContain("pacote de projeto");
    expect(s.left[2]?.reason).toContain("fora do núcleo");
  });

  test("só pacote de projeto: nada a sugerir", () => {
    const s = splitCore(parseDiff(novo("packs/acme/env/a.sh", ["a"]) + novo("env/b.sh", ["b"])));
    expect(s.core).toEqual([]);
    expect(s.left).toHaveLength(2);
  });

  test("diff vazio: nada a sugerir", () => {
    expect(splitCore(parseDiff("")).core).toEqual([]);
  });

  test("renomear do núcleo para fora (ou o contrário) não entra", () => {
    const s = splitCore(parseDiff(renomeia("kit/a.sh", "packs/acme/a.sh") + renomeia("env/b.sh", "kit/b.sh") + renomeia("kit/c.sh", "kit/d.sh")));
    expect(s.core.map((f) => f.path)).toEqual(["kit/d.sh"]);
    expect(s.left.map((l) => l.path)).toEqual(["packs/acme/a.sh", "kit/b.sh"]);
  });

  test("prefixo parecido não é núcleo (kitchen/, srcs/, SKILL.md.bak)", () => {
    const s = splitCore(parseDiff(novo("kitchen/a", ["a"]) + novo("srcs/b", ["b"]) + novo("SKILL.md.bak", ["c"])));
    expect(s.core).toEqual([]);
  });

  test("o texto do núcleo reconstrói só os arquivos que entraram", () => {
    const s = splitCore(parseDiff(NUCLEO + novo("packs/acme/profile.json", ["{}"])));
    const texto = diffText(s.core);
    expect(texto).toContain("diff --git a/src/lib/x.ts b/src/lib/x.ts");
    expect(texto).not.toContain("packs/");
  });
});
