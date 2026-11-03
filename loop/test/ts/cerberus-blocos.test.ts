// Blocos das cabeças na página Cerberus: a UI os escreve em .tsx e o painel serve <cabeça>.js a partir deles, então a
// descoberta aceita os dois; e a UI que a skill entrega tem bloco de cada cabeça.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cerberusBlocks } from "../../../src/panel/routes-core";
import { SKILL } from "./lib/rig";

const T = mkdtempSync(join(tmpdir(), "hades-cerberus-blocos-"));
afterAll(() => rmSync(T, { recursive: true, force: true }));

test("bloco em .tsx ou .js conta; outro arquivo não", () => {
  mkdirSync(join(T, "cerberus"));
  writeFileSync(join(T, "cerberus", "porta.tsx"), "");
  writeFileSync(join(T, "cerberus", "vigilia.js"), "");
  writeFileSync(join(T, "cerberus", "limiar.css"), "");
  expect(cerberusBlocks(T).sort()).toEqual(["porta", "vigilia"]);
});

test("a UI da skill tem bloco das três cabeças", () => {
  expect(cerberusBlocks(join(SKILL, "kit", "panel", "ui")).sort()).toEqual(["limiar", "porta", "vigilia"]);
});
