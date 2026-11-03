// Grupo widget-build: lado host do build do APK do widget (hades widget-apk) com `docker` falso no PATH, sem rede nem container:
// argumentos do container, cópia dos fontes, sourcesSha igual ao do painel, list/new, falha cedo sem docker e o shim do kit.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apkVersion, imageTag } from "../../../src/lib/widget-build";
import { listSourceFiles, sourcesSha, syncSources } from "../../../src/lib/widget-sources";
import { BUN, SKILL } from "./lib/rig";

const T = mkdtempSync(join(tmpdir(), "hades-widget-build-"));
afterAll(() => rmSync(T, { recursive: true, force: true }));
let n = 0;
const fresh = (): string => { const d = join(T, `w${n++}`); mkdirSync(d, { recursive: true }); return d; };
const put = (path: string, text: string, mode = 0o644): void => {
  mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); chmodSync(path, mode);
};
const mode = (path: string): number => statSync(path).mode & 0o777;

const FILES: [string, string][] = [["settings.gradle", "a\n"], ["app/src/Main.java", "b\n"], ["app/src/ç.java", "c\n"], ["tools/run.sh", "d\n"], ["z", "e\n"], ["a b/c", "f\n"]];
const shellSha = (dir: string): string => spawnSync("bash", ["-c",
  'cd "$1" && find . \\( -name build -o -name .gradle \\) -prune -o -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d" " -f1', "_", dir],
{ encoding: "utf8" }).stdout.trim();

// `docker` falso: registra os argumentos; no `run ... build` cria o que o container criaria em /work (o -v <estado>:/work)
const STUB = `#!/bin/bash
printf '%s\\n' "$*" >> "$STUB_LOG"
case "$1" in
  --version) echo "Docker version 0.0-stub" ;;
  image) [[ $2 == inspect && $3 == --format ]] && echo "sha256:feedface" ; exit \${STUB_INSPECT_RC:-0} ;;
  run)
    args=("$@")
    if [[ \${args[-1]} == build ]]; then
      for ((i = 0; i < \${#args[@]}; i++)); do [[ \${args[i]} == -v && \${args[i+1]} == *:/work ]] && s=\${args[i+1]%:/work}; done
      for f in hades-widget.keystore keystore.pass hades-widget.apk hades-widget.apk.json; do echo x > "$s/$f"; /usr/bin/chmod 666 "$s/$f"; done
    fi ;;
esac
`;

interface Rig { d: string; kit: string; log: string; bin: string; env: Record<string, string> }
/** $D instalado de mentira: kit/android com widget/, docker/ (Dockerfile e inside.sh) e kit.version */
function rig(version = "5.6.0"): Rig {
  const d = fresh(), bin = fresh(), kit = join(d, "android"), log = join(d, "docker.log");
  for (const [f, text] of FILES) put(join(kit, "widget", f), text);
  put(join(kit, "docker/Dockerfile"), "FROM scratch\n");
  put(join(kit, "docker/inside.sh"), "#!/usr/bin/env bash\n", 0o755);
  put(join(kit, "shots/WidgetShotsTest.kt"), "k\n");
  put(join(d, "kit.version"), `${version}\n`);
  put(join(bin, "docker"), STUB, 0o755);
  return { d, kit, log, bin, env: { PATH: bin, HOME: d, HADES_KIT_DIR: kit, GATE_LOCK_TICKET: "1", STUB_LOG: log } };
}
const cli = (r: Rig, args: string[], env: Record<string, string> = {}) => {
  const p = spawnSync(BUN, [join(SKILL, "src/cli.ts"), "widget-apk", ...args], { encoding: "utf8", env: { ...r.env, ...env } });
  return { rc: p.status ?? -1, out: p.stdout, err: p.stderr };
};
const calls = (r: Rig): string[] => (existsSync(r.log) ? readFileSync(r.log, "utf8").split("\n").filter(Boolean) : []);

