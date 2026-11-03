# Thanatos: post-mortem de incidente e bug em produção do projeto

O Thanatos monta o post-mortem de um incidente **do projeto** (não da própria skill) a partir de git, PRs, reviews, do
diário de eventos (`reference/journal.md`) e, se o plugin do projeto fornecer, de logs e métricas externos. Vive **fora
do repositório**: nada é escrito no clone.

## Entradas

`hades thanatos new <entrada> [--force] [--json]`

| Entrada | Como é lida |
|---|---|
| `123` ou `#123` | número de PR |
| `<iso>..<iso>` | intervalo; cada ponta com `Z` ou fuso (sem fuso é recusado, nunca lido como hora local); sai em UTC. Lê as PRs mergeadas no período (teto `HADES_THANATOS_MAX_PRS`) e o `git log` do período |
| `FIX-77` | id de card, só se casar `card.idPattern` do perfil (sem caixa). Lê as PRs mergeadas cujo título, branch ou corpo citam o id |

`new` recusa sobrescrever um post-mortem existente sem `--force` (a edição à mão se perde). Sem `gh` utilizável, nada é gravado.

## Onde grava

`~/.claude/hades/work/<owner>__<repo>/postmortems/<id>.md` e `<id>.json` (mesma raiz do diário: `HADES_WORK_ROOT`).
`<id>`: `pr-<n>`, `card-<id>` ou `range-<de>-<ate>` (instantes compactos em UTC).

O `.md` tem: Resumo, Impacto, Linha do tempo (UTC), Causa, Como foi corrigido, Dados da correção e Lacunas (mais
"Métricas da fonte externa" quando há). Impacto, causa e correção vêm das seções `## Impacto`, `## Causa` e `## Correção` do
corpo das PRs; seção ausente vira **lacuna**, nada é inventado. A linha do tempo junta, em ordem de instante: commits, abertura,
reviews e merge das PRs, eventos do diário (sem o ruído de ferramenta; teto `HADES_THANATOS_JOURNAL_MAX`) e eventos da fonte.

**Tempo até a correção:** do início (o `start` da fonte, senão o início do intervalo, senão o primeiro commit, senão a
abertura da PR; a `basis` diz qual) até o último merge.

## Esquema do `.json` (v1)

Contrato versionado: campo novo só se acrescenta; mudar o sentido de um campo é `v` novo. Quem lê tolera `v` maior.

| Campo | Conteúdo |
|---|---|
| `v` | `1` |
| `id`, `input` | id e a entrada (`{kind: pr\|range\|card, …}`) |
| `createdAt` | UTC, ISO 8601 com `Z` |
| `title`, `summary`, `impact`, `cause`, `fix` | textos |
| `timeline[]` | `{ts, source: git\|gh\|diario\|fonte, text}`, ordenada |
| `fixData` | `prs[]`, `commits[]` (sha de 12), `files[]`, `authors[]`, `timeToFix {ms, from, to, basis}` ou `null` |
| `source` | `{status: ok\|absent\|no-token\|error, note, metrics[]}` |
| `gaps[]` | o que faltou |

## Fonte externa: o comando `thanatos-source` do plugin

Contrato, sem implementação concreta no núcleo. O plugin do pacote do projeto declara em `env/plugin.json`:

```json
{ "commands": [ { "name": "thanatos-source", "script": "commands/thanatos-source.sh", "tokenKey": "MINHA_FONTE_TOKEN" } ] }
```

- `script`: caminho relativo ao `env/` (dentro dele; `.sh` roda com `bash`, `.ts` com o Bun). `tokenKey` (opcional): chave de
  `$D/credenciais.md` (`CHAVE=valor`, uma por linha).
- Chamada: `script <de> <ate>` (instantes UTC), cwd na pasta do script, ambiente mínimo (`PATH`, `HOME`, `LANG`, `TZ`) mais
  `HADES_THANATOS_TOKEN` quando há `tokenKey`. Tempo máximo: `HADES_THANATOS_SOURCE_TIMEOUT_S`.
- Saída (stdout, JSON): `{"v":1, "start":"<iso>"?, "events":[{"ts":"<iso com fuso>","text":"…","level":"…"?}], "metrics":[{"name":"…","value":0,"unit":"…"?,"ts":"<iso>"?}]}`.
  Evento sem `ts` com fuso ou métrica sem número é descartado; textos passam pelo mascaramento de segredos do diário; tetos de 500
  eventos e 200 métricas. `v` maior é aceito.
- **Sem a fonte** (sem plugin, sem o comando, sem token em `credenciais.md`, saída não zero, tempo esgotado ou JSON fora do
  contrato) o post-mortem sai **sem a seção** e a lacuna diz o que faltou. O script é código de plugin: `commands/*` entra na
  prévia do `plugins add|update` e no Limiar do Cerberus como qualquer executável do plugin.

A fonte concreta (Loki/Grafana) fica no pacote do projeto (`ref env-*`).

## Consultar

`hades thanatos list|show <id>|search <termo>` (`--json` em todos). `search` é busca de trecho, sem caixa, nunca expressão regular.

## Sugestão no watch e aviso no deliver/review

- **Watch:** ao ver `MERGED` de uma PR cuja branch casa `thanatos.fixBranchPattern` (ERE, sem caixa) ou que tem uma das
  `thanatos.fixLabels` do perfil, o `hades watch` emite `THANATOS <agente> #<pr> fix de produção mergeado: hades thanatos new <pr>`.
  Sem a regra no perfil não sugere; não sugere de novo se `pr-<n>` já existe; `HADES_THANATOS_SUGGEST=0` desliga.
- **Deliver e review:** `hades thanatos cited [--base <ref> | --pr <n> | <arquivo>…]` imprime `AVISO <arquivo> já foi citado no
  post-mortem <id> …` para cada arquivo tocado que algum post-mortem anterior citou (caminho exato); sempre sai 0. É aviso, não barra.

## Painel

Página **Thanatos** (grupo Hades): lista e leitura do `.md`. Rotas `GET /api/thanatos` e `GET /api/thanatos/:id`
(`reference/panel.md`). Só leitura.
