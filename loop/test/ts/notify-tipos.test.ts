// Issue 28: o que o dono desliga na tela tem de ser o evento que de fato dispara.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVENT_LABELS, EVENTS, history, notify, NotifyContext, status, SWITCHABLE_EVENTS } from "../../../src/lib/notify";
import { prProblems, Watcher } from "../../../src/lib/notify-watch";

const ROOT = join(import.meta.dir, "../../..");
const dir = mkdtempSync(join(tmpdir(), "hades-notify-tipos-"));
const BASE = { HADES_NOTIFY: "1", HADES_NOTIFY_DESKTOP: "0", HADES_NOTIFY_NTFY: "0", HADES_NOTIFY_QUIET: "" };
const EV_KEYS = Object.keys(EVENTS).map((e) => `HADES_NOTIFY_EV_${e.toUpperCase()}`);
const saved = new Map<string, string | undefined>();

const setEnv = (values: Record<string, string>): void => {
  for (const k of [...EV_KEYS, ...Object.keys(BASE)]) {
    if (!saved.has(k)) saved.set(k, process.env[k]);
    delete process.env[k];
  }
  Object.assign(process.env, BASE, values);
};
const configEnv = (name: string, lines: string[]): NotifyContext => {
  const d = join(dir, name);
  mkdirSync(d, { recursive: true });
  copyFileSync(join(ROOT, "kit/config.tsv"), join(d, "config.tsv")); // o catálogo da instância traz os padrões
  writeFileSync(join(d, "config.env"), `${lines.join("\n")}\n`);
  return new NotifyContext(d);
};

