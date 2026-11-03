// Grupo widget-api: GET /api/widget, token do widget, escopo e criação só local; painel real em porta livre, sem rede.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Rig, SKILL, readJson } from "./lib/rig";
import { caso } from "./lib/route";
import { widgetApiRoute } from "./lib/widget-route";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const wr = caso(await widgetApiRoute(r, "wa"));
const cfg = (key: string) => readFileSync(`${SKILL}/kit/config.tsv`, "utf8").split("\n").map((l) => l.split("\t")).find((c) => c[0] === key)?.[1] ?? "";

describe("widget-api", () => {
  const cases: [string, string, () => string][] = [
    ["sem token configurado a rota fecha (404 widget_off)", "404 widget_off", () => wr("sem-token-configurado")],
    ["criar pelo acesso remoto: 403 e nada gravado", "403 widget_local_only|0", () => `${wr("criar-pelo-remoto")}|${wr("criar-pelo-remoto-gravou")}`],
    ["criar sem o token do painel: 403", "403 token", () => wr("criar-sem-token-do-painel")],
    ["operação fora da lista: 400", "400 operação inválida", () => wr("op-invalida")],
    ["criar no painel local: 200", "200 -", () => wr("criar")],
    ["arquivo do token com 600 e só o hash dentro", "arquivo-modo 600 sem-token-em-claro 1", () => `arquivo-modo ${wr("arquivo-modo")}`],
    ["status: configurado e sem o valor do token", "200 - 1 1", () => { const f = wr("status-configurado").split(" "); return `${wr("status")} ${f[0]} ${f[2]}`; }],
    ["token certo: 200, versão 1, updatedAt em UTC e contagens", '200 -|1 2026-10-26T07:33:20Z {"active": 1, "asking": 2, "stopped": 2}', () => `${wr("certo")}|${wr("formato")}`],
    ["agentes: encerrados saem; pergunta e bloqueado viram asking", "trab:active ocioso:stopped fora:stopped pergunta:asking bloq:asking", () => wr("agentes")],
    ["há quanto tempo: segundos desde o último prompt (UTC)", "5600", () => wr("idade-trab")],
    ["campos de cada agente (contrato)", "ageSeconds,name,openQuestions,role,since,state", () => wr("campos-agente")],
    ["eventos: os mais novos primeiro (empate na ordem do registro)", "done:feito prompted:trab prompted:pergunta 6", () => wr("eventos")],
    ["eventos: o teto pedido é respeitado", "2", () => wr("teto")],
    ["token do widget pelo túnel sem cookie de sessão: aceito", "200 -", () => wr("certo-pelo-remoto-sem-cookie")],
    ["token errado: 401 widget_token", "401 widget_token", () => wr("errado")],
    ["sem cabeçalho: 401", "401 widget_token", () => wr("ausente")],
    ["token na query string não vale", "401 widget_token", () => wr("na-query")],
    ["cookie do acesso remoto não abre a rota do widget", "401 widget_token", () => wr("cookie-nao-vale")],
    ["token do widget em outra rota (GET): recusado", "403 widget_token_scope|403 widget_token_scope|403 widget_token_scope|403 widget_token_scope",
      () => `${wr("outra-rota-snapshot")}|${wr("outra-rota-remote")}|${wr("outra-rota-token-do-painel")}|${wr("outra-rota-orchestration")}`],
    ["token do widget em outra rota pelo túnel e em POST: recusado", "403 widget_token_scope|403 widget_token_scope|403 widget_token_scope",
      () => `${wr("outra-rota-remoto")}|${wr("post-em-outra-rota")}|${wr("post-no-widget")}`],
    ["revogar pelo acesso remoto: 403 e o token segue valendo", "403 widget_local_only|200 -", () => `${wr("revogar-pelo-remoto")}|${wr("ainda-vale")}`],
    ["revogado: a rota fecha", "200 -|404 widget_off", () => `${wr("revogar")}|${wr("revogado")}`],
    ["gerar de novo troca o token: o antigo não volta, o novo vale", "401 widget_token|200 -", () => `${wr("token-antigo-nao-volta")}|${wr("token-novo")}`],
    ["oito tokens errados em 10 min: 429 com Retry-After", "429 widget_rate_limited|600", () => `${wr("bloqueado")}|${wr("retry-after")}`],
    ["listener do widget: token certo 200; outro caminho, raiz e POST 404", "200 -|404 not_found|404 not_found|404 not_found",
      () => `${wr("listener-token-certo")}|${wr("listener-outro-caminho")}|${wr("listener-raiz")}|${wr("listener-post")}`],
    ["listener do widget: sem token 401", "401 widget_token", () => wr("listener-sem-token")],
    ["bloqueio por IP: o IP com 8 erros leva 429 e Retry-After; outro IP segue com 200", "429 widget_rate_limited|600|200 -",
      () => `${wr("ip-bloqueado")}|${wr("ip-retry-after")}|${wr("outro-ip-segue")}`],
    ["bloqueio por IP conta primeiro e último X-Forwarded-For: forjar um não escapa do outro", "429 widget_rate_limited|429 widget_rate_limited|200 -",
      () => `${wr("forja-primeiro")}|${wr("forja-ultimo")}|${wr("primeiro-e-ultimo-livres")}`],
    ["bloqueio por IP vale no painel (mesmo IP de socket)", "429 widget_rate_limited", () => wr("painel-mesmo-ip-bloqueado")],
    ["tabela de IPs com teto e expiração", "1|1", () => `${wr("tabela-de-ips-limitada")}|${wr("tabela-expira-velhas")}`],
    ["config.tsv: HADES_WIDGET_PORT 21221 e HADES_WIDGET_TUNNEL_TTL 30d", "21221 30d", () => `${cfg("HADES_WIDGET_PORT")} ${cfg("HADES_WIDGET_TUNNEL_TTL")}`],
    ["auditoria: criação e revogação, sem o token", "token-criado token-revogado 0", () => wr("auditoria")],
    ["config.tsv: HADES_WIDGET_EVENTS tem padrão 8", "8", () => cfg("HADES_WIDGET_EVENTS")],
    ["manifest: JSON válido com os atalhos Orquestração, Herdr e Claude", "Orquestração Herdr Claude",
      () => (readJson(`${SKILL}/kit/panel/ui/manifest.webmanifest`).shortcuts as { name: string }[]).map((s) => s.name).join(" ")],
    ["manifest: atalhos dentro do escopo e com url relativa", "true",
      () => String((readJson(`${SKILL}/kit/panel/ui/manifest.webmanifest`).shortcuts as { url: string }[]).every((s) => s.url.startsWith("/")))],
  ];
  for (const [nome, esperado, got] of cases) test(nome, () => { expect(got()).toBe(esperado); });
});
