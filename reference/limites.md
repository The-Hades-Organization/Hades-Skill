# Limites de uso — % das janelas de 5 h e semanal

Quem usa um plano por assinatura esbarra em dois limites, a janela de **5 horas** e a **semanal**, não em dólar. Esta
parte da Hades **mede** o % atual das duas janelas e **converte** o consumo em % por uma calibração feita com o uso da
própria máquina. Tela e aviso (painel, Argos, `watch`, orquestrador) estão em §Painel, aviso e orquestrador.

## Fonte do percentual

O Claude Code entrega ao comando do `statusLine` (stdin, um JSON por atualização) o objeto `rate_limits`. Formato
documentado em https://code.claude.com/docs/en/statusline.md (§Available data, §Rate limit usage), medido contra o Claude
Code **2.1.317**:

| Campo | Significado |
|---|---|
| `rate_limits.five_hour.used_percentage` | % usado da janela de 5 h, 0–100 (pode ser fracionário) |
| `rate_limits.five_hour.resets_at` | renovação, epoch em segundos |
| `rate_limits.seven_day.used_percentage` · `.resets_at` | idem, janela semanal |

- Só existe para assinantes claude.ai Pro/Max/Ultra, e só depois da primeira resposta da sessão. Cada janela pode faltar
  sozinha, e o Claude Code a descarta depois do `resets_at`. O objeto `rate_limits.spend_limit` (gateway de apps Claude)
  não é lido.
- O comando roda no início da sessão, a cada mensagem do assistente, depois de `/compact`, a cada `refreshInterval` (se
  houver) e quando uma janela chega ao `resets_at`. Em `claude -p` (não interativo) o status line não roda.
- Outras fontes não servem: o `/usage` é tela interativa e os transcripts locais não guardam cabeçalhos de limite.
- Sem a coleta ligada não há medida, e a Hades diz **sem amostras**; ela nunca inventa o %.

## Ligar a coleta (passo do dono)

A Hades **não altera** o `settings.json`. Para ligar, o dono põe o comando no `statusLine` (em `~/.claude/settings.json`):

```json
{ "statusLine": { "type": "command", "command": "hades usage sample" } }
```

`hades usage sample` lê o JSON do stdin, grava a amostra e imprime uma linha para o status line
(`5 h 23% (renova 22:10Z) · semana 41% (renova 11-07 03:00Z)`). Com um status line que já existe, encadeie sem perdê-lo:

```json
{ "statusLine": { "type": "command", "command": "tee >(hades usage sample --quiet >/dev/null) | ~/meu-statusline.sh" } }
```

(`--quiet` não imprime nada; `tee` entrega o mesmo JSON aos dois.) A coleta é barata: um arquivo local, sem rede, e
nunca devolve erro ao status line (falha de disco vira aviso no stderr).

## Amostras

`~/.claude/hades/limits/samples.jsonl` (nunca no repo do projeto), uma linha por leitura:
`{"at": "<ISO UTC>", "five": {"pct": 23.5, "resetsAt": 1738425600}, "seven": {...}, "version": "2.1.317"}`.

- Leitura igual à última (as duas janelas) não vira linha; leitura nova só entra depois de `HADES_LIMITS_SAMPLE_GAP_S`
  (60 s) da anterior.
- Retenção `HADES_LIMITS_RETENTION_DAYS` (30): passando de 2000 amostras o arquivo é reescrito só com as retidas.
- Linha corrompida é ignorada na leitura; o resto segue.
- **Medida atual** de uma janela = a última leitura cuja renovação ainda não passou; janela vencida é "sem medida atual".

## Calibração tokens → %

Feita a cada leitura (`hades usage`, `hades moirai estimate`), sem estado próprio: sai das amostras e dos tokens dos
transcripts (os mesmos do `hades usage`, por requisição, com horário), então **recalibra sozinha** a cada uso e nada é
fixo no código.

1. **Intervalos** por janela: da âncora até a primeira amostra em que o % subiu pelo menos `HADES_LIMITS_MIN_DELTA_PCT`
   (1 ponto; abaixo, o intervalo segue acumulando). Janela que renovou entre as duas amostras (renovação difere em mais
   de 2 min) ou % que desceu reinicia a âncora: o intervalo não é usado.
2. **Tokens do intervalo** por modelo, em milhões ponderados: entrada + saída + escrita de cache + leitura de cache ×
   `HADES_LIMITS_CACHE_READ_WEIGHT_PCT` (10%). O peso é premissa da conversão; a taxa absorve o erro.
3. **Taxa por modelo** (% da janela por milhão de tokens ponderados): mínimos quadrados com taxa ≥ 0 sobre os intervalos
   (vários modelos no mesmo intervalo se separam pelas misturas diferentes). Mais a **taxa por US$** equivalente de API
   (soma do % ÷ soma do US$ dos intervalos), que serve ao plano, que só conhece US$.
