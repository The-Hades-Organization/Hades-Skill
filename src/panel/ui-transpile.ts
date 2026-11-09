import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";

/** Transpila os .tsx da interface para JS, com cache por mtime: o painel serve `x.js` a partir de `x.tsx` sem etapa de build. */
export interface UiTranspiler {
  /** JS do `.tsx` em `real`; erro de sintaxe sobe com o arquivo no texto. */
  transpile(real: string): string;
}

export interface UiTranspilerOptions {
  /**
   * Pastas cujos scripts saem com escopo próprio: no navegador todo script clássico divide o escopo global, e uma
   * constante repetida em dois arquivos derruba o segundo com SyntaxError. Esses arquivos só falam entre si por `globalThis`.
   */
  isolate?: string[];
}

export function createUiTranspiler(options: UiTranspilerOptions = {}): UiTranspiler {
  const transpiler = new Bun.Transpiler({ loader: "tsx", tsconfig: { compilerOptions: { jsx: "react" } } });
  const cache = new Map<string, { mtimeMs: number; js: string }>();
  const isolated = (options.isolate ?? []).filter((dir) => existsSync(dir)).map((dir) => realpathSync(dir) + sep);
  return {
    transpile(real) {
      const { mtimeMs } = statSync(real);
      const hit = cache.get(real);
      if (hit && hit.mtimeMs === mtimeMs) return hit.js;
      const out = transpiler.transformSync(readFileSync(real, "utf8"));
      const js = isolated.some((dir) => real.startsWith(dir)) ? `(() => {\n${out}\n})();\n` : out;
      cache.set(real, { mtimeMs, js });
      return js;
    },
  };
}

/**
 * Módulos de `src/lib` que chegam ao navegador, pela chave que ganham em `window.CanvasModel`. Uma fonte só: o servidor
 * empacota estes arquivos (Bun.build, formato iife) a cada mudança; nada fora desta lista entra no pacote.
 */
export const CANVAS_UI_MODULES = {
  doc: "canvas-doc.ts",
  history: "canvas-history.ts",
  camera: "canvas-camera.ts",
  selection: "canvas-selection.ts",
  types: "canvas-types.ts",
  commands: "canvas-commands.ts",
  layout: "canvas-layout.ts",
  sync: "canvas-sync.ts",
  store: "canvas-store.ts",
  argos: "canvas-argos.ts",
  // leitura do grafo na página (forças, vizinhança, filtros, busca, estado na URL)
  quadtree: "canvas-quadtree.ts",
  force: "canvas-force.ts",
  neighbors: "canvas-neighbors.ts",
  filters: "canvas-filters.ts",
  search: "canvas-search.ts",
  urlstate: "canvas-urlstate.ts",
  // minimapa e reconhecedor de toque (a montagem na página é de outra rodada)
  minimap: "canvas-minimap.ts",
  touch: "canvas-touch.ts",
  // comandos de organização (commands-canvas.tsx)
  groups: "canvas-groups.ts",
  areas: "canvas-areas.ts",
  align: "canvas-align.ts",
  clipboard: "canvas-clipboard.ts",
  walk: "canvas-walk.ts",
  next: "canvas-next.ts",
  batch: "canvas-batch.ts",
  blur: "canvas-blur.ts",
  dock: "canvas-dock.ts",
  export: "canvas-export.ts",
  // tipos de nó do usuário (types-user.tsx) e vivos (types-live.tsx)
  note: "canvas-note.ts",
  draw: "canvas-draw.ts",
  drawing: "canvas-drawing.ts",
  create: "canvas-create.ts",
  bands: "canvas-bands.ts",
  portal: "canvas-portal.ts",
  conversation: "canvas-conversation.ts",
  agentFiles: "canvas-agent-files.ts",
  // menu de contexto e balão no nó
  actions: "canvas-actions.ts",
  compose: "canvas-compose.ts",
  // quadro ANSI do terminal do nó (node-tty.tsx)
  termAnsi: "term-ansi.ts",
  // peças ligadas na página (encaixe e filtros salvos)
  snap: "canvas-snap.ts",
  savedFilters: "canvas-saved-filters.ts",
  // conexões do dono (motor e popover de conexões, canvas-links.tsx)
  links: "canvas-links.ts",
  // orquestrador e recrutas: arestas terminal → agente alocado pela CLI (orchestrationEdges)
  recruit: "canvas-recruit.ts",
  // organizar o canvas por equipes (tidy:arrange em pages/argos.tsx)
  tidy: "canvas-tidy.ts",
  // vaga livre para nó novo: importado por canvas-recruit e canvas-sync
  space: "canvas-space.ts",
  // ligação ao vivo com o servidor: religação com recuo e conferência de reserva (pages/argos.tsx)
  live: "canvas-live.ts",
  // zoom semântico: contagem por estado, rótulos de área e resumo por tipo (canvas-engine.tsx)
  semantic: "canvas-semantic.ts",
} as const;

