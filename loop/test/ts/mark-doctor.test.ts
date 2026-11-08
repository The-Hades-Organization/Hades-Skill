// Grupo mark-doctor: o julgamento puro do item `mark-ponte` do doctor (src/lib/doctor-mark.ts) e a leitura do bridge.json
// (src/lib/mark-bridge.ts) que o alimenta, sem rede e sem processo real.
import { describe, expect, test } from "bun:test";
import { judgeMark } from "../../../src/lib/doctor-mark";
import { bridgePathOf, MARK_ERRORS, parseState, readBridge, type BridgeDeps, type BridgeRead } from "../../../src/lib/mark-bridge";

const STATE = parseState({ name: "Mark", state: "SLEEPING", speaking: false, muted: false, claude: { enabled: true, permission_mode: "plan" }, last_report: null });
const FOUND: BridgeRead = { ok: true, bridge: { port: 9000, token: "t", scheme: "http", pid: 4242 } };

const depsOf = (file: string | Error, alive = true): BridgeDeps => ({
  readFile: () => {
    if (file instanceof Error) throw file;
    return file;
  },
  size: () => (file instanceof Error ? 0 : file.length),
  alive: () => alive,
});
const errno = (code: string): Error => Object.assign(new Error(code), { code });

describe("julgamento do item mark-ponte", () => {
  test("dado o bridge.json ausente, é ok e não pede ação", () => {
    const verdict = judgeMark({ ok: false, cause: MARK_ERRORS.bridgeMissing }, undefined);
    expect(verdict.level).toBe("ok");
    expect(verdict.fix).toBeUndefined();
  });

  test.each([MARK_ERRORS.bridgeInvalid, MARK_ERRORS.processGone, MARK_ERRORS.unreachable, MARK_ERRORS.rejected, MARK_ERRORS.badResponse] as const)(
    "dada a causa %s, avisa com a ação que roda o mark",
    (cause) => {
      const verdict = judgeMark({ ok: false, cause }, undefined);
      expect(verdict.level).toBe("warn");
      expect(verdict.fix).toContain("mark");
    },
  );

  test("dado o Mark respondendo, é ok com o nome e o estado", () => {
    const verdict = judgeMark(FOUND, { kind: "answered", state: STATE as NonNullable<typeof STATE> });
    expect(verdict).toEqual({ level: "ok", msg: "Mark respondendo: Mark, SLEEPING" });
  });

  test("dado o token recusado, avisa com a ação", () => {
    const verdict = judgeMark(FOUND, { kind: "rejected" });
    expect(verdict.level).toBe("warn");
    expect(verdict.fix).toContain("mark");
  });

  test("dada a ponte encontrada sem resposta, avisa", () => {
    expect(judgeMark(FOUND, { kind: "unreachable" }).level).toBe("warn");
  });

  test("dado o --quick (sem sonda), é ok e diz que a resposta não foi conferida", () => {
    const verdict = judgeMark(FOUND, undefined);
    expect(verdict.level).toBe("ok");
    expect(verdict.msg).toContain("não conferida");
  });
});

describe("leitura do bridge.json", () => {
  const good = JSON.stringify({ port: 9000, token: "t", scheme: "https", pid: 4242 });

  test("dado um arquivo válido e o processo vivo, devolve a ponte", () => {
    expect(readBridge("/x", depsOf(good))).toEqual({ ok: true, bridge: { port: 9000, token: "t", scheme: "https", pid: 4242 } });
  });

  test("dado o processo morto, a causa é process_gone", () => {
    expect(readBridge("/x", depsOf(good, false))).toEqual({ ok: false, cause: MARK_ERRORS.processGone });
  });

  test("dado ENOENT ou ENOTDIR, a causa é bridge_missing; outro erro de leitura é bridge_invalid", () => {
    expect(readBridge("/x", depsOf(errno("ENOENT")))).toEqual({ ok: false, cause: MARK_ERRORS.bridgeMissing });
    expect(readBridge("/x", depsOf(errno("ENOTDIR")))).toEqual({ ok: false, cause: MARK_ERRORS.bridgeMissing });
    expect(readBridge("/x", depsOf(errno("EACCES")))).toEqual({ ok: false, cause: MARK_ERRORS.bridgeInvalid });
  });

  test.each([
    ["JSON quebrado", "{"],
    ["porta zero", JSON.stringify({ port: 0, token: "t", scheme: "http", pid: 1 })],
    ["porta acima do teto", JSON.stringify({ port: 70000, token: "t", scheme: "http", pid: 1 })],
    ["token vazio", JSON.stringify({ port: 9000, token: " ", scheme: "http", pid: 1 })],
    ["esquema desconhecido", JSON.stringify({ port: 9000, token: "t", scheme: "ftp", pid: 1 })],
    ["pid ausente", JSON.stringify({ port: 9000, token: "t", scheme: "http" })],
    ["não é objeto", "[]"],
  ])("dado %s, a causa é bridge_invalid", (_name, text) => {
    expect(readBridge("/x", depsOf(text))).toEqual({ ok: false, cause: MARK_ERRORS.bridgeInvalid });
  });

  test("dado um arquivo acima do teto de bytes, a causa é bridge_invalid", () => {
    expect(readBridge("/x", depsOf("x".repeat(5000)))).toEqual({ ok: false, cause: MARK_ERRORS.bridgeInvalid });
  });

  test("dado um host no arquivo, ele é ignorado: a URL usa sempre 127.0.0.1", () => {
    const read = readBridge("/x", depsOf(JSON.stringify({ port: 9000, token: "t", scheme: "http", pid: 4242, host: "evil.example" })));
    expect(read.ok).toBe(true);
    expect(JSON.stringify(read)).not.toContain("evil.example");
  });
});

describe("caminho da configuração", () => {
  test("dado o valor vazio, usa o padrão na home", () => {
    expect(bridgePathOf("", "/home/u")).toBe("/home/u/.config/mark-lvi/bridge.json");
    expect(bridgePathOf(undefined, "/home/u")).toBe("/home/u/.config/mark-lvi/bridge.json");
  });

  test("dado ~/ ou caminho absoluto, respeita o valor; relativo cai no padrão", () => {
    expect(bridgePathOf("~/x/b.json", "/home/u")).toBe("/home/u/x/b.json");
    expect(bridgePathOf("/tmp/b.json", "/home/u")).toBe("/tmp/b.json");
    expect(bridgePathOf("rel/b.json", "/home/u")).toBe("/home/u/.config/mark-lvi/bridge.json");
  });
});
