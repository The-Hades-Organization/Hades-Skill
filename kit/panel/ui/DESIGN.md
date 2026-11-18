---
name: Painel de controle
description: O estilo visual do painel. Sala escura em névoa, superfícies opacas, controles secos e só o estado fala alto.
colors:
  # tema escuro (principal); o claro vem em *-light. Fonte normativa: index.html (:root e .dark)
  background: "#0e050a"
  foreground: "#f2e6d9"
  card: "#190d14"
  popover: "#25161f"
  muted-foreground: "#bca7b4"
  primary: "#ffc6df"
  primary-foreground: "#391a2c"
  line: "#876678"
  metal: "#ffc6df"
  sidebar: "#190d14"
  rail-muted: "#bca7b4"
  ok: "#61d19a"
  warn: "#f6b84d"
  bad: "#ff6d53"
  info: "#5bc1d9"
  term: "#0b0408"
  background-light: "#f8ecf1"
  foreground-light: "#301423"
  card-light: "#fff8fb"
  popover-light: "#f0dfe6"
  muted-foreground-light: "#684b5b"
  primary-light: "#391a2c"
  primary-foreground-light: "#f5e8dc"
  line-light: "#926e7e"
  metal-ink-light: "oklch(0.6 0.1 350)"
  sidebar-light: "#391a2c"
  rail-muted-light: "#d7bfcb"
  ok-light: "#006b40"
  warn-light: "#8a4c00"
  bad-light: "#b71d00"
  info-light: "#006585"
typography:
  page-title:
    fontFamily: "Marcellus, Figtree, serif"
    fontSize: "2.5rem"
    fontWeight: 400
    lineHeight: 1.1
    letterSpacing: "0.02em"
  section-lg:
    fontFamily: "Marcellus, Figtree, serif"
    fontSize: "1.3125rem"
    fontWeight: 400
    lineHeight: 1.3
    letterSpacing: "0.03em"
  section:
    fontFamily: "Marcellus, Figtree, serif"
    fontSize: "1.125rem"
    fontWeight: 400
    lineHeight: "1.5rem"
    letterSpacing: "0.03em"
  body:
    fontFamily: "Figtree, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    lineHeight: "1.25rem"
  label:
    fontFamily: "Figtree, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: "1.25rem"
  meta:
    fontFamily: "Figtree, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    lineHeight: "1rem"
  data:
    fontFamily: "Geist Mono, ui-monospace, monospace"
    fontSize: "0.75rem"
    lineHeight: "1rem"
  kpi:
    fontFamily: "Figtree, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.2
rounded:
  none: "0"
  full: "9999px"
spacing:
  control: "32px"
  touch: "44px"
  card: "20px"
  object: "14px"
  page-x: "16px / 24px / 32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.none}"
    height: "32px"
  button-secondary:
    backgroundColor: "{colors.popover}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.none}"
    height: "32px"
  field:
    backgroundColor: "{colors.popover}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.none}"
    height: "32px"
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.none}"
    padding: "20px"
  badge-ok:
    backgroundColor: "{colors.ok}"
    textColor: "{colors.background}"
    rounded: "{rounded.none}"
  sidebar-item:
    backgroundColor: "{colors.sidebar}"
    textColor: "{colors.foreground}"
    height: "32px"
---

# Sistema visual: o estilo visual do painel

Escrito a partir de `index.html` (tokens, utilitários, CSS da casca), `app.tsx` (primitivas, ícones, casca) e `fx/poeira.tsx`. Onde este arquivo e o código divergirem, o código vence. O estilo não tem nome: chame de "o estilo visual do painel".

Para quem reestiliza `pages/`, `argos/` e `cerberus/`: use as primitivas de `HadesCore` (`Button`, `Card`, `Badge`, `Dot`, `Select`, ...) antes de escrever classe à mão; quando escrever, use os tokens e os utilitários `t-*` daqui. Cor literal (`#...`, `text-pink-300`) e `rounded-*` não entram em página.

## Overview

Um painel de operações denso, escuro por padrão, em que o fundo é névoa e tudo que se lê fica numa superfície opaca por cima dela. Os controles são secos (raio 0, sem borda, linha de base), o contorno é sugerido por colchetes de canto e a cor só aparece onde há estado ou a ação principal.

### Princípios (regras que nenhuma página quebra)

