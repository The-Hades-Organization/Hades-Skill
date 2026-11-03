// Guarda do tour por página (reference/panel.md §Tour por página): toda página do núcleo tem `pages/<id>.tour.tsx`, e todo
// passo aponta para um `data-tour-step-id` que existe no fonte da página ou traz `fallback`.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Páginas do núcleo que ainda não têm `.tour.tsx`. Cada lote tira as suas daqui (uma linha por página) ao entregar o tour;
 * a consolidação exige a lista vazia (`TOUR_REQUIRE_EMPTY=1 bun test loop/test/ts/painel-tour.test.ts`).
 */
export const TOUR_PENDING: readonly string[] = [];

const TOUR_SUFFIX = ".tour.tsx";
const ATTR = "data-tour-step-id";

interface RegisteredStep { id: string; fallback?: string }
interface RegisteredTour { steps: readonly RegisteredStep[] }
interface TourLogicShape { register(id: string, def: RegisteredTour): void }

/** Ids de alvo no fonte: as aspas na mesma linha de `data-tour-step-id` (cada id é uma palavra do atributo). */
export function tourTargetsIn(source: string): Set<string> {
  const ids = new Set<string>();
  for (const line of source.split("\n")) {
    if (!line.includes(ATTR)) continue;
    for (const quoted of line.matchAll(/(["'`])([^"'`]*)\1/g)) {
      for (const word of (quoted[2] ?? "").split(/\s+/)) if (word !== "" && word !== ATTR) ids.add(word);
    }
  }
  return ids;
}

const readIfFile = (file: string): string => (existsSync(file) && statSync(file).isFile() ? readFileSync(file, "utf8") : "");

/** Fonte da página: o arquivo dela e, se houver, a pasta com o mesmo nome (argos/, cerberus/). */
function pageSource(ui: string, id: string): string {
  const parts = [readIfFile(join(ui, "pages", `${id}.tsx`))];
  const dir = join(ui, id);
  if (existsSync(dir) && statSync(dir).isDirectory()) {
    for (const name of readdirSync(dir).sort()) if (name.endsWith(".tsx")) parts.push(readIfFile(join(dir, name)));
  }
  return parts.join("\n");
}

const transpiler = new Bun.Transpiler({ loader: "tsx" });

/**
 * Os tours que o arquivo registra, rodando o mesmo registro (tour-logic.tsx) que o navegador usa. O fonte é transpilado e
 * avaliado num escopo próprio a cada chamada, como o script clássico do navegador: o `import()` do bun guarda o módulo
 * por caminho (ignora a query) e uma segunda guarda no mesmo processo não veria o registro acontecer.
 */
async function registeredTours(ui: string, file: string): Promise<{ tours: Map<string, RegisteredTour>; error?: string }> {
  const tours = new Map<string, RegisteredTour>();
  try {
    await import(pathToFileURL(join(ui, "tour-logic.tsx")).href);
    const factory = (globalThis as unknown as { TourLogicFactory?: () => TourLogicShape }).TourLogicFactory;
    if (!factory) return { tours, error: "tour-logic.tsx não registrou TourLogicFactory" };
    const logic = factory();
    const core = { registerTour: (id: string, def: RegisteredTour) => { logic.register(id, def); tours.set(id, def); } };
    new Function("HadesCore", transpiler.transformSync(readFileSync(file, "utf8")))(core);
    return { tours };
  } catch (e) {
    return { tours, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Problemas do tour por página em `ui` (vazio = ok). `pending` é a lista de páginas ainda sem tour. */
export async function tourGuardProblems(ui: string, pending: readonly string[] = TOUR_PENDING): Promise<string[]> {
  const problems: string[] = [];
  const pagesDir = join(ui, "pages");
  const names = existsSync(pagesDir) ? readdirSync(pagesDir) : [];
  const pages = names.filter((n) => n.endsWith(".tsx") && !n.endsWith(TOUR_SUFFIX)).map((n) => n.slice(0, -".tsx".length)).sort();
  for (const id of pending) if (!pages.includes(id)) problems.push(`TOUR_PENDING lista "${id}", que não é página do núcleo`);
  for (const id of pages) {
    const tourFile = join(pagesDir, `${id}${TOUR_SUFFIX}`);
    const has = existsSync(tourFile);
    if (!has) {
      if (!pending.includes(id)) problems.push(`página ${id}: falta pages/${id}${TOUR_SUFFIX}`);
      continue;
    }
    if (pending.includes(id)) problems.push(`página ${id}: já tem tour, tire "${id}" de TOUR_PENDING`);
    const { tours, error } = await registeredTours(ui, tourFile);
    if (error !== undefined) { problems.push(`página ${id}: ${id}${TOUR_SUFFIX} não registra: ${error}`); continue; }
    const tour = tours.get(id);
    if (!tour) { problems.push(`página ${id}: ${id}${TOUR_SUFFIX} não chama registerTour("${id}", …)`); continue; }
    const targets = tourTargetsIn(pageSource(ui, id));
    for (const step of tour.steps) {
      if (step.id === `tour-${id}` || targets.has(step.id) || (step.fallback ?? "").trim() !== "") continue;
      problems.push(`página ${id}: o passo "${step.id}" aponta para ${ATTR} que não existe no fonte da página e não tem fallback`);
    }
  }
  return problems;
}
