import { readdirSync } from "node:fs";
import { join } from "node:path";

/** Marcador do index.html onde entram os tours por página (`ui/pages/<id>.tour.tsx`), sem lista à mão por página. */
export const TOURS_MARKER = "<!-- page-tours -->";
const TOUR_FILE = /^([\w-]+)\.tour\.tsx$/;

/** `<script>` de cada tour de página, em ordem alfabética; o servidor serve `x.tour.js` a partir de `x.tour.tsx`. */
export function tourScriptTags(ui: string): string {
  let names: string[];
  try {
    names = readdirSync(join(ui, "pages"));
  } catch {
    return ""; // UI sem pasta de páginas (instalação parcial): o painel sobe sem tours
  }
  return names
    .map((name) => TOUR_FILE.exec(name)?.[1])
    .filter((id): id is string => id !== undefined)
    .sort()
    .map((id) => `<script src="/ui/pages/${id}.tour.js"></script>`)
    .join("\n");
}
