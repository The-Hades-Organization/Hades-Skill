// Notificação repetida de CI vermelho e de review novo: a identidade do evento (PR + head + checks; PR + review + comentários
// novos) decide se avisa, não a janela HADES_NOTIFY_DEDUPE_MIN. Todo teste avança um relógio injetado além da janela.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVENTS, history, notify, NotifyContext } from "../../../src/lib/notify";
import { planPrNotices, type PrSnapshot } from "../../../src/lib/notify-marks";
import { Watcher } from "../../../src/lib/notify-watch";

const ROOT = join(import.meta.dir, "../../..");
const dir = mkdtempSync(join(tmpdir(), "hades-notify-dedupe-"));
const HOUR_MS = 3_600_000;
const DEDUPE_MIN = 5;
const PAST_WINDOW_MS = 2 * DEDUPE_MIN * 60_000;
const T0 = Date.UTC(2026, 10, 7, 12, 0, 0);
const BASE = { HADES_NOTIFY: "1", HADES_NOTIFY_DESKTOP: "0", HADES_NOTIFY_NTFY: "0", HADES_NOTIFY_QUIET: "", HADES_NOTIFY_DEDUPE_MIN: String(DEDUPE_MIN) };
const OWN_KEYS = [...Object.keys(EVENTS).map((e) => `HADES_NOTIFY_EV_${e.toUpperCase()}`), ...Object.keys(BASE), "HADES_NOTIFY_CI_REMIND_H"];
const saved = new Map<string, string | undefined>();
let counter = 0;

const setEnv = (values: Record<string, string> = {}): void => {
  for (const k of OWN_KEYS) {
    if (!saved.has(k)) saved.set(k, process.env[k]);
    delete process.env[k];
  }
  Object.assign(process.env, BASE, values);
};

