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