1. **Colchetes de canto, não caixa fechada.** Superfície de leitura leva `cantos` (dois ângulos de 10 px, traço 2 px, superior esquerdo e inferior direito). Nada de `border` em volta de card, painel ou grupo.
2. **Raio 0.** Toda a escala `rounded-xs` a `rounded-4xl` vale 0. Só `rounded-full` sobrevive, e só para ponto de estado (`Dot`) e giro.
3. **Hover só troca de tom.** `bg-hover`, `hover:bg-primary-hover`, `hover:bg-secondary-hover`: mistura do texto à superfície (`--hover-mix` 9% claro / 11% escuro). Nunca brilho, sombra, escala ou glow no hover.
4. **O destaque (`--primary`) é só a ação principal.** Um botão `default` por região. Estado em curso usa `--busy` (cor do texto); `--vivo` é só caret e seleção de texto.
5. **Títulos na fonte de inscrição, peso 400, sem negrito sintético.** `t-page-title`, `t-section-lg`, `t-section` (e `h1`/`h2` crus) já trazem `font-weight: 400` e `font-synthesis: none`. Não some `font-semibold`/`font-bold` a eles.
6. **A névoa fica atrás; superfícies são opacas.** `body::before` (névoa), a poeira (canvas z 0) e a vinheta ficam na moldura. Card, diálogo, menu, toast e campo são opacos (`bg-card/96` no máximo de transparência); a névoa nunca passa sob texto.
7. **Movimento contínuo só para o que pede você.** Pulso (`pulso`) é para bloqueado/warn. A correnteza do rio só corre com alguma página em atividade.
8. **Todo par novo de cores é medido:** texto ≥ 4,5:1, não texto (linha de base, ícone sozinho, traço de gráfico) ≥ 3:1, nos dois temas.

**Características:** escuro como tema principal · vinho e ameixa no fundo, rosa-metal no destaque, creme no texto · estados com luminosidade empurrada por tema · denso (controles de 32 px) · plano, com sombra só no que flutua.

## Colors

Fundo em vinho quase preto, texto creme, destaque rosa-metal no escuro e ameixa no claro; os quatro estados são as únicas cores saturadas. Nomes de token no padrão de mercado (as páginas usam as classes `bg-*`/`text-*`/`border-*` geradas pelo `@theme inline`).

### Tokens por papel (escuro / claro)

| Papel | Token / classe | Escuro | Claro | Uso |
|---|---|---|---|---|
| Chão | `--background` / `bg-background` | `#0e050a` | `#f8ecf1` | fundo da página, onde a névoa aparece; texto sobre selo cheio |
| Texto | `--foreground` / `text-foreground` | `#f2e6d9` | `#301423` | texto principal |
| Superfície 1 | `--card` / `bg-card` | `#190d14` | `#fff8fb` | card, seção de leitura (`bg-card/96`) |
| Superfície 2 | `--popover` = `--muted` = `--secondary` | `#25161f` | `#f0dfe6` | campo, menu, diálogo, toast, card dentro de card, botão secundário |
| Texto secundário | `--muted-foreground` / `text-muted-foreground` | `#bca7b4` | `#684b5b` | descrição, meta, ícone de apoio |
| Destaque | `--primary` / `bg-primary` | `#ffc6df` | `#391a2c` | só a ação principal, foco, linha de base em foco, marcado |
| Sobre destaque | `--primary-foreground` | `#391a2c` | `#f5e8dc` | texto e glifo sobre `bg-primary` |
| Linha | `--line` / `border-line`, `bg-line` | `#876678` | `#926e7e` | colchete de canto, linha de base de campo, controle desmarcado |
| Fio | `--border` / `border-border` | `line` 32% | `line` 32% | divisória de 1 px (padrão de todo `border`) |
| Fio forte | `--border-strong` / `border-border-strong` | `line` 58% | `line` 58% | fio parado, rolagem, tracinho ocioso |
| Hover | `--hover` / `bg-hover` | texto 11% translúcido | texto 9% | hover em qualquer superfície |
| Hover opaco | `--accent` / `bg-accent` | texto 11% sobre card | texto 9% sobre card | item ativo da paleta, linha clicável |
| Hover de botão | `bg-primary-hover`, `bg-secondary-hover` | primary 84% / texto 14% | idem | só nos botões |
| Perigo suave | `bg-danger-soft`, `bg-danger-soft-hover` | `bad` 14% / 18% sobre card | idem | botão destrutivo, item de menu perigoso |
| Desmarcado | `--control-off` / `bg-control-off` | `line` 18% sobre card | idem | caixa, rádio, alternador desligados |
| Em curso | `--busy` / `bg-busy`, `text-busy` | = texto | = texto | "trabalhando", fio fiando |
| Vivo | `--vivo` | = primary | = primary | caret e `::selection`, nada mais |
| Metal | `--metal` / `bg-metal`, `text-metal` | `#ffc6df` | `#ffc6df` | luz da sidebar (ponto de luz, óbolo, marca) nos dois temas |
| Tinta de metal | `--metal-ink` / `text-metal-ink` | `#ffc6df` | `oklch(0.6 0.1 350)` | série de gráfico e traço; no claro só não texto (3,98:1) |
| Estados | `--ok` `--warn` `--bad` `--info` | `#61d19a` `#f6b84d` `#ff6d53` `#5bc1d9` | `#006b40` `#8a4c00` `#b71d00` `#006585` | ver Estados |
| Gráfico | `--chart-1..5`, `--s1..4` | primary, info, warn, ok, metal-ink | idem | séries |
| Sidebar | `--sidebar`, `--sidebar-foreground`, `--sidebar-accent`, `--sidebar-border`, `--rail-muted` | `#190d14`, `#f2e6d9`, `#25161f`, line 32%, `#bca7b4` | `#391a2c`, `#f5e8dc`, creme 12%, creme 12%, `#d7bfcb` | só dentro da casca |
| Terminal | `--term`, `--term-foreground`, `--term-muted`, `--term-bad`, `--term-warn` | `#0b0408` ... | `#1d0f17` ... | escuro nos dois temas; estados próprios |

