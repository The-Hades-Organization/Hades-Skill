// `hades rtk status|apply`: resumidores por stack entregues pelo rtk (reference/rtk.md). Só o dono confia (rtk trust).
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "../lib/proc.ts";
import { EXIT, die, out } from "../lib/output.ts";
import { FILTERS_REL, applyWorktree, dataDirOf, planWorktree, rtkBinary, settingsFor, trustState } from "../lib/rtk-filters.ts";

export const HELP = `Resumidores por stack entregues pelo rtk.
Uso: hades rtk status [<dir>] [--json]   rtk, filtros que valem para o worktree, confiança e ajuste (HADES_RTK_*)
     hades rtk apply [<dir>] [--trust]   gera (ou remove, com HADES_RTK_FILTERS=off) o ${FILTERS_REL} do worktree
--trust confia no que gerou (rtk trust --yes): é do dono; o hook barra a opção vinda das ferramentas do Claude.`;

const topOf = (dir: string): string => {
  const top = run("git", ["-C", dir, "rev-parse", "--show-toplevel"]);
  return top.status === 0 ? top.stdout.trim() : dir;
};

export function rtkCommand(args: string[]): number {
  const [sub, ...rest] = args;
  const json = rest.includes("--json");
  const trust = rest.includes("--trust");
  const dir = topOf(rest.find((a) => !a.startsWith("--")) ?? process.cwd());
  const settings = settingsFor(dataDirOf());
  const rtk = rtkBinary();
  if (sub === "apply") {
    const result = applyWorktree(dir, settings, { trust, home: homedir() });
    out(`${dir}: ${result.action} (${result.why})${result.filters.length ? ` · ${result.filters.join(",")}` : ""}${result.trusted ? ` · trust: ${result.trusted}` : ""}`);
    return EXIT.ok;
  }
  if (sub === "status") {
    const plan = planWorktree(dir, settings, rtk);
    const state = rtk ? trustState(dir, rtk) : "";
    const view = { rtk: rtk ?? null, mode: settings.mode, offStacks: settings.offStacks, offFilters: settings.offFilters, worktree: dir, action: plan.action, why: plan.why, stacks: plan.stacks, filters: plan.filters, trust: state, recallDb: process.env.RTK_RECALL_DB ?? "", teeDir: process.env.RTK_TEE_DIR ?? "", file: join(dir, FILTERS_REL) };
    if (json) out(JSON.stringify(view));
    else {
      out(`rtk: ${rtk ? `${rtk.version || "?"} (${rtk.path})` : "ausente"} · HADES_RTK_FILTERS=${settings.mode}`);
      out(`worktree ${dir}: ${plan.action} (${plan.why}) · stacks ${plan.stacks.join(",") || "—"} · filtros ${plan.filters.join(",") || "—"} · confiança ${state || "—"}`);
    }
    return EXIT.ok;
  }
  return sub === undefined || sub === "--help" ? (out(HELP), EXIT.ok) : die(`rtk: subcomando desconhecido '${sub}'\n${HELP}`);
}
