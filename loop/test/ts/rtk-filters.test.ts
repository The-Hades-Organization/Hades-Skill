// Grupo rtk-filters: os rtk-filters.toml entregues nas stacks (regra do corte anunciado), o validador de arquivo de filtros,
// a política recomendada ao doctor e o campo rtk.filters do perfil. reference/rtk.md.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { announcementProblems, filterBlocks, filterFileProblems, policyAdvice, type FilterDef } from "../../../src/lib/rtk-filters";
import { validateFile } from "../../../src/lib/validate";
import { SKILL } from "./lib/rig";
import { OMIT_NOTICE, applyRtkFilter, matches } from "./lib/rtk-sim";

const STACKS = ["node-nx", "pnpm-next", "rust-cargo", "tauri"];
const COMMANDS: Record<string, string> = {
  "node-nx-nx": "npx nx build app",
  "node-nx-jest": "jest --ci",
  "pnpm-next-exec": "pnpm exec jest",
  "pnpm-next-script": "pnpm run lint",
  "rust-cargo-extra": "cargo run --release",
  "tauri-build": "pnpm tauri build",
};
const ESC = String.fromCharCode(27);
/** Soma de head_lines e tail_lines dos filtros entregues: até aqui o rtk não corta. */
const CAP = 300;

const tomlOf = (stack: string): Promise<string> => Bun.file(join(SKILL, "stacks", stack, "rtk-filters.toml")).text();
const loadFilters = async (stack: string): Promise<Record<string, FilterDef>> =>
  (Bun.TOML.parse(await tomlOf(stack)) as { filters: Record<string, FilterDef> }).filters;