`--destructive` = `--bad`; `--ring` = `--primary`; `--input` = `--line`; `--radius` = 0.

### Contraste medido (WCAG, cor resolvida pelo Chromium, composta sobre canvas de 1 px), escuro / claro

| Par | Escuro | Claro |
|---|---|---|
| texto sobre `--sidebar` | 15,42 | 12,86 |
| item sobre a página ativa na sidebar | 8,59 | 6,98 |
| sub (`rail-muted`) sobre a página ativa na sidebar (menor par de texto) | 4,69 | 4,88 |
| `muted-foreground` sobre `background` | 8,93 | 6,65 |
| `muted-foreground` sobre `card` | 8,41 | 7,31 |
| rótulo de grupo da paleta | 7,69 | 5,97 |
| `--bad` sobre `card` | 6,82 | 6,29 |
| perigo sobre `danger-soft-hover` | 5,26 | 4,64 |
| selo cheio ok / warn / bad / info / idle (texto em `--background`) | 10,62 / 11,37 / 7,24 / 9,64 / 8,93 | 5,75 / 5,86 / 5,73 / 5,71 / 6,65 |
| linha de base do campo sobre `card` (não texto) | 3,79 | 4,22 |
| anel de foco sobre `card` (não texto) | 12,98 | 14,78 |
| `metal-ink` sobre `card` | 12,98 | 3,98 (só não texto) |
| nó e aresta em repouso no canvas do Argos (`REST_FILL_PCT = 70%`) sobre `background` / `card` / `popover` (não texto) | 4,61 / 4,34 / 3,97 | 3,36 / 3,70 / 3,02 |

**Regra:** todo par novo é medido nos dois temas antes de entrar; texto ≥ 4,5, não texto ≥ 3. Opacidade sobre texto (`text-muted-foreground/60`, `opacity-50` em rótulo legível) só com medição.

## Typography

**Inscrição (títulos):** Marcellus, peso único 400 (`font-heading`). **Corpo:** Figtree variável (`font-sans`, padrão do `body`). **Dados:** Geist Mono (`font-mono`). Escala em rem (`--fs-*`), acompanha o tamanho de fonte do navegador. No escuro, `t-meta`, `t-meta-em`, `t-micro` e `t-data` ganham +0,01em de tracking automaticamente.

O papel diz o propósito, não o valor. Um papel por elemento; exceção com um utilitário somado (`leading-*`, `truncate`, `font-*`), nunca dois `t-*` juntos.

| Classe | Tamanho / altura / peso | Use para |
|---|---|---|
| `t-page-title` | 40 px (30 no celular) / 1,1 / 400 inscrição | o `h1` da página (a casca já o desenha; página não repete) |
| `t-section-lg` | 21 px / 1,3 / 400 inscrição | título de diálogo e de leitura (`DialogHeader` usa) |
| `t-section` | 18 px / 24 px / 400 inscrição | título de card e de painel lateral (`CardHeader`, `Sheet`) |
| `t-body-strong` | 14 px / 20 px / 600 | subtítulo dentro do card |
| `t-body` | 14 px / 20 px | texto de interface, descrição, dica de campo, célula de tabela |
| `t-label` | 13 px / 20 px / 500 | nav, aba, botão, nome de campo, resumo do card, rótulo de `Leitura` |
| `t-meta-em` | 12 px / 16 px / 500 | selo (`Badge`), legenda destacada, botão `xs` |
| `t-meta` | 12 px / 16 px | hora, contagem, caminho, "há 3 min", tooltip |
| `t-micro` | 11 px / 16 px / 500 | eixo de gráfico, `Kbd`, cabeçalho de tabela, rótulo de grupo |
| `t-control` | 13 px / 20 px / 500, `min-h-8` | controle montado à mão (chip, segmentado) |
| `t-data` | 12 px mono, `tabular-nums` | número, tempo, id em linha (`Mono` aplica) |
| `t-kpi` | 24 px / 1,2 / 600, `tabular-nums` | número grande de `Leitura`/`Kpi` |
| `t-code` | 12 px mono / 1,625 | log, comando, `<pre>` |
| `t-code-doc` | 13 px mono / 1,625 | `<pre>` dentro de documento |
| `t-prose` | 15 px / 28 px | Docs, resposta do chat (`.md`, `.md-chat`, `.md-note` já aplicam) |