4. **Sem calibração:** com menos de `HADES_LIMITS_MIN_INTERVALS` (5) intervalos no total, ou menos que isso com tokens
   do modelo, a taxa não existe e a saída diz `sem calib.`; nada é estimado. Modelo sem taxa entre modelos calibrados dá
   `~12.3%+` (o `+` marca que é só o que a calibração cobre).

Limites da conversão: o % é da conta inteira (outra máquina, claude.ai, outro cliente) e os tokens são só os desta máquina;
com uso fora daqui a taxa sai inflada. Os valores são **estimados** e marcados com `~`; o único valor medido é o `current`.

## CLI

`hades usage` (e `--json`, gravado em `latest.json`):

- cabeçalho: por janela, `<janela>: 23.0% usado, renova 22:10Z (medido) · calibrada em N intervalos` (ou `sem medida
  atual`, `sem calibração (N intervalos)`, e `sem amostras: ligue a coleta`);
- colunas `% 5h` e `% semana` por papel, linha de agente e tabela por dia, ao lado do US$ (estimadas, `~`);
- JSON: `pct5h`, `pctWeek` (número arredondado a 0,1 ou `null`) e `pct5hPartial`, `pctWeekPartial` em `byRole`, `byAgent`
  e `byDay`; e `limits` com `current` (`{five|seven: {pct, resetsAt, at}}`, medido), `calibration` (`porModelo`, `porUsd`,
  `intervalos` por janela) e `samples`. Só ganha campos.

`hades moirai estimate <plano>` acrescenta ao fim (texto e `--json` → `limits`; a seção `## Estimativa` gravada com
`--write` **não muda**, para não mexer no hash da aprovação):

- a faixa p25–p75 de cada unidade em % de cada janela (US$ p25/mediana/p75 × a taxa por US$);
- por janela, a soma das unidades e **"cabe na janela atual?"**: o p75 do plano contra o que resta (100 − % usado).
  `cabe`, `NÃO cabe` ou `não dá para dizer` (sem medida atual ou sem calibração). Unidade sem custo estimado (sem
  histórico) torna a soma um piso: ela só pode dizer que **não** cabe. Unidades que rodam em paralelo gastam a mesma
  janela, então a soma é a conta certa.

## Painel, aviso e orquestrador

- **Painel → Consumo:** cartão "Janelas do plano" (`GET /api/limits`: `{coleta, janelas[{janela, rotulo, pct, resetsAt, renova,
  idadeS}]}`): o % medido, a renovação e a idade da leitura. Sem amostra, só o aviso de como ligar a coleta. As colunas
  `~% 5 h` e `~% semana` (estimadas) ficam nas tabelas Por papel e Agentes. `reference/panel.md` §Consumo.
- **Argos:** o painel lateral do agente leva `5 h 23% (renova 22:10Z) · semana 41% (…)`, discreto; some sem amostra.
- **`hades watch`:** `LIMITE <5h|semana> <pct> renova <hora>` quando o % usado passa de `HADES_LIMITS_WARN_FIVE_PCT` (80) ou
  `HADES_LIMITS_WARN_SEVEN_PCT` (90). A janela é da máquina, não de um agente, então o filtro de dono não vale: todo
  observador recebe o aviso, uma vez por janela e por renovação (o visto fica em `limite.five|seven`, com o `resetsAt`;
  diferença de até 2 min na renovação é a mesma janela). Reemite só depois da renovação.
- **Orquestrador:** antes de alocar em paralelo, compara o p75 do plano com o que resta da janela de 5 h ("cabe na janela
  atual?" do `hades moirai estimate`) e leva ao dono a opção de escalonar quando não couber (`loop/orchestrate.md`).
- **Doctor e onboarding:** o `doctor` avisa (nível aviso, grupo Limites) quando o `statusLine` não chama `hades usage sample`
  e não há amostra; o passo `limites` da feature "Contas e loop" mostra o mesmo ao dono. Ligar é passo do dono; a Hades
  nunca altera o `settings.json`.

## Configuração

`HADES_LIMITS_SAMPLE_GAP_S` (60), `HADES_LIMITS_RETENTION_DAYS` (30), `HADES_LIMITS_MIN_DELTA_PCT` (1),
`HADES_LIMITS_MIN_INTERVALS` (5), `HADES_LIMITS_CACHE_READ_WEIGHT_PCT` (10), `HADES_LIMITS_WARN_FIVE_PCT` (80) e
`HADES_LIMITS_WARN_SEVEN_PCT` (90). Ver `reference/config.md`.

## Armadilhas medidas

- `claude -p` não executa o `statusLine`; só a sessão interativa alimenta as amostras.
- O % pode vir inteiro em versões ou planos que arredondam: por isso a variação mínima por intervalo (`MIN_DELTA_PCT`).
- A renovação da janela de 5 h não é fixa (começa na primeira mensagem depois da anterior): sempre compare `resetsAt`, nunca
  a hora do relógio.
