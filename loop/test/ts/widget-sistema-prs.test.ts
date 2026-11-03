// Grupo widget-sistema-prs: seções system e prs do GET /api/widget — contrato aditivo, cache do coletor sem gh na segunda leitura,
// último dado bom, 403 e 429.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { Rig, SKILL } from "./lib/rig";
import { caso } from "./lib/route";
import { widgetSistemaPrsRoute } from "./lib/widget-sistema-prs-route";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const wr = caso(await widgetSistemaPrsRoute(r, "wsp"));
const cfg = (key: string) => readFileSync(`${SKILL}/kit/config.tsv`, "utf8").split("\n").map((l) => l.split("\t")).find((c) => c[0] === key)?.[1] ?? "";

describe("widget-sistema-prs", () => {
  const cases: [string, string, () => string][] = [
    ["campos antigos intactos e seções novas aditivas", "agents,available,counts,events,updatedAt,version|prs,system", () => `${wr("campos-antigos")}|${wr("campos-novos")}`],
    ["contadores e agentes do v1 seguem iguais", '1 {"active": 1, "asking": 0, "stopped": 0} a', () => wr("agentes-intactos")],
    ["system.memory: total, usado e disponível", "32 12 20", () => wr("memoria")],
    ["system.infra: ligados contra de pé, obrigatórios, nomes dos caídos",
      '{"down": ["billing", "worker"], "enabled": 3, "required": 1, "requiredUp": 1, "up": 1}|{"down": ["cache"], "total": 2, "up": 1}', () => `${wr("servicos")}|${wr("containers")}`],
    ["system.queue: gate rodando (rótulo, idade, consumo) e quantos esperam",
      '{"running": {"ageSeconds": 240, "label": "build-api", "rssBytes": 1288490188}, "waiting": 2}', () => wr("fila")],
    ["prs: só as fora de draft, CI do GitHub e review pendente", "1 2 4 5 6|1:green 2:failing 4:running 5:none 6:none|1:0 2:1 4:1 5:0 6:0",
      () => `${wr("prs-sem-draft")}|${wr("prs-ci")}|${wr("prs-review")}`],
    ["prs: título com teto e campos do item", "120|ci,number,reviewPending,title", () => `${wr("prs-titulo-limitado")}|${wr("prs-campos")}`],
    ["prs: primeira leitura traz o dado da coleta, sem erro", "True 0 None", () => wr("prs-meta").split(" ").slice(0, 3).join(" ")],
    ["cache: a segunda leitura dentro do TTL não chama o coletor (nem o gh)", "1|60", () => `${wr("coletas-na-segunda-leitura")}|${wr("idade-do-cache")}`],
    ["cache vencido consulta de novo; falha mantém o último dado bom com código estável e sem detalhe", "2|True 5 collector_failed 301|0",
      () => `${wr("coletas-apos-vencer")}|${wr("falha-mantem-dado")}|${wr("falha-sem-detalhe")}`],
    ["falha não martela o gh (o TTL vale também depois dela) e a recuperação limpa o erro", "2|None 9 0", () => `${wr("falha-nao-martela")}|${wr("recuperou")}`],
    ["sem coleta ainda: seção indisponível (primeira falha ou coleta em andamento), nunca bloqueia a leitura", "False None collector_failed 0|False None",
      () => `${wr("primeira-falha")}|${wr("coleta-nao-bloqueia")}`],
    ["TTL nunca abaixo de GH_TTL e o coletor roda só pela linha de comando (bun src/cli.ts pr-loop-state --json)", "True|bun cli.ts pr-loop-state --json", () => `${wr("ttl-minimo")}|${wr("comando-do-coletor")}`],
    ["seções novas só atrás do token: sem token 401, token em outra rota e em POST 403", "401 widget_token|403 widget_token_scope|403 widget_token_scope",
      () => `${wr("sem-token")}|${wr("token-em-outra-rota")}|${wr("token-em-post")}`],
    ["oito tokens errados: 429 widget_rate_limited com Retry-After", "429 widget_rate_limited|600", () => `${wr("bloqueado")}|${wr("retry-after")}`],
    ["config.tsv: HADES_WIDGET_PRS_TTL tem padrão 300 (o mínimo)", "300", () => cfg("HADES_WIDGET_PRS_TTL")],
    ["Android: três widgets registrados (status, sistema, prs)", "prs sistema status",
      () => readdirSync(`${SKILL}/kit/android/widget/registry`, { recursive: true }).map(String).filter((f) => f.endsWith(".widget")).map((f) => f.split("/").pop()!.replace(/\.widget$/, "")).sort().join(" ")],
  ];
  for (const [nome, esperado, got] of cases) test(nome, () => { expect(got()).toBe(esperado); });
});
