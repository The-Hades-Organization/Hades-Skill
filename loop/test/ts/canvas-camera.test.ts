// Grupo canvas-camera: câmera do motor do canvas (src/lib/canvas-camera.ts) — tela↔mundo, pan, zoom ancorado e limites,
// roda e pinça, enquadrar e revelar, animação, teclas de câmera, recorte por viewport e nível de detalhe por zoom.
import { describe, expect, test } from "bun:test";
import {
  CAMERA_COMMAND_IDS, CAMERA_LIMITS, DETAIL_THRESHOLDS, FULL_DETAIL_CHOICES, OPENING_MIN_SCALE, fullDetailScale, openingCamera, boundsOf, cameraChord, cameraCommandDefs, cameraKey, canZoom, clampZoom,
  cullRects, cullSegments, detailFor, fitAll, fitRect, fitSelectionCamera, focusNodeCamera, hasScrollRoom, interpolateCamera, panBy,
  pinchCamera, revealRect, screenToWorld, shortLabel, visibleRect, wheelCamera, wheelIntent, wheelZoomFactor, worldToScreen,
  zoomAt, zoomLabel, zoomReset, zoomStep, zoomTo, type Camera, type CameraCommandCtx, type Rect, type Vec, type WheelInput,
} from "../../../src/lib/canvas-camera";
import { argosCommandDefs, type ArgosCommandCtx } from "../../../src/lib/canvas-argos";
import { createCommandRegistry, type CommandDef } from "../../../src/lib/canvas-commands";

const VIEW = { w: 1000, h: 600 };
const close = (a: number, b: number): void => expect(Math.abs(a - b)).toBeLessThan(1e-9);
const closeVec = (a: Vec, b: Vec): void => {
  close(a.x, b.x);
  close(a.y, b.y);
};

describe("canvas-camera: tela e mundo", () => {
  test("dado câmera com pan e zoom, tela→mundo→tela volta ao mesmo ponto", () => {
    const cam: Camera = { x: -340.5, y: 1200.25, k: 0.37 };
    for (const p of [{ x: 0, y: 0 }, { x: 999, y: 1 }, { x: 512.5, y: 333.3 }]) closeVec(worldToScreen(cam, screenToWorld(cam, p)), p);
  });

  test("dado o canto da câmera, o ponto de tela 0,0 é o canto e a escala multiplica a distância", () => {
    const cam = { x: 100, y: 50, k: 2 };
    expect(screenToWorld(cam, { x: 0, y: 0 })).toEqual({ x: 100, y: 50 });
    expect(worldToScreen(cam, { x: 110, y: 60 })).toEqual({ x: 20, y: 20 });
  });

  test("arrastar a tela leva o mundo junto: o ponto sob o dedo continua sob o dedo", () => {
    const cam = { x: 10, y: 20, k: 0.5 };
    const grabbed = screenToWorld(cam, { x: 200, y: 100 });
    closeVec(worldToScreen(panBy(cam, 30, -40), grabbed), { x: 230, y: 60 });
  });
});

