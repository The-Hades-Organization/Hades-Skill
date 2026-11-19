// Vigia dos arquivos `.cardinal` do canvas (reference/argos.md §Nó cardinal): avisa quando um arquivo muda por fora da rota
// (app nativo do Cardinal, editor, `git checkout`). A mudança é decidida pela revisão (hash do conteúdo), conferida só quando
// o carimbo (mtime e tamanho) muda. `fs.watch` acelera o aviso; a varredura periódica é a garantia (cobre pasta criada depois,
// rename e sistema de arquivos que não entrega evento). Gravação feita pela própria rota entra por `learn`, sem eco.
import { type FSWatcher, lstatSync, readFileSync, watch } from "node:fs";
import { dirname } from "node:path";
import { type CardinalFileRef, revisionOf } from "./canvas-cardinal.ts";
import { CARDINAL_LIMITS } from "../lib/canvas-cardinal.ts";
import { log } from "./log.ts";

/** Varredura de reserva: barata (um `lstat` por arquivo conhecido). */
const SWEEP_MS = 2000;
/** Eventos do `fs.watch` vêm em rajada (tmp + rename): espera assentar antes de conferir. */
const DEBOUNCE_MS = 80;

export interface CardinalWatchOptions {
  /** Os arquivos conhecidos agora (`createCanvasCardinalRoutes().files`). */
  files(): CardinalFileRef[];
  /** O arquivo `name` está agora na revisão `rev` (`null` = saiu do disco), por escrita de fora da rota. */
  onChange(name: string, rev: string | null): void;
  sweepMs?: number;
  debounceMs?: number;
  /** Desliga o `fs.watch` (teste que só quer a varredura determinística). */
  noFsWatch?: boolean;
}

export interface CardinalWatch {
  /** Começa a vigiar: guarda o estado atual como base (sem avisar) e arma os temporizadores. */
  start(): void;
  /** A rota gravou `name` na revisão `rev`: vira a base, sem aviso do vigia. */
  learn(name: string, rev: string): void;
  /** Relê a lista de arquivos e rearma o `fs.watch` das pastas (depois de adotar um arquivo). */
  refresh(): void;
  /** Confere agora, uma vez; devolve quantos avisos saíram. A varredura e o `fs.watch` chamam isto. */
  check(): number;
  stop(): void;
}

interface Known {
  stamp: string | null;
  rev: string | null;
}

export function createCardinalWatch(options: CardinalWatchOptions): CardinalWatch {
  const known = new Map<string, Known>();
  const watchers = new Map<string, FSWatcher>();
  let sweep: ReturnType<typeof setInterval> | undefined;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let started = false;

  const stampOf = (file: string): string | null => {
    try {
      const info = lstatSync(file);
      return info.isFile() ? `${info.mtimeMs}:${info.size}` : null;
    } catch {
      return null;
    }
  };

  /** Revisão do arquivo agora; `null` se não existe, não é arquivo comum, passa do teto ou não abre. */
  const revOf = (file: string): string | null => {
    try {
      const info = lstatSync(file);
      if (!info.isFile() || info.size > CARDINAL_LIMITS.bodyBytes) return null;
      return revisionOf(readFileSync(file));
    } catch {
      return null;
    }
  };

  function arm(refs: CardinalFileRef[]): void {
    if (options.noFsWatch) return;
    const dirs = new Set(refs.map((ref) => dirname(ref.file)));
    for (const [dir, watcher] of watchers) {
      if (dirs.has(dir)) continue;
      watcher.close();
      watchers.delete(dir);
    }
    for (const dir of dirs) {
      if (watchers.has(dir)) continue;
      try {
        const watcher = watch(dir, { persistent: false }, () => schedule());
        watcher.on("error", () => {
          watcher.close();
          watchers.delete(dir);
        });
        watchers.set(dir, watcher);
      } catch {
        // pasta que não existe ainda: a varredura cobre até ela aparecer
      }
    }
  }

  function schedule(): void {
    if (pending !== undefined) return;
    pending = setTimeout(() => {
      pending = undefined;
      check();
    }, options.debounceMs ?? DEBOUNCE_MS);
    pending.unref?.();
  }

  function baseline(refs: CardinalFileRef[]): void {
    for (const ref of refs) {
      if (known.has(ref.name)) continue;
      const stamp = stampOf(ref.file);
      known.set(ref.name, { stamp, rev: stamp === null ? null : revOf(ref.file) });
    }
  }

  function check(): number {
    const refs = options.files();
    let sent = 0;
    const present = new Set<string>();
    for (const ref of refs) {
      present.add(ref.name);
      const before = known.get(ref.name);
      const stamp = stampOf(ref.file);
      if (before === undefined) {
        // nome que acabou de aparecer (arquivo criado por fora): é mudança, não base
        const rev = stamp === null ? null : revOf(ref.file);
        known.set(ref.name, { stamp, rev });
        if (rev !== null) {
          sent++;
          emit(ref.name, rev);
        }
        continue;
      }
      if (stamp === before.stamp) continue;
      const rev = stamp === null ? null : revOf(ref.file);
      before.stamp = stamp;
      if (rev === before.rev) continue;
      before.rev = rev;
      sent++;
      emit(ref.name, rev);
    }
    for (const [name, before] of [...known]) {
      if (present.has(name)) continue;
      // saiu da lista (arquivo da pasta padrão apagado por fora): avisa se ainda havia conteúdo conhecido
      known.delete(name);
      if (before.rev !== null) {
        sent++;
        emit(name, null);
      }
    }
    arm(refs);
    return sent;
  }

  function emit(name: string, rev: string | null): void {
    try {
      options.onChange(name, rev);
    } catch (error) {
      log("warn", "aviso de diagrama falhou", { name, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    start() {
      if (started) return;
      started = true;
      const refs = options.files();
      baseline(refs);
      arm(refs);
      sweep = setInterval(check, options.sweepMs ?? SWEEP_MS);
      sweep.unref?.();
    },
    learn(name, rev) {
      const ref = options.files().find((candidate) => candidate.name === name);
      known.set(name, { stamp: ref ? stampOf(ref.file) : null, rev });
    },
    refresh() {
      if (!started) return;
      const refs = options.files();
      baseline(refs);
      arm(refs);
    },
    check,
    stop() {
      started = false;
      if (sweep !== undefined) clearInterval(sweep);
      if (pending !== undefined) clearTimeout(pending);
      sweep = undefined;
      pending = undefined;
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
      known.clear();
    },
  };
}
