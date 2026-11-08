// Item do doctor para a ponte do Mark (reference/doctor.md `mark-ponte`). O julgamento é puro: recebe o que o arquivo e a
// sonda disseram e devolve nível, texto e a ação que corrige. A leitura do arquivo e a sonda ficam em src/commands/doctor.ts.
import { MARK_ERRORS, type BridgeRead, type MarkStateBody } from "./mark-bridge.ts";

/** O que a sonda de `GET /api/state` achou. `unreachable` cobre recusa, timeout e resposta fora do contrato. */
export type MarkProbe = { kind: "answered"; state: MarkStateBody } | { kind: "rejected" } | { kind: "unreachable" };

export interface MarkVerdict {
  level: "ok" | "warn";
  msg: string;
  fix?: string;
}

const RUN_MARK = "rode `mark` (abre o Mark-LVI e recria o bridge.json)";

/**
 * `probe` é `undefined` quando não houve sonda (`--quick`, ou o arquivo já disse que o Mark está fora). Sem `bridge.json`
 * o Mark simplesmente não está aberto: não é aviso, o nó do Argos mostra a ação sozinho.
 */
export function judgeMark(read: BridgeRead, probe: MarkProbe | undefined): MarkVerdict {
  if (!read.ok) {
    switch (read.cause) {
      case MARK_ERRORS.bridgeMissing:
        return { level: "ok", msg: "ponte do Mark não encontrada: o Mark não está aberto" };
      case MARK_ERRORS.bridgeInvalid:
        return { level: "warn", msg: "bridge.json ilegível ou fora do contrato", fix: `${RUN_MARK}; confira HADES_MARK_BRIDGE` };
      case MARK_ERRORS.processGone:
        return { level: "warn", msg: "bridge.json aponta um processo que não existe mais (o Mark saiu sem limpar o arquivo)", fix: RUN_MARK };
      case MARK_ERRORS.unreachable:
      case MARK_ERRORS.rejected:
      case MARK_ERRORS.badResponse:
        return { level: "warn", msg: "ponte do Mark fora do ar", fix: RUN_MARK };
      default:
        return assertNever(read.cause);
    }
  }
  if (probe === undefined) return { level: "ok", msg: `ponte do Mark encontrada (pid ${read.bridge.pid}); resposta não conferida em --quick` };
  switch (probe.kind) {
    case "answered":
      return { level: "ok", msg: `Mark respondendo: ${probe.state.name}, ${probe.state.state}` };
    case "rejected":
      return { level: "warn", msg: "o Mark recusou o token do bridge.json", fix: RUN_MARK };
    case "unreachable":
      return { level: "warn", msg: "ponte encontrada, mas o Mark não respondeu", fix: RUN_MARK };
    default:
      return assertNever(probe);
  }
}

function assertNever(value: never): never {
  throw new Error(`caso não tratado: ${JSON.stringify(value)}`);
}

/** O que a sonda de voz achou: `ready` (o `/ws/voice` respondeu `ready` ao `hello`), `busy` (outro cliente tem a vaga) ou `failed`. */
export type MarkVoiceProbe = "ready" | "busy" | "failed";
export const MARK_VOICE_PROBES: readonly MarkVoiceProbe[] = ["ready", "busy", "failed"];

/**
 * Programa que o doctor roda em um `bun -e` à parte: abre `/ws/voice`, manda `hello`, espera `ready`, manda `bye` e fecha. Entra
 * `{url, token, insecure, timeoutMs}` por stdin (o token nunca vai na linha de comando nem na saída) e sai uma palavra de
 * `MARK_VOICE_PROBES`. Nenhum áudio é enviado.
 */
export const VOICE_PROBE_SCRIPT = `
const input = JSON.parse(await Bun.stdin.text());
const done = (word) => { console.log(word); process.exit(0); };
const timer = setTimeout(() => done("failed"), input.timeoutMs);
const ws = new WebSocket(input.url, { headers: { Authorization: "Bearer " + input.token }, tls: input.insecure ? { rejectUnauthorized: false } : undefined });
ws.onopen = () => ws.send(JSON.stringify({ type: "hello", mode: "ptt" }));
ws.onmessage = (event) => {
  let body = null;
  try { body = typeof event.data === "string" ? JSON.parse(event.data) : null; } catch { body = null; }
  if (body && body.type === "ready") { ws.send(JSON.stringify({ type: "bye" })); clearTimeout(timer); setTimeout(() => done("ready"), 100); }
  if (body && body.type === "busy") { clearTimeout(timer); done("busy"); }
};
ws.onerror = () => done("failed");
ws.onclose = () => setTimeout(() => done("failed"), 200);
`;

/** Lê a saída da sonda; qualquer coisa fora da lista é falha (nunca um padrão em silêncio). */
export const parseVoiceProbe = (stdout: string): MarkVoiceProbe => MARK_VOICE_PROBES.find((word) => word === stdout.trim()) ?? "failed";

/** `probe` é `undefined` quando a ponte não respondeu ao estado ou no `--quick`: o item `mark-ponte` já diz o que falta. */
export function judgeMarkVoice(probe: MarkVoiceProbe | undefined): MarkVerdict {
  switch (probe) {
    case undefined:
      return { level: "ok", msg: "voz do Mark não conferida (Mark fechado ou --quick)" };
    case "ready":
      return { level: "ok", msg: "Mark aceita voz (`/ws/voice` respondeu `ready`)" };
    case "busy":
      return { level: "ok", msg: "voz do Mark em uso por outro cliente (a vaga é de um por vez)" };
    case "failed":
      return { level: "warn", msg: "o Mark responde ao estado, mas não abriu o `/ws/voice`", fix: "atualize o Mark-LVI para a versão com voz remota e abra de novo com `mark`" };
    default:
      return assertNever(probe);
  }
}
