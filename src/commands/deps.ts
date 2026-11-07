import { EXIT, die, out, warn } from "../lib/output.ts";
import { checkAll, need } from "../lib/deps.ts";
import { IMPECCABLE_INSTALL, IMPECCABLE_LOSS, impeccableStatus } from "../lib/impeccable.ts";

const USAGE = "deps [--json] | deps need <id>…";

function table(): number {
  const statuses = checkAll();
  for (const s of statuses) {
    const mark = s.found ? "✓" : s.level === "error" ? "✗" : "!";
    out(`${mark} ${s.id}${s.version ? `  ${s.version}` : ""}${s.found ? "" : `  — falta: ${s.install}`}`);
  }
  const imp = impeccableStatus();
  out(imp.found ? `✓ impeccable  ${imp.version}  (skill opcional)` : `! impeccable  — falta (opcional): ${IMPECCABLE_INSTALL}. ${IMPECCABLE_LOSS}`);
  const missing = statuses.filter((s) => !s.found);
  return missing.some((s) => s.level === "error") ? EXIT.fail : EXIT.ok;
}

/** O que o painel e o doctor consomem: contrato estável (version 1), uma entrada por dependência do registro. */
function json(): number {
  const items = checkAll().map((s) => ({
    id: s.id,
    command: s.command,
    level: s.level,
    found: s.found,
    path: s.path,
    version: s.version,
    install: s.install,
    purpose: s.purpose,
  }));
  const imp = impeccableStatus();
  const optionalSkills = [{ id: "impeccable", found: imp.found, path: imp.path, version: imp.version, install: IMPECCABLE_INSTALL, loss: IMPECCABLE_LOSS }];
  out(JSON.stringify({ version: 1, missing: items.filter((i) => !i.found).map((i) => i.id), items, optionalSkills }));
  return EXIT.ok;
}

export function depsCommand(args: string[]): number {
  const [sub, ...rest] = args;
  if (sub === undefined) return table();
  if (sub === "--json") return json();
  if (sub === "need") {
    if (rest.length === 0) return die(USAGE);
    for (const id of rest) need(id);
    return EXIT.ok;
  }
  warn(`uso: hades ${USAGE}`);
  return EXIT.usage;
}

