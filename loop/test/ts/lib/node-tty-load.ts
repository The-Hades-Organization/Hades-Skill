// Carrega o script clássico do terminal do nó (argos/node-tty.tsx) num escopo próprio, com um HadesCore de mentira, e devolve
// `window.ArgosNodeTty`. Sem DOM: serve às funções puras do nó (translateKey, createTextInput, wheelStep…).
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { CANVAS_UI_BUNDLE, createCanvasModuleBundler, createUiTranspiler } from "../../../../src/panel/ui-transpile";

const uiDir = join(import.meta.dir, "../../../../kit/panel/ui");
type Dict = Record<string, any>;

let loaded: Promise<Dict> | null = null;
export function loadNodeTty(): Promise<Dict> {
  loaded ??= (async () => {
    const mod: { exports: any } = { exports: {} };
    new Function("exports", "module", readFileSync(join(uiDir, "vendor/react.js"), "utf8"))(mod.exports, mod);
    const bundle = await createCanvasModuleBundler(join(import.meta.dir, "../../../../src/lib")).bundle(CANVAS_UI_BUNDLE);
    const holder: Dict = {};
    new Function("globalThis", bundle as string)(holder);
    const HadesCore = {
      useState: (v: unknown) => [typeof v === "function" ? (v as () => unknown)() : v, () => undefined],
      useEffect: () => undefined, useRef: (v: unknown) => ({ current: v }), cn: (...a: unknown[]) => a.filter(Boolean).join(" "),
    };
    const scope: Dict = { CanvasModel: holder.CanvasModel };
    // a regra de rolagem vem de term-logic.tsx, que o painel carrega antes do node-tty
    new Function("globalThis", "window", createUiTranspiler().transpile(join(uiDir, "term-logic.tsx")))(scope, scope);
    new Function("globalThis", "window", "React", "HadesCore", createUiTranspiler().transpile(join(uiDir, "argos/node-tty.tsx")))(scope, scope, mod.exports, HadesCore);
    return scope.ArgosNodeTty;
  })();
  return loaded;
}
