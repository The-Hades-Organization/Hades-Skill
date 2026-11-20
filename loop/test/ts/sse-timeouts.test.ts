// Grupo sse-timeouts: o teto de ociosidade do servidor tem de ser maior que o heartbeat dos streams SSE, senão o Bun fecha a
// conexão entre dois heartbeats e os avisos do intervalo de religação se perdem.
import { describe, expect, test } from "bun:test";
import { SSE_IDLE_TIMEOUT_S, SSE_KEEP_ALIVE_MS } from "../../../src/panel/sse";

describe("sse-timeouts", () => {
  test("o idleTimeout do servidor (s) cobre o heartbeat (ms) com folga de pelo menos um heartbeat", () => {
    expect(SSE_IDLE_TIMEOUT_S * 1000).toBeGreaterThanOrEqual(SSE_KEEP_ALIVE_MS * 2);
  });

  test("o idleTimeout cabe no máximo que o Bun aceita (255 s)", () => {
    expect(SSE_IDLE_TIMEOUT_S).toBeLessThanOrEqual(255);
  });
});
