# Extensões

Uma extensão é uma ferramenta externa da máquina, com binário próprio (herdr, Mark, Cardinal), que a Hades detecta e consome. Um plugin
é código do pacote de um projeto que roda no painel (`reference/projects.md` §Plugin do Hades); os dois não se misturam: a
extensão não traz código para a Hades executar, só o manifesto que descreve o binário.

Manifesto, carregador, estado ligado/desligado, CLI e linha do doctor, mais a página Extensões do painel (§Página do painel).

## Manifesto

`extensions/<nome>/extension.json`, embutido na skill. A pasta tem o mesmo nome do campo `name`. Ler o manifesto não executa
nada. Campo ausente, tipo errado, capacidade fora da lista ou `schema` desconhecido recusam o manifesto, com o caminho do campo
e um código estável (`ext.manifest.*`).

| Campo | Tipo | Significado |
|---|---|---|
| `schema` | `1` | versão do formato |
| `name`, `description` | texto | nome (minúsculas, números, `.`, `-`, `_`) e uma frase |
| `binary.names` | lista de nomes | binários aceitos, o primeiro achado no PATH vale |
| `binary.configKey` | chave ou ausente | chave de configuração que aponta o binário (ex.: `HADES_HERDR_BIN`) |
| `version` | `{command, min}` ou `null` | comando de versão em argv (sem shell; o primeiro item é um de `binary.names`) e versão mínima `x.y.z`; `null` quando a ferramenta não tem como medir |
| `capabilities` | lista fechada | `canvas.terminal`, `canvas.diagram`, `voice`, `window` (capacidade nova entra em `CAPABILITIES`, em `src/lib/extension-manifest.ts`, antes de qualquer manifesto) |
| `install.text` | texto | instrução para o dono; a sessão nunca a executa |
| `health` | `{command}` ou `null` | comando de saúde em argv; sai com 0 quando está bem |
| `configKeys` | lista de chaves | chaves próprias do catálogo (`kit/config.tsv`) |
| `enableKey` | chave | `HADES_EXT_<NOME>`: 1 liga, 0 desliga |

## Ciclo

- **Estado:** `HADES_EXT_<NOME>` em `config.env`; padrão 1, então herdr e Mark seguem ligados e nada muda para quem não mexeu.
  Só o 0 explícito desliga.
- **Detecção:** só `hades ext info|list|doctor` (e a linha do doctor) rodam algo: o comando de versão e o de saúde do
  manifesto, sem shell, com tempo limite. Binário ausente, versão ilegível, versão abaixo da mínima e saúde falha viram
  `problems`, cada um com código estável (`ext.binary-missing`, `ext.version-unreadable`, `ext.version-below-min`,
  `ext.health-failed`).
- **Superfícies:** o doctor ganha uma linha por extensão, no grupo Extensões (ausente é `ok`, com o comando de instalar;
  problema com binário presente é aviso). O código que já usa herdr e Mark continua chamando o que chamava: consultar
  `extensionEnabled(nome)` (`src/lib/extension.ts`) é opt-in de cada superfície.

## Comandos

```
hades ext list [--json]            uma linha por extensão: instalada, versão, ligada
hades ext info <nome> [--json]     manifesto resumido, binário, versão, problemas e o texto de instalação
hades ext enable|disable <nome>    grava HADES_EXT_<NOME> em config.env (exige instalação)
hades ext doctor [<nome>] [--json] linha de saúde; sai 1 se uma extensão ligada e instalada tem problema
```

`--json` devolve `{version: 1, extensions: [...]}`; erro devolve `{version: 1, ok: false, code, error}` com `ext.unknown`,
`ext.usage`, `ext.no-instance` ou `ext.config-invalid`.

## Página do painel

`#/extensoes`, no grupo Sistema. Consome o mesmo carregador do `hades ext`, sem lógica duplicada.

- **Mostra**, por extensão: nome, descrição, instalada, versão (ou "desconhecida"), versão mínima, ligada, saúde, capacidades e os
  `problems` com o código estável. As chaves próprias (`configKeys`) saem com o valor efetivo e um link para Configurações, onde
  se edita.
- **Liga e desliga** pelo interruptor: grava `HADES_EXT_<NOME>` em `config.env`, como `hades ext enable|disable`. Religar volta ao
  padrão e a chave sai do arquivo (o `config.env` guarda só o que difere do catálogo). Desligar pede confirmação. Pelo acesso
  remoto a página é só leitura.
- **Nunca executa** a instalação: o texto de `install.text` aparece copiável, com a frase de que a Hades não o executa. A página
  só roda o que o carregador já roda (comando de versão e de saúde do manifesto, argv sem shell, tempo limite de 5 s).

Rotas (`src/panel/routes-ext.ts`):

| Rota | Corpo | Resposta |
|---|---|---|
| `GET /api/extensions` | | o mesmo JSON do `hades ext list --json`: `{version: 1, extensions: [...]}`. Guarda o resultado por 10 s, porque versão e saúde rodam binários de forma síncrona; ligar ou desligar o descarta |
| `POST /api/extensions` | `{op: "enable"\|"disable", name}` | `{version: 1, ok: true, name, enabled}` |