describe("canvas-camera: zoom", () => {
  test("zoom ancorado mantém o ponto do mundo sob o cursor", () => {
    const cam = { x: -50, y: 80, k: 0.8 };
    const cursor = { x: 640, y: 210 };
    const under = screenToWorld(cam, cursor);
    for (const factor of [1.7, 0.4, 3]) {
      const next = zoomAt(cam, cursor, factor);
      closeVec(screenToWorld(next, cursor), under);
    }
  });

  test("zoom respeita os limites e, no limite, o ponto sob o cursor não anda", () => {
    const cam = { x: 0, y: 0, k: 1 };
    const cursor = { x: 300, y: 300 };
    const tooFar = zoomAt(cam, cursor, 1e-6);
    expect(tooFar.k).toBe(CAMERA_LIMITS.zoomMin);
    closeVec(screenToWorld(tooFar, cursor), screenToWorld(cam, cursor));
    expect(zoomTo(cam, cursor, 1e6).k).toBe(CAMERA_LIMITS.zoomMax);
  });

  test("escala inválida é erro, não vira o limite em silêncio", () => {
    for (const k of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => clampZoom(k)).toThrow(RangeError);
  });

  test("roda: deltaY positivo afasta, negativo aproxima; linha e página pesam mais que pixel", () => {
    expect(wheelZoomFactor(100, 0)).toBeLessThan(1);
    expect(wheelZoomFactor(-100, 0)).toBeGreaterThan(1);
    expect(wheelZoomFactor(0, 0)).toBe(1);
    expect(wheelZoomFactor(3, 1)).toBeCloseTo(wheelZoomFactor(48, 0), 12);
    expect(wheelZoomFactor(1, 2)).toBeLessThan(wheelZoomFactor(1, 1));
  });

  test("pinça: a escala segue a razão dos dedos e o ponto sob o meio inicial vai para o meio atual", () => {
    const start = { cam: { x: 0, y: 0, k: 1 }, a: { x: 100, y: 100 }, b: { x: 200, y: 100 } };
    const under = screenToWorld(start.cam, { x: 150, y: 100 });
    const next = pinchCamera(start, { x: 50, y: 300 }, { x: 250, y: 300 });
    close(next.k, 2);
    closeVec(screenToWorld(next, { x: 150, y: 300 }), under);
  });

  test("pinça com os dedos no mesmo ponto não divide por zero: mantém a escala", () => {
    const start = { cam: { x: 0, y: 0, k: 1.5 }, a: { x: 10, y: 10 }, b: { x: 10, y: 10 } };
    expect(pinchCamera(start, { x: 5, y: 5 }, { x: 40, y: 5 }).k).toBe(1.5);
  });
});

describe("canvas-camera: enquadrar e revelar", () => {
  test("enquadrar um retângulo: cabe inteiro com a folga e fica centralizado", () => {
    const rect = { x: 1000, y: -200, w: 800, h: 300 };
    const cam = fitRect(rect, VIEW, 50);
    const tl = worldToScreen(cam, { x: rect.x, y: rect.y });
    const br = worldToScreen(cam, { x: rect.x + rect.w, y: rect.y + rect.h });
    expect(tl.x).toBeGreaterThanOrEqual(50 - 1e-9);
    expect(tl.y).toBeGreaterThanOrEqual(50 - 1e-9);
    expect(br.x).toBeLessThanOrEqual(VIEW.w - 50 + 1e-9);
    expect(br.y).toBeLessThanOrEqual(VIEW.h - 50 + 1e-9);
    closeVec({ x: (tl.x + br.x) / 2, y: (tl.y + br.y) / 2 }, { x: VIEW.w / 2, y: VIEW.h / 2 });
  });

  test("enquadrar respeita o zoom máximo para um retângulo pequeno e o mínimo para um enorme", () => {
    expect(fitRect({ x: 0, y: 0, w: 1, h: 1 }, VIEW).k).toBe(CAMERA_LIMITS.zoomMax);
    expect(fitRect({ x: 0, y: 0, w: 1e7, h: 1e7 }, VIEW).k).toBe(CAMERA_LIMITS.zoomMin);
  });

  test("enquadrar todos usa a caixa de todos os nós; sem nós volta à câmera padrão", () => {
    const rects: Rect[] = [{ x: 0, y: 0, w: 100, h: 100 }, { x: 900, y: 400, w: 100, h: 100 }];
    expect(boundsOf(rects)).toEqual({ x: 0, y: 0, w: 1000, h: 500 });
    expect(fitAll(rects, VIEW)).toEqual(fitRect({ x: 0, y: 0, w: 1000, h: 500 }, VIEW));
    expect(boundsOf([])).toBeUndefined();
    expect(fitAll([], VIEW)).toEqual({ x: 0, y: 0, k: 1 });
  });

  test("revelar: nó já à vista não mexe a câmera; nó fora entra com o menor pan, sem trocar o zoom", () => {
    const cam = { x: 0, y: 0, k: 1 };
    expect(revealRect(cam, { x: 100, y: 100, w: 50, h: 50 }, VIEW, 10)).toBe(cam);
    const right = revealRect(cam, { x: 2000, y: 100, w: 100, h: 50 }, VIEW, 10);
    expect(right).toEqual({ x: 2000 + 100 + 10 - VIEW.w, y: 0, k: 1 });
    const above = revealRect(cam, { x: 100, y: -500, w: 100, h: 50 }, VIEW, 10);
    expect(above).toEqual({ x: 0, y: -510, k: 1 });
  });

  test("animação: começa na origem, termina no destino e o zoom do meio fica entre os dois", () => {
    const a = { x: 0, y: 0, k: 0.5 };
    const b = { x: 300, y: 100, k: 2 };
    expect(interpolateCamera(a, b, 0, VIEW)).toBe(a);
    expect(interpolateCamera(a, b, 1, VIEW)).toBe(b);
    const mid = interpolateCamera(a, b, 0.5, VIEW);
    expect(mid.k).toBeGreaterThan(a.k);
    expect(mid.k).toBeLessThan(b.k);
  });
});

