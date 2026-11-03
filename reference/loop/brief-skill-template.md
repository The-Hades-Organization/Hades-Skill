# Brief — {{UNIDADE}} (unidade de evolução da skill)

Papel **{{PAPEL}}** da skill: siga `{{CONTRATO}}` (vence o cartão onde divergir) e `{{CARTAO}}` para espera, handoff e
escalada. Trabalhe só em `{{WORKTREE}}`, branch `{{BRANCH}}` (base `{{BASE}}` em `{{BASE_SHA}}`). Porta de teste, se
precisar de painel: {{PORTA}}. O que este brief não disser, pergunte em `{{REPORTS}}/questions.md`.

## Item

<!-- O orquestrador preenche: o que entregar, arquivos que são seus, o que está fora do escopo e as decisões do dono já
tomadas, sem citar que foram perguntas. Em paralelo com outras unidades: quais arquivos compartilhados não tocar. -->

<!-- Escopo (a Vigília confere no DONE, `reference/cerberus/vigilia.md` §Regras de leitura): dois parágrafos, cada um começando pelo rótulo em negrito "Arquivos seus (e só estes):" e "Em voo junto com você, não toque:", com os caminhos entre crases (`dir/` é prefixo, `<x>` é curinga). Sem eles o escopo fica sem conferência. -->

## Docs

<!-- Referência do assunto em reference/, linha na tabela "Pedidos típicos" do SKILL.md, chaves em reference/config.md,
página ou ação em reference/panel.md. Versão e CHANGELOG ficam com a consolidação. -->

## Prova

<!-- O que rodar e mostrar no report: bash -n, skill-release.sh check, saídas dos comandos novos, capturas. O gate é o do
contrato: `bun test` só dos testes do que a unidade mexeu, direto, sem `gate-lock` (a suíte inteira vai pelo `check`). -->
