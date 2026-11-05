// Manifesto do plugin do projeto ($D/plugin/plugin.json → panel), lido uma vez na subida do painel. Sem plugin: tudo vazio e
// o painel é o do núcleo. Entrada inválida no manifesto é descartada com aviso no log, nunca vira rota.
// O módulo `panel/api.ts` não roda aqui: o que ele exporta chega em `apiFunctions` (ver plugin-host.ts).
import { join } from "node:path";
import { readText } from "../lib/fs.ts";
import type { PanelEnv } from "./env.ts";
import { log } from "./log.ts";

const ROUTE = /^[a-z0-9-]{1,40}$/;
const NAME = /^[A-Za-z][\w-]{0,40}$/;
const CYCLE_SCRIPT = /^[\w-]+\.sh$/;
const PUBLIC_KEYS = ["pages", "scripts", "commands", "applies", "configGroups", "memLabel"] as const;

type Dict = Record<string, unknown>;
const isDict = (v: unknown): v is Dict => typeof v === "object" && v !== null && !Array.isArray(v);

export interface PluginRoute {
  fn: string;
  local: boolean;
}

export interface Plugin {
  manifest: Dict;
  panel: Dict;
  hasApi: boolean;
  routes: Map<string, PluginRoute>;
  actions: Set<string>;
  units: Set<string>;
  optionalContainers: Set<string>;
  cycleScripts: string[];
  runFlags: Dict[];
  endpoints: Dict[];
  public(): Dict;
}

export const routeKey = (method: string, path: string): string => `${method} ${path}`;

/** Units que o painel aceita ler (logs, plugin): as da instância. */
export const unitNamePattern = (hu: string): RegExp => new RegExp(`^${hu.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-[\\w.-]+$`);

const HU_TOKEN = "<HU>";

/** `<HU>-ev` no manifesto vira `<prefixo da instância>-ev`; nome literal (plugin antigo) passa como está. */
export const expandUnit = (name: string, hu: string): string => (name.startsWith(`${HU_TOKEN}-`) ? hu + name.slice(HU_TOKEN.length) : name);

/** O `plugin.json` do projeto; ilegível ou ausente, vazio (o ilegível avisa no log). */
export function readManifest(env: PanelEnv): Dict {
  let manifest: Dict = {};
  const text = readText(join(env.dir, "plugin", "plugin.json"));
  if (text !== undefined) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (isDict(parsed)) manifest = parsed;
      else throw new TypeError("não é um objeto");
    } catch (error) {
      log("warn", "plugin: plugin.json ilegível, ignorado", { reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return manifest;
}

/** `apiFunctions`: nomes que o `api.ts` do plugin exporta como função; sem `api.ts`, indefinido. */
export function loadPlugin(env: PanelEnv, apiFunctions: ReadonlySet<string> | undefined, manifest: Dict = readManifest(env)): Plugin {
  const unitName = unitNamePattern(env.hu);
  const panel = isDict(manifest.panel) ? manifest.panel : {};
  const list = (key: string): Dict[] => (Array.isArray(panel[key]) ? (panel[key] as unknown[]).filter(isDict) : []);
  const strs = (key: string): string[] => (Array.isArray(panel[key]) ? (panel[key] as unknown[]).filter((x): x is string => typeof x === "string") : []);
  const hasApi = Object.keys(panel).length > 0 && apiFunctions !== undefined;

  const routes = new Map<string, PluginRoute>();
  for (const r of list("routes")) {
    const method = String(r.method ?? "GET").toUpperCase();
    const { path, fn } = r;
    if (!(typeof path === "string" && ROUTE.test(path) && (method === "GET" || method === "POST") && typeof fn === "string" && NAME.test(fn) && apiFunctions?.has(fn))) {
      log("warn", "plugin: rota inválida ignorada", { route: JSON.stringify(r) });
      continue;
    }
    routes.set(routeKey(method, path), { fn, local: r.local === true });
  }
  const runFlags = list("runFlags").filter((f) => typeof f.key === "string" && ROUTE.test(f.key));
  const endpoints = list("endpoints").filter((e) => typeof e.name === "string" && NAME.test(e.name));
  const plugin: Plugin = {
    manifest,
    panel,
    hasApi,
    routes,
    actions: new Set(apiFunctions?.has("action") ? strs("actions").filter((a) => NAME.test(a)) : []),
    units: new Set(strs("units").map((u) => expandUnit(u, env.hu)).filter((u) => unitName.test(u))),
    optionalContainers: new Set(strs("optionalContainers")),
    cycleScripts: strs("cycleScripts").filter((c) => CYCLE_SCRIPT.test(c)),
    runFlags,
    endpoints,
    public() {
      const pick = (src: Dict, keys: string[]): Dict => Object.fromEntries(keys.map((k) => [k, src[k] ?? null]));
      const base: Dict = Object.fromEntries(PUBLIC_KEYS.filter((k) => k in panel).map((k) => [k, panel[k]]));
      return {
        ...base,
        name: manifest.name ?? null,
        actions: [...plugin.actions].sort(),
        units: [...plugin.units].sort(),
        optionalContainers: [...plugin.optionalContainers].sort(),
        runFlags: runFlags.map((f) => pick(f, ["key", "label", "hint", "config"])),
        endpoints: endpoints.map((e) => pick(e, ["name", "label", "icon", "url", "addr"])),
        routes: [...routes.keys()].sort().map((k) => ({ method: k.split(" ")[0], path: k.split(" ")[1] })),
      };
    },
  };
  return plugin;
}