describe("canvas-camera: teclas de câmera", () => {
  test("+ e - dão o mesmo passo nos dois sentidos, 0 enquadra, setas fazem pan e outra tecla não é de câmera", () => {
    const zin = cameraKey("+");
    const zout = cameraKey("-");
    expect(zin?.kind === "zoom" && zout?.kind === "zoom" ? zin.factor * zout.factor : 0).toBeCloseTo(1, 12);
    expect(cameraKey("=")).toEqual(zin);
    expect(cameraKey("0")).toEqual({ kind: "fit" });
    expect(cameraKey("ArrowLeft")).toEqual({ kind: "pan", dx: CAMERA_LIMITS.keyPanStep, dy: 0 });
    expect(cameraKey("ArrowDown")).toEqual({ kind: "pan", dx: 0, dy: -CAMERA_LIMITS.keyPanStep });
    expect(cameraKey("a")).toBeUndefined();
  });
});

describe("canvas-camera: recorte por viewport", () => {
  const view = visibleRect({ x: 0, y: 0, k: 2 }, VIEW); // 500 × 300 de mundo

  test("o retângulo à vista encolhe com o zoom", () => {
    expect(view).toEqual({ x: 0, y: 0, w: 500, h: 300 });
  });

  test("só passam os nós que cruzam a tela, na ordem de entrada; encostar na borda de fora não conta", () => {
    const rects = [
      { id: "dentro", x: 10, y: 10, w: 20, h: 20 },
      { id: "fora", x: 600, y: 10, w: 20, h: 20 },
      { id: "cruza", x: 490, y: 290, w: 50, h: 50 },
      { id: "encosta", x: 500, y: 0, w: 10, h: 10 },
      { id: "envolve", x: -100, y: -100, w: 1000, h: 1000 },
    ];
    expect(cullRects(rects, view).map((r) => r.id)).toEqual(["dentro", "cruza", "envolve"]);
    expect(cullRects([], view)).toEqual([]);
  });

  test("aresta passa pela caixa das pontas, inclusive reta horizontal que atravessa a tela com as pontas fora", () => {
    const ends: Record<string, [Vec, Vec]> = {
      atravessa: [{ x: -100, y: 150 }, { x: 900, y: 150 }],
      fora: [{ x: 600, y: 0 }, { x: 900, y: 300 }],
      dentro: [{ x: 10, y: 10 }, { x: 20, y: 20 }],
    };
    const ids = ["atravessa", "fora", "dentro", "sem-ponta"];
    expect(cullSegments(ids, (id) => ends[id], view)).toEqual(["atravessa", "dentro"]);
  });
});

