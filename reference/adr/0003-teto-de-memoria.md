# ADR 0003 — Teto de memória

## Contexto
No Linux o teto é a slice do systemd (`MemoryMax`/`MemoryHigh`, `HADES_SLICE_MAX`), mais o `systemd-run` do gate-lock
para cada gate: estourar derruba o Hades, não a máquina. O macOS não tem cgroup nem slice. Foi medido que `RLIMIT_AS`
e `RLIMIT_RSS` não limitam a memória residente no macOS 26 (o processo passa do limite sem ser morto).

## Decisão
- **Gates** (gate-lock): vigia de RSS da árvore do processo (`ps -axo pid,ppid,rss`, a cada ~1 s) que mata o grupo
  (TERM, depois KILL) e sai 137 quando passa do custo declarado; mais um gatilho pela memória livre (`vm_stat`,
  `memAvailableMb`). O pico medido é gravado, como no Linux.
- **Serviços**: só aviso. O painel mostra a soma de RSS; o doctor informa que não há slice
  (`HADES_SLICE_MAX` não se aplica) e `config.sh apply-slice` e o install não tentam criá-la.
- `doctor.ts`: `checkSlice` no launchd é informativo (ok com o motivo), nunca erro.

O vigia está em `src/lib/mem-watch.ts` (TS puro: a árvore de processos e a memória livre entram por injeção) e é ligado
pelo `gate-lock` quando a plataforma é macOS. Detalhes que a medição pediu:

- O comando roda em **grupo de processos próprio** (`detached`): o vigia derruba o grupo (`kill(-pgid)`) e, além disso,
  cada pid da árvore (quem saiu do grupo com `setsid` também cai). O Ctrl-C do terminal não chega a esse grupo, então o
  `gate-lock` repassa SIGINT/SIGTERM pelo grupo.
- O gatilho de memória livre só age sobre a árvore do próprio gate e só quando a leitura deu um valor (0 = falha de
  leitura, não falta de memória). O piso é 512 MB.
- Gate morto pelo vigia sai 137 mesmo que o filho tenha caído por TERM (143): o vigia sabe a causa, e a mensagem não cita
  `journalctl`. Ao fim, o que ainda estiver no grupo leva KILL.
- O RSS somado conta páginas compartilhadas mais de uma vez: o vigia é conservador (mata um pouco antes), e o pico
  gravado para o `stack-add` tende a sobrar.

## Alternativas
- **`ulimit -v`/`RLIMIT_AS`**: não funciona no macOS (medido), e `-v` limita endereço virtual, não residente.
- **`launchd` `HardResourceLimits`**: usa os mesmos rlimits, mesma falha.
- **Matar só pelo gatilho de memória livre**: não protege contra um gate que cresce dentro da folga da máquina, e
  mataria processo de outro dono.
- **Não ter teto no macOS**: o gate de 5 GB deixaria de ter proteção contra estouro, a razão de existir da fila.

## Consequências
- No macOS o teto dos serviços é uma recomendação, não uma garantia; a documentação e o doctor dizem isso.
- O vigia custa uma consulta de `ps` por segundo enquanto há gate rodando.
- A fila segue medindo memória livre antes de admitir um gate (já existente, PR do suporte ao macOS).