describe("widget-build: sourcesSha", () => {
  test("dado uma árvore de fontes, quando calcula, então é o mesmo hash do `sha256sum` do build.sh antigo", () => {
    const dir = fresh();
    for (const [f, text] of FILES) put(join(dir, f), text);
    expect(sourcesSha(dir)).toBe(shellSha(dir));
  });

  test("dado build/ e .gradle (pasta ou arquivo), quando calcula, então ficam fora do hash e da lista", () => {
    const dir = fresh();
    for (const [f, text] of FILES) put(join(dir, f), text);
    const base = sourcesSha(dir);
    put(join(dir, "build/out.class"), "x\n"); put(join(dir, "app/.gradle/cache"), "y\n"); put(join(dir, "app/build"), "arquivo\n");
    expect(sourcesSha(dir)).toBe(base);
    expect(listSourceFiles(dir).some((f) => /\/(build|\.gradle)(\/|$)/.test(f))).toBe(false);
  });

  test("dado link simbólico entre as fontes, quando calcula, então não conta (o find -type f não o seguia)", () => {
    const dir = fresh();
    put(join(dir, "a"), "a\n");
    const base = sourcesSha(dir);
    symlinkSync(join(dir, "a"), join(dir, "link"));
    expect(sourcesSha(dir)).toBe(base);
  });

  test("dado um byte mudado numa fonte, quando calcula, então o hash muda", () => {
    const dir = fresh();
    put(join(dir, "a"), "a\n");
    const before = sourcesSha(dir);
    put(join(dir, "a"), "b\n");
    expect(sourcesSha(dir)).not.toBe(before);
  });

  test("dado pasta inexistente, quando lista, então falha em vez de devolver hash de nada", () => {
    expect(() => listSourceFiles(join(T, "nao-existe"))).toThrow();
  });
});

describe("widget-build: cópia dos fontes", () => {
  test("dado fontes com modo, quando sincroniza, então copia o conteúdo e preserva o modo, sem build/ nem .gradle", () => {
    const src = fresh(), dst = join(fresh(), "x");
    put(join(src, "tools/run.sh"), "#!/bin/sh\n", 0o755); put(join(src, "app/A.java"), "a\n"); put(join(src, "build/lixo"), "l\n"); put(join(src, ".gradle/g"), "g\n");
    syncSources(src, dst);
    expect([readFileSync(join(dst, "app/A.java"), "utf8"), mode(join(dst, "tools/run.sh")), mode(join(dst, "app/A.java"))]).toEqual(["a\n", 0o755, 0o644]);
    expect([existsSync(join(dst, "build")), existsSync(join(dst, ".gradle"))]).toEqual([false, false]);
  });

  test("dado destino com sobra, quando sincroniza, então remove o que a origem não tem e mantém a saída do Gradle", () => {
    const src = fresh(), dst = fresh();
    put(join(src, "a"), "novo\n");
    put(join(dst, "a"), "velho\n"); put(join(dst, "sobra/b"), "s\n"); put(join(dst, "build/classes"), "c\n"); put(join(dst, ".gradle/c"), "c\n");
    syncSources(src, dst);
    expect(readFileSync(join(dst, "a"), "utf8")).toBe("novo\n");
    expect([existsSync(join(dst, "sobra")), existsSync(join(dst, "build/classes")), existsSync(join(dst, ".gradle/c"))]).toEqual([false, true, true]);
  });

  test("dado arquivo no destino onde a origem tem pasta, quando sincroniza, então a pasta vence", () => {
    const src = fresh(), dst = fresh();
    put(join(src, "x/y"), "y\n"); put(join(dst, "x"), "arquivo\n");
    syncSources(src, dst);
    expect(readFileSync(join(dst, "x/y"), "utf8")).toBe("y\n");
  });

  test("dado o hash da cópia, então é o mesmo da origem (o build e o painel concordam)", () => {
    const src = fresh(), dst = fresh();
    for (const [f, text] of FILES) put(join(src, f), text);
    syncSources(src, dst);
    expect(sourcesSha(dst)).toBe(sourcesSha(src));
  });
});

describe("widget-build: versão e imagem", () => {
  test("dado X.Y.Z, então versionCode é major*10000 + minor*100 + patch", () => {
    const f = join(fresh(), "V");
    const code = (v: string): number => { writeFileSync(f, `${v}\n`); return apkVersion(f).code; };
    expect([code("5.6.0"), code("10.0.1"), code("0.0.0"), code("5.06.09")]).toEqual([50600, 100001, 0, 50609]);
  });

  test("dado VERSION ilegível ou ausente, então falha dizendo o esperado", () => {
    const f = join(fresh(), "V");
    writeFileSync(f, "abc\n");
    expect(() => apkVersion(f)).toThrow("esperado X.Y.Z");
    expect(() => apkVersion(join(T, "ausente"))).toThrow("esperado X.Y.Z");
  });

  test("dado o Dockerfile, então a tag leva os 12 primeiros hex do sha256 dele", () => {
    const f = join(fresh(), "Dockerfile");
    writeFileSync(f, "FROM scratch\n");
    expect(imageTag(f)).toBe("hades-android-build:" + new Bun.CryptoHasher("sha256").update("FROM scratch\n").digest("hex").slice(0, 12));
  });
});