describe("canvas-camera: nível de detalhe", () => {
  test("longe é bloco de cor, no meio bloco com rótulo, perto o nó completo; os limiares mudam o nível", () => {
    expect(detailFor(0.05)).toBe("dot");
    expect(detailFor(DETAIL_THRESHOLDS.block - 0.001)).toBe("dot");
    expect(detailFor(DETAIL_THRESHOLDS.block)).toBe("block");
    expect(detailFor(DETAIL_THRESHOLDS.full - 0.001)).toBe("block");
    expect(detailFor(DETAIL_THRESHOLDS.full)).toBe("full");
    expect(detailFor(CAMERA_LIMITS.zoomMax)).toBe("full");
  });

  test("dado o limite escolhido pelo dono, então o nó aparece completo mais de longe, para todos os tipos", () => {
    expect(detailFor(0.3)).toBe("block");
    expect(detailFor(0.3, 0.3)).toBe("full");
    expect(detailFor(0.29, 0.3)).toBe("block");
    expect(detailFor(0.2, 0.2)).toBe("full");
    expect(detailFor(0.19, 0.2)).toBe("dot");
  });

  test("dado o valor guardado, então só as escolhas do Vista valem e o resto volta ao padrão", () => {
    expect(FULL_DETAIL_CHOICES[0]).toBe(DETAIL_THRESHOLDS.full);
    for (const k of FULL_DETAIL_CHOICES) expect(fullDetailScale(k)).toBe(k);
    for (const raw of [null, undefined, "0.3", 0.01, 5, Number.NaN]) expect(fullDetailScale(raw)).toBe(DETAIL_THRESHOLDS.full);
    expect(Math.min(...FULL_DETAIL_CHOICES)).toBeGreaterThanOrEqual(0.2);
  });

  test("rótulo curto corta com reticências no espaço de tela e some quando não cabe nada", () => {
    expect(shortLabel("agente de implementação", 1000, 12)).toBe("agente de implementação");
    const cut = shortLabel("agente de implementação", 60, 12);
    expect(cut.endsWith("…")).toBe(true);
    expect(Array.from(cut).length).toBe(Math.floor(60 / (12 * 0.6)));
    expect(shortLabel("abc", 2, 12)).toBe("");
    expect(shortLabel("ação", 8, 12)).toBe("…");
  });
});

const wheel = (over: Partial<WheelInput>): WheelInput => ({ deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, altKey: false, ...over });

describe("canvas-camera: roda, trackpad e pinça", () => {
  test("dois dedos no trackpad (pixels fracionários ou com componente horizontal) arrastam o mundo, sem zoom", () => {
    expect(wheelIntent(wheel({ deltaX: 12, deltaY: 7.5 }))).toEqual({ kind: "pan", dx: -12, dy: -7.5 });
    expect(wheelIntent(wheel({ deltaY: 9 }))).toEqual({ kind: "pan", dx: -0, dy: -9 });
    expect(wheelIntent(wheel({ deltaX: 3, deltaY: 120 })).kind).toBe("pan");
  });

  test("arrastar com a roda leva o conteúdo junto: rolar para baixo move o mundo para cima", () => {
    const cam: Camera = { x: 0, y: 0, k: 2 };
    const next = wheelCamera(cam, wheel({ deltaY: 40 }), { x: 100, y: 100 });
    expect(next.k).toBe(2);
    expect(next.y).toBeCloseTo(20, 9);
    expect(worldToScreen(next, { x: 0, y: 0 }).y).toBeCloseTo(-40, 9);
  });

  test("roda de mouse (entalhe inteiro de 100, sem horizontal, ou em linhas) dá zoom no cursor", () => {
    const up = wheelIntent(wheel({ deltaY: -100 }));
    const down = wheelIntent(wheel({ deltaY: 100 }));
    expect(up.kind === "zoom" && up.factor > 1).toBe(true);
    expect(down.kind === "zoom" && down.factor < 1).toBe(true);
    expect(wheelIntent(wheel({ deltaY: 3, deltaMode: 1 })).kind).toBe("zoom");
    const cam = { x: 5, y: 9, k: 1 };
    const cursor = { x: 300, y: 200 };
    closeVec(screenToWorld(wheelCamera(cam, wheel({ deltaY: -100 }), cursor), cursor), screenToWorld(cam, cursor));
  });

  test("Alt+roda dá zoom mesmo com o passo de trackpad, e vale o eixo que tiver valor", () => {
    const small = wheelIntent(wheel({ altKey: true, deltaY: 4.5 }));
    expect(small.kind === "zoom" && small.factor < 1).toBe(true);
    const swapped = wheelIntent(wheel({ altKey: true, deltaX: -80, deltaY: 0 }));
    expect(swapped.kind === "zoom" && swapped.factor > 1).toBe(true);
  });

  test("pinça do trackpad (Ctrl com delta pequeno) pesa mais que Ctrl+roda de mouse (entalhe de 100)", () => {
    const pinch = wheelIntent(wheel({ ctrlKey: true, deltaY: -4.2 }));
    const notch = wheelIntent(wheel({ ctrlKey: true, deltaY: -100 }));
    expect(pinch.kind === "zoom" && notch.kind === "zoom").toBe(true);
    if (pinch.kind !== "zoom" || notch.kind !== "zoom") return;
    expect(pinch.factor).toBeGreaterThan(1);
    expect(Math.log(pinch.factor) / 4.2).toBeGreaterThan(Math.log(notch.factor) / 100);
  });

  test("zoom pela roda respeita os limites e mantém o ponto sob o cursor", () => {
    const cam = { x: 0, y: 0, k: CAMERA_LIMITS.zoomMax };
    const cursor = { x: 10, y: 10 };
    const next = wheelCamera(cam, wheel({ ctrlKey: true, deltaY: -50 }), cursor);
    expect(next.k).toBe(CAMERA_LIMITS.zoomMax);
    closeVec(screenToWorld(next, cursor), screenToWorld(cam, cursor));
  });

  test("evento sem delta não mexe a câmera", () => {
    const cam = { x: 3, y: 4, k: 1.2 };
    expect(wheelCamera(cam, wheel({}), { x: 0, y: 0 })).toEqual({ x: 3 - 0, y: 4 - 0, k: 1.2 });
  });
});

