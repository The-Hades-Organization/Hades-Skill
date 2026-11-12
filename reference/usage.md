# Consumo: contexto fixo por sessão

`hades usage` lê as transcrições do Claude Code (`~/.claude/projects`) e soma custo, polling e reescrita por papel (`reference/loop/tokens.md`).
Este arquivo descreve só o bloco **contexto fixo**, que responde quanto cada sessão já carrega antes de qualquer trabalho.

## O que o número mede

- **Contexto fixo** = `input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens` da **primeira resposta** da sessão principal.
  Subagente não conta, e sessão sem resposta com uso não entra. A medida vem da linha do dia em que a sessão abriu (`Row.open`,
  `CACHE_VERSION` 6: o cache de transcrições é relido uma vez).
- Por repositório (a raiz do clone, mesmo para worktree), papel e modelo: **mediana**, **p90** (nearest-rank) e a série diária da mediana.
- Na saída `--json` é o campo novo `fixedContext` (`median`, `p90`, `sessions`, `byDay[]`, `groups[]`, `floor`); nada existente muda de nome.

## Decomposição em disco (estimativa)

Por grupo, os bytes em disco, medidos na pasta da sessão mais recente do grupo: a cadeia de `CLAUDE.md` do cwd para cima mais o do
`~/.claude`; o `MEMORY.md` do projeto; o `SKILL.md` da Hades (papéis que não são a sessão interativa); o `brief.md` do agente.
É tamanho de arquivo, não token, e o rótulo diz isso. Parte ausente não aparece. Prompt de sistema, ferramentas, lista de skills e saída de
hooks não têm arquivo para medir e ficam fora.

A cada `hades usage` e a cada `hades doctor` completo grava-se o retrato do dia (soma das partes) em `~/.claude/hades/usage/partes.json`,
30 dias. O doctor compara o retrato atual com o mais recente de uma semana atrás para dizer qual parte cresceu.

## Contexto fixo × custo

`piso = Σ (contexto fixo × turnos da sessão × preço de leitura de cache do modelo)`, sobre as sessões com a primeira resposta medida; a
linha mostra o piso, o custo dessas sessões e a razão. É um mínimo: o contexto só cresce depois da primeira resposta e a primeira
escrita de cache custa mais que a leitura.

## Doctor e painel

`hades doctor` (linha `contexto-fixo`, `reference/doctor.md`) e a página Consumo (cartão Contexto fixo, `reference/panel.md` §Consumo).
Limiar em `HADES_USAGE_BASELINE_WARN_PCT` (`reference/config.md`).
