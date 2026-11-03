// Contrato `panel/api.ts` do plugin do projeto (reference/projects.md §Plugin): tipos do que o plugin exporta e do `ctx` que
// o host entrega. O plugin importa só os tipos (`import type`, apagados na execução), então o caminho não precisa resolver
// em tempo de execução.

/** Recusa com a mensagem do plugin: o painel responde 400 e mostra o texto. */
export class PluginRefused extends Error {}

export type UnitView = Record<string, unknown>;

export interface PluginCtx {
  /** `$D` e o worktree do projeto, como texto de caminho */
  readonly D: string;
  readonly W: string;
  readonly NODE_BIN: string;
  /** cita cada argumento para o shell e os junta por espaço */
  q(...args: unknown[]): string;
  /** o valor, se estiver na lista fechada; senão recusa (400) */
  pick<T>(value: T, allowed: Iterable<T>): T;
  /** recusa o pedido com esta mensagem (400) */
  refuse(message: string): never;
  /** stdout do comando, ou "" se falhou ou estourou o tempo (padrão 8 s) */
  run(argv: string[], timeoutS?: number): string;
  /** status HTTP, ou null se não respondeu (padrão 1,5 s) */
  httpStatus(url: string, timeoutS?: number): Promise<number | null>;
  config(): Record<string, string>;
  /** comando para rodar `$D/<script>` com estes argumentos */
  sh(script: string, ...args: unknown[]): string;
  snapshot(): Record<string, unknown>;
  containers(): Set<string>;
  /** só no `sample`: units do systemd e a visão de cada uma */
  units?: Record<string, Record<string, string>>;
  unitView?(name: string): UnitView;
}

export type PluginAction = readonly [title: string, script: string, exclusive: boolean];

/** Funções que o plugin pode exportar; todas opcionais. Cada rota de `plugin.json` → `panel.routes[].fn` é uma `PluginRoute`. */
export interface PluginApi {
  action?(name: string, body: Record<string, unknown>, ctx: PluginCtx): PluginAction | Promise<PluginAction>;
  sample?(ctx: PluginCtx): Record<string, unknown> | Promise<Record<string, unknown>>;
}
export type PluginRoute = (ctx: PluginCtx, data: Record<string, unknown>) => unknown | Promise<unknown>;