describe("canvas-camera: rolagem que é do campo de texto", () => {
  test("com curso na direção da roda, o elemento rola; no fim do curso, a roda volta para o canvas", () => {
    expect(hasScrollRoom(0, 100, 300, 40)).toBe(true);
    expect(hasScrollRoom(0, 100, 300, -40)).toBe(false);
    expect(hasScrollRoom(200, 100, 300, 40)).toBe(false);
    expect(hasScrollRoom(200, 100, 300, -40)).toBe(true);
  });

  test("elemento que não transborda, ou roda sem delta, nunca é dono da roda", () => {
    expect(hasScrollRoom(0, 100, 100, 40)).toBe(false);
    expect(hasScrollRoom(0, 100, 99, -40)).toBe(false);
    expect(hasScrollRoom(50, 100, 300, 0)).toBe(false);
  });
});

describe("canvas-camera: teclas com Ctrl", () => {
  test("= e + aproximam, - e _ afastam, 0 volta a 100%, outra tecla não é de câmera", () => {
    expect(cameraChord("=")).toEqual(cameraChord("+"));
    expect(cameraChord("-")).toEqual(cameraChord("_"));
    const zin = cameraChord("=");
    const zout = cameraChord("-");
    expect(zin?.kind === "zoom" && zin.factor > 1).toBe(true);
    expect(zout?.kind === "zoom" && zout.factor < 1).toBe(true);
    expect(cameraChord("0")).toEqual({ kind: "reset" });
    expect(cameraChord("a")).toBeUndefined();
    expect(cameraChord("ArrowUp")).toBeUndefined();
  });
});

describe("canvas-camera: passos, 100% e nível de zoom", () => {
  test("um passo de zoom mantém o centro da tela parado e subir e descer volta ao ponto de partida", () => {
    const cam = { x: -120, y: 75, k: 0.9 };
    const centre = { x: VIEW.w / 2, y: VIEW.h / 2 };
    const under = screenToWorld(cam, centre);
    const up = zoomStep(cam, VIEW, 1);
    expect(up.k).toBeCloseTo(0.9 * CAMERA_LIMITS.keyZoomStep, 12);
    closeVec(screenToWorld(up, centre), under);
    const back = zoomStep(up, VIEW, -1);
    close(back.k, cam.k);
    close(back.x, cam.x);
    close(back.y, cam.y);
  });

  test("100% leva a escala a 1 sem mover o centro da tela", () => {
    const cam = { x: 400, y: -90, k: 0.3 };
    const centre = { x: VIEW.w / 2, y: VIEW.h / 2 };
    const reset = zoomReset(cam, VIEW);
    expect(reset.k).toBe(1);
    closeVec(screenToWorld(reset, centre), screenToWorld(cam, centre));
  });

  test("o nível sai arredondado em porcentagem e os botões desligam nos limites", () => {
    expect(zoomLabel(1)).toBe("100%");
    expect(zoomLabel(0.125)).toBe("13%");
    expect(zoomLabel(CAMERA_LIMITS.zoomMin)).toBe("5%");
    expect(canZoom(CAMERA_LIMITS.zoomMax, 1)).toBe(false);
    expect(canZoom(CAMERA_LIMITS.zoomMax, -1)).toBe(true);
    expect(canZoom(CAMERA_LIMITS.zoomMin, -1)).toBe(false);
    expect(canZoom(1, 1) && canZoom(1, -1)).toBe(true);
  });
});