beforeAll(() => setEnv({}));
afterAll(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Roda um ciclo do vigia sobre o journal do gate e devolve os eventos que chegaram ao histórico. */
async function gateFailureEvents(name: string, ctx: NotifyContext): Promise<string[]> {
  const locks = join(dir, `${name}.locks`);
  mkdirSync(locks, { recursive: true });
  const journal = join(locks, "gate-journal.tsv");
  writeFileSync(journal, "");
  process.env.LOCKS = locks;
  mkdirSync(ctx.state, { recursive: true });
  writeFileSync(ctx.beat, JSON.stringify({ gate_off: 0 }));
  const watcher = new Watcher(ctx);
  appendFileSync(journal, "t1\tdone\tgate\tagente-z\tx\ty\trc=2\n");
  await (watcher as unknown as { gates(): Promise<void> }).gates();
  return history(ctx).map((h) => h.event);
}

describe("nomes dos tipos", () => {
  test("dado o catálogo, então gate diz que cobre build e teste e test é a notificação de teste", () => {
    expect(EVENT_LABELS.gate).toBe("Gate, build ou teste falhou");
    expect(EVENT_LABELS.test).toContain("Notificação de teste");
  });

  test("dado o tipo test, então ele fica fora dos que têm interruptor", () => {
    expect(SWITCHABLE_EVENTS).not.toContain("test");
    expect(SWITCHABLE_EVENTS).toContain("ci");
  });
});

describe("interruptor do gate", () => {
  test("dado HADES_NOTIFY_EV_GATE=off, quando o journal tem falha, então nada é notificado", async () => {
    setEnv({ HADES_NOTIFY_EV_GATE: "off" });
    expect(await gateFailureEvents("gate-off", new NotifyContext(join(dir, "gate-off")))).toEqual([]);
  });

  test("dado o gate ligado, quando o journal tem falha, então o evento é gate", async () => {
    setEnv({});
    expect(await gateFailureEvents("gate-on", new NotifyContext(join(dir, "gate-on")))).toEqual(["gate"]);
  });
});

describe("CI separado do review", () => {
  const prs = [{ number: 7, checks: { failing: true }, headRefOid: "abcdef1234567" }, { number: 8, unseenReviewSincePush: true, lastReviewAt: "t" }];

  test("dado CI vermelho e review novo, então cada um sai no seu tipo", () => {
    expect([...prProblems(prs).values()].map((p) => `${p.event}:${p.obj}`).sort()).toEqual(["ci:PR #7 CI", "pr:PR #8 review"]);
  });

  test("dado HADES_NOTIFY_EV_CI=off, então o CI não notifica e o review novo sim", async () => {
    setEnv({ HADES_NOTIFY_EV_CI: "off" });
    const ctx = new NotifyContext(join(dir, "ci-off"));
    expect((await notify(ctx, "ci", "error", "CI vermelho", { obj: "PR #7 CI" })).why).toBe("evento desligado");
    expect((await notify(ctx, "pr", "warn", "review novo", { obj: "PR #8 review" })).sent).toBe(true);
  });

  test("dado HADES_NOTIFY_EV_PR=off no config.env e CI sem valor próprio, então o CI segue silenciado", async () => {
    setEnv({});
    const ctx = configEnv("legado", ["HADES_NOTIFY_EV_PR=off"]);
    expect(ctx.eventChannels("ci")).toBe("off");
    expect((await notify(ctx, "ci", "error", "CI vermelho", { obj: "PR #7 CI" })).why).toBe("evento desligado");
  });

  test("dado PR desligado e CI escolhido, então o CI vale o que foi escolhido", () => {
    setEnv({});
    expect(configEnv("ci-proprio", ["HADES_NOTIFY_EV_PR=off", "HADES_NOTIFY_EV_CI=phone"]).eventChannels("ci")).toBe("phone");
  });

  test("dado nada configurado, então o CI notifica nos dois canais", () => {
    setEnv({});
    expect(configEnv("padrao", []).eventChannels("ci")).toBe("both");
  });

  test("dado o catálogo do kit, então o CI começa seguindo o review (padrão pr)", () => {
    const row = readFileSync(join(ROOT, "kit/config.tsv"), "utf8").split("\n").find((l) => l.startsWith("HADES_NOTIFY_EV_CI\t"));
    expect(row?.split("\t")[1]).toBe("pr");
  });
});

describe("variável exportada", () => {
  test("dado HADES_NOTIFY_EV_GATE exportada, então o status marca o tipo como fixo e vence o config.env", () => {
    setEnv({ HADES_NOTIFY_EV_GATE: "off" });
    const ctx = configEnv("fixo", ["HADES_NOTIFY_EV_GATE=both"]);
    const gate = (status(ctx).events as Array<{ event: string; pinnedByEnv: boolean; channels: string }>).find((e) => e.event === "gate");
    expect(gate).toMatchObject({ pinnedByEnv: true, channels: "off" });
  });

  test("dado o export igual ao config.env (o env.sh exporta o config), então o tipo não aparece como fixo", () => {
    setEnv({ HADES_NOTIFY_EV_GATE: "off" });
    const events = status(configEnv("igual", ["HADES_NOTIFY_EV_GATE=off"])).events as Array<{ pinnedByEnv: boolean }>;
    expect(events.some((e) => e.pinnedByEnv)).toBe(false);
  });

  test("dado nada exportado, então nenhum tipo aparece como fixo", () => {
    setEnv({});
    const events = status(configEnv("livre", ["HADES_NOTIFY_EV_GATE=off"])).events as Array<{ pinnedByEnv: boolean }>;
    expect(events.some((e) => e.pinnedByEnv)).toBe(false);
  });

  test("dado o spec da unit do vigia, então ele não lista HADES_NOTIFY_EV_* (o watch relê o config.env)", () => {
    const text = readFileSync(join(ROOT, "src/commands/notify.ts"), "utf8");
    expect(text).not.toContain("HADES_NOTIFY_EV");
  });
});

describe("emissores", () => {
  const sources = (base: string): string[] =>
    readdirSync(base, { recursive: true, encoding: "utf8" }).map((f) => join(base, f)).filter((f) => f.endsWith(".ts") && statSync(f).isFile());

  test("dado cada emissor do código, então o evento é do catálogo", () => {
    const found: string[] = [];
    const patterns = [/"notify\.sh"\),\s*"send",\s*"([a-z-]+)"/g, /notify\(\s*\w+(?:\.\w+)?,\s*"([a-z-]+)"/g, /Watcher\.add\(\s*\w+,\s*"([a-z-]+)"/g];
    for (const file of sources(join(ROOT, "src"))) {
      const text = readFileSync(file, "utf8");
      for (const re of patterns) for (const m of text.matchAll(re)) found.push(m[1] as string);
    }
    expect(found.length).toBeGreaterThan(8);
    expect(found.filter((event) => !(event in EVENTS))).toEqual([]);
  });
});
