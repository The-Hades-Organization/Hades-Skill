// difflib.unified_diff do Python (SequenceMatcher de Ratcliff/Obershelp com a heurística de elementos populares): o diff do
// `project-init` é lido pelo dono e comparado com o do original, então o alinhamento tem de ser o mesmo, não só um diff válido.

type Match = [number, number, number];
type Opcode = ["equal" | "replace" | "delete" | "insert", number, number, number, number];

const AUTOJUNK_MIN_LENGTH = 200;
const CONTEXT_LINES = 3;

class SequenceMatcher {
  private readonly b2j = new Map<string, number[]>();

  private readonly a: string[];
  private readonly b: string[];

  constructor(a: string[], b: string[]) {
    this.a = a;
    this.b = b;
    this.b.forEach((line, index) => {
      const indices = this.b2j.get(line);
      if (indices) indices.push(index);
      else this.b2j.set(line, [index]);
    });
    if (this.b.length >= AUTOJUNK_MIN_LENGTH) {
      const limit = Math.floor(this.b.length / 100) + 1;
      for (const [line, indices] of [...this.b2j]) if (indices.length > limit) this.b2j.delete(line);
    }
  }

  private longestMatch(alo: number, ahi: number, blo: number, bhi: number): Match {
    let [besti, bestj, bestsize] = [alo, blo, 0];
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const next = new Map<number, number>();
      for (const j of this.b2j.get(this.a[i] as string) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        next.set(j, k);
        if (k > bestsize) [besti, bestj, bestsize] = [i - k + 1, j - k + 1, k];
      }
      j2len = next;
    }
    while (besti > alo && bestj > blo && this.a[besti - 1] === this.b[bestj - 1]) [besti, bestj, bestsize] = [besti - 1, bestj - 1, bestsize + 1];
    while (besti + bestsize < ahi && bestj + bestsize < bhi && this.a[besti + bestsize] === this.b[bestj + bestsize]) bestsize++;
    return [besti, bestj, bestsize];
  }

  private matchingBlocks(): Match[] {
    const queue: [number, number, number, number][] = [[0, this.a.length, 0, this.b.length]];
    const blocks: Match[] = [];
    while (queue.length > 0) {
      const [alo, ahi, blo, bhi] = queue.pop() as [number, number, number, number];
      const found = this.longestMatch(alo, ahi, blo, bhi);
      const [i, j, k] = found;
      if (k === 0) continue;
      blocks.push(found);
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
    blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
    const merged: Match[] = [];
    let [i1, j1, k1] = [0, 0, 0];
    for (const [i2, j2, k2] of blocks) {
      if (i1 + k1 === i2 && j1 + k1 === j2) k1 += k2;
      else {
        if (k1) merged.push([i1, j1, k1]);
        [i1, j1, k1] = [i2, j2, k2];
      }
    }
    if (k1) merged.push([i1, j1, k1]);
    merged.push([this.a.length, this.b.length, 0]);
    return merged;
  }

  private opcodes(): Opcode[] {
    let [i, j] = [0, 0];
    const codes: Opcode[] = [];
    for (const [ai, bj, size] of this.matchingBlocks()) {
      const tag = i < ai && j < bj ? "replace" : i < ai ? "delete" : j < bj ? "insert" : undefined;
      if (tag) codes.push([tag, i, ai, j, bj]);
      [i, j] = [ai + size, bj + size];
      if (size) codes.push(["equal", i - size, i, j - size, j]);
    }
    return codes;
  }

  groupedOpcodes(context: number = CONTEXT_LINES): Opcode[][] {
    const codes = this.opcodes();
    if (codes.length === 0) codes.push(["equal", 0, 1, 0, 1]);
    const first = codes[0] as Opcode;
    if (first[0] === "equal") codes[0] = [first[0], Math.max(first[1], first[2] - context), first[2], Math.max(first[3], first[4] - context), first[4]];
    const last = codes[codes.length - 1] as Opcode;
    if (last[0] === "equal") codes[codes.length - 1] = [last[0], last[1], Math.min(last[2], last[1] + context), last[3], Math.min(last[4], last[3] + context)];
    const groups: Opcode[][] = [];
    let group: Opcode[] = [];
    for (const [tag, i1Start, i2, j1Start, j2] of codes) {
      let [i1, j1] = [i1Start, j1Start];
      if (tag === "equal" && i2 - i1 > context * 2) {
        group.push([tag, i1, Math.min(i2, i1 + context), j1, Math.min(j2, j1 + context)]);
        groups.push(group);
        group = [];
        [i1, j1] = [Math.max(i1, i2 - context), Math.max(j1, j2 - context)];
      }
      group.push([tag, i1, i2, j1, j2]);
    }
    if (group.length > 0 && !(group.length === 1 && (group[0] as Opcode)[0] === "equal")) groups.push(group);
    return groups;
  }
}

function formatRange(start: number, stop: number): string {
  let beginning = start + 1;
  const length = stop - start;
  if (length === 1) return String(beginning);
  if (length === 0) beginning -= 1;
  return `${beginning},${length}`;
}

/** difflib.unified_diff(a, b, fromfile, tofile) com n=3 e lineterm="\n"; as linhas vêm com o fim de linha (keepends). */
export function unifiedDiff(a: string[], b: string[], fromFile: string, toFile: string): string[] {
  const out: string[] = [];
  for (const group of new SequenceMatcher(a, b).groupedOpcodes()) {
    if (out.length === 0) out.push(`--- ${fromFile}\n`, `+++ ${toFile}\n`);
    const first = group[0] as Opcode;
    const last = group[group.length - 1] as Opcode;
    out.push(`@@ -${formatRange(first[1], last[2])} +${formatRange(first[3], last[4])} @@\n`);
    for (const [tag, i1, i2, j1, j2] of group) {
      if (tag === "equal") {
        for (const line of a.slice(i1, i2)) out.push(` ${line}`);
        continue;
      }
      if (tag === "replace" || tag === "delete") for (const line of a.slice(i1, i2)) out.push(`-${line}`);
      if (tag === "replace" || tag === "insert") for (const line of b.slice(j1, j2)) out.push(`+${line}`);
    }
  }
  return out;
}
