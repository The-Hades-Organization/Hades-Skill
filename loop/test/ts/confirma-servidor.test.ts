// Grupo confirma-servidor: HADES_CONFIRM_TYPED lida do config.env pelo servidor (Argos e herdr). Ligada, ou ausente, ação
// destrutiva sem o nome em `confirm` é recusada; só o "0" gravado a aceita. Herdr falso no PATH, nada toca o real.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARGOS_ERRORS } from "../../../src/lib/argos";
import { createActions, type ActionDeps } from "../../../src/panel/argos-actions";
import { createHerdr } from "../../../src/panel/herdr";
import { createHerdrPage, typedConfirmRequired } from "../../../src/panel/herdr-page";
import { BadRequest } from "../../../src/panel/http";
import type { PanelEnv } from "../../../src/panel/env";
import { configValues, remoteConfigRefusal } from "../../../src/panel/routes-core";
import { SKILL } from "./lib/rig";

const T = mkdtempSync(join(tmpdir(), "hades-confirma-"));
const BIN = join(T, "bin");
const D = join(T, "data");
const LOG = join(T, "herdr.log");
const HERDR_FAKE = `#!/usr/bin/env bash
case "\${1:-} \${2:-}" in
  'session list') echo '{"sessions":[{"name":"default","running":true,"default":true},{"name":"outra","running":true}]}'; exit 0 ;;
  'api snapshot') echo '{"result":{"snapshot":{"workspaces":[{"workspace_id":"w1","label":"alpha"}],"tabs":[],"panes":[],"agents":[]}}}'; exit 0 ;;
esac
(IFS='|'; echo "$*" >> "${LOG}")
echo '{"result":{}}'
`;
const calls = (): string[] => {
  try {
    return readFileSync(LOG, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};
const setTyped = (value: string | undefined): void => {
  writeFileSync(join(D, "config.env"), value === undefined ? "" : `HADES_CONFIRM_TYPED=${value}\n`);
};

const SAVED = { PATH: process.env.PATH, HOME: process.env.HOME };
beforeAll(() => {
  mkdirSync(BIN, { recursive: true });
  mkdirSync(join(D, "logs"), { recursive: true });
  writeFileSync(join(BIN, "herdr"), HERDR_FAKE);
  chmodSync(join(BIN, "herdr"), 0o755);
  copyFileSync(join(SKILL, "kit", "config.tsv"), join(D, "config.tsv"));
  process.env.PATH = `${BIN}:${SAVED.PATH}`;
  process.env.HOME = join(T, "home");
});
afterAll(() => {
  process.env.PATH = SAVED.PATH;
  process.env.HOME = SAVED.HOME;
  rmSync(T, { recursive: true, force: true });
});

const env = (): PanelEnv => ({ dir: D, locks: undefined }) as unknown as PanelEnv;
const page = () => createHerdrPage(env(), createHerdr());

describe("confirma: leitura da preferência", () => {
  test("dada a chave ausente, então o catálogo traz 1 e a confirmação é exigida", () => {
    setTyped(undefined);
    expect(configValues(env()).HADES_CONFIRM_TYPED).toBe("1");
    expect(typedConfirmRequired(configValues(env()))).toBe(true);
  });
  test("dado o config.env ilegível (sem catálogo), então a confirmação continua exigida", () => {
    expect(typedConfirmRequired({})).toBe(true);
    expect(typedConfirmRequired({ HADES_CONFIRM_TYPED: "talvez" })).toBe(true);
  });
  test("dada a chave em 0, então a confirmação deixa de ser exigida", () => {
    setTyped("0");
    expect(typedConfirmRequired(configValues(env()))).toBe(false);
  });
  test("as duas chaves entram ligadas no catálogo", () => {
    setTyped(undefined);
    const values = configValues(env());
    expect([values.HADES_CONFIRM_HOLD, values.HADES_CONFIRM_TYPED]).toEqual(["1", "1"]);
  });
});

describe("confirma: herdr (sessão e estrutura)", () => {
  const session = (body: Record<string, unknown>) => page().sessionAct({ action: "stop", name: "outra", ...body }, false);
  const admin = (body: Record<string, unknown>) => page().admin({ session: "default", action: "workspace-close", workspace: "w1", ...body }, false);

  test("dado digitar ligado, quando fecha sem confirm, então recusa e o herdr não é chamado", async () => {
    setTyped("1");
    const before = calls().length;
    await expect(session({})).rejects.toBeInstanceOf(BadRequest);
    await expect(admin({})).rejects.toBeInstanceOf(BadRequest);
    expect(calls().length).toBe(before);
  });
  test("dado a chave ausente, quando fecha sem confirm, então recusa", async () => {
    setTyped(undefined);
    await expect(session({})).rejects.toBeInstanceOf(BadRequest);
    await expect(admin({})).rejects.toBeInstanceOf(BadRequest);
  });
  test("dado digitar ligado, quando confirm bate, então aceita", async () => {
    setTyped("1");
    expect(await session({ confirm: "outra" })).toEqual({ ok: true });
    expect(await admin({ confirm: "alpha" })).toMatchObject({ ok: true });
  });
  test("dado digitar desligado, quando fecha sem confirm, então aceita pela API", async () => {
    setTyped("0");
    const before = calls().length;
    expect(await session({})).toEqual({ ok: true });
    expect(await admin({})).toMatchObject({ ok: true });
    const writes = calls().slice(before).filter((line) => !line.includes("snapshot"));
    expect(writes).toEqual(["session|stop|outra", "workspace|close|w1"]);
  });
  test("dado digitar desligado, então os outros guardas da sessão continuam", async () => {
    setTyped("0");
    await expect(session({ name: "nao-existe" })).rejects.toThrow("sessão do herdr desconhecida");
    await expect(session({ action: "delete" })).rejects.toThrow("pare a sessão antes de apagá-la");
  });
});

describe("confirma: Argos", () => {
  const stops: string[] = [];
  const target = { id: "agent:o__r:unit-a", name: "unit-a", worktree: T, pane: "w1:p1" };
  const actions = (config: Record<string, string>) => {
    const deps: ActionDeps = {
      logFile: join(D, "logs", "panel-argos.log"), fallbackCwd: T,
      herdrPage: { sessionAct: async (body: Record<string, unknown>) => { stops.push(String(body.name)); return { ok: true }; } } as unknown as ActionDeps["herdrPage"],
      target: () => target, live: async () => ({ herdrState: "idle", pending: null }), config: () => config, notify: async () => undefined,
    };
    return createActions(deps);
  };
  const stop = (config: Record<string, string>, extra: Record<string, unknown> = {}) =>
    actions(config).act({ node: target.id, action: "stop_session", args: { session: "outra" }, ...extra }, { remote: false });

  test("dado digitar ligado ou ausente, quando falta o nome, então confirm_required e nada roda", async () => {
    for (const config of [{ HADES_CONFIRM_TYPED: "1" }, {}] as Record<string, string>[]) {
      await expect(stop(config)).rejects.toMatchObject({ code: ARGOS_ERRORS.confirmRequired });
      await expect(stop(config, { confirm: "outro" })).rejects.toMatchObject({ code: ARGOS_ERRORS.confirmRequired });
    }
    expect(stops).toEqual([]);
  });
  test("dado digitar ligado, quando o nome bate, então roda", async () => {
    await stop({ HADES_CONFIRM_TYPED: "1" }, { confirm: "unit-a" });
    expect(stops).toEqual(["outra"]);
  });
  test("dado digitar desligado, quando falta o nome, então roda sem confirm", async () => {
    await stop({ HADES_CONFIRM_TYPED: "0" });
    expect(stops).toEqual(["outra", "outra"]);
  });
  test("dado digitar desligado, então ação desconhecida e argumento inválido continuam recusados", async () => {
    await expect(actions({ HADES_CONFIRM_TYPED: "0" }).act({ node: target.id, action: "apagar_tudo" }, { remote: false })).rejects.toMatchObject({ code: ARGOS_ERRORS.unknownAction });
    await expect(stop({ HADES_CONFIRM_TYPED: "0" }, { args: { session: "../x" } })).rejects.toMatchObject({ code: ARGOS_ERRORS.invalidArgs });
  });
});

describe("confirma: acesso remoto", () => {
  test("dado o acesso remoto, quando muda uma das travas de confirmação, então é recusado", () => {
    for (const key of ["HADES_CONFIRM_HOLD", "HADES_CONFIRM_TYPED"]) {
      expect(remoteConfigRefusal([key])).toBe("as travas de confirmação só se mudam pelo painel local");
    }
  });
  test("dado o acesso remoto, quando muda outra chave, então segue como estava", () => {
    expect(remoteConfigRefusal(["HADES_CLEAN_JOBS_KEEP"])).toBeUndefined();
  });
});