describe("widget-build: hades widget-apk com docker falso", () => {
  test("dado build, então o container leva usuário, versão, hash dos fontes, estado e inside.sh montados", () => {
    const r = rig();
    const p = cli(r, ["build"]);
    const run = calls(r).find((c) => c.startsWith("run ")) ?? "";
    const tag = imageTag(join(r.kit, "docker/Dockerfile"));
    expect(p.rc).toBe(0);
    expect(run).toContain(`--user ${process.getuid?.()}:${process.getgid?.()}`);
    expect(run).toContain("-e HOME=/work/home -e GRADLE_USER_HOME=/work/gradle-home");
    expect(run).toContain("-e HADES_VERSION_NAME=5.6.0 -e HADES_VERSION_CODE=50600");
    expect(run).toContain(`-e HADES_SOURCES_SHA=${sourcesSha(join(r.kit, "widget"))}`);
    expect(run).toContain(`-v ${r.kit}:/work -v ${r.kit}/docker/inside.sh:/inside.sh:ro`);
    expect(run.endsWith(`${tag} bash /inside.sh build`)).toBe(true);
  });

  test("dado build, então a cópia dos fontes está em build/src e o hash dela é o do painel", () => {
    const r = rig();
    cli(r, ["build"]);
    expect(sourcesSha(join(r.kit, "build/src"))).toBe(sourcesSha(join(r.kit, "widget")));
    expect(existsSync(join(r.kit, "build/shots"))).toBe(false);
  });

  test("dado build, então a imagem é construída quando falta, e só então", () => {
    const r = rig();
    cli(r, ["build"], { STUB_INSPECT_RC: "1" });
    const first = calls(r);
    expect(first.filter((c) => c.startsWith("build -q -t hades-android-build:"))).toHaveLength(1);
    expect(first.find((c) => c.startsWith("build "))?.endsWith(`${r.kit}/docker`)).toBe(true);
    rmSync(r.log);
    cli(r, ["build"]);
    expect(calls(r).some((c) => c.startsWith("build "))).toBe(false);
  });

  test("dado build ok, então chaves ficam 600, APK e sidecar 644 e a saída resume o resultado", () => {
    const r = rig();
    const p = cli(r, ["build"]);
    expect([mode(join(r.kit, "hades-widget.keystore")), mode(join(r.kit, "keystore.pass")), mode(join(r.kit, "hades-widget.apk")), mode(join(r.kit, "hades-widget.apk.json"))])
      .toEqual([0o600, 0o600, 0o644, 0o644]);
    expect(mode(r.kit)).toBe(0o700);
    expect(p.out).toContain(`apk: ${r.kit}/hades-widget.apk (2 bytes, versão 5.6.0, código 50600)`);
    expect(p.out).toContain("imagem: hades-android-build:");
  });

  test("dado o container falhando, então o código dele sobe e o APK não é anunciado", () => {
    const r = rig();
    put(join(r.bin, "docker"), `${STUB}\n[[ $1 == run ]] && exit 7\nexit 0\n`.replace("esac\n\n", "esac\n"), 0o755);
    const p = cli(r, ["build"]);
    expect([p.rc, p.out.includes("apk:")]).toEqual([7, false]);
  });

  test("dado test e shots, então o comando vai ao container e shots copia também as capturas de referência", () => {
    const r = rig();
    cli(r, ["test"]);
    cli(r, ["shots"]);
    const runs = calls(r).filter((c) => c.startsWith("run "));
    expect(runs.map((c) => c.split(" ").pop())).toEqual(["test", "shots"]);
    expect(readFileSync(join(r.kit, "build/shots/WidgetShotsTest.kt"), "utf8")).toBe("k\n");
  });

  test("dado VERSION ilegível, então falha antes de rodar o container", () => {
    const r = rig("lixo");
    const p = cli(r, ["build"]);
    expect([p.rc, p.err.includes("esperado X.Y.Z"), calls(r).some((c) => c.startsWith("run "))]).toEqual([1, true, false]);
  });

  test("dado list, então roda o registro no container só com leitura", () => {
    const r = rig();
    expect(cli(r, ["list"]).rc).toBe(0);
    const run = calls(r).find((c) => c.startsWith("run ")) ?? "";
    expect(run).toContain(`--user ${process.getuid?.()}:${process.getgid?.()} -v ${r.kit}/widget:/widget:ro `);
    expect(run.endsWith("bash /widget/tools/run.sh /widget list")).toBe(true);
  });

  test("dado new <id>, então o container escreve nas fontes (sem :ro) e leva o id", () => {
    const r = rig();
    expect(cli(r, ["new", "fila"]).rc).toBe(0);
    const run = calls(r).find((c) => c.startsWith("run ")) ?? "";
    expect(run).toContain(`-v ${r.kit}/widget:/widget `);
    expect(run).not.toContain(":/widget:ro");
    expect(run.endsWith("bash /widget/tools/run.sh /widget new fila")).toBe(true);
  });

  test("dado new sem id, então uso e saída 2, sem rodar container", () => {
    const r = rig();
    const p = cli(r, ["new"]);
    expect([p.rc, p.err, calls(r).some((c) => c.startsWith("run "))]).toEqual([2, "uso: build.sh new <id>\n", false]);
  });

  test("dado subcomando desconhecido, então uso e saída 2; -h imprime o uso e sai 0", () => {
    const r = rig();
    expect([cli(r, ["xyz"]).rc, cli(r, ["-h"]).rc, cli(r, ["-h"]).out.startsWith("uso: hades widget-apk")]).toEqual([2, 0, true]);
  });

  test("dado status, então diz imagem, APK e keystore, antes e depois do build", () => {
    const r = rig();
    const before = cli(r, ["status"]).out;
    cli(r, ["build"]);
    const after = cli(r, ["status"]).out;
    expect(before).toContain("apk: ainda não gerado");
    expect(before).toContain("keystore: ainda não gerada");
    expect(after).toContain(`apk: ${r.kit}/hades-widget.apk (2 bytes)`);
    expect(after).toContain(`keystore: ${r.kit}/hades-widget.keystore`);
  });

  test("dado image, então garante a imagem e imprime tag e digest, sem rodar o build", () => {
    const r = rig();
    const p = cli(r, ["image"]);
    expect(p.out).toMatch(/^imagem: hades-android-build:[0-9a-f]{12} sha256:feedface\n$/);
    expect(calls(r).some((c) => c.startsWith("run "))).toBe(false);
  });

  test("dado fora da fila e com GATE_LOCK, então o build passa pela fila com o rótulo e o custo", () => {
    const r = rig();
    const lock = join(r.d, "gate-lock.sh");
    put(lock, `#!/bin/bash\nprintf '%s\\n' "$*" > "${r.d}/lock.args"\n`, 0o755);
    const env = { ...r.env, GATE_LOCK: lock };
    delete (env as Record<string, string | undefined>).GATE_LOCK_TICKET;
    const p = spawnSync(BUN, [join(SKILL, "src/cli.ts"), "widget-apk", "test"], { encoding: "utf8", env });
    const args = readFileSync(join(r.d, "lock.args"), "utf8");
    expect(p.status).toBe(0);
    expect(args.startsWith("run build --label widget-android --cost-gb 3 -- ")).toBe(true);
    expect(args.trimEnd().endsWith("src/cli.ts widget-apk test")).toBe(true);
    expect(calls(r).some((c) => c.startsWith("run "))).toBe(false);
  });

  test("dado sem docker no PATH, então falha cedo (69) dizendo como instalar, sem tocar no estado", () => {
    const r = rig();
    rmSync(join(r.bin, "docker"));
    for (const sub of ["build", "list", "status"]) {
      const p = cli(r, [sub]);
      expect([p.rc, p.err.includes("dependência ausente: docker"), p.err.includes("Como instalar: instale o Docker Engine")]).toEqual([69, true, true]);
    }
    expect(existsSync(join(r.kit, "build"))).toBe(false);
  });
});

