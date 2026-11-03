// Gerenciador de serviço do usuário: o que o Hades pede do systemd (Linux) e do launchd (macOS). Quem precisa de uma
// unit persistente (painel, vigia), de um processo transitório (job, chat) ou só de perguntar o estado fala com esta
// interface; o texto da unit, o plist e o argv de cada ferramenta ficam em service-manager-systemd.ts e
// service-manager-launchd.ts. Decisão e contrato: reference/adr/0001-gerenciador-de-servico.md.
import { EXIT, die } from "./output.ts";
import { LaunchdManager } from "./service-manager-launchd.ts";
import { SystemdManager } from "./service-manager-systemd.ts";

export type ServiceManagerKind = "systemd" | "launchd";
export const SERVICE_MANAGER_ENV = "HADES_SERVICE_MANAGER";

/** Variáveis de ambiente do serviço, na ordem em que aparecem na unit. */
export type EnvPairs = ReadonlyArray<readonly [string, string]>;

/** Serviço persistente: sobe no start, reinicia se cair e (opcional) sobe sozinho no login. */
export interface ServiceSpec {
  /** nome completo da unit: `<HU>-<sufixo>` (hds-panel, hds_alfa-notify); no launchd vira o rótulo com.hades.<HU>.<sufixo> */
  unit: string;
  description: string;
  workdir: string;
  env: EnvPairs;
  /** executável e argumentos; o primeiro e os caminhos absolutos saem entre aspas na unit do systemd */
  argv: string[];
  /** stdout e stderr, em modo append */
  logFile: string;
  restart: "on-failure" | "no";
  restartSec: number;
}

/** Processo transitório (job, sessão de chat): roda uma vez, grava a saída em arquivo e some quando acaba. */
export interface TransientSpec {
  unit: string;
  workdir: string;
  env: EnvPairs;
  argv: string[];
  /** stdout e stderr, em modo append */
  stdout: string;
  /** arquivo que vira o stdin do processo */
  stdin?: string;
}

/** Comando que roda e sai (limpeza) e o gerenciador dispara a cada intervalo, sem processo residente. */
export interface TimerSpec {
  /** nome-base: no systemd são as units `<unit>.service` e `<unit>.timer`; no launchd, um só plist com StartInterval */
  unit: string;
  description: string;
  timerDescription: string;
  env: EnvPairs;
  /** executável e argumentos; no systemd o primeiro sai cru e os caminhos absolutos seguintes entre aspas */
  argv: string[];
  /** stdout e stderr, em modo append */
  logFile: string;
  /** o intervalo como o dono escreveu (6h, 1d): o systemd o lê direto em OnUnitActiveSec */
  every: string;
  /** o mesmo intervalo em segundos (parseEverySeconds): o StartInterval do launchd; indefinido = intervalo ilegível */
  everySec: number | undefined;
  /** prioridade baixa de CPU e de disco (Nice=10 e IOSchedulingClass=idle; Nice e LowPriorityIO no launchd) */
  background: boolean;
}

/** Serviço que o gerenciador reinicia se cair (túnel), sem unit persistente: some ao parar ou no logout. */
export interface KeepAliveSpec {
  unit: string;
  /** só o launchd o leva (o PATH do devtunnel); o systemd-run herda o ambiente do gerenciador de usuário */
  env: EnvPairs;
  /** o primeiro item é resolvido no PATH quando não é absoluto (o launchd não procura) */
  argv: string[];
  /** stdout e stderr, em modo append; no launchd é de onde sai a URL do túnel (readLog) */
  logFile: string;
  restartSec: number;
  /** só o systemd tem slice (teto de memória) */
  slice?: string;
}

/** O que o vigia e o painel precisam de uma unit: estado e quantas vezes o gerenciador a reiniciou. */
export interface UnitInfo {
  unit: string;
  activeState: string;
  restarts: number;
}

