// Grupo install-copy: cópia do kit e do env.pack para o $D em TS (sem rsync): modo preservado, exclusões, manifesto,
// remoção do que saiu do kit, espelho do $D/plugin/ e NOT_INSTALLED numa fonte só.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOT_INSTALLED, copyKit, copyPack, kitManifest, mirrorPlugin, retireOldKit } from "../../../src/lib/install-copy";

const T = mkdtempSync(join(tmpdir(), "hades-install-copy-"));
afterAll(() => rmSync(T, { recursive: true, force: true }));
let n = 0;
const fresh = (): string => { const d = join(T, `c${n++}`); mkdirSync(d, { recursive: true }); return d; };
const put = (path: string, text: string, mode = 0o644): void => {
  mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); chmodSync(path, mode);
};
const mode = (path: string): number => statSync(path).mode & 0o777;

describe("install-copy: cópia do kit", () => {
  test("dado .sh executável e dado comum, quando copia, então o modo de cada um é preservado", () => {
    const kit = fresh(), d = fresh();
    put(`${kit}/run.sh`, "#!/bin/sh\n", 0o755); put(`${kit}/panel/ui/app.js`, "x\n", 0o644); put(`${kit}/gate/g.sh`, "#!/bin/sh\n", 0o750);
    copyKit(kit, d);
    expect([mode(`${d}/run.sh`), mode(`${d}/panel/ui/app.js`), mode(`${d}/gate/g.sh`)]).toEqual([0o755, 0o644, 0o750]);
  });

  test("dado kit mudado, quando recopia sobre o $D, então sobrescreve conteúdo e modo", () => {
    const kit = fresh(), d = fresh();
    put(`${kit}/a.sh`, "um\n", 0o644); copyKit(kit, d);
    put(`${kit}/a.sh`, "dois\n", 0o755); copyKit(kit, d);
    expect([readFileSync(`${d}/a.sh`, "utf8"), mode(`${d}/a.sh`)]).toEqual(["dois\n", 0o755]);
  });

  test("dado os arquivos que o install não copia, quando copia o kit, então nenhum chega ao $D (em qualquer profundidade)", () => {
    const kit = fresh(), d = fresh();
    for (const f of ["env.template.sh", "install.sh", "skill-release.sh", "sub/install.sh", "__pycache__/x.pyc", "sub/__pycache__/y.pyc"]) put(`${kit}/${f}`, "x\n");
    put(`${kit}/keep.sh`, "k\n");
    copyKit(kit, d);
    for (const f of ["env.template.sh", "install.sh", "skill-release.sh", "sub/install.sh", "__pycache__", "sub/__pycache__"]) expect(existsSync(`${d}/${f}`)).toBe(false);
    expect(existsSync(`${d}/keep.sh`)).toBe(true);
  });

  test("dado env.pack com post-install, renamed, assets e reference, quando sobrepõe, então só o resto vai e o estado do $D fica", () => {
    const pack = fresh(), d = fresh();
    for (const f of ["post-install.sh", "renamed.tsv", "assets/a.zip", "reference/r.md", "infra/__pycache__/z.pyc", "config.tsv", "panel/p.py", "svc.sh", "infra/gen.sh"]) put(`${pack}/${f}`, "x\n");
    put(`${d}/config.env`, "K=1\n");
    copyPack(pack, d);
    for (const f of ["post-install.sh", "renamed.tsv", "assets", "reference", "infra/__pycache__", "config.tsv", "panel"]) expect(existsSync(`${d}/${f}`)).toBe(false);
    expect(["svc.sh", "infra/gen.sh", "config.env"].every((f) => existsSync(`${d}/${f}`))).toBe(true);
  });

  test("dado NOT_INSTALLED, então é uma só lista e o skill-release a importa em vez de repeti-la", () => {
    expect(["env.template.sh", "install.sh", "skill-release.sh", "post-install.sh", "renamed.tsv"].every((f) => NOT_INSTALLED.test(f))).toBe(true);
    expect(NOT_INSTALLED.test("config.sh")).toBe(false);
    const src = readFileSync(join(import.meta.dir, "../../../src/commands/skill-release.ts"), "utf8");
    expect(src).toMatch(/import \{[^}]*NOT_INSTALLED[^}]*\} from "\.\.\/lib\/install-copy\.ts"/);
    expect(src).not.toMatch(/const NOT_INSTALLED/);
  });
});

