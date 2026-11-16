// Classificação de OOM de um scope do gate: o rc que o comando devolve não basta (o nx sai 130 com o worker do esbuild morto).
export const OOM_SIGNAL_RCS: readonly number[] = [137, 143];
const OOM_RC = 137;

/** `oom_kill N` do `memory.events` do cgroup (hierárquico: conta os descendentes do scope). */
export function oomKillsOf(memoryEvents: string | undefined): number {
  const match = /^oom_kill\s+([0-9]+)$/m.exec(memoryEvents ?? "");
  return match === null ? 0 : Number(match[1]);
}

/** Linhas do journal do usuário que dizem oom-kill do scope (só as do `unit`, nunca de outro gate). */
export function journalOomLines(log: string, unit: string): string[] {
  return log.split("\n").filter((line) => line.includes(unit) && /oom-kill/.test(line));
}

/** Saída que não é 0 nem sinal, com OOM comprovado no scope, vira 137: o chamador não confunde com gate reprovado. */
export function rcAfterOom(rc: number, oomed: boolean): number {
  return oomed && rc !== 0 && !OOM_SIGNAL_RCS.includes(rc) ? OOM_RC : rc;
}
