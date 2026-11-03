// `hades env-watch` (kit/watch.sh): plantão do ambiente, emite uma linha por evento acionável, sem parar.
//   HEADS-CHANGED <detalhe>  PR nova/fechada/head movido (checado a cada HADES_WATCH_PR_EVERY s)
//   CEDE <ticket>            gate pesado de outro agente esperando >2 min sem pesado rodando e sem memória
//   GATES-CLEAR              Hades pausado e nenhum pesado na fila/rodando (pode retomar)
import { join } from "node:path";
import { hadesBase } from "../lib/base.ts";
import { isDir, isFile, listDir, readText } from "../lib/fs.ts";
import { stateDir } from "../lib/kit.ts";
import { out } from "../lib/output.ts";
import { memAvailableMb, run } from "../lib/proc.ts";
import { headLines } from "./pr-set.ts";
import { writeFileSync } from "node:fs";

const TICK_MS = Number(process.env.HADES_WATCH_TICK_MS || 30_000); // só o teste encurta o intervalo
const WAIT_BEFORE_CEDE_S = 120;
const HEAVY_KINDS = /^(test|unit|test:unit|integration|test:integration|test-integration|gate)$/;
const HADES_LABEL_PREFIX = "hades-";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const num = (key: string): number => Number(process.env[key] || 0);

/** O que o `diff` do original mostrava: linhas só do antigo (`<`) e só do novo (`>`), na ordem do diff, tab e quebra viram espaço. */
export function headsDiff(before: string[], after: string[]): string {
  const lcs: number[][] = Array.from({ length: before.length + 1 }, () => new Array<number>(after.length + 1).fill(0));
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      lcs[i]![j] = before[i] === after[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const parts: string[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      i++;
      j++;
    } else if (j >= after.length || (i < before.length && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      parts.push(`< ${before[i++]}`);
    } else {
      parts.push(`> ${after[j++]}`);
    }
  }
  return parts.map((line) => `${line.replaceAll("\t", " ")} `).join("");
}

function sortedLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function currentHeads(): string {
  try {
    return headLines().join("\n");
  } catch {
    return ""; // sem gh ou sem PRs: o original calava (2>/dev/null) e pulava a checagem
  }
}

function field(text: string, key: string): string {
  const m = new RegExp(`^${key}=(.*)$`, "m").exec(text);
  return m?.[1] ?? "";
}

function sinceSeconds(stamp: string, nowS: number): number {
  const r = run("date", ["-d", stamp, "+%s"]);
  return r.status === 0 && /^\d+$/.test(r.stdout.trim()) ? Number(r.stdout.trim()) : nowS;
}

interface Queue {
  heavyRunning: boolean;
  waiting: string;
}

function readQueue(locks: string, nowS: number): Queue {
  const queue: Queue = { heavyRunning: false, waiting: "" };
  const dir = join(locks, "gate-queue");
  for (const name of listDir(dir).filter((n) => n.endsWith(".t"))) {
    const text = readText(join(dir, name));
    if (text === undefined) continue;
    const label = field(text, "label");
    if (!HEAVY_KINDS.test(field(text, "kind")) || label.startsWith(HADES_LABEL_PREFIX)) continue;
    const state = field(text, "state");
    if (state === "running") queue.heavyRunning = true;
    else if (state === "waiting" && nowS - sinceSeconds(field(text, "since"), nowS) > WAIT_BEFORE_CEDE_S) queue.waiting = label;
  }
  return queue;
}

export async function envWatchCommand(): Promise<number> {
  const dir = stateDir();
  const locks = process.env.LOCKS ?? "";
  // o pr-set para a stack na base do perfil
  process.env.HADES_BASE_BRANCH = hadesBase(process.env.HADES_WT ?? "").replace(/^origin\//, "");
  const lastDiffFile = join(dir, "logs", "watch.last-diff");
  let lastDiff = (readText(lastDiffFile) ?? "").replace(/\n+$/, "");
  let lastPr = 0;
  let ceded = false;
  for (;;) {
    const nowS = Math.trunc(Date.now() / 1000);
    if (nowS - lastPr >= num("HADES_WATCH_PR_EVERY")) {
      lastPr = nowS;
      const cur = currentHeads();
      if (cur !== "") {
        // sem last-build.heads o `sort` do original dava vazio: toda PR atual conta como nova
        const diff = headsDiff(sortedLines(readText(join(dir, "last-build.heads")) ?? ""), cur.split("\n"));
        if (diff !== "" && diff !== lastDiff) out(`HEADS-CHANGED ${diff}`);
        lastDiff = diff;
        if (isDir(join(dir, "logs"))) writeFileSync(lastDiffFile, diff);
      }
    }
    const { heavyRunning, waiting } = readQueue(locks, nowS);
    const avail = memAvailableMb();
    // HADES_CEDE=0 (ou $D/cede.disabled, o jeito antigo) = o dono suspendeu a regra de ceder
    if (num("HADES_CEDE") !== 0 && !isFile(join(dir, "cede.disabled")) && !ceded && waiting !== "" && !heavyRunning && avail < num("HADES_CEDE_AVAIL_MB")) {
      out(`CEDE ${waiting} (MemAvailable ${avail} MB)`);
      ceded = true;
    }
    if (ceded && !heavyRunning && waiting === "") {
      out("GATES-CLEAR");
      ceded = false;
    }
    await sleep(TICK_MS);
  }
}
