# Snapshot dos bancos

Rede de proteção do `update.sh`: uma migration de PR pode quebrar dados do ambiente, e `migrate deploy` não desfaz.
O snapshot guarda um `pg_dump -Fc` de cada banco dos serviços habilitados (o prefixo do nome vem do ambiente do projeto). Cache, object storage e fila ficam de
fora, e não há restore automático: quem decide voltar é o dono.

## Comandos (`$D/snapshot.sh`)

| Comando | Faz |
|---|---|
| `take [--label <txt>]` | dump de cada banco pelo `docker exec` no container `HADES_PG_CONTAINER` (chave do plugin do projeto, `reference/config.md` §Chaves do plugin), em `$D/snapshots/<AAAAMMDD-HHMMSS>[-label]/` com `meta.json` (head da branch, PRs do `prs.tsv`, serviços, bancos e tamanhos). Aplica a retenção. |
| `list [--json]` | um snapshot por linha; `--json` traz `snapshots[]` e `bytes` (o `clean.sh` e a página do plugin que mostra os snapshots leem daí). |
| `restore <id> [ms…]` | sem `ms`, todos do snapshot. Tira antes um snapshot `pre-restore` do estado atual, para os serviços afetados que estão no ar, **refaz o banco** (drop + create + `pg_restore --clean --if-exists` numa transação), religa os que estavam no ar (os obrigatórios primeiro) e espera o `/health/ready`. Hades pausado: não religa nada. |
| `rm <id>` | apaga. |

## No `update.sh`

Antes do passo de migrate, com Hades não pausado: `HADES_SNAPSHOT_MODE=migration` (padrão) tira o `pre-update` só se o
diff dos serviços afetados traz arquivo em `apps/<ms>/**/migrations/` (`<ms>` = o nome do serviço); `always` tira em todo update que migra; `never`
não tira. Falha no snapshot **para o update** antes de migrar. Pausado, as migrations já são adiadas e não há snapshot.

## Retenção

`HADES_SNAPSHOT_KEEP` (quantos) e `HADES_SNAPSHOT_MAX_GB` (teto somado) valem depois de cada `take`, apagando os mais
antigos; o recém-tirado e o snapshot em restauração nunca saem.

## Armadilhas medidas

- `pg_restore --clean` sozinho **não** apaga tabela criada depois do snapshot (justamente o que a migration fez): por
  isso o restore refaz o banco.
- `docker exec -i` dentro de laço `while read` consome o stdin do laço (só o primeiro banco era guardado): o `take`
  usa `< /dev/null`.
- O snapshot dos dados é só o Postgres: carga que escreve em cache ou fila precisa ser reaplicada.
