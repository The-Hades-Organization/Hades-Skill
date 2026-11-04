# Minos — o publicador das saídas da Hades

Minos leva uma saída da Hades a quem não está com o painel aberto (o time, a liderança, você no celular sem o túnel). Ele
**não** converte `.md` em HTML, não troca os arquivos que os agentes leem (`brief`, `handoff`, `questions`, `report`, `plan`,
`STATUS` continuam `.md`) e não duplica o `renderMd` do painel. O que ele faz: a sessão gera **dados**, o Minos transforma
em **página**, o Cerberus confere, e a sessão publica.

## Divisão de trabalho

| Quem | Faz |
|---|---|
| Sessão do Claude | monta o plano e roda o `hades minos publish`; publica o arquivo com a ferramenta Artifact; devolve o link ao Minos (`hades minos link`) |
| `hades minos` (CLI) | monta o JSON do modelo, valida na fronteira, passa o Cerberus, grava a página e o registro; **nunca** fala com o claude.ai |
| Cerberus | barra a publicação com credencial, dado pessoal ou valor do `credenciais.md` |

Publicar num Artifact é ação da sessão, não da CLI: a ferramenta Artifact só existe dentro dela. Por isso o `publish` devolve
o que a sessão deve publicar, e só isso.

## Modelos

v1: um modelo, `orquestracao` (o acompanhamento que `reference/loop/orchestrate.md` §6 pede). O contrato fica pronto para
`lote-de-reviews` e `post-mortem` (próximos, não implementados): cada modelo é uma entrada em `MODELS`
(`src/lib/minos-model.ts`) com id, validador do JSON e renderizador; `hades minos list` mostra os modelos e as saídas.

### Contrato de `orquestracao` (`schema: 1`)

```json
{
  "model": "orquestracao", "schema": 1, "scope": "personal",
  "generatedAt": "2026-11-04T12:00:00Z",
  "plan": { "title": "…", "objective": "…", "state": ["linha de 'Estado atual'"], "units": [{ "name": "…", "role": "impl", "dependsOn": [] }] },
  "agents": [{ "name": "…", "mode": "impl", "state": "working", "phase": "…", "branch": "…", "pr": 12, "openQuestions": 0, "reportDone": false }],
  "prs": [{ "number": 12, "branch": "…", "agent": "…" }],
  "escalations": [{ "agent": "…", "question": "Q1 — …" }],
  "consumption": { "estimate": [{ "unit": "…", "costP50": 1.2, "minutesP50": 30, "confidence": "media" }], "limits": { "five": { "pct": 23, "resetsAt": "…Z" }, "seven": null } }
}
```

- Validado na fronteira (`validateOrchestration`): campo desconhecido é ignorado, tipo errado, enum desconhecido, texto
  acima do teto e lista acima do teto são **recusados** com o caminho do campo (nunca coagidos). Mudança é aditiva
  (`schema` só sobe com campo removido ou de outro significado).
- Os dados vêm do que a Hades já tem: o `plan.md` (título, objetivo, "Estado atual", tabela de unidades, `## Estimativa`
  da Moirai), o registro dos agentes (`<work>/orchestration/agents`), as perguntas abertas de cada `questions.md`, e o
  último % das janelas de uso (`reference/limites.md`). Fonte ausente vira lista vazia ou `null`, nunca número inventado.
- Tempo em UTC (ISO 8601 com `Z`). Sem texto de interface nos dados: rótulos ficam na página.

## Página

`kit/minos/orquestracao.html` é estática e genérica: o Minos escreve nela o corpo (tudo passa por `esc`, nenhum HTML vindo
de dado entra cru) e uma cópia legível dos dados num `<script type="application/json" id="minos-data">` (com `<` escapado).
Visual do painel (`kit/panel/ui/index.html`: Marfim no claro, Érebo no escuro, Figtree/Marcellus/Geist Mono com a pilha de
sistema como reserva, raio 0), tema pelo sistema e por `data-theme`. Sem script e sem recurso externo, então a mesma página
serve ao Artifact e ao `--html` offline.

## Fluxo de publicação (confira o que a ferramenta Artifact aceita)

