// Slice carregado no gerenciador (systemctl --user show), não só o arquivo em ~/.config/systemd/user: sem o daemon-reload
// (ou com SKIP_SYSTEMD=1 no install) o arquivo existe e os serviços sobem sem teto de memória.
import { run } from "./proc.ts";

const BYTES_PER_MIB = 1048576;
const SHOW_TIMEOUT_MS = 5000;

export interface LoadedSlice {
  loadState: string;
  /** bytes; undefined quando o gerenciador devolve `infinity` ou nada */
  memoryMaxBytes: number | undefined;
}

export function parseSliceShow(text: string): LoadedSlice {
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) fields.set(line.slice(0, eq), line.slice(eq + 1).trim());
  }
  const max = fields.get("MemoryMax") ?? "";
  return { loadState: fields.get("LoadState") ?? "", memoryMaxBytes: /^[0-9]+$/.test(max) ? Number(max) : undefined };
}

/** O que o systemd carregou para o slice; undefined quando o `show` não responde (sem sessão de usuário). */
export function showSlice(slice: string): LoadedSlice | undefined {
  const shown = run("systemctl", ["--user", "show", `${slice}.slice`, "-p", "LoadState", "-p", "MemoryMax"], { timeoutMs: SHOW_TIMEOUT_MS });
  if (shown.status !== 0) return undefined;
  const loaded = parseSliceShow(shown.stdout);
  return loaded.loadState === "" ? undefined : loaded;
}

export type SliceVerdict = "carregado" | "nao-carregado" | "teto-diferente";

/** `expectedMib` 0 = sem teto configurado para comparar: só a carga conta. */
export function judgeSlice(loaded: LoadedSlice, expectedMib: number): SliceVerdict {
  if (loaded.loadState !== "loaded") return "nao-carregado";
  if (expectedMib > 0 && loaded.memoryMaxBytes !== expectedMib * BYTES_PER_MIB) return "teto-diferente";
  return "carregado";
}
