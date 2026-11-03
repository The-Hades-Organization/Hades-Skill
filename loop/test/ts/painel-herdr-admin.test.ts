// Grupo painel-herdr-admin: a gerência do herdr pelo painel (POST /api/herdr/admin, src/panel/herdr-page.ts) contra um
// herdr falso no PATH que grava o argv. Contrato: reference/panel.md §Herdr. Nada toca o herdr real da máquina.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHerdr } from "../../../src/panel/herdr";
import { ADMIN_ACTIONS, adminCwd, adminLabel, adminPlan, createHerdrPage } from "../../../src/panel/herdr-page";
import { BadRequest } from "../../../src/panel/http";
import type { PanelEnv } from "../../../src/panel/env";
import { Rig } from "./lib/rig";
import { fetchRaw, JSON_CT, remoteHeaders, startTestPanel, until, widgetData } from "./lib/widget-rig";

type Dict = Record<string, unknown>;

const T = mkdtempSync(join(tmpdir(), "hades-herdr-admin-"));
const BIN = join(T, "bin");
const D = join(T, "data");
const LOG = join(T, "herdr.log");
const NOTIFY_LOG = join(T, "notify.log");
const SNAPSHOT = {
  workspaces: [{ workspace_id: "w1", label: "alpha" }, { workspace_id: "w2", label: null }],
  tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main" }, { tab_id: "w1:t2", workspace_id: "w1", label: null }],
  panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", agent: "claude" }, { pane_id: "w1:p2", tab_id: "w1:t1" }],
  agents: [{ pane_id: "w1:p1", name: "orq", agent_status: "idle" }],
};
// `session list` e `api snapshot` são leitura; o resto grava o argv (um argumento por campo, separados por "|") e responde
// o que o herdr 0.8.2 responde ao criar; FAKE_HERDR_FAIL faz a escrita recusar como o CLI real (JSON no stderr, saída 1)
const HERDR_FAKE = `#!/usr/bin/env bash
case "\${1:-} \${2:-}" in
  'session list') echo '{"sessions":[{"name":"default","running":true,"default":true}]}'; exit 0 ;;
  'api snapshot') printf '{"result":{"snapshot":%s}}\\n' "$(cat "${T}/snapshot.json")"; exit 0 ;;
esac
(IFS='|'; echo "$*" >> "${LOG}")
if [[ -n "\${FAKE_HERDR_FAIL:-}" ]]; then echo '{"error":{"code":"x","message":"recusado pelo herdr"}}' >&2; exit 1; fi
case "\${1:-} \${2:-}" in
  'workspace create') echo '{"result":{"workspace":{"workspace_id":"w9"}}}' ;;
  'pane split') echo '{"result":{"pane":{"pane_id":"w1:p9"}}}' ;;
  *) echo '{"result":{}}' ;;
esac
`;
const calls = (): string[] => {
  try {
    return readFileSync(LOG, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

const SAVED_PATH = process.env.PATH;
const SAVED_HOME = process.env.HOME;
beforeAll(() => {
  mkdirSync(BIN, { recursive: true });
  mkdirSync(join(D, "logs"), { recursive: true });
  mkdirSync(join(T, "home", "proj"), { recursive: true });
  writeFileSync(join(BIN, "herdr"), HERDR_FAKE);
  chmodSync(join(BIN, "herdr"), 0o755);
  writeFileSync(join(T, "snapshot.json"), JSON.stringify(SNAPSHOT));
  writeFileSync(join(D, "notify.sh"), `#!/usr/bin/env bash\necho "$*" >> "${NOTIFY_LOG}"\n`);
  chmodSync(join(D, "notify.sh"), 0o755);
  process.env.PATH = `${BIN}:${SAVED_PATH}`;
  process.env.HOME = join(T, "home");
});
afterAll(() => {
  process.env.PATH = SAVED_PATH;
  process.env.HOME = SAVED_HOME;
  rmSync(T, { recursive: true, force: true });
});

const page = (): ReturnType<typeof createHerdrPage> => createHerdrPage({ dir: D, locks: undefined } as unknown as PanelEnv, createHerdr());
const admin = (body: Dict, remote = false): Promise<Dict> => page().admin({ session: "default", ...body }, remote);
const refused = async (body: Dict, remote = false): Promise<string> => {
  const before = calls().length;
  const error = await admin(body, remote).then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(BadRequest);
  expect(calls().length).toBe(before);
  return (error as Error).message;
};

describe("herdr-admin: cada ação monta o argv certo", () => {
  const cases: [string, Dict, string][] = [
    ["workspace-create", { label: "novo", cwd: join(T, "home", "proj") }, `workspace|create|--no-focus|--label|novo|--cwd|${join(T, "home", "proj")}`],
    ["workspace-create", {}, "workspace|create|--no-focus"],
    ["workspace-rename", { workspace: "w1", label: "beta" }, "workspace|rename|w1|beta"],
    ["workspace-close", { workspace: "w1", confirm: "alpha" }, "workspace|close|w1"],
    ["workspace-close", { workspace: "w2", confirm: "w2" }, "workspace|close|w2"],
    ["tab-create", { workspace: "w1", label: "logs" }, "tab|create|--workspace|w1|--no-focus|--label|logs"],
    ["tab-rename", { tab: "w1:t1", label: "geral" }, "tab|rename|w1:t1|geral"],
    ["tab-close", { tab: "w1:t1", confirm: "main" }, "tab|close|w1:t1"],
    ["pane-split", { pane: "w1:p2", direction: "down" }, "pane|split|w1:p2|--direction|down|--no-focus"],
    ["pane-rename", { pane: "w1:p2", label: "build" }, "pane|rename|w1:p2|build"],
    ["pane-close", { pane: "w1:p1", confirm: "orq" }, "pane|close|w1:p1"],
    ["pane-close", { pane: "w1:p2", confirm: "w1:p2" }, "pane|close|w1:p2"],
    ["agent-start", { pane: "w1:p2", name: "rev", kind: "codex", args: ["--model", "gpt-5"] }, "agent|start|rev|--kind|codex|--pane|w1:p2|--|--model|gpt-5"],
    ["agent-start", { pane: "w1:p2", name: "rev", kind: "claude" }, "agent|start|rev|--kind|claude|--pane|w1:p2"],
  ];
  for (const [action, body, argv] of cases) {
    test(`dada a ação ${action} válida, quando roda, então o herdr recebe ${argv.split("|").slice(0, 2).join(" ")} em lista`, async () => {
      const before = calls().length;
      expect(await admin({ action, ...body })).toMatchObject({ ok: true });
      expect(calls().slice(before)).toEqual([argv]);
    });
  }

  test("todas as ações da lista têm caso acima", () => {
    expect(new Set(cases.map(([a]) => a))).toEqual(new Set(ADMIN_ACTIONS));
  });

  test("workspace e painel criados voltam com o ID que o herdr deu", async () => {
    expect(await admin({ action: "workspace-create" })).toEqual({ ok: true, created: "w9" });
    expect(await admin({ action: "pane-split", pane: "w1:p2", direction: "right" })).toEqual({ ok: true, created: "w1:p9" });
  });
});

describe("herdr-admin: entrada inválida é recusada antes do herdr", () => {
  test("ação desconhecida, sessão desconhecida e alvo fora do retrato", async () => {
    await refused({ action: "workspace-explode" });
    await refused({ action: "" });
    expect(await refused({ session: "outra", action: "workspace-create" })).toContain("sessão");
    await refused({ action: "workspace-rename", workspace: "w404", label: "x" });
    await refused({ action: "tab-close", tab: "w1:t9", confirm: "x" });
    await refused({ action: "pane-split", pane: "w1:p404", direction: "right" });
    await refused({ action: "pane-rename", pane: ["w1:p1"], label: "x" });
  });

  test("nome vazio, longo, com quebra de linha ou começando por '-'", async () => {
    await refused({ action: "workspace-rename", workspace: "w1", label: "   " });
    await refused({ action: "workspace-rename", workspace: "w1", label: "x".repeat(65) });
    await refused({ action: "tab-rename", tab: "w1:t1", label: "a\nb" });
    await refused({ action: "pane-rename", pane: "w1:p2", label: "--clear" });
    await refused({ action: "workspace-create", label: "-x" });
    expect(() => adminLabel("x".repeat(64), true)).not.toThrow();
    expect(adminLabel("", false)).toBeUndefined();
  });

  test("pasta fora do home, relativa, inexistente ou arquivo", async () => {
    await refused({ action: "workspace-create", cwd: "/etc" });
    await refused({ action: "workspace-create", cwd: "proj" });
    await refused({ action: "workspace-create", cwd: join(T, "home", "nao-existe") });
    await refused({ action: "workspace-create", cwd: join(T, "home", "..", "..", "etc") });
    writeFileSync(join(T, "home", "arquivo"), "x");
    await refused({ action: "workspace-create", cwd: join(T, "home", "arquivo") });
    expect(adminCwd(join(T, "home") + "/", join(T, "home"))).toBe(join(T, "home"));
  });

  test("split com direção fora da lista", async () => {
    await refused({ action: "pane-split", pane: "w1:p2", direction: "left" });
    await refused({ action: "pane-split", pane: "w1:p2" });
  });

  test("agent start: nome, tipo, argumentos, painel que já tem agente e nome em uso", async () => {
    const ok = { action: "agent-start", pane: "w1:p2", name: "rev", kind: "claude" };
    await refused({ ...ok, name: "Rev" });
    await refused({ ...ok, name: "" });
    await refused({ ...ok, name: "a".repeat(33) });
    await refused({ ...ok, kind: "vim" });
    await refused({ ...ok, kind: "__proto__" });
    await refused({ ...ok, args: "--model x" });
    await refused({ ...ok, args: ["--model", "a b"] });
    await refused({ ...ok, args: ["x\ny"] });
    await refused({ ...ok, args: ['"x"'] });
    await refused({ ...ok, args: [1] });
    await refused({ ...ok, args: Array.from({ length: 17 }, () => "x") });
    await refused({ ...ok, pane: "w1:p1" });
    await refused({ ...ok, name: "orq" });
  });
});

describe("herdr-admin: destrutivas exigem o nome do alvo", () => {
  const closes: [string, Dict, string][] = [
    ["workspace-close", { workspace: "w1" }, "alpha"],
    ["tab-close", { tab: "w1:t1" }, "main"],
    ["pane-close", { pane: "w1:p1" }, "orq"],
  ];
  for (const [action, target, name] of closes) {
    test(`dado ${action}, quando falta o nome ou ele está errado, então recusa sem chamar o herdr`, async () => {
      await refused({ action, ...target });
      await refused({ action, ...target, confirm: "" });
      await refused({ action, ...target, confirm: `${name}x` });
      await refused({ action, ...target, confirm: name.toUpperCase() });
      await refused({ action, ...target, confirm: true });
    });
  }

  test("o nome vem do servidor: o rótulo mandado pela tela não vale", async () => {
    expect(await refused({ action: "workspace-close", workspace: "w1", confirm: "w1", label: "w1" })).toContain("confirmar");
  });

  test("workspace sem rótulo confirma pelo ID", () => {
    expect(adminPlan("workspace-close", { workspace: "w2" }, SNAPSHOT).confirmName).toBe("w2");
  });
});

describe("herdr-admin: log, aviso remoto e recusa do herdr", () => {
  test("o log leva ação, alvo e origem, nunca o nome digitado nem os argumentos", async () => {
    const secret = "nome-secreto-xyz";
    await admin({ action: "tab-rename", tab: "w1:t1", label: secret }, true);
    await admin({ action: "agent-start", pane: "w1:p2", name: "rev", kind: "claude", args: ["--model", "argumento-secreto"] });
    const logged = readFileSync(join(D, "logs", "panel-herdr.log"), "utf8");
    expect(logged).toContain("acao=tab-rename alvo=w1:t1");
    expect(logged).toContain("acao=agent-start alvo=w1:p2");
    expect(logged).toContain("origem=remoto ok");
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain("argumento-secreto");
    expect(logged).not.toContain("confirm");
  });

  test("remoto dispara o aviso (ação e alvo, sem o nome); local não", async () => {
    rmSync(NOTIFY_LOG, { force: true });
    await admin({ action: "pane-rename", pane: "w1:p2", label: "rotulo-secreto" }, false);
    await admin({ action: "workspace-rename", workspace: "w1", label: "rotulo-secreto" }, true);
    const text = await until(async () => {
      try {
        return readFileSync(NOTIFY_LOG, "utf8");
      } catch {
        return "";
      }
    }, (v) => v.includes("workspace-rename"));
    expect(text).toContain("w1");
    expect(text).not.toContain("pane-rename");
    expect(text).not.toContain("rotulo-secreto");
  });

  test("quando o herdr recusa, a mensagem dele sobe como BadRequest e o log marca erro", async () => {
    process.env.FAKE_HERDR_FAIL = "1";
    try {
      await expect(admin({ action: "pane-split", pane: "w1:p2", direction: "right" })).rejects.toThrow(new BadRequest("recusado pelo herdr"));
    } finally {
      delete process.env.FAKE_HERDR_FAIL;
    }
    expect(readFileSync(join(D, "logs", "panel-herdr.log"), "utf8")).toMatch(/acao=pane-split alvo=w1:p2 .* erro\n/);
  });
});

describe("herdr-admin: a rota do painel (token, chave e túnel)", () => {
  const r = new Rig();
  let P: Awaited<ReturnType<typeof startTestPanel>>;
  let PD: string;
  beforeAll(async () => {
    PD = widgetData(r, "herdr-admin").D;
    P = await startTestPanel(PD);
  });
  afterAll(() => {
    P?.stop();
    r.cleanup();
  });
  const body = { action: "pane-rename", pane: "w1:p2", label: "viaRota" };
  const post = (headers: Record<string, string>) => fetchRaw(P.base, "/api/herdr/admin", { ...JSON_CT, ...headers }, body);

  test("local com o token executa", async () => {
    const before = calls().length;
    const res = await post({ "x-panel-token": P.token });
    expect([res.status, res.json]).toEqual([200, { ok: true }]);
    expect(calls().slice(before)).toEqual(["pane|rename|w1:p2|viaRota"]);
  });

  test("sem o token: 403 e o herdr não é chamado", async () => {
    const before = calls().length;
    expect((await post({})).status).toBe(403);
    expect(calls().length).toBe(before);
  });

  test("remoto sem a chave: 401; com a chave e sem o token: 403; nenhum chama o herdr", async () => {
    const before = calls().length;
    expect((await post({ ...remoteHeaders(PD, false), "x-panel-token": P.token })).status).toBe(401);
    expect((await post(remoteHeaders(PD, true))).status).toBe(403);
    expect(calls().length).toBe(before);
  });

  test("remoto com a chave e o token passa e é registrado como remoto", async () => {
    const res = await post({ ...remoteHeaders(PD, true), "x-panel-token": P.token });
    expect(res.status).toBe(200);
    expect(readFileSync(join(PD, "logs", "panel-herdr.log"), "utf8")).toContain("acao=pane-rename alvo=w1:p2 sessao=default origem=remoto ok");
  });

  test("ação inválida pela rota é 400, não 500", async () => {
    const res = await fetchRaw(P.base, "/api/herdr/admin", { ...JSON_CT, "x-panel-token": P.token }, { action: "nada" });
    expect(res.status).toBe(400);
  });
});
