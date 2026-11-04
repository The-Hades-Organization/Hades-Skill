# Contrato das unidades de evolução da skill (todas as unidades `skill-new`)

O orquestrador abre a unidade com `hades agent skill-new` (`reference/loop/orchestrate.md` §Evoluir a própria skill). Você evolui a **própria skill Hades**, não o
repositório de nenhum projeto. Leia `reference/evolving.md` e o `SKILL.md` da sua worktree antes de começar. Para o kit, leia o
script que você vai mexer e a referência do assunto (`reference/*.md`).

## O que muda em relação ao cartão `roles/impl.md`
Siga o cartão em esperar, estacionar, escalar e dúvidas. **Não se aplicam:** spec, card, PR, push,
checagem de tipos de projeto, build/teste de projeto, `/review-agents` e `gate-lock.sh`. Não há nada do repositório de
projeto aqui.

- **Onde trabalhar:** só na sua worktree `~/.claude/hades/skill-dev/<unidade>` (branch `skill/<unidade>` do git
  local da skill; ele pode ter remote, mas push nunca é automático: o `skill-new` grava
  `branch.skill/<unidade>.pushRemote=no_push`). Nunca edite `~/.claude/skills/hades` (é a `main`, da consolidação) nem
  a worktree de outra unidade.
- **Commits:** locais, na sua branch, no formato `feat: …` / `fix: …` / `docs: …`. Sem `Co-Authored-By`, sem push, sem
  `--force`, sem rebase de `main`.
- **Gate:** `bash -n` nos `.sh` que mexeu, `bun x tsc --noEmit` e `bun test` (só os testes do que mexeu; a suíte inteira vai pelo
  `check`), e `HADES_DATA=<sua pasta de teste>/data kit/skill-release.sh check` rodado da sua worktree. Nunca `release`:
  a versão sai na consolidação.
- **Prova:** numa instalação descartável, em `~/.claude/hades/skill-dev/_data/<unidade>/data`:
  `HADES_WT=<clone do projeto de teste> HADES_DATA=~/.claude/hades/skill-dev/_data/<unidade>/data SKIP_SYSTEMD=1 SKIP_WORKTREE=1 bash kit/install.sh`
  (reinstale depois de cada mudança no kit).
  - **Painel de teste:** `HADES_WT=… HADES_DATA=… bun <skill>/src/cli.ts panel serve --port <sua porta>`
    com `run_in_background`; pare-o no fim. **Nunca** `panel.sh start|restart|autostart`: eles gravam a unit real
    `hds-panel`.
  - Tela: captura headless pelo truque de `reference/panel.md` §Armadilhas (proxy que segura o `load`).
- **Não tocar:** o ambiente vivo (`<dados do ambiente vivo>`, `~/.claude/hades/instance`),
  units `hds-*` reais, `~/.config/systemd/user/hds-panel.service`, linger, containers e volumes do projeto docker
  `hades`, e o clone do projeto (nada de `git` nele). Container ou unit de teste levam o prefixo `skilldev-<unidade>` e
  são removidos no fim.
- **Estilo do kit:** script novo com `source env.sh` na linha 2, uso no cabeçalho, idempotente. Comentário curto em
  pt-BR só onde explica o porquê ou uma armadilha medida (veja os scripts vizinhos). Nada de caminho absoluto,
  usuário, host, e-mail, token ou URL de túnel no kit: o `check` reprova. Estado novo fica em `$D` e entra na lista
  "NUNCA toca" do `install.sh`. Parâmetro ajustável vira chave no `config.tsv` (`reference/config.md` §Chave nova),
  nunca padrão repetido no script.
- **Arquivos compartilhados** (a tabela do plano): `config.tsv`, `src/panel/`, a base `panel/ui/app.js` (páginas em
  `panel/ui/pages/` são de quem mexe naquela página), `SKILL.md`,
  `reference/panel.md`, `reference/config.md`. Mude com acréscimo: bloco próprio, linhas novas, sem reordenar nem
  refatorar o que já existe. Liste cada acréscimo no report. `VERSION` e `CHANGELOG.md` ficam com a consolidação.
- **Documentação:** referência do assunto (criar `reference/<assunto>.md` se for assunto novo), linha na tabela
  "Pedidos típicos" do `SKILL.md`, chaves em `reference/config.md`, página/ação em `reference/panel.md`.

## Entrega
`.design-sync-reports/report.md`, com:
- primeira linha `STATUS: DONE`, escrita depois do último prompt (report mais velho que o prompt não conta);
- uma linha de prova positiva (`passou`/`ok`/`rc=0` junto de `test`, `tsc`, `gate`…; "falhou" não vale) e o commit na mesma
  linha da palavra "commit" (sha na branch); sem isso o vigia emite `DONE-HELD` e o orquestrador tem de intervir;
- o que fez e os arquivos mexidos;
- a prova (comandos e saída resumida, caminho das capturas);
- acréscimos nos arquivos compartilhados;
- **rascunho da entrada do CHANGELOG** (o que, por quê, armadilhas medidas);
- o que ficou de fora.

Dúvida que só o dono decide vai em `.design-sync-reports/questions.md` (`## Q<n> — <assunto>`). Siga com o que não
depende dela.
