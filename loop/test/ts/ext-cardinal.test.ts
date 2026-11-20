// Extensão cardinal (U6): manifesto embutido, os quatro problemas do doctor com binário falso e o motor de desenho efetivo.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardinalWebItem } from "../../../src/lib/doctor-ext";
import { drawingEngine, ENGINE_REASONS, judgeEngine, webBuildPresent } from "../../../src/lib/drawing-engine";
import { EXT_ERRORS } from "../../../src/lib/extension-manifest";
import { loadManifests, statusOf, type ExtensionDeps, type ExtensionStatus } from "../../../src/lib/extension";
import { visibleItems } from "../../../src/panel/routes-core";
import type { Effective } from "../../../src/lib/config-catalog";
import { run, which } from "../../../src/lib/proc";

const manifest = (() => {
  const found = loadManifests().extensions.find((e) => e.manifest.name === "cardinal");
  if (found === undefined) throw new Error("manifesto do cardinal não carregou");
  return found.manifest;
})();

describe("manifesto embutido", () => {
  test("declara capacidade, versão, saúde e as três chaves", () => {
    expect(manifest.capabilities).toEqual(["canvas.diagram"]);
    expect(manifest.version).toEqual({ command: ["cardinal", "--version"], min: "0.1.0" });
    expect(manifest.health).toEqual({ command: ["cardinal", "--check"] });
    expect(manifest.configKeys).toEqual(["HADES_CARDINAL_BIN", "HADES_CARDINAL_WEB", "HADES_DRAWING_ENGINE"]);
    expect(manifest.binary.configKey).toBe("HADES_CARDINAL_BIN");
  });
});

describe("doctor com binário falso", () => {
  let bin: string;
  const fake = (script: string): void => {
    writeFileSync(join(bin, "cardinal"), `#!/bin/sh\n${script}\n`);
    chmodSync(join(bin, "cardinal"), 0o755);
  };
  const deps = (config: Record<string, string> = {}): ExtensionDeps => ({
    config: new Map(Object.entries(config)),
    which: (c) => which(c, bin),
    run: (c, a) => run(c, a, { timeoutMs: 5000 }),
  });
  beforeAll(() => void (bin = mkdtempSync(join(tmpdir(), "cardinal-bin-"))));
  afterAll(() => rmSync(bin, { recursive: true, force: true }));

  test("não existe: ext.binary-missing", () => {
    const s = statusOf(manifest, deps());
    expect(s.installed).toBe(false);
    expect(s.problems.map((p) => p.code)).toEqual([EXT_ERRORS.binaryMissing]);
  });
  test("versão baixa: ext.version-below-min", () => {
    fake('case "$1" in --version) echo "cardinal 0.0.9 (format 2)";; *) echo ok;; esac');
    expect(statusOf(manifest, deps()).problems.map((p) => p.code)).toEqual([EXT_ERRORS.versionBelowMin]);
  });
  test("responde sem versão: ext.version-unreadable", () => {
    fake("echo sem-numero");
    expect(statusOf(manifest, deps()).problems.map((p) => p.code)).toEqual([EXT_ERRORS.versionUnreadable]);
  });
  test("falha no --check: ext.health-failed", () => {
    fake('case "$1" in --version) echo "cardinal 0.1.0 (format 2)";; *) exit 3;; esac');
    expect(statusOf(manifest, deps()).problems.map((p) => p.code)).toEqual([EXT_ERRORS.healthFailed]);
  });
  test("saudável: formato `cardinal 0.1.0 (format 2)`", () => {
    fake('case "$1" in --version) echo "cardinal 0.1.0 (format 2)";; *) echo ok;; esac');
    expect(statusOf(manifest, deps())).toMatchObject({ installed: true, version: "0.1.0", problems: [] });
  });
  test("HADES_CARDINAL_BIN aponta o binário fora do PATH", () => {
    const s = statusOf(manifest, { ...deps({ HADES_CARDINAL_BIN: join(bin, "cardinal") }), which: () => undefined });
    expect(s.installed).toBe(true);
  });
  test("linha do build web", () => {
    expect(cardinalWebItem("", () => false)).toMatchObject({ level: "ok" });
    expect(cardinalWebItem("/x/dist", () => true)).toMatchObject({ level: "ok" });
    expect(cardinalWebItem("/x/dist", () => false)).toMatchObject({ level: "warn", id: "ext-cardinal-web" });
  });
});

