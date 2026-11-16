// O que o `gate-lock run` precisa saber para mandar um item para fora: onde (`--where`/chave), a stack e a afinidade da
// etapa, a chave de aquecimento e o estado dos workers. Sem efeito colateral além de ler o worktree e consultar o ssh.
import { join } from "node:path";
import type { JsonObject } from "../profile.ts";
import type { Affinity, Candidate, Where } from "./dispatch.ts";
import { probeWorker } from "./client.ts";
import { ProtocolError, containedInHome, isHost, type WorkerSpec } from "./protocol.ts";
import type { SshCommand } from "./transport.ts";
import { affinityOf, readKeyFiles, remoteSpecOf, warmKey } from "./warm.ts";

export const WHERE_LOCAL = "local";
export const WHERE_AUTO = "auto";

/**
 * `--where` ou `HADES_GATE_WHERE`. `auto` só vale pela chave: quem pede um host na linha de comando sabe onde quer, e
 * quem deixa o despacho decidir faz isso na configuração do ambiente.
 */
export function parseWhere(raw: string, fromFlag: boolean): Where {
  if (raw === "" || raw === WHERE_LOCAL) return { mode: "local" };
  if (raw === WHERE_AUTO) {
    if (fromFlag) throw new ProtocolError("--where auto não existe: use HADES_GATE_WHERE=auto na configuração");
    return { mode: "auto" };
  }
  if (!isHost(raw)) throw new ProtocolError(`--where inválido: '${raw}' (local | <host>)`);
  return { mode: "host", host: raw };
}

export interface RemotePlan {
  /** stack do pacote que declara `remote.*` ("" = sem aquecimento) */
  stack: string;
  warmKey: string | undefined;
  affinity: Affinity;
  /** `remote.passEnv`: nomes das variáveis de build que atravessam */
  passEnv: string[];
}

const NO_AFFINITY: Affinity = { labels: [], minMemGb: 0 };

/** Plano da etapa `<stack>:<etapa>` (vazio quando o item não vem de uma etapa). */
export function planOf(step: string, clone: string, stacks: ReadonlyMap<string, JsonObject>): RemotePlan {
  const colon = step.indexOf(":");
  if (colon < 0) return { stack: "", warmKey: undefined, affinity: NO_AFFINITY, passEnv: [] };
  const name = step.slice(0, colon);
  const stack = stacks.get(name);
  const affinity = affinityOf(stack, step.slice(colon + 1));
  const spec = remoteSpecOf(stack);
  if (spec === undefined) return { stack: "", warmKey: undefined, affinity, passEnv: [] };
  return { stack: name, warmKey: warmKey({ stack: name, scope: clone, files: readKeyFiles(clone, spec.key) }), affinity, passEnv: spec.passEnv };
}

/** Consulta todos os workers em paralelo; o que não responde vira candidato inalcançável. */
export function probeAll(ssh: SshCommand, workers: readonly WorkerSpec[]): Promise<Candidate[]> {
  return Promise.all(workers.map(async (spec) => ({ spec, status: await probeWorker(ssh, spec.host) })));
}

/** `--out`: caminho absoluto dentro de $HOME (o worker recusa o resto; falhar aqui poupa a ida). */
export function checkOut(files: readonly string[], home: string, cwd: string): string[] {
  return files.map((file) => {
    const absolute = file.startsWith("/") ? file : join(cwd, file);
    if (!containedInHome(absolute, home)) throw new ProtocolError(`--out fora de $HOME ou fora do formato: '${file}'`);
    return absolute;
  });
}
