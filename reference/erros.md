# Erros que se explicam

Toda falha que o usuário vê (painel, CLI, hook que barra comando) diz quatro coisas, em pt-BR e sem jargão interno:

1. O que aconteceu: a mensagem original, com o dado que a sustenta (nome do agente, porta, caminho relativo).
2. Por quê: a causa provável.
3. O que fazer: ação concreta, com o comando pronto entre crases ou o botão da tela.
4. Saiba mais: arquivo e seção de `reference/`.

O código estável (`code`, os enums `*_ERRORS`) continua sendo o que a máquina lê. O texto para humano mora no catálogo e nunca
leva segredo, caminho da home do usuário nem pilha.

```bash
hades explain                 # lista os códigos que têm explicação
hades explain note_stale_revision   # o que o erro quer dizer, por quê e o que fazer
```

## Como funciona

Um catálogo só, `src/lib/human-errors-catalog.ts`: `código → { title, cause, action, ref }`. `src/lib/human-errors.ts` expõe:

| Função | Para quê |
|---|---|
| `explain(code)` | Entrada do catálogo, ou o texto de fallback (mostra o código e aponta `hades doctor`). Nunca devolve `undefined`. `known` diz se veio do catálogo. |
| `renderCli(message, code)` | Bloco do stderr da CLI: a mensagem original na primeira linha, depois `Por quê`, `O que fazer`, `Saiba mais` e `(código: …)`. |
| `renderHook(message, code, action?)` | Razão da recusa do hook. `action` troca a ação do catálogo quando a recusa sabe o comando exato. |
| `renderEntry(code)` | Saída de `hades explain <código>`. |
| `messageOfCliFailure(stderr)` | Volta da CLI para o painel: acha a mensagem original antes do bloco. |

Três bordas usam o catálogo:

- **CLI.** Os comandos que saem com erro chamam `renderCli`. A primeira linha mantém o formato antigo
  (`hades canvas: <mensagem> (<código>)`), então quem filtra a saída pelo texto continua achando o que achava.
- **Painel (servidor).** `send(status, body)` em `src/panel/http.ts` acrescenta o campo `explain`
  (`{ code, title, cause, action, ref }`) a toda resposta 4xx/5xx cujo corpo tem `code`. O contrato só cresce: `error` e `code`
  seguem onde estavam.
- **Hook.** `src/hook.ts` barra o comando pelo `src/lib/guard-hook.ts`, que monta a razão com `renderHook`: diz o que foi barrado e o que fazer no lugar.

Os códigos das enums ficam como texto literal no catálogo, sem importar os módulos de canvas: a CLI e o hook carregam o
catálogo em toda chamada, e o código estável só ganha valores. O teste `loop/test/ts/human-errors.test.ts` importa as enums e
exige uma entrada para cada código do inventário prioritário.

## No painel

O componente `ErroExplicado` (`kit/panel/ui/parts/erro.tsx`) mostra o erro inteiro: título, o que aconteceu, por quê, o que
fazer (com botão de copiar o comando) e onde ler mais. Está em `window.HadesParts.ErroExplicado` e em
`HadesCore.ErroExplicado`; as páginas desestruturam de `HadesCore`.

```tsx
<ErroExplicado error={e} title="Não foi possível ler o Cerberus" onRetry={load} />
```

| Propriedade | Tipo | Efeito |
|---|---|---|
| `error` | `unknown` | O que a página tiver: um `Error` de `post()`/`fetch` (leva `explain` e `code` quando o painel respondeu), o corpo `{ error, code, explain }` de uma resposta, ou só uma string. |
| `title` | `string?` | Título da falha na página ("Não foi possível ler o Cerberus"). Sem ele vale o título da explicação. |
| `onRetry` | `() => void?` | Mostra o botão "Tentar de novo". |

Regras que valem para quem adota o componente (as páginas do Argos entram na consolidação):

- **Rede caída e resposta que não é JSON** viram o texto de `panel_unreachable`: o navegador não tem catálogo, então o componente
  carrega um espelho desse único texto, e o teste confere que ele é igual à entrada do catálogo.
- **`getJSON` não lança em resposta com erro**: ele devolve o corpo. Para o componente receber o `explain`, a página lança o
  corpo (`throw Object.assign(new Error(body.error), body)`) ou usa `post()`, que já faz isso.
- **Celular.** O componente quebra palavra longa (`break-words`, `min-w-0`) e os botões usam o `Button` do painel, que passa de 44 px
  de altura abaixo de `md`. Nada depende de hover.
- O texto do toast de falha usa `errDesc(e)`, que junta a mensagem e a ação do `explain`.

## Como acrescentar uma entrada

1. Ache o código estável (o campo `code` da resposta, o `(código: …)` do stderr, ou o valor do enum `*_ERRORS`).
2. Acrescente a entrada em `HUMAN_ERRORS` no `src/lib/human-errors-catalog.ts`, perto das do mesmo assunto:

   ```ts
   note_stale_revision: {
     title: "A nota mudou desde que você a abriu",
     cause: "Outra aba (ou o agente) gravou uma versão mais nova.",
     action: "Recarregue a nota e refaça a edição.",
     ref: "reference/argos.md §Notas",
   },
   ```

3. Escreva o texto assim:
   - `title`: o que aconteceu, numa linha, sem nome de função.
   - `cause`: a causa provável, sem dado de runtime (o dado vai na mensagem original, ao lado).
   - `action`: o passo seguinte, com o comando pronto entre crases (o primeiro vira o botão de copiar no painel).
   - `ref`: `reference/<arquivo>.md §<título exato de uma seção>`. O teste confere que a seção existe.
4. Código novo de enum: o teste de cobertura falha até a entrada existir. Código que só aparece em literal
   (rota que monta o `code` na mão) entra em `LITERAL_CODES` no teste.
5. Rode `bun test loop/test/ts/human-errors`.

Tom do texto: o guia de escrita da Hades. Frase curta, causa antes da ação, sem culpar o usuário e sem jargão interno.

## Armadilhas

- **Não compare pelo texto.** Quem consome ramifica pelo `code`. O texto do catálogo pode mudar a qualquer momento.
- **Código sem entrada não quebra nada**: `explain` devolve o fallback, com o código e a indicação do `hades doctor`. Mas o teste
  falha para código do inventário prioritário.
- **Segredo e pilha.** O texto do catálogo é estático. Dado variável (token, caminho, pilha) fica fora dele e fora do `explain`.
- **`deps need`** ainda sai com o erro genérico: `src/commands/deps*` é de outra unidade e adota `renderCli` quando ela consolidar.
