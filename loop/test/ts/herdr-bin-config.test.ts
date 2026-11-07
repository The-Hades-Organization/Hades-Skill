// HADES_HERDR_BIN: a validação na subida do binário do herdr que o painel chama (src/lib/config.ts resolveHerdrBin).
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERDR_BIN_DEFAULT, resolveHerdrBin } from "../../../src/lib/config";

const T = mkdtempSync(join(tmpdir(), "hades-herdr-bin-"));
afterAll(() => rmSync(T, { recursive: true, force: true }));
const exe = join(T, "herdr-fork");
const plain = join(T, "texto");
writeFileSync(exe, "#!/bin/sh\n");
chmodSync(exe, 0o755);
writeFileSync(plain, "x");
chmodSync(plain, 0o644);

describe("resolveHerdrBin", () => {
  test("dado vazio ou ausente, então vale o herdr do PATH", () => {
    expect(resolveHerdrBin(undefined)).toBe(HERDR_BIN_DEFAULT);
    expect(resolveHerdrBin("")).toBe("herdr");
    expect(resolveHerdrBin("   ")).toBe("herdr");
  });

  test("dado caminho absoluto executável, então é aceito como está", () => {
    expect(resolveHerdrBin(exe)).toBe(exe);
  });

  test("dado ~/ no começo, então expande pelo HOME informado", () => {
    expect(resolveHerdrBin("~/herdr-fork", T)).toBe(join(T, "herdr-fork"));
  });

  test("dado caminho absoluto que não existe, não é executável ou é diretório, então recusa com a chave na mensagem", () => {
    for (const bad of [join(T, "nao-existe"), plain, T]) expect(() => resolveHerdrBin(bad)).toThrow(/HADES_HERDR_BIN/);
  });

  test("dado nome simples, então passa; relativo, com espaço ou com .., então recusa", () => {
    expect(resolveHerdrBin("herdr-0.9")).toBe("herdr-0.9");
    for (const bad of ["./herdr", "../herdr", "bin/herdr", "meu herdr", "-x", "a;b"]) expect(() => resolveHerdrBin(bad)).toThrow(/HADES_HERDR_BIN inválido/);
  });
});
