# Catálogo de qualidade

Regras genéricas de boa engenharia (linguagem, framework, práticas, estilo, testes, banco) que o dono **liga e
desliga** e que a Hades injeta nos briefs e nas fases do loop. Não há regra de empresa nem de projeto aqui: as do
projeto vêm do perfil (`rules.docs`, `reference/projects.md`) e valem por cima.

## Onde fica

| O quê | Onde |
|---|---|
| Catálogo base (127 regras, texto próprio) | `<skill>/quality/base.json` |
| Pacotes base (conjuntos nomeados de regras) | `<skill>/quality/packs.json` |
| Regras e pacotes do dono (mesmo formato; mesmo `id` vence o base) | `~/.claude/hades/quality/*.json` |
| Escolhas do dono | `~/.claude/hades/quality/choices.tsv` (uma linha `id<TAB>on\|off` só para o que difere do padrão) |

Formato `hades.quality/1` e `choices.tsv`: `reference/projects.md` §Catálogo. `default: off` marca regra de nicho
(estilo e linguagem específicos) que o dono liga se quiser.

## Pacotes

Um pacote é uma lista nomeada de `id` de regra (`packs[]`: `id`, `title`, `text`, `rules`); a mesma regra pode estar
em vários. O pacote **não tem estado próprio**: ligar ou desligar um pacote grava a escolha de cada regra dele em
`choices.tsv`, e a escolha mais recente vence (desligar uma regra depois de ligar o pacote vale; ligar o pacote de
novo a religa). O estado mostrado é derivado: **ligado** (todas), **desligado** (nenhuma) ou **parcial**. Ligar um
pacote parcial completa o pacote.

| Pacote | Para quê |
|---|---|
| `codigo-limpo` | nomes, funções, erro explícito, SOLID, comentários e commits |
| `servicos` | serviço em produção: camadas, configuração, timeout, desligamento, saúde, paginação, limites |
| `frontend` | interface: componente sem regra, acessibilidade, tradução, tokens, ciclo de vida, corrida de respostas |
| `mensageria` | fila, tópico e webhook: entrega repetida, mensagem inválida, efeito depois do commit, agendamento |
| `contratos` | o que cruza a fronteira: evolução aditiva, fonte única, uma grafia, código de erro estável |
| `observabilidade` | log estruturado e correlacionado, métrica de cardinalidade limitada, degradação visível, sondagens |
| `seguranca` | autorização no servidor, segredo, injeção, conteúdo externo, abuso, auditoria |
| `banco` | consulta, transação, restrição no banco, data com fuso, migração segura |
| `testes` | comportamento, determinismo, limites e erro, bug com teste |
| `rust` | projeto Rust: erro sem pânico, async sem bloqueio, `unsafe` justificado, tracing, lints no manifesto, teste determinístico |

Regras de uma linguagem só (`py.`, `sh.`, `ts.`…) ficam fora de pacote: o filtro por grupo já as cobre. A exceção é a
linguagem com regras suficientes para ligar de uma vez (hoje `rs.`, no pacote `rust`). O dono
acrescenta pacote num `~/.claude/hades/quality/*.json` com chave `packs` (mesmo `id` substitui o do base);
`hades quality validate` reprova id duplicado e pacote que cita regra inexistente.

## Ligar e desligar

- **Painel:** página **Qualidade** (grupo Sistema da navegação): cartão **Pacotes** (interruptor, selo
  Ligado/Desligado/Parcial, barra de quantas regras estão ligadas e "Filtrar"), busca, filtro por grupo e por pacote,
  interruptor por regra, "Ligar/Desligar grupo", "Ligar/Desligar todas" e "Padrão". Funciona no celular (390 px).
  `GET /api/quality` traz `packs` (com `state`, `on`, `total`); `POST` aceita `pack` além de `ids`/`group`/`all`.
- **Linha de comando** (`hades quality`, mesma lógica do painel):

```bash
hades quality list [--group <g>] [--pack <p>] [--on|--off] [--json]
hades quality on|off <id|prefixo.>… [--group <g>] [--pack <p>] [--all]    # grava choices.tsv
hades quality packs [--json]                                  # pacotes e estado: ligado, desligado, parcial
hades quality validate                                        # ids únicos, todo id de pacote existe
hades quality reset [<id>…]                                   # volta ao padrão do catálogo
hades quality inject --phase brief|deliver|inbox|review [--dir <d>]
hades quality conflicts [--dir <d>]
```

## Injeção

`hades quality inject --phase <fase> [--dir <d>]` devolve o bloco markdown das regras ligadas, ordenadas por
severidade e grupo; vazio se nenhuma estiver ligada (nada muda, e o golden fica idêntico). Pacote não aparece no
bloco: o formato do `inject` é o mesmo, só as regras ligadas.

- **Briefs:** `hades agent new` e `skill-new` acrescentam o bloco ao fim do brief.
- **Fases deliver, inbox e review:** o `hades agent` grava `.design-sync-reports/quality.md` na worktree
  (`phase_quality`) e cita o caminho no prompt da sessão; sem regra ligada, o arquivo é removido.
- `check` (`grep` ou `cmd`) aparece junto da regra como a checagem sugerida; a Hades não a roda sozinha.

## Precedência

invariantes da Hades > pedido do dono > regras do projeto > catálogo ligado > código vizinho.

O perfil **não desliga** item global ligado. Em `rules.quality[]` ele pode:
- subir a severidade (`severity`): vale a maior, e o bloco marca "subida por <projeto>";
- declarar `contradicts: true` quando uma regra dele contraria o item (a do projeto vale);
- anotar `note`.

## Relatório de conflito

`hades quality conflicts` imprime a seção **Conflitos de qualidade** (vazia se não houver), que entra no relatório
da passada (`reference/loop/report.md`). Tipos: `contradiz`, `severidade-menor` (o projeto pede menos do que o
catálogo ligado exige: vale o catálogo) e `id-desconhecido`.

## API para a `project init`

Mapear as regras do projeto ao catálogo é da `project init`: ela grava `rules.quality[]` no perfil usando os `id` de
`hades quality list --json`; o perfil é validado pelo `profile.schema.json`. Implementação e heurística do mapeamento: `reference/project-init.md` §Regras e catálogo.