describe("install-copy: manifesto e o que saiu do kit", () => {
  test("dado kit, então o manifesto lista sha256 e caminho ordenados, sem os não copiados", () => {
    const kit = fresh();
    put(`${kit}/b.sh`, "b\n"); put(`${kit}/a/z.txt`, "z\n"); put(`${kit}/install.sh`, "i\n"); put(`${kit}/__pycache__/q.pyc`, "q\n");
    const lines = kitManifest(kit);
    expect(lines.map((l) => l.split("  ")[1])).toEqual(["a/z.txt", "b.sh"]);
    expect(lines[1]).toMatch(/^[0-9a-f]{64} {2}b\.sh$/);
  });

  test("dado arquivo que saiu do kit e está intocado, então sai do $D com a pasta vazia; editado, avisa e fica no manifesto", () => {
    const kit = fresh(), d = fresh();
    put(`${kit}/novo.sh`, "n\n"); put(`${kit}/ui/velho.js`, "v\n"); put(`${kit}/editado.sh`, "e\n");
    copyKit(kit, d);
    const old = kitManifest(kit).join("\n") + "\n";
    rmSync(`${kit}/ui`, { recursive: true }); rmSync(`${kit}/editado.sh`);
    writeFileSync(`${d}/editado.sh`, "minha edicao\n");
    const said: string[] = [];
    const kept = retireOldKit(old, kit, d, (l) => said.push(l));
    expect(said).toEqual(["aviso: editado.sh saiu do kit mas foi editado em " + d + "; ficou (apague à mão se não precisa dele)", "removido do kit: ui/velho.js"]);
    expect([existsSync(`${d}/ui`), existsSync(`${d}/editado.sh`), existsSync(`${d}/novo.sh`)]).toEqual([false, true, true]);
    expect(kept.length).toBe(1);
    expect(kept[0]).toMatch(/ {2}editado\.sh$/);
  });

  test("dado manifesto com caminho fora do $D, então ignora a linha e não apaga nada fora", () => {
    const kit = fresh(), d = fresh(), fora = join(T, "fora.txt");
    writeFileSync(fora, "fora\n");
    const sum = "5b0c6d2a6f1b0f6e0f7b5a0f1c3d2e4f5a6b7c8d9e0f1a2b3c4d5e6f708192a3";
    retireOldKit(`${sum}  ../fora.txt\n${sum}  /etc/passwd\n${sum}  a/../../fora.txt\n`, kit, d, () => undefined);
    expect(existsSync(fora)).toBe(true);
  });
});

describe("install-copy: espelho do $D/plugin/", () => {
  test("dado o plugin que tirou arquivos, quando espelha, então some do $D/plugin o que saiu e o que não é ponto de extensão fica", () => {
    const pack = fresh(), d = fresh();
    put(`${pack}/config.tsv`, "novo\n"); put(`${pack}/panel/a.py`, "a\n"); put(`${pack}/panel/sub/b.py`, "b\n");
    put(`${d}/plugin/config.tsv`, "velho\n"); put(`${d}/plugin/onboard.tsv`, "saiu\n"); put(`${d}/plugin/panel/c.py`, "c\n");
    put(`${d}/plugin/panel/sub/d.py`, "d\n"); put(`${d}/plugin/panel/__pycache__/a.pyc`, "cache\n"); put(`${d}/plugin/estado.json`, "{}\n");
    mirrorPlugin(pack, d);
    expect(readFileSync(`${d}/plugin/config.tsv`, "utf8")).toBe("novo\n");
    expect(["onboard.tsv", "panel/c.py", "panel/sub/d.py"].map((f) => existsSync(`${d}/plugin/${f}`))).toEqual([false, false, false]);
    expect(["panel/a.py", "panel/sub/b.py", "panel/__pycache__/a.pyc", "estado.json"].map((f) => existsSync(`${d}/plugin/${f}`))).toEqual([true, true, true, true]);
  });

  test("dado plugin sem panel/, quando espelha, então o panel/ antigo do $D/plugin sai inteiro", () => {
    const pack = fresh(), d = fresh();
    put(`${pack}/plugin.json`, "{}\n"); put(`${d}/plugin/panel/a.py`, "a\n");
    mirrorPlugin(pack, d);
    expect([existsSync(`${d}/plugin/panel`), existsSync(`${d}/plugin/plugin.json`)]).toEqual([false, true]);
  });
});
