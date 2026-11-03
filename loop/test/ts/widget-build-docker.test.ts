// Grupo widget-build-docker (opcional, fora da regressão padrão): build REAL do APK com Docker e rede.
// Roda só com HADES_TEST_DOCKER=1, e pela fila de builds: `HADES_TEST_DOCKER=1 hades gate-lock run build -- bun test <este arquivo>`.
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apkVersion, imageTag } from "../../../src/lib/widget-build";
import { sourcesSha } from "../../../src/lib/widget-sources";
import { BUN, SKILL } from "./lib/rig";

const ENABLED = process.env.HADES_TEST_DOCKER === "1";
const BUILD_TIMEOUT_MS = 30 * 60 * 1000;
const T = mkdtempSync(join(tmpdir(), "hades-widget-docker-"));
afterAll(() => rmSync(T, { recursive: true, force: true }));

describe.skipIf(!ENABLED)("widget-build-docker: build real", () => {
  test("dado o kit da skill, quando gera o APK, então o sidecar descreve o arquivo e o apksigner verifica", () => {
    const state = join(T, "android");
    const p = spawnSync(BUN, [join(SKILL, "src/cli.ts"), "widget-apk", "build"], {
      encoding: "utf8", env: { ...process.env, HADES_DATA: T, HADES_KIT_DIR: "", GATE_LOCK_TICKET: "1" }, timeout: BUILD_TIMEOUT_MS,
    });
    expect(p.status).toBe(0);
    const apk = join(state, "hades-widget.apk");
    const meta = JSON.parse(readFileSync(`${apk}.json`, "utf8")) as Record<string, unknown>;
    const version = apkVersion(join(SKILL, "VERSION"));
    const verify = spawnSync("docker", ["run", "--rm", "-v", `${state}:/work:ro`, imageTag(join(SKILL, "kit/android/docker/Dockerfile")), "apksigner", "verify", "--print-certs", "/work/hades-widget.apk"], { encoding: "utf8" });
    const cert = /Signer #1 certificate SHA-256 digest: ([0-9a-f]{64})/.exec(verify.stdout)?.[1];
    const { builtAt, ...rest } = meta;
    expect(verify.status).toBe(0);
    expect(rest).toEqual({
      versionName: version.name, versionCode: version.code, sha256: createHash("sha256").update(readFileSync(apk)).digest("hex"),
      size: statSync(apk).size, certSha256: cert, sourcesSha256: sourcesSha(join(SKILL, "kit/android/widget")),
    });
    expect(String(builtAt)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(statSync(join(state, "hades-widget.keystore")).mode & 0o777).toBe(0o600);
  }, BUILD_TIMEOUT_MS);
});