beforeAll(() => setEnv());
beforeEach(() => setEnv());
afterAll(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Uma instância de teste com relógio próprio: `advance` move o tempo, `tick` roda um ciclo do vigia sobre a lista de PRs. */
function instance(configLines?: string[]) {
  const d = join(dir, `i${counter++}`);
  mkdirSync(d, { recursive: true });
  if (configLines) {
    copyFileSync(join(ROOT, "kit/config.tsv"), join(d, "config.tsv"));
    writeFileSync(join(d, "config.env"), `${configLines.join("\n")}\n`);
  }
  const clock = { ms: T0 };
  const ctx = new NotifyContext(d, () => clock.ms);
  let watcher = new Watcher(ctx);
  return {
    ctx,
    advance: (ms: number): void => void (clock.ms += ms),
    tick: (prs: PrSnapshot[]): Promise<void> => watcher.notifyPrs(prs),
    restartWatcher: (): void => void (watcher = new Watcher(ctx)),
    sent: (event: "ci" | "pr"): string[] => history(ctx).filter((h) => h.event === event).map((h) => h.text),
  };
}

const failing = (...names: string[]): PrSnapshot["checks"] => ({ failing: names.map((name) => ({ name, url: null })) });
const pr = (over: Partial<PrSnapshot> = {}): PrSnapshot => ({
  number: 7,
  headRefOid: "abc1234567890",
  checks: failing(),
  live: [],
  topLevelLive: [],
  unseenReviewSincePush: false,
  lastReviewAt: null,
  ...over,
});
const thread = (id: string): unknown => ({ id });
const comment = (commentId: number): { commentId: number } => ({ commentId });

describe("relógio injetado", () => {
  test("dado o mesmo aviso, quando o relógio passa da janela, então sai de novo; dentro da janela, não", async () => {
    const { ctx, advance } = instance();
    const send = () => notify(ctx, "agent", "info", "igual", { obj: "x" });
    expect((await send()).sent).toBe(true);
    advance(60_000);
    expect(await send()).toEqual({ sent: false, why: "repetido na janela" });
    advance(PAST_WINDOW_MS);
    expect((await send()).sent).toBe(true);
  });
});

describe("CI vermelho: PR + head + checks que falharam", () => {
  test("dado CI vermelho no head abc, quando o vigia repete o ciclo além da janela, então avisa uma vez", async () => {
    const { tick, advance, sent } = instance();
    await tick([pr({ checks: failing("build") })]);
    for (let i = 0; i < 3; i++) {
      advance(PAST_WINDOW_MS);
      await tick([pr({ checks: failing("build") })]);
    }
    expect(sent("ci")).toHaveLength(1);
  });

  test("dado o rerun pendente que falha de novo nos mesmos checks do mesmo head, então não avisa", async () => {
    const { tick, advance, sent } = instance();
    await tick([pr({ checks: failing("build", "lint") })]);
    advance(PAST_WINDOW_MS);
    await tick([pr()]); // rerun: nada falhando por um ciclo
    advance(PAST_WINDOW_MS);
    await tick([pr({ checks: failing("lint", "build") })]);
    expect(sent("ci")).toHaveLength(1);
  });

  test("dado um push novo que falha, então avisa de novo", async () => {
    const { tick, advance, sent } = instance();
    await tick([pr({ checks: failing("build") })]);
    advance(PAST_WINDOW_MS);
    await tick([pr({ headRefOid: "def9876543210", checks: failing("build") })]);
    expect(sent("ci")).toHaveLength(2);
  });

  test("dado o mesmo head com um check novo falhando, então avisa de novo", async () => {
    const { tick, advance, sent } = instance();
    await tick([pr({ checks: failing("build") })]);
    advance(PAST_WINDOW_MS);
    await tick([pr({ checks: failing("build", "e2e") })]);
    expect(sent("ci")).toHaveLength(2);
  });

  test("dado o head que muda e volta a falhar, quando o head antigo volta, então conta como push novo", async () => {
    const { tick, advance, sent } = instance();
    await tick([pr({ checks: failing("build") })]);
    await tick([pr({ headRefOid: "def9876543210" })]); // verde no head novo: a marca do head velho expira
    advance(PAST_WINDOW_MS);
    await tick([pr({ checks: failing("build") })]);
    expect(sent("ci")).toHaveLength(2);
  });

  test("dado checks.failing vazio (o formato real do coletor), então não notifica CI", async () => {
    const { tick, sent } = instance();
    await tick([pr({ checks: failing() })]);
    expect(sent("ci")).toEqual([]);
  });

  test("dado checks.failing vazio, então o plano não tem evento de CI", () => {
    expect(planPrNotices([pr({ checks: failing() })], {}, { now: 0, remindHours: 0 }).events).toEqual([]);
  });

  test("dado o vigia reiniciado, quando o CI segue vermelho no mesmo head, então não avisa de novo", async () => {
    const { tick, advance, restartWatcher, sent } = instance();
    await tick([pr({ checks: failing("build") })]);
    restartWatcher();
    advance(PAST_WINDOW_MS);
    await tick([pr({ checks: failing("build") })]);
    expect(sent("ci")).toHaveLength(1);
  });

  test("dado a PR que sai da lista (fechou) por mais que a tolerância, quando uma PR de mesmo número volta vermelha, então avisa", async () => {
    const { tick, advance, sent } = instance();
    await tick([pr({ checks: failing("build") })]);
    advance(2 * HOUR_MS);
    await tick([]);
    advance(PAST_WINDOW_MS);
    await tick([pr({ checks: failing("build") })]);
    expect(sent("ci")).toHaveLength(2);
  });

  test("dado a PR ausente por um ciclo só (lista falha de passagem), então a marca fica e não reavisa", async () => {
    const { tick, advance, sent } = instance();
    await tick([pr({ checks: failing("build") })]);
    advance(PAST_WINDOW_MS);
    await tick([]);
    advance(PAST_WINDOW_MS);
    await tick([pr({ checks: failing("build") })]);
    expect(sent("ci")).toHaveLength(1);
  });
});

describe("review novo: PR + review + comentários top-level novos", () => {
  const review = (over: Partial<PrSnapshot> = {}): PrSnapshot =>
    pr({ lastReviewAt: "2026-11-07T10:00:00Z", live: [thread("t1"), thread("t2")], unseenReviewSincePush: true, ...over });

  test("dado um review com threads vivas, quando o vigia repete o ciclo além da janela, então avisa uma vez", async () => {
    const { tick, advance, sent } = instance();
    await tick([review()]);
    for (let i = 0; i < 3; i++) {
      advance(PAST_WINDOW_MS);
      await tick([review()]);
    }
    expect(sent("pr")).toHaveLength(1);
  });

  test("dado o review já avisado, quando respondo e resolvo threads (a contagem viva muda), então não avisa", async () => {
    const { tick, advance, sent } = instance();
    await tick([review()]);
    advance(PAST_WINDOW_MS);
    await tick([review({ live: [thread("t2")] })]);
    advance(PAST_WINDOW_MS);
    await tick([review({ live: [] })]);
    expect(sent("pr")).toHaveLength(1);
  });

  test("dado outro review depois do primeiro, então avisa de novo", async () => {
    const { tick, advance, sent } = instance();
    await tick([review()]);
    advance(PAST_WINDOW_MS);
    await tick([review({ lastReviewAt: "2026-11-07T13:00:00Z" })]);
    expect(sent("pr")).toHaveLength(2);
  });

  test("dado comentário top-level novo (id novo), então avisa; resolver um comentário antigo, não", async () => {
    const { tick, advance, sent } = instance();
    await tick([pr({ topLevelLive: [comment(1), comment(2)] })]);
    advance(PAST_WINDOW_MS);
    await tick([pr({ topLevelLive: [comment(2)] })]); // resolvi o 1
    advance(PAST_WINDOW_MS);
    await tick([pr({ topLevelLive: [comment(2), comment(3)] })]);
    expect(sent("pr")).toHaveLength(2);
  });

  test("dado o review já avisado, quando o head muda por push, então o mesmo review não é avisado de novo", async () => {
    const { tick, advance, sent } = instance();
    await tick([review()]);
    advance(PAST_WINDOW_MS);
    await tick([review({ headRefOid: "def9876543210" })]);
    expect(sent("pr")).toHaveLength(1);
  });

  test("dado o vigia reiniciado, quando o mesmo review segue pendente, então não avisa de novo", async () => {
    const { tick, advance, restartWatcher, sent } = instance();
    await tick([review()]);
    restartWatcher();
    advance(PAST_WINDOW_MS);
    await tick([review()]);
    expect(sent("pr")).toHaveLength(1);
  });
});

describe("interruptores independentes", () => {
  const both = (): PrSnapshot[] => [pr({ checks: failing("build"), lastReviewAt: "t", live: [thread("t1")] })];

  test("dado Review novo desligado, então o CI vermelho segue avisando", async () => {
    setEnv({ HADES_NOTIFY_EV_PR: "off" });
    const { tick, sent } = instance([]);
    await tick(both());
    expect({ ci: sent("ci").length, pr: sent("pr").length }).toEqual({ ci: 1, pr: 0 });
  });

  test("dado CI vermelho desligado, então o review novo segue avisando", async () => {
    setEnv({ HADES_NOTIFY_EV_CI: "off" });
    const { tick, sent } = instance([]);
    await tick(both());
    expect({ ci: sent("ci").length, pr: sent("pr").length }).toEqual({ ci: 0, pr: 1 });
  });

  test("dado o tipo desligado, quando ele é ligado depois, então o problema que já existia avisa (desligado não marca)", async () => {
    setEnv({ HADES_NOTIFY_EV_CI: "off" });
    const { tick, advance, sent } = instance([]);
    await tick(both());
    expect(sent("ci")).toEqual([]);
    setEnv();
    advance(PAST_WINDOW_MS);
    await tick(both());
    expect(sent("ci")).toHaveLength(1);
  });

  test("dado o catálogo do kit, então CI vermelho começa em both, independente do review", () => {
    const row = readFileSync(join(ROOT, "kit/config.tsv"), "utf8").split("\n").find((l) => l.startsWith("HADES_NOTIFY_EV_CI\t"));
    expect(row?.split("\t")[1]).toBe("both");
    expect(instance([]).ctx.eventChannels("ci")).toBe("both");
  });

  test("dado Review novo desligado no config.env e CI sem valor próprio, então o CI agora notifica", () => {
    expect(instance(["HADES_NOTIFY_EV_PR=off"]).ctx.eventChannels("ci")).toBe("both");
  });

  test("dado o valor pr já gravado no CI, então continua aceito e segue o canal do review", () => {
    expect(instance(["HADES_NOTIFY_EV_PR=off", "HADES_NOTIFY_EV_CI=pr"]).ctx.eventChannels("ci")).toBe("off");
    expect(instance(["HADES_NOTIFY_EV_PR=phone", "HADES_NOTIFY_EV_CI=pr"]).ctx.eventChannels("ci")).toBe("phone");
  });
});

describe("lembrete de CI ainda vermelho", () => {
  const redForHours = async (config: Record<string, string>, hours: number): Promise<string[]> => {
    setEnv(config);
    const { tick, advance, sent } = instance([]);
    for (let h = 0; h <= hours; h++) {
      await tick([pr({ checks: failing("build") })]);
      advance(HOUR_MS);
    }
    return sent("ci");
  };

  test("dado o catálogo do kit, então o lembrete vem desligado (0)", () => {
    const row = readFileSync(join(ROOT, "kit/config.tsv"), "utf8").split("\n").find((l) => l.startsWith("HADES_NOTIFY_CI_REMIND_H\t"));
    expect(row?.split("\t")[1]).toBe("0");
  });

  test("dado o lembrete desligado, quando o CI fica vermelho por dois dias, então só o aviso original sai", async () => {
    expect(await redForHours({}, 48)).toHaveLength(1);
  });

  test("dado o lembrete de 4 h, quando o CI segue vermelho, então sai um lembrete a cada 4 h e o texto diz que é lembrete", async () => {
    const texts = await redForHours({ HADES_NOTIFY_CI_REMIND_H: "4" }, 9); // avisos em 0 h, 4 h e 8 h
    expect(texts).toHaveLength(3);
    const reminders = texts.filter((t) => t.includes("Lembrete"));
    expect(reminders).toHaveLength(2);
    expect(reminders.every((t) => t.includes("não é falha nova"))).toBe(true);
  });

  test("dado o lembrete ligado, quando o CI fica verde, então não há lembrete", async () => {
    setEnv({ HADES_NOTIFY_CI_REMIND_H: "1" });
    const { tick, advance, sent } = instance([]);
    await tick([pr({ checks: failing("build") })]);
    advance(HOUR_MS);
    await tick([pr()]);
    advance(5 * HOUR_MS);
    await tick([pr()]);
    expect(sent("ci")).toHaveLength(1);
  });
});
