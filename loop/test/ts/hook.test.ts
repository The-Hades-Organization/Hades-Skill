// Grupo hook: decisões do hook (bun src/hook.ts) sobre os casos de fixtures/hook/cases.tsv.
import { afterAll, describe, test } from "bun:test";
import { FX, Rig, checkText } from "./lib/rig";
import { hookCases } from "./lib/hook";

const r = new Rig().setup();
afterAll(() => r.cleanup());

describe("hook", () => {
  test("hook.txt", () => checkText("hook.txt", r.norm(hookCases(r, `${FX}/hook/cases.tsv`, r.hookDirs()))));
});