describe("widget-build: shim kit/android/build.sh", () => {
  test("dado o shim da skill, quando roda, então chama a CLI desta skill e grava o estado em $HADES_DATA/android", () => {
    const r = rig();
    const data = fresh();
    const p = spawnSync("bash", [join(SKILL, "kit/android/build.sh"), "status"], {
      encoding: "utf8", env: { ...process.env, PATH: `${r.bin}:${process.env.PATH}`, HADES_DATA: data, STUB_LOG: r.log, HADES_KIT_DIR: "", HADES_SKILL_DIR: "" },
    });
    expect(p.status).toBe(0);
    expect(p.stdout).toContain("imagem: hades-android-build:");
    expect(p.stdout).toContain("apk: ainda não gerado");
  });

  test("dado o shim, então é curto e só delega (sem docker, rsync nem container no bash do host)", () => {
    const text = readFileSync(join(SKILL, "kit/android/build.sh"), "utf8");
    expect(text).toContain("hades_kit_ts widget-apk");
    expect(/\b(rsync|docker run|gradle)\b/.test(text.split("\n").filter((l) => !l.startsWith("#")).join("\n"))).toBe(false);
  });

  test("dado o kit da skill, então o script de dentro do container é bash estrito e está em docker/inside.sh", () => {
    const inside = readFileSync(join(SKILL, "kit/android/docker/inside.sh"), "utf8");
    expect(inside).toContain("set -euo pipefail");
    expect(mode(join(SKILL, "kit/android/docker/inside.sh")) & 0o111).not.toBe(0);
  });
});
