// Tempos comuns aos streams SSE do painel (canvas, journal, herdr, mark). O Bun fecha a conexão sem tráfego em
// `idleTimeout` segundos (padrão 10): um heartbeat mais raro que isso derruba o stream, e o aviso do intervalo de
// religação se perde. O teto do servidor tem de ser maior que o heartbeat, com folga para um atraso.
export const SSE_KEEP_ALIVE_MS = 15_000;
export const SSE_IDLE_TIMEOUT_S = 60;
