# Extensões

Uma extensão é uma ferramenta externa da máquina, com binário próprio (herdr, Mark), que a Hades detecta e consome. Um plugin
é código do pacote de um projeto que roda no painel (`reference/projects.md` §Plugin do Hades); os dois não se misturam: a
extensão não traz código para a Hades executar, só o manifesto que descreve o binário.

Nesta fatia: manifesto, carregador, estado ligado/desligado, CLI e linha do doctor. A página do painel fica para a próxima.

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
| `capabilities` | lista fechada | `canvas.terminal`, `voice`, `window` (capacidade nova entra em `CAPABILITIES`, em `src/lib/extension-manifest.ts`, antes de qualquer manifesto) |
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
