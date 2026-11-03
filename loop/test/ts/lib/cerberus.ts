// Apoio das suítes do Cerberus: cenário sequencial coletado na carga do arquivo (cada passo depende do anterior, como no
// bash) e uma asserção por `want`/`has`, registrada como teste na ordem do original.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { want as wantEq } from "./rig";

type Check = { label: string; run: () => void };

export class Cases {
  private list: Check[] = [];
  want(label: string, expected: string | number, actual: string | number): void {
    this.list.push({ label, run: () => wantEq(label, expected, actual) });
  }
  /** `has`: o texto contém o trecho. */
  has(label: string, text: string, part: string): void {
    this.list.push({ label, run: () => expect(text, label).toContain(part) });
  }
  /** Um teste por asserção, na ordem em que o cenário as produziu. */
  register(): void {
    for (const c of this.list) test(c.label, c.run);
  }
  get size(): number { return this.list.length; }
}

/** `$(...)`: tira as quebras de linha do fim. */
export const sub = (s: string): string => s.replace(/\n+$/, "");

export const json = (s: string): any => JSON.parse(s); // eslint-disable-line @typescript-eslint/no-explicit-any

/** Veredito mínimo válido que uma guarda de teste imprime. */
export const ev = (resultado: string, onde: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ resultado, evidencia: [{ conferido: "caso do teste", onde }], ...extra });

/** Apaga do registro as guardas exec (as de teste entram depois). */
export function dropExecGuards(root: string): void {
  for (const cab of readdirSync(root, { withFileTypes: true })) {
    if (!cab.isDirectory()) continue;
    for (const f of readdirSync(join(root, cab.name))) {
      if (!f.endsWith(".json")) continue;
      const p = join(root, cab.name, f);
      if (json(readFileSync(p, "utf8")).tipo === "exec") rmSync(p, { force: true });
    }
  }
}

/** Guarda exec de teste: cabeça, id, momentos, corpo do script (bash) e campos extras do registro. */
export function writeGuard(root: string, cabeca: string, id: string, momentos: string[], body: string, extra: Record<string, unknown> = {}): void {
  const dir = join(root, cabeca);
  mkdirSync(join(dir, "checks"), { recursive: true });
  const sh = join(dir, "checks", `${id}.sh`);
  writeFileSync(sh, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(sh, 0o755);
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ titulo: "guarda de teste", momentos, tipo: "exec", cmd: [`checks/${id}.sh`], origem: "teste", ...extra }, null, 2) + "\n");
}
