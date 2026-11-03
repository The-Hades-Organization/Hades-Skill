// Grupo painel-claude: anexos do chat (nome, tipo, limite, pasta fora do repo, acesso remoto) e apagamento junto da sessão.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuth } from "../../../src/panel/auth.ts";
import { panelEnv } from "../../../src/panel/env.ts";
import { startPanel, type Panel } from "../../../src/panel/server.ts";
import { ATTACH_CODES, ATTACH_MAX_FILES, attachKind, safeName } from "../../../src/panel/chat-attach.ts";

const SKILL = join(import.meta.dir, "../../..");
const T = mkdtempSync(join(tmpdir(), "hades-claude-anexo-"));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const b64 = (b: Buffer | string): string => Buffer.from(b).toString("base64");

interface Rig { panel: Panel; base: string; D: string; wt: string; token: string; pub: string; cookie: string }
let rig: Rig;

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port as number;
  void probe.stop(true);
  return port;
}

beforeAll(async () => {
  const wt = join(T, "proj");
  const D = join(T, "proj-data");
  mkdirSync(wt, { recursive: true });
  mkdirSync(join(D, "panel"), { recursive: true });
  Bun.spawnSync(["git", "init", "-q", wt]);
  copyFileSync(join(SKILL, "kit/config.tsv"), join(D, "config.tsv"));
  writeFileSync(join(D, "env.sh"), `W="${wt}"\n`);
  const pub = "claude-teste.devtunnels.example";
  writeFileSync(join(D, "panel-tunnel.url"), `https://${pub}\n`);
  writeFileSync(join(D, "panel", "remote.key"), "chave-de-teste\n");
  const panel = await startPanel(D, await freePort());
  const cookie = `${panelEnv(D).cookie}=${createAuth(panelEnv(D)).sessionValue("chave-de-teste")}`;
  rig = { panel, base: `http://127.0.0.1:${panel.port}`, D, wt, token: panel.token, pub, cookie };
});
afterAll(() => {
  rig.panel.stop();
  rmSync(T, { recursive: true, force: true });
});

