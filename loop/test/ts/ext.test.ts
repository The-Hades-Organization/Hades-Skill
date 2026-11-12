// Grupo ext: manifesto de extensão (validação, carga dos embutidos), estado ligado/desligado, CLI `hades ext` e a linha do
// doctor, com binário falso numa pasta temporária (nada do herdr ou do Mark reais).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { extensionDoctorItems, judgeExtension } from "../../../src/lib/doctor-ext";
import { compareVersions, EXT_ERRORS, extractVersion, parseManifest } from "../../../src/lib/extension-manifest";
import { isEnabled, loadManifests, statusOf, type ExtensionDeps } from "../../../src/lib/extension";
import { run, which } from "../../../src/lib/proc";

const ROOT = join(import.meta.dir, "..", "..", "..");
const CLI = join(ROOT, "src", "cli.ts");

const good = (): Record<string, unknown> => ({
  schema: 1,
  name: "demo",
  description: "Ferramenta de exemplo.",
  binary: { names: ["demo-bin"] },
  version: { command: ["demo-bin", "--version"], min: "1.2.0" },
  capabilities: ["voice"],
  install: { text: "instale o demo" },
  health: { command: ["demo-bin", "--version"] },
  configKeys: ["HADES_DEMO_X"],
  enableKey: "HADES_EXT_DEMO",
});
const codesOf = (raw: unknown): string[] => {
  const r = parseManifest(raw);
  return r.ok ? [] : r.errors.map((e) => `${e.code}@${e.field}`);
};
const withField = (patch: Record<string, unknown>): Record<string, unknown> => ({ ...good(), ...patch });

describe("validação do manifesto", () => {
  test("manifesto bom é aceito", () => expect(parseManifest(good()).ok).toBe(true));
  test("não objeto: erro do arquivo", () => expect(codesOf([])).toEqual([`${EXT_ERRORS.notObject}@`]));
  for (const field of ["name", "description", "binary", "version", "capabilities", "install", "health", "configKeys", "enableKey"]) {
    test(`campo ausente: ${field}`, () => {
      const m = good();
      delete m[field];
      expect(codesOf(m)).toContain(`${EXT_ERRORS.fieldMissing}@${field}`);
    });
  }
  test("tipo errado leva o caminho do campo", () => {
    expect(codesOf(withField({ description: 3 }))).toEqual([`${EXT_ERRORS.fieldType}@description`]);
    expect(codesOf(withField({ binary: { names: "x" } }))).toEqual([`${EXT_ERRORS.fieldType}@binary.names`]);
  });
  test("capacidade desconhecida aponta o índice", () => {
    expect(codesOf(withField({ capabilities: ["voice", "teleporte"] }))).toEqual([`${EXT_ERRORS.capabilityUnknown}@capabilities[1]`]);
  });
  test("lista de capacidades vazia é recusada", () => expect(codesOf(withField({ capabilities: [] }))).toEqual([`${EXT_ERRORS.fieldValue}@capabilities`]));
  test("schema que a skill não conhece", () => expect(codesOf(withField({ schema: 2 }))).toEqual([`${EXT_ERRORS.schemaUnsupported}@schema`]));
  test("comando de versão tem de começar por um binário declarado", () => {
    expect(codesOf(withField({ version: { command: ["outro", "--version"], min: "1.0.0" } }))).toEqual([`${EXT_ERRORS.fieldValue}@version.command[0]`]);
  });
  test("versão mínima fora de x.y.z", () => expect(codesOf(withField({ version: { command: ["demo-bin"], min: "1.2" } }))).toEqual([`${EXT_ERRORS.fieldValue}@version.min`]));
  test("version e health aceitam null", () => expect(parseManifest(withField({ version: null, health: null })).ok).toBe(true));
  test("chave de configuração em minúsculas", () => expect(codesOf(withField({ configKeys: ["abc"] }))).toEqual([`${EXT_ERRORS.fieldValue}@configKeys[0]`]));
  test("os erros se acumulam, sem parar no primeiro", () => expect(codesOf(withField({ description: 1, enableKey: "x" })).length).toBe(2));
});

