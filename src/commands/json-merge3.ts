// Merge estrutural de 3 vias para JSON em conflito: parte do "ours" (HEAD) e aplica só o que o
// "theirs" mudou em relação à base. Chave mudada dos dois lados com valores diferentes é conflito real (exit 1).
import { writeFileSync } from "node:fs";
import { EXIT, out, warn } from "../lib/output.ts";
import { dumpJson, git } from "../lib/kit.ts";

type Json = unknown;
type Obj = { [key: string]: Json };
const MISSING = Symbol("missing");
type Maybe = Json | typeof MISSING;

const isObj = (v: Maybe): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function equal(a: Maybe, b: Maybe): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]));
  }
  return false;
}

// defineProperty: uma chave "__proto__" do JSON é dado, não o protótipo do objeto
function put(target: Obj, key: string, value: Json): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function get(obj: Obj, key: string): Maybe {
  return Object.hasOwn(obj, key) ? obj[key] : MISSING;
}

function stage(path: string, n: number): Json {
  const r = git(["show", `:${n}:${path}`]);
  return r.status === 0 && r.stdout.trim() ? (JSON.parse(r.stdout) as Json) : {};
}

function merge(base: Maybe, ours: Maybe, theirs: Maybe, path: string, clashes: string[]): Json {
  if (isObj(ours) && isObj(theirs)) {
    const result: Obj = {};
    for (const k of Object.keys(ours)) put(result, k, ours[k]);
    const baseObj: Obj = isObj(base) ? base : {};
    const keys = new Set([...Object.keys(theirs), ...Object.keys(baseObj)]);
    for (const k of keys) {
      const b = get(baseObj, k);
      const o = get(ours, k);
      const t = get(theirs, k);
      if (equal(t, b)) continue; // a PR não mexeu nesta chave
      if (equal(o, b)) {
        if (t === MISSING) delete result[k];
        else put(result, k, t);
      } else if (equal(o, t)) {
        continue;
      } else if (isObj(o) && isObj(t)) {
        put(result, k, merge(b === MISSING ? {} : b, o, t, `${path}.${k}`, clashes));
      } else {
        clashes.push(`${path}.${k}`);
      }
    }
    return result;
  }
  if (equal(theirs, base)) return ours;
  if (equal(ours, base) || equal(ours, theirs)) return theirs;
  clashes.push(path);
  return ours;
}

export function jsonMerge3Command(files: string[]): number {
  let rc: number = EXIT.ok;
  for (const file of files) {
    const clashes: string[] = [];
    const result = merge(stage(file, 1), stage(file, 2), stage(file, 3), "$", clashes);
    if (clashes.length) {
      out(`${file}: CONFLITO REAL em ${clashes.length} chave(s): ${clashes.slice(0, 10).join(", ")}`);
      rc = EXIT.fail;
      continue;
    }
    writeFileSync(file, `${dumpJson(result)}\n`);
    const added = git(["add", file]);
    if (added.status !== 0) {
      warn(`json-merge3: git add ${file}: ${added.stderr.trim()}`);
      return EXIT.fail;
    }
    out(`${file}: ok`);
  }
  return rc;
}
