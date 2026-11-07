STATUS: DONE — ver report.md

## Ambiente
- Painel de teste: porta 21272, REINICIADO após o merge (processo `bun src/cli.ts panel serve --port 21272`, pid ~827028; achar com `pgrep -f "bun src/cli.ts panel serve --port 21272"`; parar no fim com `kill <pid>`, `pkill` proibido).
  Depois de merge ou de mudar a lista de scripts, reinicie o painel (sem isso a página quebra com `createLiveLink` indefinido). Kit reinstalado com o código de 16964c0:
  `B=~/.claude/hades/skill-dev/_data/argos-camadas; HADES_WT=$B/clone HADES_DATA=$B/data SKIP_SYSTEMD=1 SKIP_WORKTREE=1 bash kit/install.sh` (os 2 "erro(s)" do install são do ambiente de teste).
- `node_modules` da worktree é symlink para `~/.claude/skills/hades/node_modules` (ignorado pelo git). Contrato `skill-dev-contract.md`: sem push, sem PR, sem gate-lock; commits locais sem co-author. Uma chamada Bash por resposta; `hades` = `bun ~/.claude/skills/hades/src/cli.ts`.
- Scripts de captura (scratchpad da sessão 3: /tmp/claude-1000/-home-hadsonr--claude-hades-skill-dev-argos-camadas/b9fbe365-c162-4097-98a2-6269df4712f9/scratchpad): `shot2.mjs <dir> <dark|light> <passos.mjs>` com env `VW`/`VH`
  (viewport e toque), `seed.py` (semeia o canvas.json do painel de teste), `dockm.mjs` (mede botões dentro da moldura destacada de cada nó), `mob.mjs` (mede no canvas, bandeja, overflow). Rode com `timeout 100 node …` e saída em arquivo (nunca `| tail`).

## Regras do dono em vigor
- Responsivo no celular (brief, seção Item): 360 px, 768 px e desktop; sem rolagem horizontal; sem texto estourando; alvo de toque >= 44 px; nada só no hover; report com captura em 360 px de cada tela tocada.
- Achado da argos-interacao: botões do cabeçalho da nota (Raw, Formatada, Opções) abaixo de 44 px; corrigir e mostrar no report. A interacao já está na main (6.28.0): MERGE FEITO (bf57e7f). Falta só regravar o golden no fim.

## Feito (commits em `skill/argos-camadas`, head 16964c0, working tree limpa)
- Paleta de áreas, bandeja, NodeActions, moldura "Voltar ao canvas", ações ligadas nos cabeçalhos, docs, golden (commits anteriores; ver git log).
- bf57e7f merge da main; único conflito foi o golden (resolvido com `--theirs`, DEVE ser regravado).
- 16964c0 celular: `node-note.tsx` BTN `h-6 … justify-center shrink-0 max-md:min-h-11 max-md:min-w-11`; `parts.tsx` NODE_ACTION_BTN `max-md:size-11` e cabeçalho da moldura `max-md:h-11!`;
  `node-terminal.tsx` cabeçalhos (agente e terminal) `max-md:h-11!`, botões de vista `max-md:size-11`, botão de conexões `max-md:h-11 max-md:min-w-11`. Tailwind do painel é o v4 do navegador (`h-11!` vale).
- Provas até agora: `tsc --noEmit` e `-p tsconfig.ui.json` rc=0 (antes do `shrink-0`; reroda no fim); `bun test canvas-hidden canvas-types-user canvas-note argos-ui canvas-areas`: 402 pass, 0 fail.
- Medição em 360 px (moldura destacada, 1:1): sem rolagem horizontal (scrollWidth 360/360); "Voltar ao canvas" 144x44; botões de vista do agente 44x44; pílula da bandeja 105x44 (overflow 360/360).
  Nota ANTES do `shrink-0`: Raw 40x44, Formatada 77x44, Opções 40x44 (largura 40 < 44 por encolher no flex). A re-medição depois do `shrink-0` + reinstall mostrou ainda 40x44 na primeira rodada: pode ser cache do navegador/painel não
  reiniciado com o arquivo novo; REMEDIR (ver abaixo) antes de concluir; se persistir, o cabeçalho da nota está comprimindo por `min-w-0 flex-1` do título: garantir `shrink-0` também no grupo "Modo da nota" ou dar `min-w-11` com `flex-none`.