describe("versões", () => {
  test("extrai o primeiro x.y.z", () => expect(extractVersion("herdr 0.9.5 (build 2)")).toBe("0.9.5"));
  test("sem versão na saída", () => expect(extractVersion("sem numero")).toBeUndefined());
  test("compara numericamente, não por texto", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.2.0", "1.2.0")).toBe(0);
    expect(compareVersions("1.1.9", "1.2.0")).toBeLessThan(0);
  });
});

describe("manifestos embutidos", () => {
  const loaded = loadManifests();
  const catalog = readFileSync(join(ROOT, "kit", "config.tsv"), "utf8").split("\n").map((l) => l.split("\t")[0]);
  test("herdr e Mark carregam sem erro", () => {
    expect(loaded.broken).toEqual([]);
    expect(loaded.extensions.map((e) => e.manifest.name)).toEqual(["herdr", "mark"]);
  });
  test("capacidades declaradas", () => {
    const caps = Object.fromEntries(loaded.extensions.map((e) => [e.manifest.name, e.manifest.capabilities]));
    expect(caps).toEqual({ herdr: ["canvas.terminal"], mark: ["voice", "window"] });
  });
  test("chave de estado e chaves próprias existem no catálogo do kit", () => {
    for (const { manifest } of loaded.extensions) for (const key of [manifest.enableKey, ...manifest.configKeys]) expect(catalog).toContain(key);
  });
  test("o estado vem ligado por padrão", () => {
    const rows = readFileSync(join(ROOT, "kit", "config.tsv"), "utf8").split("\n").filter((l) => l.startsWith("HADES_EXT_"));
    for (const row of rows) expect(row.split("\t")[1]).toBe("1");
  });
  test("pasta com manifesto quebrado vira erro, sem derrubar as outras", () => {
    const root = mkdtempSync(join(tmpdir(), "ext-load-"));
    mkdirSync(join(root, "ruim"));
    writeFileSync(join(root, "ruim", "extension.json"), "{nao json");
    mkdirSync(join(root, "outro"));
    writeFileSync(join(root, "outro", "extension.json"), JSON.stringify(good()));
    mkdirSync(join(root, "sem-arquivo"));
    const r = loadManifests(root);
    rmSync(root, { recursive: true });
    expect(r.broken.map((b) => `${b.dir}:${b.errors[0]?.code}`)).toEqual([`outro:${EXT_ERRORS.nameMismatch}`, `ruim:${EXT_ERRORS.notJson}`, `sem-arquivo:${EXT_ERRORS.notJson}`]);
    expect(r.extensions).toEqual([]);
  });
});

describe("detecção, versão e saúde com binário falso", () => {
  let bin: string;
  const fake = (script: string): void => {
    writeFileSync(join(bin, "demo-bin"), `#!/bin/sh\n${script}\n`);
    chmodSync(join(bin, "demo-bin"), 0o755);
  };
  const depsFor = (config: Record<string, string> = {}): ExtensionDeps => ({
    config: new Map(Object.entries(config)),
    which: (c) => which(c, bin),
    run: (c, a) => run(c, a, { timeoutMs: 5000 }),
  });
  const manifest = (): ReturnType<typeof okManifest> => okManifest();
  function okManifest() {
    const r = parseManifest(good());
    if (!r.ok) throw new Error("manifesto de teste inválido");
    return r.manifest;
  }
  beforeAll(() => void (bin = mkdtempSync(join(tmpdir(), "ext-bin-"))));
  afterAll(() => rmSync(bin, { recursive: true, force: true }));

  test("binário ausente: ext.binary-missing, linha informa como instalar", () => {
    const s = statusOf(manifest(), depsFor());
    expect(s.installed).toBe(false);
    expect(s.problems[0]?.code).toBe(EXT_ERRORS.binaryMissing);
    expect(judgeExtension(s).msg).toContain("instale o demo");
  });
  test("binário presente e na versão certa: saudável", () => {
    fake('echo "demo 1.3.0"');
    const s = statusOf(manifest(), depsFor());
    expect(s).toMatchObject({ installed: true, version: "1.3.0", problems: [] });
    expect(judgeExtension(s)).toMatchObject({ level: "ok" });
    expect(judgeExtension(s).msg).toContain("saudável");
  });
  test("versão abaixo da mínima: aviso com a ação de atualizar", () => {
    fake('echo "demo 1.1.0"');
    const v = judgeExtension(statusOf(manifest(), depsFor()));
    expect(v.level).toBe("warn");
    expect(v.fix).toContain("instale o demo");
    expect(statusOf(manifest(), depsFor()).problems[0]?.code).toBe(EXT_ERRORS.versionBelowMin);
  });
  test("versão ilegível", () => {
    fake('echo "sem numero"');
    expect(statusOf(manifest(), depsFor()).problems[0]?.code).toBe(EXT_ERRORS.versionUnreadable);
  });
  test("binário que sai com erro: versão ilegível e saúde falha", () => {
    fake("exit 3");
    expect(statusOf(manifest(), depsFor()).problems.map((p) => p.code)).toEqual([EXT_ERRORS.versionUnreadable, EXT_ERRORS.healthFailed]);
  });
  test("estado: ligada salvo 0 explícito", () => {
    expect(isEnabled(manifest(), new Map())).toBe(true);
    expect(isEnabled(manifest(), new Map([["HADES_EXT_DEMO", "0"]]))).toBe(false);
    expect(judgeExtension(statusOf(manifest(), depsFor({ HADES_EXT_DEMO: "0" }))).msg).toContain("desligada");
  });
  test("o doctor entrega uma linha por extensão embutida", () => {
    const items = extensionDoctorItems(depsFor());
    expect(items.map((i) => i.id)).toEqual(["ext-herdr", "ext-mark"]);
    for (const i of items) expect(i.level).toBe("ok"); // ausente é opcional: não é aviso
  });
});

