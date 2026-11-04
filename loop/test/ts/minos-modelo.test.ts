// Grupo minos-modelo: o contrato do modelo `orquestracao`, a montagem dos dados, a página (tudo escapado), o registro de
// links e a varredura que antecede toda publicação. Tudo puro: nada de disco do ambiente nem de rede.
import { describe, expect, test } from "bun:test";
import { buildOrchestration, parsePlan, type AgentSource } from "../../../src/lib/minos-collect";
import { credentialValues, scanOutput } from "../../../src/lib/minos-guard";
import { dataBlock, esc, loadTemplate, pageTitle, renderOrchestrationHtml } from "../../../src/lib/minos-html";
import { ContractError, ORQUESTRACAO_SCHEMA, validateOrchestration, type OrchestrationData } from "../../../src/lib/minos-model";
import { outputId, parseArtifactUrl } from "../../../src/lib/minos-store";

const NOW = new Date("2026-11-04T12:00:00Z");
const NO_TERMS = { names: [], vocab: [], domain: [], allow: [], slug: "" };
// montado em partes: este arquivo não casa com a varredura de segredos do release
const FAKE_TOKEN = `${"gh"}p_${"a1B2".repeat(9)}`;

const PLAN = `# Plano — Entrega <b>de exemplo</b>

## Estado atual
- **Unidades:** api — trabalhando
- **Aguardando:** o dono

## Objetivo
Acompanhar a entrega.

## Unidades
| Unidade | Card | Papel | Modelo/esforço | Base | Depende de | Specs |
|---|---|---|---|---|---|---|
| api | novo | impl | x | main | — | S1 |
| web | novo | impl | x | main | \`api\` | S2 |

## Estimativa
| Unidade | Custo p25 (US$) | Custo mediana (US$) | Custo p75 (US$) | Duração p25 (min) | Duração mediana (min) | Duração p75 (min) | Gate mediana (min) | Amostra | Confiança | Base |
|---|---|---|---|---|---|---|---|---|---|---|
| api | 1 | 2.5 | 4 | 10 | 35 | 60 | 5 | 4 | media | parecidas |
| web | — | — | — | — | — | — | — | 0 | nenhuma | sem-historico |
`;

const agent = (over: Partial<AgentSource> = {}): AgentSource => ({
  name: "api", mode: "impl", state: "working", phase: "", branch: "skill/api", pr: 12, openQuestions: ["Q1 — qual formato?"], reportDone: false, ...over,
});

const build = (over: Partial<Parameters<typeof buildOrchestration>[0]> = {}): OrchestrationData =>
  buildOrchestration({ planText: PLAN, agents: [agent()], limits: { five: { pct: 23.4, resetsAt: "2026-11-04T18:00:00Z" }, seven: null }, scope: "personal", now: NOW, ...over });

const refused = (input: unknown): string => {
  try {
    validateOrchestration(input);
  } catch (error) {
    expect(error).toBeInstanceOf(ContractError);
    return (error as ContractError).message;
  }
  throw new Error("o contrato aceitou o que devia recusar");
};

describe("minos-modelo: dados", () => {
  test("dado o plano e os agentes, quando monta, então o contrato sai válido e completo", () => {
    const data = build();
    expect(validateOrchestration(JSON.parse(JSON.stringify(data)))).toEqual(data);
    expect(data.schema).toBe(ORQUESTRACAO_SCHEMA);
    expect(data.plan.title).toBe("Entrega <b>de exemplo</b>");
    expect(data.plan.units.map((u) => [u.name, u.dependsOn])).toEqual([["api", []], ["web", ["api"]]]);
    expect(data.plan.state).toEqual(["Unidades: api — trabalhando", "Aguardando: o dono"]);
    expect(data.prs).toEqual([{ number: 12, branch: "skill/api", agent: "api" }]);
    expect(data.escalations).toEqual([{ agent: "api", question: "Q1 — qual formato?" }]);
    expect(data.agents[0]?.openQuestions).toBe(1);
  });

  test("dada a seção Estimativa, então custo e duração medianos entram, e '—' vira null com confiança sem histórico", () => {
    const { estimate } = parsePlan(PLAN);
    expect(estimate).toEqual([
      { unit: "api", costP50: 2.5, minutesP50: 35, confidence: "media" },
      { unit: "web", costP50: null, minutesP50: null, confidence: "nenhuma" },
    ]);
  });

  test("dado plano vazio e nenhum agente, então listas vazias e janelas null, sem número inventado", () => {
    const data = build({ planText: "", agents: [], limits: { five: null, seven: null } });
    expect(data.plan).toEqual({ title: "Orquestração", objective: "", state: [], units: [] });
    expect([data.agents, data.prs, data.escalations, data.consumption.estimate]).toEqual([[], [], [], []]);
    expect(data.consumption.limits).toEqual({ five: null, seven: null });
  });

  test("dado estado de agente desconhecido, então vira 'unknown' e duas unidades na mesma PR contam uma vez", () => {
    const data = build({ agents: [agent({ state: "voando" }), agent({ name: "web", branch: "skill/api" })] });
    expect(data.agents[0]?.state).toBe("unknown");
    expect(data.prs).toHaveLength(1);
  });
});

