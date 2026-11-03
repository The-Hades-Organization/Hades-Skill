// Grupo install-canvases: a reinstalação nunca toca em $D/canvases/ (os documentos do canvas do Argos) nem em $D/canvas.json.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyKit, kitManifest, retireOldKit } from "../../../src/lib/install-copy";

const T = mkdtempSync(join(tmpdir(), "hades-install-canvases-"));
afterAll(() => rmSync(T, { recursive: true, force: true }));

describe("install: estado do canvas", () => {
  test("dado canvases/ e canvas.json no $D, quando reinstala e o kit perde arquivos, então ficam intactos", () => {
    const kit = join(T, "kit"), d = join(T, "d");
    mkdirSync(kit, { recursive: true });
    mkdirSync(join(d, "canvases"), { recursive: true });
    writeFileSync(join(kit, "a.sh"), "a\n");
    copyKit(kit, d);
    const old = kitManifest(kit).join("\n") + "\n";
    writeFileSync(join(d, "canvases", "meu.json"), '{"v":1}');
    writeFileSync(join(d, "canvas.json"), '{"v":1}');
    rmSync(join(kit, "a.sh"));
    writeFileSync(join(kit, "b.sh"), "b\n");
    retireOldKit(old, kit, d, () => undefined);
    copyKit(kit, d);
    expect(readFileSync(join(d, "canvases", "meu.json"), "utf8")).toBe('{"v":1}');
    expect(readFileSync(join(d, "canvas.json"), "utf8")).toBe('{"v":1}');
  });

  test("dado o cabeçalho do install, então canvases/ está na lista do que a reinstalação nunca toca", () => {
    const src = readFileSync(join(import.meta.dir, "../../../src/commands/install.ts"), "utf8");
    expect(src.split("\n").slice(0, 8).join("\n")).toContain("canvas.json, canvases/)");
  });
});