/** Nome pedido em `/ui/lib/<nome>` → pacote. Qualquer outro nome responde 404. */
export const CANVAS_UI_BUNDLE = "canvas-model.js";

export interface ModuleBundler {
  /** JS do pacote, ou `undefined` se `name` não está na lista. Falha de empacotamento sobe (o servidor registra e responde 500). */
  bundle(name: string): Promise<string | undefined>;
}

/** `libDir` é a pasta `src/lib` da skill; cada arquivo da lista é conferido (caminho real) dentro dela. */
export function createCanvasModuleBundler(libDir: string): ModuleBundler {
  let cached: { key: string; js: string } | undefined;
  let building: { key: string; js: Promise<string> } | undefined;

  const resolveAllowed = (): Map<string, string> => {
    const base = realpathSync(libDir);
    const files = new Map<string, string>();
    for (const [name, file] of Object.entries(CANVAS_UI_MODULES)) {
      const real = realpathSync(join(base, file));
      if (!real.startsWith(base + sep)) throw new Error(`módulo da UI fora de src/lib: ${file}`);
      files.set(real, name);
    }
    return files;
  };

  const build = async (allowed: Map<string, string>): Promise<string> => {
    const entry = [...allowed].map(([real, name], i) => `import * as m${i} from ${JSON.stringify(real)}; mods[${JSON.stringify(name)}] = m${i};`);
    const result = await Bun.build({
      entrypoints: ["canvas-model-entry"],
      format: "iife",
      target: "browser",
      plugins: [{
        name: "canvas-model",
        setup(b) {
          b.onResolve({ filter: /^canvas-model-entry$/ }, () => ({ path: "canvas-model-entry", namespace: "canvas-model" }));
          b.onLoad({ filter: /.*/, namespace: "canvas-model" }, () => ({
            loader: "ts",
            contents: `const mods: Record<string, unknown> = {};\n${entry.join("\n")}\n(globalThis as unknown as { CanvasModel: unknown }).CanvasModel = Object.freeze(mods);\n`,
          }));
          // todo import (do pacote ou entre os módulos) tem de cair num arquivo da lista: o pacote nunca puxa Node nem outro código
          b.onResolve({ filter: /.*/ }, (args) => {
            const target = args.path.startsWith("/") ? args.path : join(dirname(args.importer), args.path);
            let real: string;
            try {
              real = realpathSync(target);
            } catch {
              throw new Error(`import fora da lista dos módulos da UI: ${args.path}`);
            }
            if (!allowed.has(real)) throw new Error(`import fora da lista dos módulos da UI: ${args.path}`);
            return { path: real };
          });
        },
      }],
    });
    if (!result.success || !result.outputs[0]) throw new AggregateError(result.logs, "empacotamento dos módulos da UI falhou");
    return result.outputs[0].text();
  };

  return {
    async bundle(name) {
      if (name !== CANVAS_UI_BUNDLE) return undefined;
      const allowed = resolveAllowed();
      const key = [...allowed.keys()].map((real) => `${real}:${statSync(real).mtimeMs}`).join("|");
      if (cached?.key === key) return cached.js;
      if (building?.key !== key) {
        // pedidos simultâneos durante o empacotamento esperam o mesmo resultado
        const js: Promise<string> = build(allowed)
          .then((text) => {
            cached = { key, js: text };
            return text;
          })
          .finally(() => {
            if (building?.js === js) building = undefined;
          });
        building = { key, js };
      }
      return building.js;
    },
  };
}

/**
 * Página de desenvolvimento do motor do canvas (`/dev/canvas`): o harness de escala, fora da navegação do dono. Carrega
 * só React, o pacote do modelo e os scripts do motor; não tem token (o harness não grava nada no servidor).
 */
export const CANVAS_HARNESS_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Canvas: harness de escala</title>
<style>
:root { color-scheme: light dark; --background: #f9f2eb; --foreground: #391a2c; --card: #fffaf5; --border: rgba(57,26,44,.14); --border-strong: rgba(57,26,44,.3); --muted-foreground: #7a5a6a; --ring: #c8264a; --vivo: #c8264a; }
@media (prefers-color-scheme: dark) { :root { --background: #12090e; --foreground: #eddece; --card: #1d1218; --border: rgba(237,222,206,.12); --border-strong: rgba(237,222,206,.28); --muted-foreground: #b39aa6; } }
html, body { margin: 0; height: 100%; background: var(--background); color: var(--foreground); font: 14px/1.4 ui-sans-serif, system-ui, sans-serif; }
#root { height: 100%; }
</style>
</head>
<body>
<div id="root"></div>
<script src="/ui/vendor/react.js"></script>
<script src="/ui/vendor/react-dom.js"></script>
<script src="/ui/lib/${CANVAS_UI_BUNDLE}"></script>
<script src="/ui/argos/canvas-engine.js"></script>
<script src="/ui/argos/canvas-synth.js"></script>
<script src="/ui/argos/canvas-harness.js"></script>
</body>
</html>
`;
