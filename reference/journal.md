# Diário de eventos por agente (`src/lib/journal.ts`, `hades journal`)

Um JSONL por agente com o que ele fez e esperou: ferramentas, pedidos de permissão, fim de turno, prompts, eventos do
`watch`, do gate-lock e do Cerberus. É a base comum do Argos (acompanhar e agir sobre agentes) e do Thanatos
(post-mortem): quem consome (Argos, Thanatos) **só lê**.

## O que grava, e quem grava

| Fonte (`source`) | Quem escreve | `kind` |
|---|---|---|
| `guard` | o hook (`src/hook.ts`, `hades guard`) | `tool_pre`, `tool_post` (com `ok:`/`erro:` no resumo, sem a saída), `tool_blocked` (o guard barrou), `permission` (Notification de permissão; `tool` = a ferramenta pedida), `notification` (outros avisos), `stop`, `prompt` |
| `watch` | `hades watch`, cada evento que emite | `watch.<evento>` (`watch.question`, `watch.done`, …) |
| `gate` | gate-lock | `gate.enqueue`, `gate.admit`, `gate.timeout`, `gate.done` (`rc=` e duração) |
| `cerberus` | Cerberus | `cerberus.barra`, `cerberus.aviso` (o ok não grava) |
| `orch` | `hades agent decide` | `decision` (o orquestrador decidiu sozinho; sem agente, em `_sessions/_orch`; `reference/autonomia.md`) |
| `orch` | `hades agent done`, `park`, `skill-clean` | `agent.end` (encerrou a atividade do agente; o Argos apaga a permissão pendente que veio antes dele; um `permission` depois dele vale de novo) |

O hook registra os cinco eventos do Claude Code (`PreToolUse` e `PostToolUse` com matcher `*`, `Notification`, `Stop`,
`UserPromptSubmit`); o `guard register` troca no lugar, sem duplicar. As **decisões** do guard seguem só para o Bash,
como antes: o `*` só amplia o que é gravado.

## Esquema (v1)

Uma linha JSON por evento. Contrato versionado: campo novo só se acrescenta; mudar o sentido de um campo é `v` novo.

| Campo | Conteúdo |
|---|---|
| `v` | versão do esquema (`1`) |
| `ts` | instante em UTC, ISO 8601 com `Z` |
| `agent` | agente registrado; vazio se a sessão não casa com nenhum |
| `session` | `session_id` do Claude Code |
| `source` | `guard` · `watch` · `gate` · `cerberus` · `orch` |
| `kind` | ver tabela acima |
| `tool` | nome da ferramenta, quando há |
| `summary` | curto (até 200 caracteres): Bash = comando mascarado e truncado (sem corpo de heredoc); Read/Edit/Write = caminho; demais = só o nome da ferramenta; prompt = tamanho e os primeiros 60 caracteres |
| `cwd` | diretório da chamada |
| `decision` | só em `kind: decision`: `{level, needed, question, chosen, alternatives}` (cada campo até 200 caracteres, até 5 alternativas) |

Nunca entram conteúdo de arquivo, saída de ferramenta, prompt inteiro nem segredo: tokens conhecidos, `Bearer`,
`usuário:senha@` em URL, flags e variáveis com nome de segredo viram `***` **antes** de truncar.

## Onde fica

`<raiz de trabalho>/journal/<agente>.jsonl`, a mesma raiz de `~/.claude/hades/work/<owner>__<repo>/` (evolução da skill:
`_skill/journal/`). O agente sai do registro (`orchestration/agents`) pelo `cwd` dentro da worktree registrada.
Sessão sem agente: `<raiz>/_maquina/journal/_sessions/<session_id>.jsonl`.

## Retenção

| Chave | Padrão | Efeito |
|---|---|---|
| `HADES_JOURNAL` | `1` | `0` desliga a gravação |
| `HADES_JOURNAL_DAYS` | `14` | a limpeza (`clean`, categoria `journal`; roda no `logrotate`) apaga o arquivo parado há mais que isso e poda as linhas velhas do vivo |
| `HADES_JOURNAL_MAX_MB` | `20` | passou do teto, `<agente>.jsonl` vira `<agente>.1.jsonl` (o anterior sai) |

## Garantias

- Gravar **nunca** falha nem atrasa o hook: append com `flock` não bloqueante (3 tentativas de 1 ms); erro de disco ou
  lock ocupado é engolido e contado em `journal/.dropped`.
- O `bun:ffi` do lock só carrega quando há o que gravar; diário desligado não paga por ele.
- Latência do hook: o diário piora o p95 entre +1 e +2 ms.

## Como ler

- CLI: `hades journal list` · `tail|show <agente> [--since <dur|iso>] [--kind k] [--limit n] [--json]`.
  `--kind tool` casa `tool_pre`/`tool_post`; `--kind gate` casa `gate.*`. Sessão sem agente: `_sessions/<session_id>`.
- Painel: `GET /api/journal?agent=&since=&kind=&limit=` e `GET /api/journal/stream?agent=` (`reference/panel.md`).
- Direto: o JSONL (uma linha por evento, ordem de gravação). Quem consome tolera `v` maior ignorando campos
  desconhecidos e pula linha que não parseia (a última pode estar em escrita).