1. `hades minos publish orquestracao <plano.md> [--html <arquivo>] [--team]`
   - monta os dados, valida, roda o **Cerberus** (abaixo). Barrado: nada é gravado, a saída explica o que barrou, rc=1.
   - grava `$D/minos/<saída>/index.html` e `data.json`, atualiza o registro `$D/minos/outputs.json` e imprime o bloco
     "publique" (abaixo). Com `--html <arquivo>`, grava a página também ali (offline) e **não** pede publicação.
2. A sessão publica com a ferramenta Artifact:
   - `file_path` = o `index.html` impresso; sem `url` na primeira vez, **`url` = o link registrado** nas seguintes (publica no
     mesmo lugar; o link que o time recebeu não muda); `icon: "chart"` só na primeira; `description` de uma frase (impressa).
   - A ferramenta pede `<title>` de duas a quatro palavras (a página já traz "Orquestração Hades" / "Orquestração do time"),
     cores em tokens de `:root` com tema escuro, `body` com fundo explícito, 16 px de margem e nenhum script externo: a
     página gerada já cumpre. Nada de `capabilities` (a v1 não lê dado vivo; atualizar é republicar).
   - Antes de republicar um artifact que a conversa não publicou, a ferramenta exige `action: "read"` do `url` primeiro.
3. `hades minos link <saída> <url>` grava o link devolvido pela ferramenta (só `https://claude.ai/…`). Daí em diante o
   `publish` imprime esse link e a sessão republica nele.
4. `hades minos open <saída>` abre o link registrado (ou a página local, se não houver link).

A saída do `publish` (para a sessão):

```
publique: <caminho do index.html>
link registrado: <url> | nenhum (primeira publicação)
descrição: <uma frase>
depois: hades minos link <saída> <url devolvida>
```

## Cerberus antes de toda publicação e atualização

A guarda é a mesma que barra o corpo dos reviews (`reference/cerberus/porta.md`), em duas camadas, ambas **antes** de
qualquer arquivo ficar no lugar:

1. varredura dos dados e da página em memória com os termos da skill (credencial, caminho da máquina, e-mail, nome de
   projeto) mais os **valores** do `credenciais.md` do `$D` (valor de 8+ caracteres que apareça no texto barra);
2. o momento `artefato` do Cerberus (`segredo-diff` com `--ctx arquivo=`), sobre a página em uma pasta de preparo.

Acontece em toda chamada de `publish`, na primeira e nas atualizações, para a página pessoal e a do time. A recusa diz o
motivo e onde (`campo` ou `linha`), nunca repete o valor. Segredo que já foi publicado é credencial queimada: reescrever a
página não basta.

## Página do time

Expõe o estado do trabalho a terceiros, então é **opcional e desligada**: `HADES_MINOS_TEAM=0` (Configurações → Minos). O
dono liga no onboarding (passo opcional "Página do time"). Com ela desligada, `--team` recusa. A página pessoal é o padrão.
O time é outro artifact (`<saída>.team`, link próprio), com `scope: "team"` nos dados. A ferramenta Artifact publica
sempre privado: **compartilhar** é do dono, no claude.ai, depois de conferir a página.

## `--html`: sem conta no claude.ai

`--html <arquivo>` grava a página autocontida (o padrão de `hades contrib html`: sem script, sem recurso externo) e
termina ali; serve a quem não tem conta ou quando não dá para publicar. O Cerberus roda do mesmo jeito.

## Painel

Na página Orquestração, o botão **Publicar** gera o `--html` local (`$D/minos/orquestracao/index.html`) e mostra o comando
de publicação para copiar. Não há página nova.

## Fora da v1 (próximos passos)

- Design System como artifact (cores, fontes e espaçamentos do painel como um artifact de tipo Design System para as
  páginas herdarem); hoje o visual é copiado do `index.html` do painel.
- Modelos `lote-de-reviews` (dados do `hades review-record`) e `post-mortem` (Thanatos), e o botão nas páginas Reviews e
  Thanatos.
- Comparar o visual da página com o do painel no `skill-release drift`.
