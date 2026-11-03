// Download do APK do widget no painel, sem rede e sem Docker: painel real em processo numa porta livre de 127.0.0.1, APK falso e
// sidecar gravados no $D/android; imprime `<caso> <valor>` por verificação. O grupo widget-apk lê com `caso()`.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildAction } from "../../../../src/panel/actions.ts";
import { panelEnv } from "../../../../src/panel/env.ts";
import { type Rig } from "./rig";
import { type Dict, JSON_CT, Lines, bearer, directWidget, fetchRaw, py, remoteHeaders, startTestPanel, stubCollector, widgetData } from "./widget-rig";

const APK_BYTES = Buffer.concat(Array.from({ length: 100 }, () => Buffer.from("PK\x03\x04apk-falso-para-teste", "latin1")));
const VERSION = "4.11.0";
const CERT = "ab".repeat(32);
const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

/** A conta do android/build.sh (sources_sha), para provar que o painel e o build concordam. */
function shellSourcesSha(r: Rig, src: string): string {
  const cmd = 'cd "$1" && find . \\( -name build -o -name .gradle \\) -prune -o -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d" " -f1';
  return r.X(["bash", "-c", cmd, "_", src]).out.trim();
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(join(dir, e.name)) : [join(dir, e.name)]));
}

export async function widgetApkRoute(r: Rig, tag: string): Promise<string> {
  const { D, listenerPort } = widgetData(r, tag);
  const collector = stubCollector(r);
  const o = new Lines();
  const P = await startTestPanel(D);
  try {
    const { base } = P;
    const apk = `${D}/android/hades-widget.apk`, meta = `${D}/android/hades-widget.apk.json`, src = `${D}/android/widget`;
    const dl = "/api/widget/apk/download";
    const fetchP = (path: string, headers: Record<string, string> = {}, body?: unknown, method?: string, b = base) => fetchRaw(b, path, headers, body, method);
    const isApk = (raw: Uint8Array) => Buffer.compare(Buffer.from(raw), APK_BYTES) === 0;
    const remote = remoteHeaders(D, false);
    const cookie = { Cookie: remoteHeaders(D).Cookie as string };
    const token = { ...JSON_CT, "X-Panel-Token": P.token };
    const writeSidecar = (sources: string, sha?: string, version = VERSION) => writeFileSync(meta, JSON.stringify({
      versionName: version, versionCode: 41100, builtAt: "2026-10-26T06:00:00Z", size: APK_BYTES.length, sha256: sha ?? sha256(APK_BYTES), certSha256: CERT, sourcesSha256: sources,
    }));

    mkdirSync(`${D}/android`, { recursive: true });
    rmSync(apk, { force: true });
    rmSync(meta, { force: true });

    // sem APK
    let rep = await fetchP(dl);
    o.print("sem-apk-download", rep.status, rep.json?.code, Number(rep.text.includes(D) || rep.text.includes(apk)), Number(rep.text.includes("Gerar APK")));
    rep = await fetchP("/api/widget/apk");
    o.print("sem-apk-meta", rep.status, JSON.stringify(rep.json).replace(/":/g, '": '));

    // com APK e sidecar válido
    writeFileSync(apk, APK_BYTES);
    const sources = shellSourcesSha(r, src);
    writeSidecar(sources);
    rep = await fetchP(dl);
    o.print("download", rep.status, rep.hdr.get("Content-Type"), rep.hdr.get("Content-Disposition"), Number(isApk(rep.raw)), py(rep.hdr.get("Content-Length") === String(APK_BYTES.length)), rep.hdr.get("Cache-Control"));
    rep = await fetchP(dl, {}, undefined, "HEAD");
    o.print("head", rep.status, rep.hdr.get("Content-Type"), rep.hdr.get("Content-Disposition"), Number(rep.raw.length === 0));
    rep = await fetchP("/api/widget/apk");
    const m = rep.json as Dict;
    o.print("meta", rep.status, m.exists, m.size, m.sha256 === sha256(APK_BYTES), m.versionName, m.versionCode, m.builtAt, m.certSha256 === CERT, m.outdated);
    o.print("campos-meta", Object.keys(m).sort().join(","));
    // o painel e o build.sh chegam ao mesmo hash dos fontes: o sidecar leva o do build.sh e o painel o dá como atualizado
    o.print("hash-dos-fontes-igual-ao-do-build", Number(m.outdated === false));

    // fontes mudaram depois do build: desatualizado; o cache por mtime percebe
    const srcFile = listFiles(src).sort()[0] as string;
    const original = readFileSync(srcFile);
    writeFileSync(srcFile, Buffer.concat([original, Buffer.from("\n// mudou\n")]));
    utimesSync(srcFile, 1, 1_900_000_000);
    o.print("desatualizado", py(((await fetchP("/api/widget/apk")).json as Dict).outdated));
    writeFileSync(srcFile, original);
    utimesSync(srcFile, 1, 1_900_000_001);
    o.print("desatualizado-volta", py(((await fetchP("/api/widget/apk")).json as Dict).outdated));

    // sidecar de outro APK não empresta a versão
    writeSidecar(sources, "0".repeat(64));
    const div = (await fetchP("/api/widget/apk")).json as Dict;
    o.print("sidecar-divergente", div.versionName, div.versionCode, div.outdated);
    o.print("nome-sem-versao", (await fetchP(dl)).hdr.get("Content-Disposition"));
    // versionName fora do padrão não vira nome de arquivo
    writeSidecar(sources, undefined, '1.0"; x=');
    o.print("nome-invalido", (await fetchP(dl)).hdr.get("Content-Disposition"));
    writeFileSync(meta, "{lixo");
    o.print("sidecar-ilegivel", (await fetchP("/api/widget/apk")).status, ((await fetchP("/api/widget/apk")).json as Dict).versionName);
    writeSidecar(sources);

    // acesso remoto: sem cookie recusado, com cookie serve
    for (const [label, path] of [["remoto-sem-cookie-download", dl], ["remoto-sem-cookie-meta", "/api/widget/apk"]] as const) {
      rep = await fetchP(path, remote);
      o.print(label, rep.status, Number(isApk(rep.raw)), rep.hdr.get("Content-Type"));
    }
    o.print("remoto-sem-cookie-head", (await fetchP(dl, remote, undefined, "HEAD")).status);
    rep = await fetchP(dl, { ...remote, ...cookie });
    o.print("remoto-com-cookie", rep.status, Number(isApk(rep.raw)), rep.hdr.get("Content-Type"));
    o.print("remoto-chave-errada", (await fetchP(dl, { ...remote, Cookie: `${panelEnv(D).cookie}=errado` })).status);
    o.print("host-estranho", (await fetchP(dl, { Host: "outro.example.invalid", "X-Forwarded-Host": "outro.example.invalid" })).status);

    // token do widget: nunca abre o download nem os metadados
    const wtok = String(directWidget(D, { now: () => 0 }).tokenAct("create").token);
    const bear = bearer(wtok);
    for (const [label, path] of [["token-do-widget-download", dl], ["token-do-widget-meta", "/api/widget/apk"]] as const) {
      rep = await fetchP(path, bear);
      o.print(label, rep.status, rep.json?.code, Number(isApk(rep.raw)));
    }
    o.print("token-do-widget-head", (await fetchP(dl, bear, undefined, "HEAD")).status);

    // listener do widget (túnel anônimo): o APK não passa por lá, com ou sem token
    const wbase = `http://127.0.0.1:${listenerPort}`;
    for (const [label, path] of [["listener-download", dl], ["listener-meta", "/api/widget/apk"]] as const) {
      for (const [t, hdrs] of [["com-token", bear], ["sem-token", {}]] as const) {
        rep = await fetchP(path, hdrs, undefined, undefined, wbase);
        o.print(`${label}-${t}`, rep.status, Number(isApk(rep.raw)), rep.hdr.get("Content-Type"));
      }
    }

    // gerar: só com o token do painel (e o cookie, no remoto); a ação vem da lista fechada e chama android/build.sh build
    o.print("gerar-sem-token", (await fetchP("/api/action", JSON_CT, { action: "widget-apk" })).status);
    o.print("gerar-remoto-sem-cookie", (await fetchP("/api/action", { ...remote, ...token }, { action: "widget-apk" })).status);
    o.print("gerar-token-do-widget", (await fetchP("/api/action", { ...JSON_CT, ...bear }, { action: "widget-apk" })).status);
    const ctx = { env: panelEnv(D), plugin: { runFlags: [], optionalContainers: new Set<string>() }, config: () => ({}), containerNames: () => [], baseRef: async () => "origin/main", pluginAction: async () => { throw new Error("sem plugin"); } };
    const built = await buildAction(ctx as unknown as Parameters<typeof buildAction>[0], { action: "widget-apk" });
    const words = built.script.split(/\s+/).map((w) => w.replace(/^'|'$/g, ""));
    o.print("gerar-acao", built.title, Number((words[words.length - 2] as string).endsWith("android/build.sh")), words[words.length - 1], Number(built.exclusive));
  } finally {
    P.stop();
    collector.restore();
  }
  return o.out;
}