const local = (): Record<string, string> => ({ "x-panel-token": rig.token, "content-type": "application/json", origin: rig.base });
const remote = (): Record<string, string> => ({
  ...local(), origin: `https://${rig.pub}`, "x-forwarded-for": "203.0.113.9", "x-forwarded-host": rig.pub, cookie: rig.cookie,
});
const attach = (headers: Record<string, string>, body: unknown): Promise<Response> =>
  fetch(`${rig.base}/api/claude/attach`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
const code = async (r: Response): Promise<string> => ((await r.json()) as { code: string }).code;

describe("anexo do chat: nome e tipo", () => {
  test("dado nome com pasta, barra e ponto-ponto, então fica só o nome saneado e a extensão em minúsculas", () => {
    expect(safeName("../../etc/passwd.TXT")).toEqual({ name: "passwd.TXT", ext: "txt" });
    expect(safeName("a\\b\\..\\foto final (1).PNG").name).toBe("foto_final_1_.PNG");
    expect(safeName("....").name).toBe("arquivo");
    expect(safeName("x".repeat(300) + ".md").name.length).toBeLessThanOrEqual(80);
  });
  test("dado imagem com assinatura trocada ou texto com byte nulo, então recusa pelo tipo", () => {
    expect(attachKind("png", PNG)).toBe("imagem");
    expect(() => attachKind("png", Buffer.from("texto"))).toThrow();
    expect(() => attachKind("txt", Buffer.from([0x61, 0, 0x62]))).toThrow();
    expect(() => attachKind("exe", Buffer.from("MZ"))).toThrow();
    expect(attachKind("md", Buffer.from("# oi"))).toBe("texto");
  });
});

describe("anexo do chat: rota", () => {
  test("dado o painel local, quando anexa um texto, então grava sob $D/claude/attach, fora do repo, e devolve o caminho", async () => {
    const r = await attach(local(), { name: "../notas.md", data: b64("# notas") });
    expect(r.status).toBe(200);
    const d = (await r.json()) as { id: string; draft: boolean; path: string; name: string; kind: string; bytes: number };
    expect(d).toMatchObject({ draft: true, name: "notas.md", kind: "texto", bytes: 7 });
    expect(d.path.startsWith(join(rig.D, "claude", "attach", d.id))).toBe(true);
    expect(d.path.startsWith(`${rig.wt}/`)).toBe(false);
    expect(readFileSync(d.path, "utf8")).toBe("# notas");
    const again = (await (await attach(local(), { id: d.id, name: "x.png", data: b64(PNG) })).json()) as { id: string; kind: string };
    expect(again).toMatchObject({ id: d.id, kind: "imagem" });
  });

  test("dado arquivo acima do limite, então 413 attach_too_large e nada fica gravado", async () => {
    const before = readdirSync(join(rig.D, "claude", "attach")).length;
    const big = b64(Buffer.alloc(5 * 1024 * 1024 + 1, 97));
    const r = await attach(local(), { name: "grande.txt", data: big });
    expect(r.status).toBe(413);
    expect(await code(r)).toBe(ATTACH_CODES.tooLarge);
    expect(readdirSync(join(rig.D, "claude", "attach")).length).toBe(before);
  });

  test("dado tipo fora da lista, imagem falsa, base64 inválido e arquivo vazio, então recusa por código", async () => {
    expect(await code(await attach(local(), { name: "a.exe", data: b64("MZ") }))).toBe(ATTACH_CODES.badType);
    expect(await code(await attach(local(), { name: "a.png", data: b64("não sou png") }))).toBe(ATTACH_CODES.badType);
    expect(await code(await attach(local(), { name: "a.txt", data: "###" }))).toBe(ATTACH_CODES.badRequest);
    expect(await code(await attach(local(), { name: "a.txt", data: "" }))).toBe(ATTACH_CODES.badRequest);
    expect(await code(await attach(local(), { data: b64("x") }))).toBe(ATTACH_CODES.badRequest);
    expect(await code(await attach(local(), "isto não é json"))).toBe(ATTACH_CODES.badRequest);
  });

  test("dado id de sessão inexistente ou com ponto-ponto, então não grava fora da pasta de anexos", async () => {
    expect(await code(await attach(local(), { id: "deadbeef", name: "a.txt", data: b64("x") }))).toBe(ATTACH_CODES.unknownSession);
    const r = await attach(local(), { id: "../../x", name: "a.txt", data: b64("x") });
    expect([404, 400]).toContain(r.status);
    expect(existsSync(join(rig.D, "x"))).toBe(false);
  });

  test("dado o teto de arquivos por conversa, então o seguinte é 429 attach_too_many", async () => {
    const first = (await (await attach(local(), { name: "0.txt", data: b64("0") })).json()) as { id: string };
    for (let i = 1; i < ATTACH_MAX_FILES; i++) expect((await attach(local(), { id: first.id, name: `${i}.txt`, data: b64("x") })).status).toBe(200);
    const r = await attach(local(), { id: first.id, name: "extra.txt", data: b64("x") });
    expect(r.status).toBe(429);
    expect(await code(r)).toBe(ATTACH_CODES.tooMany);
  });

  test("dado o acesso remoto, sem chave é 401, sem token é 403, e com os dois passa", async () => {
    expect((await attach({ ...remote(), cookie: "" }, { name: "a.txt", data: b64("x") })).status).toBe(401);
    const { "x-panel-token": _t, ...semToken } = remote();
    expect((await attach(semToken, { name: "a.txt", data: b64("x") })).status).toBe(403);
    expect((await attach(remote(), { name: "a.txt", data: b64("x") })).status).toBe(200);
  });

  test("dado o log do chat, então leva nome, tamanho e tipo, nunca o conteúdo", async () => {
    await attach(local(), { name: "segredo.txt", data: b64("CONTEUDO-SECRETO-77") });
    const log = readFileSync(join(rig.D, "logs", "claude-chat.log"), "utf8");
    expect(log).toContain("anexo nome=segredo.txt bytes=19 tipo=texto");
    expect(log).not.toContain("CONTEUDO-SECRETO-77");
  });

  test("dado chat desligado, então o anexo recusa com attach_disabled", async () => {
    await fetch(`${rig.base}/api/config`, { method: "POST", headers: local(), body: JSON.stringify({ values: { HADES_CHAT: "0" } }) });
    const r = await attach(local(), { name: "a.txt", data: b64("x") });
    expect(r.status).toBe(403);
    expect(await code(r)).toBe(ATTACH_CODES.disabled);
    await fetch(`${rig.base}/api/config`, { method: "POST", headers: local(), body: JSON.stringify({ values: { HADES_CHAT: "1" } }) });
  });
});

describe("anexo do chat: envio e apagamento", () => {
  test("dado anexo que não existe na pasta da sessão, quando envia citando-o, então 400 e nenhuma conversa nasce", async () => {
    const r = await fetch(`${rig.base}/api/claude/send`, {
      method: "POST", headers: local(), body: JSON.stringify({ text: "veja", draft: "abcdef01", files: ["0000-nao-existe.txt", "../../etc/passwd"] }),
    });
    expect(r.status).toBe(400);
    expect(existsSync(join(rig.D, "claude", "sessions.json"))).toBe(false);
  });

  test("dado sessão registrada com anexos, quando apaga a sessão, então a pasta de anexos some junto", async () => {
    const d = (await (await attach(local(), { name: "a.txt", data: b64("x") })).json()) as { id: string };
    writeFileSync(join(rig.D, "claude", "sessions.json"), JSON.stringify({ [d.id]: { id: d.id, title: "t" } }));
    const r = await fetch(`${rig.base}/api/claude/delete`, { method: "POST", headers: local(), body: JSON.stringify({ id: d.id }) });
    expect(r.status).toBe(200);
    expect(existsSync(join(rig.D, "claude", "attach", d.id))).toBe(false);
  });
});