export interface ServiceManager {
  readonly kind: ServiceManagerKind;
  /** id do registro de dependências (src/deps/registry.tsv) da ferramenta que o gerenciador exige */
  readonly requires: string;
  /** onde a definição persistente da unit está (ou ficaria) agora */
  definitionPath(unit: string): string;
  /** grava a definição se mudou; true = mudou (quem está no ar precisa reiniciar) */
  write(spec: ServiceSpec): boolean;
  /** Os verbos devolvem o código de saída: 0 = ok. stop de unit que não existe é ok. */
  start(unit: string): number;
  stop(unit: string): number;
  restart(unit: string): number;
  /** início automático no login; `now` também para o serviço */
  enable(unit: string): number;
  disable(unit: string, now?: boolean): number;
  /** limpa o estado `failed` (volta a inactive); sem efeito em unit que não falhou */
  resetFailed(unit: string): void;
  isActive(unit: string): boolean;
  /** active | activating | failed | inactive, o vocabulário do `systemctl is-active` */
  activeState(unit: string): string;
  isEnabled(unit: string): boolean;
  /** enabled | disabled */
  enabledState(unit: string): string;
  /** estado e reinícios de várias units numa chamada só; unit que o gerenciador não conhece volta inactive, com 0 reinícios */
  inspect(units: string[]): UnitInfo[];
  /** nomes das units em execução cujo nome começa com `prefix` (hds-pjob-) */
  listActive(prefix: string): string[];
  /** as últimas `lines` linhas do log da unit */
  readLog(unit: string, lines: number): string;
  /** O comando que lança o transitório, para quem roda assíncrono (o painel). No launchd grava o plist do job antes de devolver. */
  transientArgv(spec: TransientSpec): string[];
  /** Para o transitório e recolhe o que sobrou dele. */
  stopTransient(unit: string): number;
  /** Os mesmos do painel, sem travar o laço de eventos: `listActive` (com `transitional`, também activating/deactivating) e `stopTransient`. */
  listActiveAsync(prefix: string, transitional?: boolean): Promise<string[]>;
  stopTransientAsync(unit: string): Promise<number>;
  /** Recolhe os transitórios com o prefixo que terminaram sozinhos (fora de `active`): o launchd não os recolhe como o `--collect`. Devolve as units recolhidas. */
  collectFinished(prefix: string, active: ReadonlySet<string>): string[];
  /** O `Environment` da unit, como `"K=V" "K=V"`; vazio se ela não existe. */
  unitEnvironment(unit: string): string;

  /** grava a definição do timer se mudou; true = mudou (quem está armado precisa rearmar) */
  writeTimer(spec: TimerSpec): boolean;
  /** liga o timer no login e o arma; `rearm` o rearma para ler o intervalo novo */
  armTimer(unit: string, rearm: boolean): number;
  /** desliga e desarma */
  disarmTimer(unit: string): number;
  /** o timer inicia sozinho no login */
  timerEnabled(unit: string): boolean;
  /** enabled | disabled; vazio se o gerenciador não conhece o timer */
  timerEnabledState(unit: string): string;
  /** quando disparou pela última vez, como o gerenciador o escreve; vazio se ele não guarda (launchd: a marca é do job) */
  timerLastTrigger(unit: string): string;
  /** sobe o serviço que reinicia em falha e devolve o código de saída do que o lançou */
  runKeepAlive(spec: KeepAliveSpec): number;
}

/** Qual gerenciador vale: HADES_SERVICE_MANAGER força (os testes); senão launchd no macOS e systemd no resto. */
export function managerKind(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): ServiceManagerKind {
  const forced = env[SERVICE_MANAGER_ENV];
  if (forced === undefined || forced === "") return platform === "darwin" ? "launchd" : "systemd";
  if (forced === "systemd" || forced === "launchd") return forced;
  return die(`${SERVICE_MANAGER_ENV}=${forced}: use systemd ou launchd`, EXIT.usage);
}

export function serviceManager(kind: ServiceManagerKind = managerKind()): ServiceManager {
  switch (kind) {
    case "systemd":
      return new SystemdManager();
    case "launchd":
      return new LaunchdManager();
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}