describe("canvas-camera: focar e zoom na seleção", () => {
  const node: Rect = { x: 1000, y: 500, w: 200, h: 66 };
  const centreOf = (r: Rect): Vec => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

  test("focar um nó o centraliza e sobe o zoom até o detalhe completo, sem passar do que cabe", () => {
    const far = focusNodeCamera({ x: 0, y: 0, k: 0.1 }, node, VIEW);
    expect(far.k).toBe(DETAIL_THRESHOLDS.full);
    closeVec(worldToScreen(far, centreOf(node)), { x: VIEW.w / 2, y: VIEW.h / 2 });
  });

  test("focar quem já está perto não afasta: a escala se mantém", () => {
    const near = focusNodeCamera({ x: 0, y: 0, k: 1.2 }, node, VIEW);
    expect(near.k).toBe(1.2);
    closeVec(worldToScreen(near, centreOf(node)), { x: VIEW.w / 2, y: VIEW.h / 2 });
  });

  test("nó maior que a tela vira enquadrar: a escala cai até caber", () => {
    const huge: Rect = { x: 0, y: 0, w: 5000, h: 3000 };
    const cam = focusNodeCamera({ x: 0, y: 0, k: 1 }, huge, VIEW);
    expect(cam.k).toBeCloseTo(fitRect(huge, VIEW).k, 12);
    expect(cam.k).toBeLessThan(DETAIL_THRESHOLDS.full);
  });

  test("zoom na seleção enquadra a caixa de todos os selecionados, centralizada e com folga", () => {
    const rects: Rect[] = [{ x: 0, y: 0, w: 300, h: 100 }, { x: 1500, y: 700, w: 300, h: 100 }];
    const cam = fitSelectionCamera(rects, VIEW) as Camera;
    expect(cam).toEqual(fitRect({ x: 0, y: 0, w: 1800, h: 800 }, VIEW));
    for (const r of rects) {
      const tl = worldToScreen(cam, { x: r.x, y: r.y });
      const br = worldToScreen(cam, { x: r.x + r.w, y: r.y + r.h });
      expect(tl.x).toBeGreaterThanOrEqual(CAMERA_LIMITS.fitPadding - 1e-9);
      expect(br.y).toBeLessThanOrEqual(VIEW.h - CAMERA_LIMITS.fitPadding + 1e-9);
    }
  });

  test("um nó só não enche a tela: o zoom da seleção para em focusZoomMax, com o nó no centro", () => {
    const cam = fitSelectionCamera([node], VIEW) as Camera;
    expect(cam.k).toBe(CAMERA_LIMITS.focusZoomMax);
    expect(fitRect(node, VIEW).k).toBeGreaterThan(CAMERA_LIMITS.focusZoomMax);
    closeVec(worldToScreen(cam, centreOf(node)), { x: VIEW.w / 2, y: VIEW.h / 2 });
  });

  test("sem seleção não há câmera: quem chama decide (o motor cai em enquadrar tudo)", () => {
    expect(fitSelectionCamera([], VIEW)).toBeUndefined();
  });

  test("seleção enorme respeita o zoom mínimo", () => {
    expect((fitSelectionCamera([{ x: 0, y: 0, w: 1e7, h: 1e7 }], VIEW) as Camera).k).toBe(CAMERA_LIMITS.zoomMin);
  });
});