- Em 768 px (rodada rápida): scrollWidth 768/768; botão de conexões do terminal 40x40 (abaixo de 44 em 768 px: `max-md` cobre só < 768; avaliar usar `max-lg:`/`pointer-coarse:` nos alvos do cabeçalho para a faixa 768 — o `Button` global usa `max-md`, então 768 fica como no resto do painel; decidir e registrar), "Voltar ao canvas" 144x40.
- Os botões de ação dentro de nós no canvas medem 26x26 na tela com zoom 60%: o conteúdo do nó escala com o canvas (44 × 0,6). Os 44 px valem a 100% e na moldura destacada (1:1); registrar no report como limite inerente ao canvas espacial e que o caminho de toque é Destacar -> moldura.

## Falta, em ordem
1. Remedir em 360 e 768 com `dockm.mjs` (nota: Raw/Formatada/Opções >= 44; terminal: vista/conexões) e decidir a faixa de 768 px (item acima). Capturas em `capturas/mob-360-*.png` e `mob-768-*.png` já gravadas (nota-destacada, terminal-destacado, canvas, destacado, bandeja); regravar as da nota depois da correção.
2. Conferir o seletor de cor de área (AskDialog `SwatchChoice`, `TOUCH_MIN`) em 360 px: abrir `area:color` pela paleta (Ctrl+K) com uma área selecionada; captura `mob-360-cor-area.png`; sem estourar a grade.
3. Rodar: `bun x tsc --noEmit` e `-p tsconfig.ui.json`; `cd loop/test/ts && bun test canvas-hidden.test.ts canvas-types-user.test.ts canvas-note.test.ts argos-ui.test.ts canvas-areas.test.ts`; regravar o golden
   `cd loop/test/ts && LEGADO_REGRAVA=1 bun test ./painel-legado.test.ts` e commitar; `HADES_DATA=~/.claude/hades/skill-dev/_data/argos-camadas/data kit/skill-release.sh check` (falhas conhecidas e não minhas: `cerberus-ts > histórico com linha cortada`
   falha também na main; `node-balloon` e rota `herdr-admin` instáveis sob carga, passam isolados).
4. Capturas desktop depois: elevada (`depois-elev`) e áreas em tema claro, comparar com `antes-*.png`.
5. Impeccable: `/impeccable critique` só carregou a skill (sem PRODUCT.md; DESIGN.md do painel existe). Exige 2 subagentes isolados (A revisão, B `impeccable detect --json kit/panel/ui/argos`) ou banner `⚠️ DEGRADED: single-context (<motivo>)`.
   Sem editar arquivos nessa rodada. Resultado e nota antes/depois no report. Pontos já vistos: ações pequenas em zoom 60%, toast da bandeja sobre o minimapa, "Voltar ao canvas" só na moldura.
6. Notas: `hades canvas note write andamento-argos-camadas --append "<marco 2/3: bandeja, paleta, ações do cabeçalho, Voltar ao canvas, celular 44 px, merge da 6.28.0>"`; na `andamento-argos-fluxo`: `reading-bar.tsx` ainda diz "Ocultos do canvas"
   (renomear para "Bandeja do canvas"; é arquivo deles) e `dialogs.choose` ganhou `swatch?`. "Camada implícita pelo foco" pedida à interacao: não feito.
7. `reference/argos.md`: acrescentar uma linha em §Elevar e acoplar sobre alvos de 44 px em max-md e o limite do zoom (ver acima). Tour da página só se citar "Ocultos" (`grep -rn "Ocultos\|Ocultar do canvas" kit reference`).
8. `report.md` começando com `STATUS: DONE` + linha de prova (`tsc ok`, `test ok`, `gate` com a ressalva dos testes pré-existentes, `commit <sha>` na mesma linha), arquivos mexidos, seção "Celular" com a tabela de medidas e as capturas de 360 px de cada tela tocada
   (cabeçalho do agente/terminal, nota, moldura destacada, bandeja, seletor de cor, áreas), acréscimos em arquivos compartilhados (`pages/argos.tsx`: `onNodeCommand`, `trayItems`/`onUnhide`; `commands-canvas.tsx`: `swatch?`; `canvas-engine.tsx`: areaInk/título; `loop/test/ts/argos-ui.test.ts`: asserção),
   rascunho de CHANGELOG, conflitos de regra (nenhum), o que ficou de fora (camada pelo foco, desenho/texto sem cabeçalho, renomear `reading-bar`). Report antigo -> `report-<n>.md` se existir.
9. Parar o painel de teste (kill do pid) e conferir `git status` limpo antes do DONE.