describe("motor efetivo", () => {
  const status = (patch: Partial<ExtensionStatus> = {}): ExtensionStatus => ({
    name: "cardinal", description: "", capabilities: [], enabled: true, installed: true, path: "/bin/cardinal", version: "0.1.0", minVersion: "0.1.0",
    problems: [], install: "", configKeys: [], enableKey: "HADES_EXT_CARDINAL", ...patch,
  });
  const cfg = (engine?: string): Map<string, string> => new Map(engine === undefined ? [] : [["HADES_DRAWING_ENGINE", engine]]);
  const missing = { code: EXT_ERRORS.binaryMissing, field: "binary.names", message: "binário não encontrado" };

  test("padrão é cardinal quando a extensão está saudável", () => {
    expect(judgeEngine(cfg(), status(), false)).toMatchObject({ configured: "cardinal", effective: "cardinal", usable: true, reason: null });
  });
  test("padrão sem a extensão utilizável cai para hades", () => {
    expect(judgeEngine(cfg(), status({ enabled: false }), false)).toMatchObject({ configured: "cardinal", effective: "hades", usable: false });
  });
  test("hades explícito mantém o Desenho antigo", () => {
    expect(judgeEngine(cfg("hades"), status(), true)).toMatchObject({ configured: "hades", effective: "hades", usable: true });
  });
  test("cardinal configurado e saudável vale", () => {
    expect(judgeEngine(cfg("cardinal"), status(), false)).toMatchObject({ effective: "cardinal", usable: true });
  });
  test("valor desconhecido cai no padrão", () => expect(judgeEngine(cfg("outro"), status(), false).configured).toBe("cardinal"));
  test("extensão desligada: cai para hades com a razão", () => {
    const v = judgeEngine(cfg("cardinal"), status({ enabled: false }), true);
    expect(v).toMatchObject({ effective: "hades", usable: false });
    expect(v.reason?.code).toBe(ENGINE_REASONS.extensionOff);
  });
  test("manifesto ausente", () => {
    expect(judgeEngine(cfg("cardinal"), undefined, true).reason?.code).toBe(ENGINE_REASONS.extensionMissing);
  });
  test("binário ausente e sem build web: razão é a do doctor", () => {
    const v = judgeEngine(cfg("cardinal"), status({ installed: false, path: null, version: null, problems: [missing] }), false);
    expect(v).toMatchObject({ effective: "hades" });
    expect(v.reason?.code).toBe(EXT_ERRORS.binaryMissing);
  });
  test("versão antiga: razão ext.version-below-min", () => {
    const old = { code: EXT_ERRORS.versionBelowMin, field: "version.min", message: "versão 0.0.9 abaixo da mínima 0.1.0" };
    expect(judgeEngine(cfg("cardinal"), status({ version: "0.0.9", problems: [old] }), false).reason?.code).toBe(EXT_ERRORS.versionBelowMin);
  });
  test("sem binário, mas com build web: o Cardinal vale (editor e agente são dependências separadas)", () => {
    const v = judgeEngine(cfg("cardinal"), status({ installed: false, path: null, version: null, problems: [missing] }), true);
    expect(v).toMatchObject({ effective: "cardinal", usable: true });
  });

  test("drawingEngine mede a extensão real com dependências injetadas", () => {
    const deps: ExtensionDeps = {
      config: cfg("cardinal"),
      which: () => undefined,
      run: () => ({ status: 1, stdout: "", stderr: "", timedOut: false }),
    };
    expect(drawingEngine(deps, () => false)).toMatchObject({ configured: "cardinal", effective: "hades" });
    expect(drawingEngine(deps, () => true)).toMatchObject({ effective: "cardinal" });
    const off = new Map(deps.config).set("HADES_EXT_CARDINAL", "0");
    expect(drawingEngine({ ...deps, config: off }, () => true).reason?.code).toBe(ENGINE_REASONS.extensionOff);
  });
  test("build web: precisa do index.html", () => {
    const dir = mkdtempSync(join(tmpdir(), "cardinal-web-"));
    expect(webBuildPresent(dir)).toBe(false);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), "<html></html>");
    expect(webBuildPresent(dir)).toBe(true);
    expect(webBuildPresent("")).toBe(false);
    expect(webBuildPresent(undefined)).toBe(false);
    rmSync(dir, { recursive: true });
  });
});

describe("seletor nas Configurações", () => {
  const item = (key: string, changed = false): Effective => ({ key, default: "hades", type: "enum:hades,cardinal", group: "Extensões", label: key, apply: "next", desc: "", value: changed ? "cardinal" : "hades", changed });
  const view = (usable: boolean) => ({ configured: "hades" as const, effective: "hades" as const, usable, reason: null });
  const keys = (engine: ReturnType<typeof view>, changed = false): string[] => visibleItems([item("HADES_CARDINAL_BIN"), item("HADES_DRAWING_ENGINE", changed)], engine).map((i) => i.key);

  test("some sem a extensão saudável, as outras chaves ficam", () => expect(keys(view(false))).toEqual(["HADES_CARDINAL_BIN"]));
  test("aparece com a extensão saudável", () => expect(keys(view(true))).toEqual(["HADES_CARDINAL_BIN", "HADES_DRAWING_ENGINE"]));
  test("já alterado continua visível, para o dono poder voltar", () => expect(keys(view(false), true)).toContain("HADES_DRAWING_ENGINE"));
});
