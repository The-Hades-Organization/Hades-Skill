// Predefinições dos terminais criados no canvas (reference/argos.md §Terminais criados no canvas): agente, modelo,
// esforço, papel e a aparência sugerida ao nó, em `$D/argos/presets.json` (`{ presets: ArgosPresetEntry[] }`).
// Campo ausente segue o padrão global; a aparência é só o valor inicial do nó (o nó é dono dela depois).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  ARGOS_ERROR_CODES, agentOf, ArgosError, colorOf, effortOf, modelOf, optional, shortText, slugFormatOf, slugify, uniqueSlug,
} from "./argos-roles.ts";

export type ArgosPreset = {
  name: string; agent: string; model?: string; effort?: string; icon?: string; color?: string; theme?: string; font?: string;
  /** slug de papel */
  role?: string;
};
export type ArgosPresetEntry = ArgosPreset & { slug: string };

export const PRESET_LIMITS = { name: 60, icon: 32, theme: 32, font: 64, presets: 100, fileBytes: 256 * 1024 } as const;
const THEME_PATTERN = /^[A-Za-z0-9][\w-]{0,31}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function themeOf(value: unknown): string {
  if (typeof value !== "string" || !THEME_PATTERN.test(value)) throw new ArgosError(ARGOS_ERROR_CODES.invalid, "tema inválido (identificador de até 32 caracteres)");
  return value;
}

/** Valida uma predefinição vinda de fora; devolve só os campos do contrato, sem os ausentes. */
export function validatePreset(raw: unknown): ArgosPreset {
  if (!isRecord(raw)) throw new ArgosError(ARGOS_ERROR_CODES.invalid, "predefinição tem de ser um objeto");
  const model = optional(raw.model, modelOf);
  const effort = optional(raw.effort, effortOf);
  const icon = optional(raw.icon, (v) => shortText(v, "ícone", PRESET_LIMITS.icon));
  const color = optional(raw.color, (v) => colorOf(v));
  const theme = optional(raw.theme, themeOf);
  const font = optional(raw.font, (v) => shortText(v, "fonte", PRESET_LIMITS.font));
  const role = optional(raw.role, slugFormatOf);
  const preset: ArgosPreset = {
    name: shortText(raw.name, "nome da predefinição", PRESET_LIMITS.name), agent: agentOf(raw.agent),
    ...(model !== undefined && { model }), ...(effort !== undefined && { effort }), ...(icon !== undefined && { icon }),
    ...(color !== undefined && { color }), ...(theme !== undefined && { theme }), ...(font !== undefined && { font }),
    ...(role !== undefined && { role }),
  };
  return preset;
}

export interface PresetStore {
  list(): ArgosPresetEntry[];
  get(slug: string): ArgosPresetEntry | undefined;
  /** Cria (sem slug) ou atualiza (com slug existente; senão `not-found`). */
  save(preset: unknown, slug?: string): ArgosPresetEntry;
  remove(slug: string): void;
}

/**
 * As predefinições em `file`. Leitura e escrita síncronas: no laço de eventos do painel, ler-mudar-gravar não intercala
 * com outra requisição. Arquivo ilegível é erro alto (nunca vira lista vazia que a próxima gravação apagaria).
 */
export function createPresetStore(file: string): PresetStore {
  function load(): ArgosPresetEntry[] {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (text.length > PRESET_LIMITS.fileBytes) throw new Error("presets.json grande demais");
    const doc: unknown = JSON.parse(text);
    if (!isRecord(doc) || !Array.isArray(doc.presets)) throw new Error("presets.json sem a lista presets");
    return doc.presets.map((entry: unknown) => {
      if (!isRecord(entry)) throw new Error("presets.json com entrada que não é objeto");
      return { ...validatePreset(entry), slug: slugFormatOf(entry.slug) };
    });
  }

  function store(presets: ArgosPresetEntry[]): void {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ presets }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  }

  const notFound = (): ArgosError => new ArgosError(ARGOS_ERROR_CODES.notFound, "predefinição inexistente");

  return {
    list: load,
    get: (slug) => load().find((p) => p.slug === slug),
    save(raw, slug) {
      const preset = validatePreset(raw);
      const presets = load();
      if (slug !== undefined) {
        const at = presets.findIndex((p) => p.slug === slugFormatOf(slug));
        if (at < 0) throw notFound();
        const entry = { ...preset, slug };
        store(presets.map((p, i) => (i === at ? entry : p)));
        return entry;
      }
      if (presets.length >= PRESET_LIMITS.presets) throw new ArgosError(ARGOS_ERROR_CODES.invalid, `limite de ${PRESET_LIMITS.presets} predefinições`);
      const entry = { ...preset, slug: uniqueSlug(slugify(preset.name, "predefinicao"), new Set(presets.map((p) => p.slug))) };
      store([...presets, entry]);
      return entry;
    },
    remove(slug) {
      const presets = load();
      if (!presets.some((p) => p.slug === slugFormatOf(slug))) throw notFound();
      store(presets.filter((p) => p.slug !== slug));
    },
  };
}