Caixa-alta com tracking aberto (`uppercase tracking-[.14em] t-micro font-semibold`) existe só em três lugares da base: cabeçalho de tabela (`Th`), rótulo de grupo da sidebar e rótulo de grupo da paleta. Não é um papel para rótulo acima de título.

Número que muda: `tnum` (ou `t-data`/`t-kpi`, que já trazem). Número que conta ao mudar: `Num`.

## Layout

- **Densidade.** Botão e campo têm 32 px (`h-8`); item da sidebar 32 px com texto de 13 px (`t-label`). É um painel de operações denso, e a mesa mostra mais linhas por tela.
- **Toque.** Abaixo de 768 px (ou ponteiro grosso) botão, aba, select e input sobem a 44 px por regra global do `index.html` e pelos `max-md:h-11` das primitivas. Não desfaça com `!h-8`. O `Switch` mantém o próprio tamanho e ganha área de toque por `::after`.
- **Casca.** Sidebar 248 px (`w-[248px]`), recolhida 64 px (`w-16`), escondida abaixo de `md`. Topo `h-12`, `sticky`, `bg-background/90 backdrop-blur-sm`. Conteúdo `max-w-[1500px]`, `px-4 md:px-6 lg:px-8`, `pt-7 pb-24`. Cabeçalho da página `mb-6`.
- **Ritmo.** Entre cards `gap-6` (o `Loading` é o molde: `grid gap-6 xl:grid-cols-2`). Dentro do card `gap-4`, padding `p-5` (`p-4` no celular); objeto compacto (`Card variant="object"`) `p-3.5 gap-2.5`. Leitura de `Regua` `px-5 py-4`.
- **Página `{ stage: true }`** (Argos): o canvas ocupa a janela dentro de `.stage-frame`; não há título visível nem indicador "Ao vivo" (a falha aparece no `StageNotice`).
- **Grid.** Filhos de `.grid` já têm `min-width: 0` (texto longo trunca em vez de vazar). Lista que cresce sem fim: `CARD_SCROLL` (`max-h-[28rem] overflow-y-auto scrollbar-thin`).
- **Camadas (z).** topo 30 · dock de execução 40 · diálogo, folha, menu 50 · lista do `Select`, toasts 60 · rajada de poeira 65 · tooltip 70.

## Elevation & Depth

Plano por padrão. A profundidade vem do tom (chão → card → superfície 2) e da névoa atrás; sombra só no que flutua.

- **Chão:** `bg-background` + névoa (`body::before`, três manchas `--nevoa-1..3`, deriva de 52 s) + vinheta (`body::after`) + poeira (`fx/poeira.tsx`: grãos na cor `--primary`, até 48, canvas fixo em z 0, entre a névoa e `#root`).
- **Card:** `bg-card/96`, sem sombra, com `cantos`. Card dentro de card cai sozinho para superfície 2 (`.cartao .cartao`).
- **Superfície 2:** `bg-popover` / `bg-muted` / `bg-secondary`: campo, menu, toast, diálogo, chip.
- **Sobreposição:** menu, lista do `Select`, tooltip, toast, dock, `StageNotice` usam sombra longa e baixa (`--elev: 0 12px 32px -8px rgb(0 0 0/.7)` ou `0 10px 30px -10px`); diálogo `0 24px 60px -12px rgb(0 0 0/.8)`. Menu e lista do `Select` somam `inset 0 -2px 0 var(--primary)` (a linha de base do controle que os abriu).
- **Flutuante sobre o canvas:** `elev-float` (superfície 2 `bg-popover` + sombra de sobreposição `--elev`, sem borda) e `elev-shadow` (só `--elev`, para o que já tem superfície própria).
- **Fundo de modal:** `bg-background/72 backdrop-blur-[2px]`.
- Halo/brilho: só o óbolo da sidebar tem (`box-shadow: 0 0 12px 2px` em metal). Nenhuma superfície de página brilha.

## Shapes