describe("minos-modelo: contrato na fronteira", () => {
  const ok = JSON.parse(JSON.stringify(build()));
  const mutate = (fn: (d: Record<string, any>) => void): unknown => {
    const copy = JSON.parse(JSON.stringify(ok));
    fn(copy);
    return copy;
  };

  test("recusa schema de outra versão, modelo errado e escopo desconhecido", () => {
    expect(refused(mutate((d) => { d.schema = 2; }))).toContain("schema");
    expect(refused(mutate((d) => { d.model = "lote-de-reviews"; }))).toContain("model");
    expect(refused(mutate((d) => { d.scope = "publico"; }))).toContain("scope");
  });

  test("recusa tipo errado com o caminho do campo, sem repetir o valor", () => {
    const message = refused(mutate((d) => { d.agents[0].pr = "doze"; }));
    expect(message).toContain("agents[0].pr");
    expect(message).not.toContain("doze");
    expect(refused(mutate((d) => { d.agents[0].reportDone = "sim"; }))).toContain("agents[0].reportDone");
  });

  test("recusa enum desconhecido, instante sem Z, texto e lista acima do teto, % fora de 0–100", () => {
    expect(refused(mutate((d) => { d.agents[0].state = "dormindo"; }))).toContain("agents[0].state");
    expect(refused(mutate((d) => { d.generatedAt = "2026-11-04T12:00:00-03:00"; }))).toContain("generatedAt");
    expect(refused(mutate((d) => { d.plan.title = "x".repeat(501); }))).toContain("plan.title");
    expect(refused(mutate((d) => { d.prs = Array.from({ length: 201 }, (_, i) => ({ number: i, branch: "b", agent: "a" })); }))).toContain("prs");
    expect(refused(mutate((d) => { d.consumption.limits.five.pct = 101; }))).toContain("consumption.limits.five.pct");
  });

  test("recusa o que não é objeto, e aceita campo extra ignorando-o (contrato aditivo)", () => {
    expect(refused(null)).toContain("$");
    expect(refused(mutate((d) => { d.plan = []; }))).toContain("plan");
    const extra = validateOrchestration(mutate((d) => { d.novo = 1; }));
    expect("novo" in extra).toBe(false);
  });
});

