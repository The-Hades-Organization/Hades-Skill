/* Tour da página Branch e PRs (#/code). Contrato dos tours por página: reference/panel.md §Tour por página.
 * Só texto (sem JSX): cada string é uma chave de tradução em potencial. Sem prévia: a página sempre mostra a base e a
 * branch hades/local, mesmo sem PR aplicada. */
HadesCore.registerTour('code', {
  steps: [
    {
      id: 'tour-code',
      title: 'Branch e PRs',
      body: 'A hades/local é a branch do ambiente: a base do projeto mais as PRs que você escolher. Esta página escolhe o conjunto, mostra o que está aplicado e refaz a branch quando você manda.',
      ref: 'panel.md › Seletor de PRs',
      side: 'bottom',
    },
    {
      id: 'code-selecao',
      title: 'O que entra na branch',
      body: 'Escolha só a base ou a base mais PRs. No segundo modo, marque as PRs da lista; PR empilhada traz a stack abaixo dela. Marcar não muda nada ainda: a seleção só vale ao salvar.',
      command: 'prs.list',
      ref: 'panel.md › Seletor de PRs',
      side: 'right',
    },
    {
      id: 'code-local',
      title: 'hades/local',
      body: 'O resumo da branch: se a seleção foi alterada, se está salva mas falta atualizar, ou se já está aplicada. Desfazer descarta a seleção ainda não salva. O menu de documentos abre os relatórios da última reconstrução.',
      side: 'left',
    },
    {
      id: 'code-tranca',
      title: 'A trança',
      body: 'A base e cada PR são fios que se juntam num nó. Fio cheio já está na branch, tracejado entra ao atualizar, fino e riscado sai. O X (ou desfazer) em cada linha tira ou devolve a PR.',
      fallback: 'A trança aparece dentro do card hades/local, sempre com pelo menos a linha da base.',
      side: 'left',
    },
    {
      id: 'code-documentos',
      title: 'Documentos da branch',
      body: 'rebuild.report é o resultado da última reconstrução, conflicts.log os conflitos resolvidos e como, notes.md as ações sugeridas e STATUS.md o estado das PRs.',
      side: 'left',
    },
    {
      id: 'code-salvar',
      title: 'Salvar e atualizar',
      body: '"Salvar" só grava a seleção. "Salvar e atualizar" também refaz a hades/local do zero (git reset --hard na base), recompila e reinicia: o que foi commitado direto nela se perde. Os dois param enquanto um ciclo roda ou se nenhuma PR estiver marcada.',
      command: 'update.sh',
      fallback: 'Os botões ficam desabilitados com um ciclo em curso ou sem PR marcada; o texto abaixo deles diz qual dos dois.',
      side: 'left',
    },
    {
      id: 'code-base',
      title: 'Base',
      body: 'A base remota do projeto: último commit, quando foi o último fetch e quantos commits novos a hades/local ainda não tem. "Fetch da base" só atualiza a referência, não mexe na branch. "Atualizar" aparece quando há commits novos.',
      command: 'git fetch origin --prune',
      fallback: 'Sem a base encontrada, o card pede o Fetch. Rode "Fetch da base" para trazê-la.',
      side: 'left',
    },
  ],
});