- Raio 0 em tudo (`--radius-*` = 0). `rounded-full` só em `Dot`, nos pontinhos de 7 px da sidebar e em giro.
- **`cantos`** é a forma de contorno: `position: relative`, cor por `--c` (padrão `--line`). Variações entregues: diálogo `cantos [--c:var(--primary)]`, cartão de erro `cantos [--c:var(--bad)]`. Elemento `fixed`/`absolute` com `cantos` precisa de `fixed!`/`absolute!` (o utilitário põe `relative`).
- **Linha de base de 2 px** (`inset 0 -2px 0 var(--line)`) é reservada a campo (`campo`, gatilho do `Select`) e controle desmarcado. Não é decoração de card nem de botão.
- **Linha selecionável (`.item-ativo`):** `bg-accent shadow-[inset_3px_0_0_var(--primary)] hover:bg-accent` (hover opaco com filete de 3 px à esquerda em `--primary`, sem sobrescrever no hover), para linhas selecionáveis de listas laterais e itens ativos da paleta.
- **Losango:** o rádio (13 px girado 45°) e o nó do `.fio` (6 px).
- Fio de 1 px (`border`, `border-border`) só para divisória interna (linhas de tabela, cabeçalho de folha, `Regua`, rodapé da paleta).

## Components

Tudo em `window.HadesCore`. Use a primitiva; não recrie.

### Controles

| Precisa de | Use | Notas |
|---|---|---|
| Ação principal (uma por região) | `<Button>` (`variant="default"`) | `bg-primary`, hover `bg-primary-hover` |
| Ação comum | `<Button variant="secondary">` ou `"outline"` | os dois são secundário cheio (`bg-secondary`); a linha de base fica só para campo |
| Ação discreta, ícone de barra | `variant="ghost"`, `size="icon-sm"` | hover `bg-hover` |
| Destrutiva | `variant="destructive"` (`bg-danger-soft text-bad`) ou `"ghost-destructive"`; irreversível: `HoldConfirm` | vermelho cheio só no selo, nunca no botão |
| Link de texto | `variant="link"` | sublinhado em `--line`, destaque `--primary` no hover; sobre superfície de terminal (`bg-term`), `text-term-foreground underline decoration-line underline-offset-4 hover:text-metal` |
| Tamanhos | `default`/`sm` 32 px, `xs` 28 px, `lg` 40 px, `icon` 36, `icon-sm` 32, `icon-xs` 28; todos 44 no celular | `loading` mantém a cor com giro e `aria-busy`; `disabled` esmaece com hachura diagonal |
| Texto | `<Input icon={I.Search}>` ou `className="campo h-8 px-3 t-body"` em `input`/`textarea` | `campo`: superfície 2, linha de base `--line`; foco ou aberto → `--primary`; `aria-invalid` → `--bad` com fundo tingido |
| Escolha numa lista | `<Select size="sm">` | **use `size="sm"` (32 px) ao lado de botões;** o padrão `md` tem 44 px. Lista em popover na mesa, folha de baixo no celular |
| Abas / alternância | `<Segmented>` (role `tablist`, 32 px); `<Choice wide>` troca por `Select` na tela estreita | selecionada: `bg-secondary` + `inset 0 -2px 0 var(--primary)`. Não há primitiva `Tabs` separada |
| Liga/desliga | `<Switch>` | 44×22, desligado `bg-control-off` + linha de base, ligado `bg-primary` |
| Caixa | `<Checkbox>` ou `input type="checkbox"` nativo (já estilizado na base) | 18 px; marcado enche de `--primary`, glifo em `--primary-foreground` |
| Rádio | `input type="radio"` nativo | losango de 13 px com anel de 2 px em `--line` |
| Linha de configuração | `<Field label hint>` | rótulo `t-label`, dica `t-body` muted, `border-b` |
| Menu "mais ações" | `<Menu items>` | superfície 2, linha de base em destaque; item perigoso `text-bad hover:bg-danger-soft` |
| Dica | `<Tip text>` | `bg-popover t-meta`, posiciona sozinho |
| Atalho | `<Kbd>` | `bg-muted t-micro`, linha de base de 1 px |
| Copiar | `<CopyButton text>` | |
| Diálogo | `<Dialog>` + `DialogHeader` (`t-section-lg`, `tone="danger"` pinta o ícone) + `DialogFooter` | `bg-popover`, `cantos` em destaque, entra com `animate-emergir-centro`, foco preso |
| Painel lateral | `<Sheet side="right" wide>` | `bg-background`, cabeçalho `t-section` com `border-b` |
| Aviso | `toast` do app (via `useApp()`) → `Toaster` | barra de 5 px à esquerda na cor do tipo; emerge, sai se desfazendo em grãos |
| Tabela | `Table`/`Th`/`Td`/`Tr` | `t-body tnum`, `Th` em `t-micro` caixa-alta, zebra `even:bg-secondary/55`, hover `bg-hover`; abaixo de `md`, `Th` e `Td` usam `max-md:px-2` e permitem quebra, e tabelas largas ocultam colunas secundárias com `max-md:hidden` para caber em 360 px |
| Vazio | `<Empty icon title>` | uma linha, não um bloco ilustrado |
| Carregando | `<Skeleton>` (shimmer), `<Loading>` | |
| Card | `<Card>` (seção) / `<Card variant="object">` + `<CardHeader title description summary icon action>` | título `t-section`, resumo `t-label` muted, descrição `t-body` muted ≤ 75ch |
| Leituras / KPIs | `<Regua>` com `<Leitura label value unit detail>`; avulso `<Kpi tone>` | `Regua` é uma peça com `cantos` e divisórias de 1 px; número em `t-kpi` |
| Contagem como forma | `<Tracos items>` | um traço por unidade, altura e cor pelo estado |
| Frase de estado | `<LinhaDeEstado main rest>` | principal em `font-medium`, vizinhos muted |
| Gráfico | `AreaChart`, `Legend` | séries `--chart-*` / `--s*`; sem amostras ou com séries zeradas no período, renderiza uma linha compacta sem ocupar a altura do gráfico |