describe("minos-modelo: página", () => {
  const hostile = build({
    planText: PLAN.replace("Acompanhar a entrega.", '<script>alert(1)</script> "aspas" & cia'),
    agents: [agent({ name: "<img src=x onerror=1>", openQuestions: ["Q1 — </script><svg onload=1>"] })],
  });
  const html = renderOrchestrationHtml(loadTemplate(), hostile);

  test("tudo que vem de dado entra escapado e nada vira marcação", () => {
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<svg onload");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &quot;aspas&quot; &amp; cia");
    expect(html).toContain("Entrega &lt;b&gt;de exemplo&lt;/b&gt;");
  });

  test("o único script é o bloco JSON dos dados, e o JSON não fecha nem abre marcação", () => {
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).toContain('<script type="application/json" id="minos-data">');
    const block = dataBlock(hostile);
    expect(block).not.toContain("<");
    expect(JSON.parse(block)).toEqual(JSON.parse(JSON.stringify(hostile)));
  });

  test("autocontida: sem recurso externo, sem manipulador de evento e sem marcador sobrando", () => {
    // dados limpos: o texto hostil escapado ainda contém "src=" como texto, o que não é atributo
    const clean = renderOrchestrationHtml(loadTemplate(), build());
    expect(clean).not.toMatch(/https?:\/\//i);
    expect(clean).not.toMatch(/<link|<img|<iframe|@import|url\(|\ssrc=|\shref=/i);
    expect(clean).not.toMatch(/\son[a-z]+=/i);
    expect(clean).not.toMatch(/\{\{[A-Z]+\}\}/);
  });

  test("tema claro e escuro, pelo sistema e por data-theme, e título de duas a quatro palavras por escopo", () => {
    expect(html).toContain('@media (prefers-color-scheme: dark)');
    expect(html).toContain(':root:not([data-theme="light"])');
    expect(html).toContain(':root[data-theme="dark"]');
    expect(pageTitle(hostile)).toBe("Orquestração Hades");
    expect(pageTitle(build({ scope: "team" }))).toBe("Orquestração do time");
    expect(html).toContain("<title>Orquestração Hades</title>");
  });

  test("dado marcador {{X}} dentro de um valor, então não é relido como marcador", () => {
    const tricky = build({ planText: PLAN.replace("Acompanhar a entrega.", "{{DATA}}") });
    expect(renderOrchestrationHtml(loadTemplate(), tricky)).toContain("{{DATA}}");
  });

  test("esc cobre os cinco caracteres", () => {
    expect(esc(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});

describe("minos-modelo: registro", () => {
  test("a saída tem id estável por modelo, plano e escopo", () => {
    expect(outputId("orquestracao", "/x/Plano Novo.md", "personal")).toBe("orquestracao-plano-novo");
    expect(outputId("orquestracao", "/x/Plano Novo.md", "team")).toBe("orquestracao-plano-novo-team");
  });

  test("só aceita link https do claude.ai em /artifact/<id>", () => {
    expect(parseArtifactUrl("https://claude.ai/artifact/abc-123")).toBe("https://claude.ai/artifact/abc-123");
    expect(parseArtifactUrl("https://claude.ai/code/artifact/0a1b/")).toBe("https://claude.ai/code/artifact/0a1b");
    for (const bad of ["http://claude.ai/artifact/a", "https://evil.example/artifact/a", "https://claude.ai.evil.example/artifact/a",
      "https://claude.ai/chat/a", "https://claude.ai/artifact/", "https://u:p@claude.ai/artifact/a", "https://claude.ai:8443/artifact/a", "javascript:alert(1)", "lixo"]) {
      expect(parseArtifactUrl(bad)).toBeUndefined();
    }
  });
});

describe("minos-modelo: varredura antes de publicar", () => {
  const scan = (text: string, credentials?: string) => scanOutput({ texts: [{ label: "página", text }], credentials, terms: NO_TERMS });

  test("dada credencial no texto, então barra com rótulo, linha e tipo, sem repetir o valor", () => {
    const reasons = scan(`linha limpa\ntoken: ${FAKE_TOKEN}`);
    expect(reasons).toEqual(["página:2  credencial"]);
    expect(reasons.join()).not.toContain(FAKE_TOKEN);
  });

  test("dado caminho da máquina e e-mail real, então barra os dois", () => {
    expect(scan("veja /home/fulano/projeto/x")).toEqual(["página:1  caminho da máquina"]);
    expect(scan("fale com fulano@empresa.com.br")).toEqual(["página:1  e-mail"]);
    expect(scan("noreply@example.com")).toEqual([]);
  });

  test("dado valor do credenciais.md na página, então barra sem repetir o valor; valor curto não conta", () => {
    const cofre = "# cofre\n- `API_X=valor-do-cofre-123`\nCURTO=abc\nTOKEN_Y: \"outro-valor-secreto\"\n";
    expect(credentialValues(cofre)).toEqual(["valor-do-cofre-123", "outro-valor-secreto"]);
    const reasons = scan("a\nusando valor-do-cofre-123 aqui\nabc", cofre);
    expect(reasons).toEqual(["página:2  valor do credenciais.md"]);
    expect(reasons.join()).not.toContain("valor-do-cofre");
  });

  test("dado texto limpo, então nada barra (e sem credenciais.md também)", () => {
    expect(scan("Acompanhamento da entrega: 3 agentes, 2 PRs.")).toEqual([]);
    expect(credentialValues(undefined)).toEqual([]);
  });
});
