## Qualidade — regras ligadas para este trabalho

Precedência: invariantes da Hades > pedido do dono > regras do projeto > estas regras > código vizinho. Regra do projeto que contraria uma destas vale; registre o conflito no relatório da passada.

**alta**
- `pratica.erro-explicito` [praticas]: Falha é tratada ou propagada com contexto; catch vazio e erro engolido são proibidos. Quem captura decide algo (repetir, traduzir, registrar e seguir), senão deixa subir. — checagem: `grep -E 'catch *(\([a-zA-Z_]*\))? *\{ *\}'` em `*`
- `teste.deterministico` [testes]: Sem dependência de hora, ordem, rede ou acaso não controlado; relógio e aleatoriedade entram por injeção. Teste instável é bug aberto, não ruído.