Foco por teclado em tudo: `outline-2` **tracejado** (a base põe `--tw-outline-style: dashed`) em `outline-ring`, `outline-offset-3` nos botões; dentro da sidebar `outline-metal` com `-outline-offset-2`.

### Estados

Cinco tons mais o "em curso". A cor nunca é o único sinal: vem com ícone, rótulo ou forma.

| Estado | Token | `Dot kind` | `Badge variant` | `.fio data-s` |
|---|---|---|---|---|
| ok / concluído | `--ok` | `ok` | `ok` | `medido` (1,5 px em texto, nós em losango) |
| warn / esperando você | `--warn` | `warn` + `pulse` | `warn` | `frouxo` (tracejado muted) |
| bad / falhou | `--bad` | `bad` | `bad` (ou `destructive`) | `cortado` (trecho em `--bad`, tesoura, resto tracejado) |
| info | `--info` | `info` | `info` | — |
| idle / parado | `--muted-foreground` | `idle` (muted 40%) | `idle` | `parado` (1 px `--border-strong`) |
| busy / trabalhando | `--busy` (= texto) | `busy` | `busy` (com `I.LoaderCircle animate-spin`; `StateBadge` e `JOB_ST.rodando` já usam) | `fiando` (3 px em `--busy`, brilho correndo) |

- **`Badge`** é selo cheio sem borda: fundo no estado, texto em `--background` (`t-meta-em font-semibold`). `secondary`/`outline` são o selo neutro. `StateBadge st` monta ícone + rótulo a partir de `svcState`/`unitState`.
- **`Dot`**: quadrado de 8 px arredondado; `pulse` só para o que pede você (warn, bloqueado), por opacidade (`pulso`, 2,4 s), sem expandir. Ok e busy ficam parados.
- **`Fio s nos corte label`**: sempre com rótulo (é imagem para o leitor de tela). O fio global sob o topo (`FioGlobal`) tem um segmento por coisa viva.
- **"Trabalhando" usa `--busy`, nunca o destaque.** O destaque é a ação principal; se o estado em curso fosse rosa, competiria com o botão.
- **Canvas do Argos:** nós completos têm corpo em `--card`, cabeçalho em `--popover`, faixa de estado de 4 px no topo e colchetes `cantos` em `--line`; arestas têm 1,5 a 2,5 px na cor do estado do nó de destino, com tracejado animado a 22 px/s quando o destino trabalha; nós e arestas em repouso diluem `--muted-foreground` a `REST_FILL_PCT = 70%` sobre `--card` (garantindo contraste ≥ 3:1 sobre `--background`, `--card` e `--popover` nos dois temas).
- Barra de progresso: `Progress kind` (fio de 4 px, `bg-foreground` neutro ou a cor do estado).
- Perigo em texto: `text-bad`; em fundo de ação: `bg-danger-soft`.

### Ícones