/** Linhas com conteúdo que o terminal mostraria: sem ANSI, redesenho de progresso (\r) reduzido ao último trecho, sem linha em branco. */
function visibleContent(output: string): string[] {
  return output
    .split("\n")
    .map((l) => l.replace(new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g"), ""))
    .map((l) => (l.includes("\r") ? (l.split("\r").filter((s) => s !== "").pop() ?? "") : l))
    .filter((l) => l.trim() !== "");
}

/** Linhas com conteúdo que sumiram sem o anúncio do rtk: vazio = o corte se anunciou (reference/rtk.md §O corte se anuncia). */
function unannouncedLoss(input: string, filtered: string): number {
  const kept = filtered.split("\n").filter((l) => !OMIT_NOTICE.test(l));
  const announced = filtered.split("\n").reduce((sum, l) => sum + Number(OMIT_NOTICE.exec(l)?.[1] ?? 0), 0);
  return visibleContent(input).length - kept.filter((l) => l.trim() !== "").length - announced;
}

const noisy = (lines: number): string =>
  Array.from({ length: lines }, (_, i) => `${ESC}[32m  compilando módulo ${i}\r  compilando módulo ${i} ok${ESC}[0m\n`).join("\n");

describe("rtk-filters: filtros entregues nas stacks", () => {
  test("cada stack com filtro entrega um arquivo válido para o rtk (chaves reais, sem corte mudo)", async () => {
    for (const stack of STACKS) expect({ stack, problems: filterFileProblems(await tomlOf(stack)) }).toEqual({ stack, problems: [] });
  });

  test("todo filtro entregue tem um comando de amostra neste teste (filtro novo exige amostra)", async () => {
    const names = (await Promise.all(STACKS.map(loadFilters))).flatMap((f) => Object.keys(f)).sort();
    expect(names).toEqual(Object.keys(COMMANDS).sort());
  });

  for (const stack of STACKS) {
    test(`${stack}: nenhuma linha com conteúdo some sem anúncio, com saída curta e longa`, async () => {
      for (const [name, def] of Object.entries(await loadFilters(stack))) {
        const command = COMMANDS[name] as string;
        expect(matches(def, command)).toBe(true);
        for (const size of [1, 20, CAP, CAP + 1, 1000]) {
          const input = noisy(size);
          expect({ name, size, loss: unannouncedLoss(input, applyRtkFilter(def, input)) }).toEqual({ name, size, loss: 0 });
        }
      }
    });

    test(`${stack}: o N do anúncio é o número de linhas que o corte tirou`, async () => {
      for (const [name, def] of Object.entries(await loadFilters(stack))) {
        const out = applyRtkFilter(def, noisy(1000)).split("\n");
        const notices = out.filter((l) => OMIT_NOTICE.test(l));
        const kept = out.length - notices.length;
        expect({ name, notices: notices.length }).toEqual({ name, notices: 1 });
        expect(Number(OMIT_NOTICE.exec(notices[0] as string)?.[1])).toBe(1000 - kept);
      }
    });

    test(`${stack}: saída dentro do teto não leva anúncio e as linhas em branco saem`, async () => {
      for (const def of Object.values(await loadFilters(stack))) {
        const out = applyRtkFilter(def, "a\n\n\nb\n   \nc");
        expect(out).toBe("a\nb\nc");
      }
    });
  }

  test("o simulador acusa filtro que descarta linha com conteúdo sem anunciar", () => {
    const leaky: FilterDef = { match_command: "^x", strip_lines_matching: ["^warning"] };
    const input = "ok\nwarning: um\nwarning: dois\nfim";
    expect(unannouncedLoss(input, applyRtkFilter(leaky, input))).toBe(2);
  });
});

describe("rtk-filters: filterFileProblems (a regra vale para o arquivo do plugin também)", () => {
  const file = (body: string): string => `schema_version = 1\n\n[filters.f]\nmatch_command = '^x'\n${body}\n`;

  test("rejeita strip_lines_matching de linha com conteúdo", () => {
    expect(filterFileProblems(file("strip_lines_matching = ['^Compiling']"))).toEqual([
      "[filters.f]: strip_lines_matching '^Compiling' descarta linha com conteúdo sem anúncio",
    ]);
  });

  test("aceita strip só de linha em branco", () => {
    for (const blank of ["^\\s*$", "^$", "^\\s+$"]) expect(filterFileProblems(file(`strip_lines_matching = ['${blank}']`))).toEqual([]);
  });

  test("rejeita keep_lines_matching e match_output (descartam sem contar)", () => {
    expect(filterFileProblems(file("keep_lines_matching = ['^error']")).join("|")).toContain("keep_lines_matching");
    expect(filterFileProblems(file("match_output = [{ pattern = 'x', message = 'm' }]")).join("|")).toContain("match_output");
  });

  test("rejeita chave desconhecida do rtk, comando ausente e filtro repetido", () => {
    expect(filterFileProblems(file("strip_everything = true")).join("|")).toContain("chave 'strip_everything' desconhecida");
    expect(filterFileProblems("schema_version = 1\n[filters.f]\nstrip_ansi = true\n")).toContain("[filters.f]: falta match_command");
    expect(filterFileProblems(`${file("")}\n[filters.f]\nmatch_command = '^y'\n`)[0]).toContain("Cannot redefine table 'f'");
  });

  test("rejeita TOML quebrado, schema_version ausente e chave de topo estranha", () => {
    expect(filterFileProblems("[filters.f")[0]).toStartWith("TOML inválido");
    expect(filterFileProblems("[filters.f]\nmatch_command = '^x'\n")).toContain("schema_version = 1 é obrigatório");
    expect(filterFileProblems(`${file("")}\n[extra]\nx = 1\n`)).toContain("chave 'extra' fora do formato do rtk");
  });

  test("announcementProblems: lista vazia de keep e match_output não é problema", () => {
    expect(announcementProblems("f", { keep_lines_matching: [], match_output: [] })).toEqual([]);
  });

  test("filterBlocks separa os [filters.*] e deixa o cabeçalho e os [[tests.*]] de fora", () => {
    const blocks = filterBlocks("s", "# cabeçalho\nschema_version = 1\n\n[filters.a]\nmatch_command = '^a'\n\n[filters.b]\nmatch_command = '^b'\n\n[[tests.a]]\nname = 't'\n");
    expect(blocks.map((b) => [b.stack, b.name, b.text])).toEqual([
      ["s", "a", "[filters.a]\nmatch_command = '^a'\n"],
      ["s", "b", "[filters.b]\nmatch_command = '^b'\n"],
    ]);
  });
});

describe("rtk-filters: policyAdvice (recomendação do doctor, só lê)", () => {
  const tuned = { hooks: { exclude_commands: ["diff", "ps -p"] }, limits: { grep_max_results: 1000, grep_max_per_file: 100 }, display: { max_width: 240 } };

  test("política ajustada em 1.x não gera recomendação", () => {
    expect(policyAdvice({ ...tuned, retriever: { mode: "sqlite" } }, "1.1.0")).toEqual([]);
  });

  test("sem config.toml recomenda tudo: diff, ps -p, grep, largura", () => {
    const advice = policyAdvice(undefined, "1.1.0").join("\n");
    for (const part of ['"diff"', '"ps -p"', "grep_max_results", "grep_max_per_file", "max_width"]) expect(advice).toContain(part);
  });

  test("1.x: retriever desligado ou em tee sem tee_on_success é apontado", () => {
    expect(policyAdvice({ ...tuned, retriever: { mode: "disabled" } }, "1.1.0").join("|")).toContain("disabled");
    expect(policyAdvice({ ...tuned, retriever: { mode: "tee" } }, "1.1.0").join("|")).toContain("tee_on_success");
    expect(policyAdvice({ ...tuned, retriever: { mode: "tee", tee_on_success: true } }, "1.1.0")).toEqual([]);
  });

  test("0.x: [tee] mode = always é a recomendação; em 1.x ela não aparece", () => {
    expect(policyAdvice(tuned, "0.43.0").join("|")).toContain('[tee] mode = "always"');
    expect(policyAdvice({ ...tuned, tee: { mode: "always" } }, "0.43.0")).toEqual([]);
    expect(policyAdvice(tuned, "1.1.0").join("|")).not.toContain("[tee]");
  });

  test("versão desconhecida não recomenda a chave de nenhuma geração", () => {
    expect(policyAdvice(tuned, "")).toEqual([]);
  });
});

describe("rtk-filters: campo rtk.filters do perfil (project validate)", () => {
  const T = mkdtempSync(join(tmpdir(), "hades-rtk-profile-"));
  const pack = join(T, "meu-projeto");
  mkdirSync(pack, { recursive: true });
  const profile = (rtk: unknown): string => {
    const path = join(pack, "profile.json");
    writeFileSync(path, JSON.stringify({ schema: "hades.profile/1", name: "meu-projeto", identity: { repo: "acme/meu-projeto" }, flow: { kind: "pr", base: "develop" }, rtk }, null, 2));
    return path;
  };
  const good = "schema_version = 1\n\n[filters.meu]\nmatch_command = '^make\\b'\nstrip_ansi = true\nhead_lines = 50\ntail_lines = 50\n";

  test("arquivo do pacote com filtro válido passa", () => {
    writeFileSync(join(pack, "rtk-filters.toml"), good);
    expect(validateFile(profile({ filters: "rtk-filters.toml" }))).toEqual([]);
  });

  test("arquivo ausente ou fora do pacote reprova", () => {
    expect(validateFile(profile({ filters: "nao-existe.toml" }))).toEqual(["$.rtk.filters: 'nao-existe.toml' não é arquivo do pacote"]);
    writeFileSync(join(T, "fora.toml"), good);
    expect(validateFile(profile({ filters: "../fora.toml" }))).toEqual(["$.rtk.filters: '../fora.toml' não é arquivo do pacote"]);
  });

  test("filtro do plugin que descarta sem anunciar reprova com a razão", () => {
    writeFileSync(join(pack, "rtk-filters.toml"), good.replace("strip_ansi = true", "strip_lines_matching = ['^make']"));
    expect(validateFile(profile({ filters: "rtk-filters.toml" }))).toEqual([
      "$.rtk.filters: [filters.meu]: strip_lines_matching '^make' descarta linha com conteúdo sem anúncio",
    ]);
  });

  test("chave desconhecida dentro de rtk reprova pelo esquema", () => {
    writeFileSync(join(pack, "rtk-filters.toml"), good);
    expect(validateFile(profile({ filters: "rtk-filters.toml", extra: 1 })).join("|")).toContain("rtk");
  });

  afterAll(() => rmSync(T, { recursive: true, force: true }));
});