describe("CLI hades ext", () => {
  let data: string;
  let bin: string;
  const hades = (args: string[]): { status: number; out: string } => {
    const r = spawnSync(process.execPath, [CLI, "ext", ...args], {
      encoding: "utf8",
      // o ambiente vence o config.env: a release exporta HADES_EXT_* da instalação, então o teste as tira
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HADES_EXT_"))), HADES_DATA: data, PATH: `${bin}:${dirname(process.execPath)}`, HADES_HERDR_BIN: "" },
    });
    return { status: r.status ?? 1, out: r.stdout + r.stderr };
  };
  beforeAll(() => {
    data = mkdtempSync(join(tmpdir(), "ext-data-"));
    bin = mkdtempSync(join(tmpdir(), "ext-cli-bin-"));
    writeFileSync(join(bin, "herdr"), '#!/bin/sh\necho "herdr 0.9.5"\n');
    chmodSync(join(bin, "herdr"), 0o755);
  });
  afterAll(() => {
    rmSync(data, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  });

  test("list --json: contrato versionado, herdr instalado e Mark ausente", () => {
    const r = hades(["list", "--json"]);
    const doc = JSON.parse(r.out) as { version: number; extensions: { name: string; installed: boolean; enabled: boolean; version: string | null }[] };
    expect(doc.version).toBe(1);
    expect(doc.extensions.map((e) => [e.name, e.installed, e.enabled, e.version])).toEqual([["herdr", true, true, "0.9.5"], ["mark", false, true, null]]);
  });
  test("disable e enable gravam em config.env e o list acompanha", () => {
    expect(hades(["disable", "mark"]).status).toBe(0);
    expect(readFileSync(join(data, "config.env"), "utf8")).toContain("HADES_EXT_MARK=0");
    const off = JSON.parse(hades(["list", "--json"]).out) as { extensions: { name: string; enabled: boolean }[] };
    expect(off.extensions.find((e) => e.name === "mark")?.enabled).toBe(false);
    expect(hades(["enable", "mark"]).status).toBe(0);
    expect(readFileSync(join(data, "config.env"), "utf8")).not.toContain("HADES_EXT_MARK");
  });
  test("extensão desconhecida: código estável no --json", () => {
    const r = hades(["info", "nada", "--json"]);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, code: "ext.unknown" });
  });
  test("uso errado sai com 2", () => expect(hades(["info"]).status).toBe(2));
  test("doctor de uma extensão só", () => {
    const r = hades(["doctor", "herdr"]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("herdr: instalada 0.9.5, ligada, saudável");
    expect(r.out).not.toContain("mark");
  });
  test("info mostra o comando de instalação como texto", () => expect(hades(["info", "herdr"]).out).toContain("a Hades não executa"));
});