- `I` é o único conjunto: lucide inteiro mais desenhos próprios. Use sempre `I.Nome`, nunca importe ícone de outro lugar nem escreva glifo de texto (✓, ×, ▸) como ícone.
- **Traço:** 2 px, ponta seca e quina viva (`svg.lucide { stroke-linecap: square; stroke-linejoin: miter }` vale para tudo). Largura diferente só por atributo (`strokeWidth={4}` no visto da caixa).
- **Próprios** (grade 24, mesmo traço, um ou dois grãos de 2 px perto do contorno, prefixo `~` = corpo com preenchimento a 28%): `grafo`, `loop`, `fila`, `consumo`, `terminal`, `chat`, `logs`, `notif`, `config`, `docs`, `guarda`, `ramo`, `play`, `parar`, `atualizar`, `ok`, `alerta`, `fechar`, `buscar`, `menu`, `seta`. Eles substituem os nomes do lucide sem mudar o import: `I.Repeat`, `I.ListOrdered`, `I.Coins`, `I.Terminal`/`SquareTerminal`/`TerminalSquare`, `I.MessageSquare`, `I.ScrollText`, `I.Bell`, `I.SlidersHorizontal`, `I.BookOpen`, `I.GitBranch`, `I.Play`, `I.CircleStop`, `I.RefreshCw`, `I.CircleCheck`/`CircleCheckBig`, `I.TriangleAlert`, `I.X`, `I.Search`, `I.Menu`, `I.ChevronDown`. Nomes novos: `I.Grafo`, `I.Guarda`.
- **Figuras de página** (preenchidas, `currentColor`): `I.Argos`, `I.Cerberus`, `I.Caronte`. A navegação usa o traço (`I.Grafo`, `I.Guarda`).
- `I.CircleX` (falha) fica no lucide de propósito: com o desenho próprio de fechar, a falha do aviso ficaria igual ao botão de fechar ao lado.
- Tamanho: `size-4` padrão (os botões aplicam), `size-3.5` em meta, `size-3` em selo, `size-[15px]` na sidebar. Cor de apoio: `text-muted-foreground`.

### Movimento

| O quê | Classe / CSS | Duração e curva |
|---|---|---|
| Controles (cor, fundo, linha de base) | `transition-colors`, `duration-150` | 150 ms |
| Entrada de página | `FadeSlot` (efeito de névoa) | 1 s; sem entrada escalonada (`animate-fade-up` = none) |
| Algo que entra (toast, cartão de erro, dock) | `animate-emergir` (sobe 8 px, perde 7 px de desfoque) | 450 ms `cubic-bezier(.2,.7,.2,1)` |
| Diálogo | `animate-emergir-centro` | 450 ms |
| Algo que sai | `animate-desfazer` (sobe, desfoca, some) + rajada de poeira | 600 ms ease-in |
| Folha de páginas do celular | `animate-folha` (desce do topo) | 350 ms |
| Popover, tooltip, fundo de modal | `animate-fade-in` | 250 ms |
| Folha lateral | `animate-slide-in-right` / `-left` | 300 ms |
| Dado que mudou | `animate-flash` (warn 25% → transparente), `Num` | 1,2 s |
| Carregando | `animate-shimmer`, `animate-spin` | 1,6 s |
| Pulso de atenção | `pulso` | 2,4 s, só com `no-preference` |
| Fio fiando | `.fio[data-s=fiando]` | 1,8 s contínuo |
| Pontos de luz da sidebar | `.luz` 350 ms; `.obolo` desliza 420 ms; `.ponto-vivo` desce 900 ms | |
| Rio | `.rio[data-vivo]::after` correnteza | 6 s, só com atividade |
| Névoa | `body::before` deriva | 52 s alternado |

**Movimento reduzido** (`prefers-reduced-motion: reduce`): toda animação e transição cai a 0,01 ms; alternativas paradas em vez de corte: o fio fiando usa hachura, o rio perde a correnteza, o pulso não roda, a poeira é desenhada uma vez e não emite rajada (também com economia de dados). Animação nova em página precisa caber nesse bloco ou ter a própria alternativa parada.

### Casca

