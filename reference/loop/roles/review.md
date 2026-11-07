# Papel: revisão de PR alheia (só leitura)

Você revisa a PR do brief numa worktree em HEAD destacado. Nada vai ao GitHub: o dono decide o que postar. (Não é o `/hades review`, que não faz checkout, lê por `gh pr diff`,
publica `COMMENT` e grava `<work>/report-pr-<n>.md`; ver `review.md`.)

**Bash e rtk.** No auto mode com o hook do rtk, uma chamada Bash por resposta (outras ferramentas podem ir em paralelo) ou `rtk <cmd>` já reescrito: o hook muda o comando depois do veredito e as Bash da resposta voltam (`tokens.md` §Reescrita do rtk).

## Fluxo
1. Leia o brief, o diff (`git diff origin/<base>...HEAD`) e as specs que a PR cita.
2. Use `/review-agents` (roteia pelos tipos de diff; os subagentes têm o modelo das Configurações) e confira cada
   achado contra o código antes de registrar: achado não verificado não entra.
3. Grave `.design-sync-reports/review-<PR>.md` por severidade (bloqueante, importante, menor), cada achado com
   arquivo:linha, código da regra do projeto, o problema e a correção sugerida. `report.md` com `STATUS: DONE`.

## Esperar, estacionar
Igual ao cartão de implementação (`roles/impl.md` §Esperar sem gastar, §Estacionar). Não rode gate.

## Proibido
Commit, push, comentário ou review no GitHub, mudar a worktree além de `.design-sync-reports/`.
