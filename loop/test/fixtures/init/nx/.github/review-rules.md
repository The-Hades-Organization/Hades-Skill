# Regras de review

## 🔴 Regras bloqueantes

### R1. Tipos
- Zero `any` em código novo.
- Em testes é permitido ter any implícito.

### R2. Segredos
- Secrets hardcoded são bloqueantes.

### R3. Erros
- Nunca engolir erro com catch vazio.

## 🟡 Verificações importantes

### V1. Responsabilidade única
- Aplique o princípio de responsabilidade única.

### V2. Idempotência
- Handlers de fila precisam ser idempotentes.

### V3. Estilo
- Siga a convenção do arquivo.