- **Sidebar** (`Sidebar`): coluna `bg-sidebar`; cada página tem um ponto `.luz` (7 px, `--metal`) cuja opacidade cai com a distância `--d` até a página aberta (piso 0,16); o texto não perde contraste. `.rio` (fio de 1 px) liga os pontos. A atual leva `.nav-atual` (faixa de 3 px + gradiente de metal) e o `.obolo` (9 px com halo) desliza até ela. Página com atividade acende inteira e desce do topo do rio (`.ponto-vivo`, lê `--desde`). Item: `h-8`, `t-label`, ícone `size-[15px]` em `text-rail-muted` (`text-metal` na atual), sub em `t-meta text-rail-muted`. Grupo: rótulo `t-micro` caixa-alta, recolhível. Rodapé: memória (barra de 3 px, `bg-metal`/`bg-warn`/`bg-bad`) e aviso de versão.
- **Sidebar opaca:** no escuro `--sidebar` é um bloco opaco (`#190d14`). No claro a sidebar continua escura (`#391a2c`): a luz é o metal nos dois temas, e metal sobre fundo claro perde contraste.
- **Sidebar recolhida** (`rail`, Ctrl+B): só ícones `size-9` com `.luz.luz-recolhida` (5 px à esquerda), separadores `bg-sidebar-border`, `Tip` à direita com nome e contagem; pontinho de 7 px `bg-ok` (túnel) ou `pulso bg-warn` (bloqueado).
- **Topo:** `h-12`, frase de estado (`StateLine`), busca como `campo h-8 w-60` com `Kbd` (abre a paleta), `LiveIndicator` (`Dot` + "Ao vivo" em `t-meta`), tema. `FioGlobal` de 3 px embaixo.
- **Paleta (`CommandPalette`, Ctrl+K):** `Dialog` sem padding, `sm:max-w-xl`, topo fixo em `top-[12vh]` (não salta ao filtrar; no celular `top-3`). Busca `h-12` com linha de base em destaque; grupo em `t-micro` caixa-alta muted; item ativo `.item-ativo` (`bg-accent` + `inset 3px 0 0 var(--primary)`); rodapé de atalhos em `t-meta` com `Kbd`.
- **Navegação no celular:** `Sheet side="top" rail` (folha de 88dvh, `bg-sidebar`) que desce do topo com `animate-folha`, foco preso. Botão `I.Menu` no topo, marca em `bg-primary`.
- **Cartão de erro (`Boundary`):** cada página roda dentro de um; o erro usa `cantos [--c:var(--bad)] bg-card p-5 animate-emergir`, título `t-section` com `I.CircleX text-bad`, detalhe em `<pre>` `bg-muted t-code`. O resto do painel segue.
- **`StageNotice`:** em página stage, pílula `bg-popover t-meta` no rodapé do canvas com `Dot bad`/`idle` quando os dados param.
- **Dock de execução:** botão fixo `bg-popover` com `Dot kind="busy"`, título, `t-data` com a duração e "Ver" em `bg-primary`.

## Do's and Don'ts

### Faça
- Use a primitiva (`Card`, `Button`, `Badge`, `Dot`, `Select size="sm"`, `Segmented`) e os papéis `t-*`.
- Contorno por `cantos`; divisória interna por `border-b` de 1 px; linha selecionável em lista lateral com `.item-ativo`.
- Meça todo par de cor novo nos dois temas (texto ≥ 4,5; não texto ≥ 3).
- Teste no tema claro: `--primary` é ameixa escura, `--metal-ink` não serve para texto e links sobre `bg-term` usam `text-term-foreground underline decoration-line underline-offset-4 hover:text-metal`.
- Deixe o estado com ícone ou rótulo além da cor.

### Não faça (errado → certo)

| Errado | Certo |
|---|---|
| `<div className="rounded-lg border bg-card p-5">` | `<Card>` (ou `cantos bg-card/96 p-5`) |
| `className="rounded-md ..."` | sem raio; só `rounded-full` em ponto de estado |
| `hover:shadow-lg`, `hover:scale-105`, `hover:ring-primary/40`, glow | `hover:bg-hover` (ou o hover da primitiva) |
| dois `<Button>` padrão lado a lado | um `default`, o resto `variant="secondary"` ou `"ghost"` |
| `text-primary` / `bg-primary` para "rodando" | `text-busy`, `Dot kind="busy"`, `Fio s="fiando"` |
| `<h2 className="text-lg font-semibold">` | `<h2 className="t-section">` (peso 400, sem `font-semibold`) |
| `t-section font-bold` | `t-section` (ou `t-body-strong` se não for título) |
| `text-[13px] font-medium` | `t-label` |
| `bg-card/60 backdrop-blur` sobre a névoa | `bg-card/96` (ou `bg-card`) opaco |
| `border border-input rounded-md` em input | `<Input>` ou `campo` |
| `<Select>` (44 px) numa barra de botões de 32 px | `<Select size="sm">` |
| `variant="outline"` esperando borda | é secundário cheio; borda/linha de base não existe em botão |
| `bg-red-500 text-white` em botão de excluir | `variant="destructive"` (ou `HoldConfirm`) |
| `<Badge className="border border-ok text-ok">` | `<Badge variant="ok">` (cheio, texto em `--background`) |
| `<Dot kind="ok" pulse>` | `<Dot kind="ok">`; `pulse` só em warn/bloqueado |
| `animate-pulse` em qualquer coisa | `pulso`, e só para o que pede você |
| ícone de outro pacote, emoji, `✓` em texto | `I.Check`, `I.CircleCheck` |
| `text-pink-300`, `#ffc6df` literal | `text-primary`, `text-metal`, `text-metal-ink` |
| `animate-fade-up` / entrada escalonada por item | a página entra inteira (`FadeSlot`); só o dado que mudou se mexe (`animate-flash`, `Num`) |
| rótulo pequeno em caixa-alta acima do título do card | `CardHeader title summary description` |
| `opacity-50` em texto legível | `text-muted-foreground` (medido) |
| `elev-float` em card de página | `Card`; `elev-float` é para o que flutua sobre o canvas |
