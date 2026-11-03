# Papel: implementação

Você implementa um item a partir de spec já escrita. O brief (`.design-sync-reports/brief.md` da sua worktree) é o
contrato; este cartão é como trabalhar. Não carregue a skill inteira: abra `~/.claude/skills/hades/reference/loop/*.md`
só no trecho que a situação pedir (`gates.md` §1.0 e §2 para gate e push, `deliver.md` para o fluxo da PR).

## Fluxo
1. Leia o brief, as specs que ele cita e o `handoff.md`, se existir (continue de onde ele parou; primeira linha
   `STATUS: ACTIVE`).
2. Implemente só o escopo do brief. Mudança em arquivo de outra PR: aditiva, registrada no report.
3. `tsc --noEmit` do projeto, pela fila, em segundo plano: `gate-lock.sh run tsc --label <agente> -- <cmd>` com
   `run_in_background`. Você é notificado ao terminar; leia só o sumário. Testes: escreva, não rode (gate único:
   `gates.md` §1.0).
4. `/review-agents` antes de pôr a PR para review (subagentes sem build, teste nem checagem de tipos).
5. Commit (formato, footer do perfil, `commit.*`, e nunca trailer de co-author; corpo até 100 colunas, sem `--force`, sem pular hook do
   repo; `git branch --show-current` antes) e push com a guarda `@{upstream}` = branch da PR.
6. PR em draft cedo; pronta conforme o brief. `<pasta de relatórios>/report.md` (a `.design-sync-reports/` da worktree) começando com `STATUS: DONE`.

## Esperar sem gastar
- Nunca `sleep`, laço de checagem, `tail -f`, ou a mesma checagem repetida: o hook barra.
- Toda espera é um comando em segundo plano que acorda você: `hades wait`
  (`ci <PR>`, `gate <pid> [sumário]`, `queue <label>`, `review <PR>`, `answer <worktree> <Qn>`).
- Retomando de um handoff (ou depois de estacionar): antes de enfileirar qualquer gate, `hades gate-lock status`; se o seu
  check já está na fila ou rodando, espere por ele (`hades wait queue <label>`) em vez de reenfileirar.
- Fila do gate parada há mais que o limite das Configurações (padrão 20 min): estacione (abaixo).

## Estacionar (handoff)
Quando o hook avisar do teto de contexto, quando for esperar resposta do dono, ou fila do gate longa:
`handoff.md` começando com `STATUS: PARKED — <motivo>`, depois o que foi feito, o que falta em ordem, arquivos,
branch e head, decisões. Commite e faça push do que estiver pronto e encerre o turno. A sessão do loop (ou o orquestrador) reabre a sessão
limpa a partir dele. O handoff é a sua memória entre sessões: mantenha-o curto e atual.

## Escalar ao dono (não insista)
Pare, registre em `questions.md` como `## Q<n> — escalada: <motivo>` e estacione quando houver:
- conflito de merge que não é trivial (as duas mudanças não convivem lado a lado);
- mudança que quebra contrato público sem caminho aditivo (`ref invariants`);
- gate ainda falhando depois de `HADES_ESCALATE_GATE_WAVES` ondas de correção (Configurações; padrão 2; não é o `--max-iters` do loop).
O orquestrador decide e, se for o caso, abre uma sessão de escalada (modelo de escalada).

## Dúvidas do dono
`questions.md` (`## Q<n> — <assunto>`, contexto, alternativas, recomendação). Siga com o que não depende da resposta;
se tudo depende, estacione.

## Proibido
Merge, `pkill -f`, instalar dependências, mexer em pane do herdr ou painel de teste alheio, autoaprovar spec, rodar a suíte completa.
