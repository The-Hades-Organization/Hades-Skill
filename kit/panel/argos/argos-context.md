# Você está no Argos

Este terminal é um nó do Argos, o canvas de agentes do painel Hades. O dono vê o canvas: o seu nó, as notas ligadas a
você, os outros terminais e as áreas (retângulos coloridos que agrupam uma frente de trabalho). Ao começar, e antes de
criar qualquer nó, rode `hades canvas context`: ele diz em que canvas e em que área você está, o seu papel, a quem você
responde, as notas que você lê e as Configurações que valem para você.

## Área

- Se `hades canvas context` mostra uma área, você trabalha dentro dela. Tudo o que você cria pela CLI (nota, recruta,
  desenho) nasce dentro da sua área. Cheia, ela cresce e afasta o que estiver no caminho. Não crie nó por outro caminho.
- Não mova, renomeie nem apague nó ou área de outra frente. Arrumar o canvas inteiro (`hades canvas organize`) só com
  pedido do dono.
- Fora de área, o que você cria nasce perto de você, sem área.

## Comandos de qualquer terminal

Todos se identificam pelo pane em que você roda e saem com código diferente de zero e uma mensagem quando recusados.

- `hades canvas context [--rules]`: o contexto acima; `--rules` repete este texto.
- `hades canvas note list`, `note read <nota> [--only]`, `note write <nota> [--append] [texto]`: as notas ligadas a você.
  O andamento vai na nota, não no terminal.
- `hades canvas area list`: as áreas do canvas e quem está em cada uma.
- `hades canvas notify <texto>`: avisa o dono (desktop e celular). Só para o que ele precisa saber agora.

Só o terminal com a caixa Orquestrador recruta, cria nota e desenho e dispensa; as instruções de gerente dele dizem como.

## Regras da Hades que valem aqui

- Esperas nunca por `sleep`, laço de checagem ou `tail -f` (o hook barra): use `hades wait …` em segundo plano.
- Lint, build, teste e checagem de tipos passam pela fila (`gate-lock.sh run …`), um comando por vez, em segundo plano.
- No auto mode com o hook do rtk, uma chamada Bash por resposta.
- Leia arquivo grande por trecho (`grep -n` e `sed -n 'A,Bp'`); o que entra no contexto é relido a cada turno.
- Commit sem trailer de co-author. PR, commit, comentário e card não citam worker, `gate-lock`, `--where` nem onde o
  gate rodou.
- Nunca `/model` (grava o padrão de todas as sessões), `pkill -f`, merge de PR, nem mexer em pane do herdr ou painel alheio.
- Perto do teto de contexto, ou antes de esperar longe, estacione: `handoff.md` com `STATUS: PARKED — <motivo>`.
- O que o papel ou o brief disser vale mais que esta lista.
