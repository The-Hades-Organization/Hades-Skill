// Grupo widget-apk: download e metadados do APK do widget pelo painel, remoto, listener do widget, ação de gerar.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Rig, SKILL } from "./lib/rig";
import { caso } from "./lib/route";
import { widgetApkRoute } from "./lib/widget-apk-route";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const wk = caso(await widgetApkRoute(r, "wk"));
const mime = "application/vnd.android.package-archive", ui = `${SKILL}/kit/panel/ui`;
const count = (p: string, re: RegExp) => readFileSync(p, "utf8").split("\n").filter((l) => re.test(l)).length;

describe("widget-apk", () => {
  const dl = `attachment; filename="hades-widget-4.11.0.apk"`;
  const cases: [string, string, () => string][] = [
    ["sem APK: download 404 apk_missing, mensagem acionável e sem caminho no corpo", "404 apk_missing 0 1", () => wk("sem-apk-download")],
    ["sem APK: metadados dizem que não existe", '404 {"exists": false}', () => wk("sem-apk-meta").replace(/^200/, "404")],
    ["download: 200, tipo de APK, anexo com nome versionado, corpo íntegro, sem cache", `200 ${mime} ${dl} 1 True no-store`, () => wk("download")],
    ["HEAD do download: mesmos cabeçalhos, sem corpo", `200 ${mime} ${dl} 1`, () => wk("head")],
    ["metadados: tamanho, sha256 do arquivo, versão, data UTC, certificado e atualizado", "200 True 2400 True 4.11.0 41100 2026-10-26T06:00:00Z True False", () => wk("meta")],
    ["metadados: campos do contrato", "builtAt,certSha256,exists,kitVersion,outdated,sha256,size,versionCode,versionName", () => wk("campos-meta")],
    ["hash dos fontes: o painel e o build.sh chegam ao mesmo valor", "1", () => wk("hash-dos-fontes-igual-ao-do-build")],
    ["fonte do widget mudou depois do build: desatualizado; voltou ao igual: atualizado", "True False", () => `${wk("desatualizado")} ${wk("desatualizado-volta")}`],
    ["sidecar de outro APK não empresta a versão (e conta como desatualizado)", "None None True", () => wk("sidecar-divergente")],
    ["sem versão confiável o nome do arquivo é genérico; versionName inválido também", 'attachment; filename="hades-widget.apk"|attachment; filename="hades-widget.apk"', () => `${wk("nome-sem-versao")}|${wk("nome-invalido")}`],
    ["sidecar ilegível não derruba os metadados", "200 None", () => wk("sidecar-ilegivel")],
    ["remoto sem cookie: download, metadados e HEAD recusados (401), sem o APK", "401 0 application/json|401 0 application/json|401",
      () => `${wk("remoto-sem-cookie-download")}|${wk("remoto-sem-cookie-meta")}|${wk("remoto-sem-cookie-head")}`],
    ["remoto com o cookie da chave: serve o APK", `200 1 ${mime}`, () => wk("remoto-com-cookie")],
    ["remoto com cookie errado e host estranho: recusados", "401|403", () => `${wk("remoto-chave-errada")}|${wk("host-estranho")}`],
    ["token do widget não abre download nem metadados (403 widget_token_scope)", "403 widget_token_scope 0|403 widget_token_scope 0|403",
      () => `${wk("token-do-widget-download")}|${wk("token-do-widget-meta")}|${wk("token-do-widget-head")}`],
    ["listener do widget não serve o APK (404), com ou sem token", "404 0 application/json|404 0 application/json|404 0 application/json|404 0 application/json",
      () => `${wk("listener-download-com-token")}|${wk("listener-download-sem-token")}|${wk("listener-meta-com-token")}|${wk("listener-meta-sem-token")}`],
    ["gerar: sem token do painel 403; remoto sem cookie 401; token do widget 403", "403|401|403",
      () => `${wk("gerar-sem-token")}|${wk("gerar-remoto-sem-cookie")}|${wk("gerar-token-do-widget")}`],
    ["gerar: ação fechada que chama android/build.sh build, fora da trava do ambiente", "Gerar o APK do widget Android 1 build 0", () => wk("gerar-acao")],
    ["card do APK: um componente só (módulo compartilhado), usado em Acesso remoto e fora da Visão geral, sem cópia", "1 0 1 0 0",
      () => [count(`${ui}/widget-apk.tsx`, /^HadesCore\.WidgetApk = WidgetApk;/), count(`${ui}/pages/overview.tsx`, /<WidgetApk /), count(`${ui}/pages/remote.tsx`, /<WidgetApk /),
        count(`${ui}/pages/overview.tsx`, /function WidgetApk/), count(`${ui}/pages/remote.tsx`, /function WidgetApk/)].join(" ")],
    ["card do APK: o módulo carrega depois da base e antes das páginas", "ok", () => {
      const L = readFileSync(`${ui}/index.html`, "utf8").split("\n"); let a = 0, w = 0, p = 0;
      L.forEach((l, i) => { if (/ui\/app.js/.test(l)) a = i + 1; if (/ui\/widget-apk.js/.test(l)) w = i + 1; if (/ui\/pages\/overview.js/.test(l)) p = i + 1; });
      return a && a < w && w < p ? "ok" : "ordem errada";
    }],
  ];
  for (const [nome, esperado, got] of cases) test(nome, () => { expect(got()).toBe(esperado); });
});
