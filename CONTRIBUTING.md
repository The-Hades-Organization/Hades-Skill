# Contribuir com a Hades

Issues e PRs são bem-vindas. Este arquivo resume o caminho de quem é de fora; o detalhe está nas referências citadas.

## Antes de abrir

- Bug ou pedido: abra uma issue pelos modelos (bug ou feature).
- Vulnerabilidade: siga o [`SECURITY.md`](SECURITY.md); nunca uma issue pública.

## Da mudança à PR

1. Faça um fork e crie uma branch a partir da `main`.
2. Mude o necessário, seguindo as regras abaixo, e documente na referência do assunto em `reference/`.
3. Rode o gate local:

   ```bash
   bun install                                     # traz typescript e @types/bun
   bun x tsc --noEmit                              # tipos
   bun test loop/test/ts                           # regressão do núcleo
   bun src/cli.ts skill-release guard              # guardas de nome de projeto e de domínio
   ```

4. Abra a PR contra a `main`, dizendo o que muda, por quê e como você provou.

## Regras do projeto

- TypeScript direto do fonte, sem build; sem `any`.
- Comentário só onde explica o porquê.
- Nada de caminho absoluto, usuário, host, URL de túnel, segredo nem nome de projeto no núcleo; a guarda reprova.
- A ajuda dos comandos e os textos do painel são em pt-BR.

## Licença e versão

Não há DCO nem CLA. Ao abrir uma PR, você concorda que a contribuição é distribuída sob a licença MIT do projeto
([`LICENSE`](LICENSE)). Não mexa em `VERSION` nem no `CHANGELOG.md`: o mantenedor faz isso na release.

## O que acontece com a PR

Uma PR de fora é revisada na própria PR. A consolidação traz o diff para a `main`, a mudança sai na release seguinte e a
PR é fechada citando a versão. O fluxo está em [`reference/contrib.md`](reference/contrib.md); o de quem mantém a skill,
em [`reference/evolving.md`](reference/evolving.md).