describe("canvas-camera: comandos no registro de comandos", () => {
  const calls: string[] = [];
  const handlers = {
    zoomIn: () => calls.push("in"),
    zoomOut: () => calls.push("out"),
    zoomReset: () => calls.push("reset"),
    fitSelection: () => calls.push("selection"),
    focusNode: () => calls.push("focus"),
  };
  const ctx = (selectedLabel: string | null): CameraCommandCtx => ({ selectedLabel, handlers });
  const build = () => {
    const registry = createCommandRegistry<CameraCommandCtx>();
    for (const def of cameraCommandDefs<CameraCommandCtx>()) registry.register(def);
    return registry;
  };

  test("os cinco comandos entram no registro sem conflito de atalho e aparecem na paleta, no menu do fundo e na ajuda", () => {
    const registry = build();
    expect(registry.list().map((d) => d.id)).toEqual([...CAMERA_COMMAND_IDS]);
    const selected = ctx("agente-1");
    expect(registry.palette(selected).map((e) => e.id)).toEqual([...CAMERA_COMMAND_IDS]);
    expect(registry.canvasMenu(selected).map((e) => e.id)).toEqual([...CAMERA_COMMAND_IDS]);
    expect(registry.help(selected).map((e) => e.id)).toEqual([...CAMERA_COMMAND_IDS]);
  });

  test("zoom na seleção e focar só valem com um nó selecionado; o rótulo de focar leva o nome", () => {
    const registry = build();
    expect(registry.palette(ctx(null)).map((e) => e.id)).toEqual(["zoom-in", "zoom-out", "zoom-reset"]);
    const focus = registry.palette(ctx("agente-1")).find((e) => e.id === "focus-node");
    expect(focus?.label).toBe("Focar em agente-1");
    const long = registry.palette(ctx("x".repeat(200))).find((e) => e.id === "focus-node");
    expect((long?.label.length ?? 0)).toBeLessThanOrEqual("Focar em ".length + 60);
  });

  test("Ctrl+=, Ctrl++, Ctrl+-, Ctrl+0, z e c disparam o comando certo; com o foco num campo de texto o zoom é do navegador", () => {
    const registry = build();
    const state = (editable: boolean, label: string | null) => ({ editable, ctx: ctx(label) });
    const fire = (key: string, extra: { ctrlKey?: boolean }, editable = false, label: string | null = "n"): string | undefined => {
      const def = registry.resolveKey({ key, ...extra }, state(editable, label));
      def?.run(ctx(label));
      return def?.id;
    };
    expect(fire("=", { ctrlKey: true })).toBe("zoom-in");
    expect(fire("+", { ctrlKey: true })).toBe("zoom-in");
    expect(fire("-", { ctrlKey: true })).toBe("zoom-out");
    expect(fire("0", { ctrlKey: true })).toBe("zoom-reset");
    expect(fire("z", {})).toBe("zoom-selection");
    expect(fire("c", {})).toBe("focus-node");
    expect(calls).toEqual(["in", "in", "out", "reset", "selection", "focus"]);
    expect(fire("=", { ctrlKey: true }, true)).toBeUndefined();
    expect(fire("z", {}, true)).toBeUndefined();
    expect(fire("z", {}, false, null)).toBeUndefined();
  });

  test("os atalhos da câmera não colidem com os comandos que a página registra hoje", () => {
    // registrar em conjunto com os comandos reais do Argos: conflito de acorde lançaria shortcut_conflict
    const registry = createCommandRegistry<ArgosCommandCtx & CameraCommandCtx>();
    const argos = argosCommandDefs({ actions: [{ id: "approve_permission", label: "Aprovar", hint: "" }, { id: "prompt", label: "Prompt", hint: "" }], stateFilters: [] });
    for (const def of argos) registry.register(def as CommandDef<ArgosCommandCtx & CameraCommandCtx>);
    for (const def of cameraCommandDefs<ArgosCommandCtx & CameraCommandCtx>()) registry.register(def);
    expect(registry.list().length).toBe(argos.length + CAMERA_COMMAND_IDS.length);
  });
});

describe("câmera de abertura", () => {
  const view = { w: 1200, h: 700 };
  const box = (x: number, y: number) => ({ x, y, w: 200, h: 66 });

  test("dado grafo enorme, então a escala nunca fica abaixo do piso de 0,6", () => {
    const many = Array.from({ length: 400 }, (_, i) => box((i % 20) * 300, Math.floor(i / 20) * 120));
    expect(openingCamera(many, view)?.k).toBe(OPENING_MIN_SCALE);
    expect(OPENING_MIN_SCALE).toBe(0.6);
  });

  test("dado grafo pequeno, então tudo cabe à vista acima do piso", () => {
    expect(openingCamera([box(0, 0), box(300, 0)], view)?.k).toBeGreaterThanOrEqual(OPENING_MIN_SCALE);
  });

  test("dado sem nó ou sem área, então não há câmera", () => {
    expect(openingCamera([], view)).toBeUndefined();
    expect(openingCamera([box(0, 0)], { w: 0, h: 700 })).toBeUndefined();
  });
});