O POST exige o token da sessão e o painel local. Recusas, com código estável: `ext.local-only` (403, acesso remoto),
`ext.bad-request` (400, operação ou nome inválido), `ext.unknown` (404), `ext.config-invalid` (400, a configuração recusou o valor).

## Cardinal

`extensions/cardinal/extension.json`: editor de diagramas de dados. O Cardinal é GPL-3.0 e o Hades é MIT, então nada dele entra
aqui: só se fala com ele por processo (o binário `cardinal`, por argv, sem shell) e, mais adiante, por iframe (o build web).
O arquivo `.cardinal` é a fonte da verdade; o Hades nunca o converte para formato próprio.

- **Manifesto:** capacidade `canvas.diagram`; `binary.configKey` `HADES_CARDINAL_BIN`; versão por `cardinal --version`
  (saída `cardinal 0.1.0 (format 2)`, mínima `0.1.0`); saúde por `cardinal --check`.
- **Chaves** (`kit/config.tsv`, grupo Extensões): `HADES_EXT_CARDINAL` (1), `HADES_CARDINAL_BIN` (vazio),
  `HADES_CARDINAL_WEB` (vazio; pasta `dist/` do build web, fora do repositório) e `HADES_DRAWING_ENGINE` (`hades`).
- **Dois pedaços independentes:** o binário serve às operações de agente; o build web serve ao editor embutido. Sem o binário
  o usuário ainda edita (com o build web); sem o build web o agente ainda trabalha.
- **Build web no doctor:** além da linha `ext-cardinal`, o `hades doctor` traz `ext-cardinal-web`: `ok` quando
  `HADES_CARDINAL_WEB` está vazio ou aponta uma pasta com `index.html`; aviso quando aponta uma pasta sem ele. Se a pasta
  traz `version.txt` (o Vite copia de `public/`; primeiro `x.y.z` do arquivo) e o binário informa a versão, o doctor avisa
  quando as duas divergem. Sem `version.txt` não há comparação.

### Executor do binário

`src/panel/cardinal-runner.ts` roda `cardinal` por argv, sem shell, para as rotas de agente do nó (`describe`, `svg`, `edit`, `export`; `reference/argos.md` §Nó `cardinal`). Limites: 30 s, 8 MiB de entrada, 32 MiB de saída, ambiente mínimo, grupo de processos próprio (timeout mata o grupo). O binário vem de `HADES_CARDINAL_BIN` ou do PATH; com a extensão desligada ou sem binário, `cardinal_unavailable` (503). O `.cardinal` segue a fonte da verdade: o painel só repassa bytes.

### Editor embutido: rota `/ext/cardinal/web/*`

`src/panel/ext-cardinal-web.ts` serve os arquivos de `HADES_CARDINAL_WEB` (aceita `~`), lida a cada pedido. Só GET.

