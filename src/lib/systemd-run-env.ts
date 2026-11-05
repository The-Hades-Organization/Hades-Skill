// Ambiente de um processo que o painel lança numa unit transitória (job, chat): o systemd-run e o launchd começam de um
// ambiente vazio e a unit herda o HOME do gerenciador de serviço, não o do painel. Numa instância com outro HOME isso fazia
// o job ler e gravar o `~` real; por isso HOME e as variáveis de instância que o env.sh exporta seguem do painel.
import { home } from "./paths.ts";
import type { EnvPairs } from "./service-manager.ts";

/** O que identifica a instância do painel: HADES_ID e os nomes que o config.sh deriva dele (HU, HSLICE, HPROJ). */
export interface InstanceNames {
  hu: string;
  instanceId: string;
  slice: string;
  project: string;
}

export interface InstanceEnvSource extends InstanceNames {
  worktree: string;
  dir: string;
}

/** HOME do painel que disparou, as variáveis de instância e o PATH dele, mais o que o chamador acrescentar. */
export function instanceEnv(source: InstanceEnvSource, extra: EnvPairs = []): EnvPairs {
  return [
    ["PATH", process.env.PATH ?? ""], ["NO_COLOR", "1"], ["TERM", "dumb"],
    ["HOME", home()],
    ["HADES_ID", source.instanceId], ["HU", source.hu], ["HSLICE", source.slice], ["HPROJ", source.project],
    ["HADES_WT", source.worktree], ["HADES_DATA", source.dir],
    ...extra,
  ];
}
