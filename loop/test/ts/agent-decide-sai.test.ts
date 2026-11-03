// `hades agent decide` tem de terminar sozinho: o orquestrador o roda e espera o código de saída. Subprocesso real com
// timeout, porque o defeito (processo que fica vivo depois de imprimir DECIDIDO) não aparece chamando decide() em-processo.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, openSync, closeSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCK_EX, LOCK_NB, sysFlock } from "../../../src/lib/flock";
import { BUN, SKILL } from "./lib/rig";

const T = mkdtempSync(join(tmpdir(), "hades-decide-sai-"));
const HOME = join(T, "home");
const DATA = join(T, "data");
const PLAN = join(T, "plano.md");
const CLI = join(SKILL, "src/cli.ts");
const PRAZO_MS = 20_000;

beforeAll(() => {
  mkdirSync(join(HOME, ".claude/hades"), { recursive: true });
  mkdirSync(join(DATA, "notify"), { recursive: true });
  writeFileSync(join(HOME, ".claude/hades/instance"), `${DATA}\n`);
  writeFileSync(join(DATA, "config.sh"), "");
  writeFileSync(join(DATA, "config.tsv"), readFileSync(join(SKILL, "kit/config.tsv")));
  writeFileSync(join(DATA, "config.env"), ["HADES_ORCH_AUTONOMY=3", "HADES_NOTIFY=1", "HADES_NOTIFY_NTFY=0", "HADES_NOTIFY_DESKTOP=0", ""].join("\n"));
  writeFileSync(PLAN, "# Plano\n");
});
afterAll(() => rmSync(T, { recursive: true, force: true }));

async function decideEmSubprocesso(extraEnv: Record<string, string> = {}): Promise<{ code: number | null; timedOut: boolean; stdout: string }> {
  const proc = Bun.spawn([BUN, CLI, "agent", "decide", PLAN, "--level-needed", "1", "--question", "reestimar?", "--chosen", "reestimar"], {
    env: { PATH: process.env.PATH ?? "", HOME, HADES_DATA: DATA, HADES_WORK_ROOT: join(T, "work"), HADES_NOTIFY_LOCK_WAIT_S: "1", ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, PRAZO_MS);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code: timedOut ? null : code, timedOut, stdout: await new Response(proc.stdout).text() };
}

describe("hades agent decide termina", () => {
  test("com o notify ligado e o lock livre, sai 0 depois de DECIDIDO", async () => {
    const r = await decideEmSubprocesso();
    expect(r.stdout).toContain("DECIDIDO");
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
  }, PRAZO_MS + 5_000);

  test("com o lock do notify preso por outro processo, desiste da notificação no prazo e sai 0", async () => {
    const fd = openSync(join(DATA, "notify", ".lock"), "a");
    expect(sysFlock()(fd, LOCK_EX | LOCK_NB)).toBe(0);
    try {
      const r = await decideEmSubprocesso();
      expect(r.stdout).toContain("DECIDIDO");
      expect(r.timedOut).toBe(false);
      expect(r.code).toBe(0);
    } finally {
      closeSync(fd);
    }
  }, PRAZO_MS + 5_000);
});