- **Contenção:** o caminho é decodificado e recusado com `..`, `.`, `\` ou NUL; o arquivo é resolvido com `realpath` e tem de
  ficar sob a pasta (symlink para fora dá 404). `/ext/cardinal/web` e `/ext/cardinal/web/` servem `index.html`.
- **Erros:** `cardinal_web_missing` (404) quando a variável está vazia, a pasta não existe ou não tem `index.html`;
  `cardinal_web_not_found` (404) para o arquivo.
- **Cabeçalhos:** `Content-Type` por extensão (`.wasm` = `application/wasm`); `Cache-Control: public, max-age=31536000,
  immutable` para nomes com hash do Vite (`nome-HASH.ext`) e `no-cache` para o resto (`index.html`, `icon.svg`); sem
  `X-Frame-Options`, com `Content-Security-Policy: frame-ancestors 'self'`; `Access-Control-Allow-Origin: *` (o iframe tem
  origem opaca); nenhum COOP/COEP (o build é de uma thread). O resto do painel segue com `X-Frame-Options: DENY`
  (`send()` aceita a exceção por chamada, `SendExtras` em `src/panel/http.ts`).
- **Compressão:** serve `<arquivo>.br` ou `<arquivo>.gz` ao lado quando o cliente aceita; sem eles, gzip na hora para
  `.wasm/.js/.css/.html/.svg/.json` (cache em memória por arquivo, tamanho e mtime). Sempre com `Vary: Accept-Encoding`.
- **Autenticação pelo túnel:** o acesso remoto autentica por cookie derivado de `remote.key` (`auth.authed`). Subrecurso de
  iframe com origem opaca não manda cookie, então a rota responde **antes** da chave remota, depois do `hostOk` (host do
  túnel continua obrigatório). Ela entrega só o build, nada do usuário; a API fica atrás da chave e só o pai fala com ela.

### Editor embutido: ponte `postMessage` e componente do nó

O nó `cardinal` do canvas monta o editor num iframe (`/ext/cardinal/web/index.html?host=1`, `sandbox="allow-scripts"` sem
`allow-same-origin`: origem opaca, sem cookie nem acesso à API). Quem fala com as rotas é o pai (a página); o iframe só troca
mensagens. Lógica em `src/lib/cardinal-bridge.ts` (sem DOM), componente em `kit/panel/ui/argos/node-cardinal.tsx`
(`window.ArgosNodeCardinal.CardinalEditor`), montado por `types-user.tsx` só com o nó aberto.

- **Envelope:** toda mensagem leva `cardinal: 1` (`BRIDGE_PROTOCOL`) e `type`; só se aceita mensagem vinda do `contentWindow`
  do iframe do nó. `ready` com `protocol` diferente deixa o estado em `failed` (`protocol_mismatch`).
- **Do editor ao painel:** `ready` (traz `protocol` e `format`), `dirty`, `save` (`baseRev` + `bytes`), `export-result`,
  `merge-notice` (`conflicts[]`: `both-changed`, `deleted-vs-changed`, `dangling-reference`).
- **Do painel ao editor:** `load` (`rev`, `readOnly`, bytes), `saved` (`rev`), `save-rejected` (`currentRev`, depois de um 409),
  `external-change` (`rev` + bytes do arquivo atual; o editor é quem mescla), `set-readonly`, `request-export`.
- **Somente leitura:** quando o `format` do arquivo é maior que o do `ready`, o `load` leva `readOnly: true`.
- **Salvar:** `save` vira `PUT` com `rev: baseRev`; 409 vira `save-rejected` seguido de `external-change`. O painel nunca mescla.
- **Exportar:** `request-export` (SVG ou PNG, escala 2 no PNG); o resultado é gravado ao lado pelo `POST …/artifact`
  (`reference/argos.md` §Nó `cardinal`) só se o arquivo não tem edição pendente; senão a imagem é gerada sem gravar.
- **Aviso de arquivo mudado:** o SSE `cardinal` (`onCardinal` em `canvas-live.ts`) alimenta `cardinalFeed`; o editor aberto do
  mesmo nome recebe `fileChanged(rev)`. Revisão igual à que o editor já tem não gera `external-change`.
- **Abrir e fechar:** o nó mostra título e **Abrir editor / Fechar editor**. Fechar passa `closing=true`, o editor salva o
  pendente (teto `FLUSH_TIMEOUT_MS`, 5 s; o gatilho é tirar o foco do iframe) e o nó só desmonta no `onClosed`. Desmontagem
  abrupta (fechar a aba) é best-effort.
- **Limites:** até `EDITOR_MAX_LIVE` (2) editores vivos por página; o terceiro mostra o aviso de limite sem criar iframe.
  Sem `ready` em `READY_TIMEOUT_MS` (20 s) o estado vai a `failed` (`ready_timeout`).

### Motor de desenho efetivo

`HADES_DRAWING_ENGINE` é só o pedido. O motor efetivo (`src/lib/drawing-engine.ts`, `drawingEngine`) é calculado: `cardinal`
vale quando a extensão está ligada **e** (o binário está saudável **ou** o build web existe). Senão o efetivo é `hades` e há uma
razão com código estável:

| Código | Quando |
|---|---|
| `engine.extension-off` | `HADES_EXT_CARDINAL=0` |
| `engine.extension-missing` | o manifesto não está nesta instalação |
| `ext.binary-missing`, `ext.version-unreadable`, `ext.version-below-min`, `ext.health-failed` | o primeiro problema do binário, sem build web que o supra |

O padrão é `hades` até a unidade 17 do plano de integração: instalar a extensão não muda o fluxo de ninguém. Os nós de desenho
existentes seguem intactos; com o motor `cardinal` aparecem como "motor do Hades desligado" (unidades seguintes).

Onde aparece: `GET /api/extensions` ganha `drawingEngine: {configured, effective, usable, reason}`; `GET /api/config` ganha o
mesmo em `engine` e **omite** o item `HADES_DRAWING_ENGINE` enquanto o Cardinal não está utilizável (o item continua visível se
o dono já o mudou do padrão, para poder voltar). A página Extensões mostra o aviso quando se pediu `cardinal` e o efetivo é `hades`.
O julgamento roda o binário, por isso fica em cache por 10 s.

## Extensão mínima de exemplo

Uma ferramenta `eco` que responde `eco 1.0.0` a `eco --version`:

```json
{
  "schema": 1,
  "name": "eco",
  "description": "Ferramenta de exemplo que repete o que recebe.",
  "binary": { "names": ["eco"] },
  "version": { "command": ["eco", "--version"], "min": "1.0.0" },
  "capabilities": ["window"],
  "install": { "text": "Instale o eco com o gerenciador de pacotes e deixe-o no PATH." },
  "health": { "command": ["eco", "--version"] },
  "configKeys": [],
  "enableKey": "HADES_EXT_ECO"
}
```

Para valer: salve em `extensions/eco/extension.json` e acrescente a linha `HADES_EXT_ECO` (padrão 1, tipo `bool`, grupo
Extensões) em `kit/config.tsv` (`reference/config.md` §Chave nova). O teste de manifestos embutidos exige que a chave exista.
