/// <reference path="./logic.tsx" />
/* Executor do layout de forças na página Argos: avança a simulação de src/lib/canvas-force.ts em fatias de ~8 ms por quadro,
 * para a página não travar. Sem DOM nem React: quadro, cancelamento e relógio entram por injeção, então o bun test usa
 * os mesmos falsos e o harness /dev/canvas carrega o arquivo para medir 1000 nós. Carregado depois de argos/logic.js. */

interface RunnerPlacement { id: string; x: number; y: number }
interface RunnerProgress { steps: number; settled: boolean; done: boolean }
/** O que o executor usa da simulação (`ForceSimulation` de canvas-force). */
interface RunnerSimulation { step(n: number): RunnerProgress; placements(): RunnerPlacement[] }
interface ForceRunResult {
  placements: RunnerPlacement[];
  steps: number;
  /** Assentou (energia abaixo do limiar); `false` quando bateu o teto de passos ou foi parado. */
  settled: boolean;
  /** Do início ao fim, pelo relógio injetado. */
  ms: number;
}
interface ForceRunnerDeps {
  frame(run: () => void): number;
  cancel(handle: number): void;
  clock(): number;
  /** Posições do quadro (não chamado com `reducedMotion`: o resultado chega só no fim). */
  show(placements: RunnerPlacement[]): void;
  onDone(result: ForceRunResult): void;
  /** Erro do passo (`ForceError` com código, em geral `force_diverged`): a rodada para e nada é gravado. */
  onError(error: unknown): void;
  sliceMs?: number;
  reducedMotion?: boolean;
}
interface ForceRunner {
  /** Começa a rodada; uma que estivesse rodando é descartada sem `onDone`. */
  start(sim: RunnerSimulation): void;
  /** Para onde está e devolve o resultado parcial; `null` se nada rodava. Não chama `onDone`. */
  stop(): ForceRunResult | null;
  running(): boolean;
}

function makeReadingRunner() {
  const L = (globalThis as unknown as { ArgosLogic: ArgosLogicApi }).ArgosLogic;
  /** Orçamento de simulação por quadro: sobra tempo para o desenho dentro dos 16 ms de 60 fps. */
  const SLICE_MS = 8;

  const createForceRunner = (deps: ForceRunnerDeps): ForceRunner => {
    const sliceMs = deps.sliceMs ?? SLICE_MS;
    let sim: RunnerSimulation | null = null;
    let handle: number | null = null;
    let startedAt = 0;
    let steps = 0;
    let spentMs = 0;
    let slice = 1;

    const result = (current: RunnerSimulation, settled: boolean): ForceRunResult =>
      ({ placements: current.placements(), steps, settled, ms: deps.clock() - startedAt });

    // relógio sem resolução para medir a fatia (o navegador arredonda o tempo): dobra a fatia até ele medir algo
    const nextSlice = (): number => (spentMs > 0 && steps > 0 ? L.sliceSteps(spentMs / steps, sliceMs) : Math.min(slice * 2, L.SLICE_STEPS_MAX));

    const tick = (): void => {
      handle = null;
      const current = sim;
      if (!current) return;
      const t0 = deps.clock();
      let progress: RunnerProgress;
      try {
        progress = current.step(slice);
      } catch (e) {
        sim = null;
        deps.onError(e);
        return;
      }
      spentMs += deps.clock() - t0;
      steps = progress.steps;
      slice = nextSlice();
      if (progress.done) {
        sim = null;
        deps.onDone(result(current, progress.settled));
        return;
      }
      if (!deps.reducedMotion) deps.show(current.placements());
      handle = deps.frame(tick);
    };

    const cancelFrame = (): void => {
      if (handle !== null) deps.cancel(handle);
      handle = null;
    };

    return {
      start(next) {
        cancelFrame();
        sim = next;
        startedAt = deps.clock();
        steps = 0;
        spentMs = 0;
        slice = L.sliceSteps(null, sliceMs);
        handle = deps.frame(tick);
      },
      stop() {
        const current = sim;
        cancelFrame();
        sim = null;
        return current ? result(current, false) : null;
      },
      running: () => sim !== null,
    };
  };

  return { SLICE_MS, createForceRunner };
}
type ArgosReadingRunnerApi = ReturnType<typeof makeReadingRunner>;
(globalThis as unknown as { ArgosReadingRunner: ArgosReadingRunnerApi }).ArgosReadingRunner = makeReadingRunner();
