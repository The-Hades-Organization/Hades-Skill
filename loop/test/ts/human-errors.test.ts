// Erros que se explicam (reference/erros.md): o catálogo cobre os códigos estáveis do inventário prioritário, cada entrada
// aponta uma seção que existe, o texto não vaza caminho nem pilha, e as três bordas (CLI, painel, componente) usam o catálogo.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { explainCommand } from "../../../src/commands/explain.ts";
import { CANVAS_CLI_ERRORS } from "../../../src/commands/canvas.ts";
import { ARGOS_ERRORS } from "../../../src/lib/argos.ts";
import { CANVAS_ERRORS } from "../../../src/lib/canvas-doc.ts";
import { LINK_ERRORS } from "../../../src/lib/canvas-links.ts";
import { RECRUIT_ERRORS } from "../../../src/lib/canvas-recruit.ts";
import { CANVAS_STORE_ERRORS, SAVE_ERRORS } from "../../../src/lib/canvas-store.ts";
import {
  CLI_ERRORS, CLIENT_ERRORS, HOOK_ERRORS, HUMAN_ERRORS, PANEL_ERRORS, cliCodeOfExit, explain, knownCodes, messageOfCliFailure,
  renderCli, renderEntry, renderHook, suggestName,
} from "../../../src/lib/human-errors.ts";
import { send } from "../../../src/panel/http.ts";
import { FILES_ERRORS } from "../../../src/panel/canvas-files.ts";
import { DRAWING_ROUTE_ERRORS } from "../../../src/panel/canvas-drawings.ts";
import { NOTE_ROUTE_ERRORS } from "../../../src/panel/canvas-notes.ts";
import { PORTAL_ROUTE_ERRORS } from "../../../src/panel/canvas-portal.ts";
import { CARONTE_ERRORS } from "../../../src/panel/caronte.ts";
import { SIZE_ERRORS } from "../../../src/panel/herdr-page.ts";
import { SOCKET_ERRORS } from "../../../src/panel/herdr.ts";
import { SUPERVISOR_ERRORS } from "../../../src/panel/argos-supervisor.ts";

const ROOT = join(import.meta.dir, "../../..");

/** Códigos do painel que a rota monta em literal (sem enum): widget, plugin e APK. */
const LITERAL_CODES = ["widget_off", "widget_token", "widget_token_scope", "widget_local_only", "widget_rate_limited", "apk_missing", "plugin_not_found", "plugin_local_only", "plugin_error"];

const PRIORITY: Record<string, readonly string[]> = {
  CANVAS_ERRORS: Object.values(CANVAS_ERRORS),
  CANVAS_STORE_ERRORS: Object.values(CANVAS_STORE_ERRORS),
  SAVE_ERRORS: Object.values(SAVE_ERRORS),
  SUPERVISOR_ERRORS: Object.values(SUPERVISOR_ERRORS),
  CARONTE_ERRORS: Object.values(CARONTE_ERRORS),
  ARGOS_ERRORS: Object.values(ARGOS_ERRORS),
  FILES_ERRORS: Object.values(FILES_ERRORS),
  SOCKET_ERRORS: Object.values(SOCKET_ERRORS),
  SIZE_ERRORS: Object.values(SIZE_ERRORS),
  NOTE_ROUTE_ERRORS: Object.values(NOTE_ROUTE_ERRORS),
  DRAWING_ROUTE_ERRORS: Object.values(DRAWING_ROUTE_ERRORS),
  PORTAL_ROUTE_ERRORS: Object.values(PORTAL_ROUTE_ERRORS),
  PANEL_ERRORS: Object.values(PANEL_ERRORS),
  CLI_ERRORS: Object.values(CLI_ERRORS),
  CLIENT_ERRORS: Object.values(CLIENT_ERRORS),
  HOOK_ERRORS: Object.values(HOOK_ERRORS),
  CANVAS_CLI_ERRORS: Object.values(CANVAS_CLI_ERRORS),
  RECRUIT_ERRORS: Object.values(RECRUIT_ERRORS),
  LINK_ERRORS: [LINK_ERRORS.noReader, LINK_ERRORS.selfLoop, LINK_ERRORS.duplicateLink, LINK_ERRORS.limitExceeded],
  LITERAIS: LITERAL_CODES,
};

describe("catálogo: cobertura do inventário prioritário", () => {
  for (const [grupo, codes] of Object.entries(PRIORITY)) {
    test(`dado ${grupo}, então cada código tem entrada própria`, () => {
      const sem = codes.filter((code) => !explain(code).known);
      expect(sem).toEqual([]);
    });
  }
});

describe("catálogo: forma das entradas", () => {
  const entries = Object.entries(HUMAN_ERRORS);

  test("dado qualquer entrada, então título, causa, ação e referência vêm preenchidos", () => {
    const vazias = entries.filter(([, e]) => [e.title, e.cause, e.action, e.ref].some((text) => text.trim() === ""));
    expect(vazias.map(([code]) => code)).toEqual([]);
  });

  test("dado qualquer entrada, então o texto não leva pilha nem caminho absoluto da máquina", () => {
    const vazando = entries.filter(([, e]) => /\bat \S+\.(ts|js):\d+|\/home\/|\/Users\/|node_modules|Bearer |token=/.test(`${e.title} ${e.cause} ${e.action}`));
    expect(vazando.map(([code]) => code)).toEqual([]);
  });

  test("dado qualquer entrada, então a referência é reference/<arquivo>.md §<seção> e a seção existe no arquivo", () => {
    const quebradas: string[] = [];
    for (const [code, e] of entries) {
      const m = /^(reference\/[\w/-]+\.md) §(.+)$/.exec(e.ref);
      const file = m?.[1];
      const section = m?.[2];
      if (file === undefined || section === undefined || !existsSync(join(ROOT, file))) {
        quebradas.push(`${code}: ${e.ref}`);
        continue;
      }
      const headings = readFileSync(join(ROOT, file), "utf8").split("\n").filter((l) => l.startsWith("#")).map((l) => l.replace(/^#+\s*/, ""));
      if (!headings.some((h) => h === section || h.startsWith(section))) quebradas.push(`${code}: ${e.ref}`);
    }
    expect(quebradas).toEqual([]);
  });

  test("dado qualquer entrada, então o comando entre crases da ação parece um comando de verdade", () => {
    const estranhos = entries.flatMap(([code, e]) => [...e.action.matchAll(/`(hades [^`]+)`/g)].map((m) => [code, m[1] ?? ""] as const)).filter(([, cmd]) => /[{}]/.test(cmd));
    expect(estranhos).toEqual([]);
  });

  test("dado o catálogo, então knownCodes lista tudo em ordem alfabética", () => {
    const codes = knownCodes();
    expect(codes).toEqual([...codes].sort());
    expect(codes.length).toBe(entries.length);
  });
});

describe("explain: fallback", () => {
  test("dado um código sem entrada, então mostra o código, aponta o doctor e não vira entrada conhecida", () => {
    const e = explain("codigo_que_ninguem_escreveu");
    expect([e.known, e.code]).toEqual([false, "codigo_que_ninguem_escreveu"]);
    expect(e.cause).toContain("codigo_que_ninguem_escreveu");
    expect(e.action).toContain("hades doctor");
  });

  test("dado nenhum código, então vale a falha genérica da CLI", () => {
    expect(explain(undefined).code).toBe(CLI_ERRORS.failed);
  });

  test("dado um nome herdado do protótipo, então não confunde com entrada", () => {
    expect(explain("constructor").known).toBe(false);
    expect(explain("__proto__").known).toBe(false);
  });
});

describe("CLI: renderCli e messageOfCliFailure", () => {
  test("dado uma mensagem e um código, então a primeira linha é a mensagem e o bloco traz causa, ação, referência e código", () => {
    const lines = renderCli("faltou nome do agente", CLI_ERRORS.agentNameMissing).split("\n");
    expect(lines[0]).toBe("hades: faltou nome do agente");
    expect(lines.slice(1).map((l) => l.trim().split(":")[0])).toEqual(["Por quê", "O que fazer", "Saiba mais", "(código"]);
  });

  test("dado um prefixo, então ele troca o 'hades'", () => {
    expect(renderCli("x", CLI_ERRORS.usage, "hades canvas").startsWith("hades canvas: x\n")).toBe(true);
  });

  test("dado o stderr com o bloco, então a mensagem é a linha antes das indentadas", () => {
    expect(messageOfCliFailure(`${renderCli("não achei o pane", CLI_ERRORS.failed)}\n`)).toBe("hades: não achei o pane");
  });

  test("dado o stderr sem bloco, então vale a última linha, como sempre foi", () => {
    expect(messageOfCliFailure("aviso\nfalhou de verdade\n")).toBe("falhou de verdade");
  });

  test("dado stderr vazio, então a mensagem é vazia", () => {
    expect(messageOfCliFailure("  \n")).toBe("");
  });

  test.each([[2, CLI_ERRORS.usage], [3, CLI_ERRORS.noProfile], [4, CLI_ERRORS.outsideRepo], [69, CLI_ERRORS.missingDependency], [75, CLI_ERRORS.gateNotAdmitted], [1, CLI_ERRORS.failed], [77, CLI_ERRORS.failed]])(
    "dado a saída %i, então o código padrão é %s",
    (exit, code) => expect(cliCodeOfExit(exit)).toBe(code),
  );

  test("dado um código conhecido, então renderEntry traz o catálogo sem mensagem de runtime", () => {
    const text = renderEntry(CLI_ERRORS.noProfile);
    expect(text).toContain(`Código:       ${CLI_ERRORS.noProfile}`);
    expect(text.split("\n")[0]).toBe(explain(CLI_ERRORS.noProfile).title);
  });
});

describe("hades explain", () => {
  function roda(args: string[]): { rc: number; saida: string } {
    const antes = process.stdout.write.bind(process.stdout);
    let saida = "";
    process.stdout.write = ((chunk: string | Uint8Array) => ((saida += String(chunk)), true)) as typeof process.stdout.write;
    try {
      return { rc: explainCommand(args), saida };
    } finally {
      process.stdout.write = antes;
    }
  }

  test("dado um código conhecido, então sai 0 com a explicação", () => {
    const r = roda([CLI_ERRORS.noProfile]);
    expect([r.rc, r.saida.includes("O que fazer:")]).toEqual([0, true]);
  });

  test("dado um código desconhecido, então sai 1 com o fallback", () => {
    const r = roda(["nao_existe"]);
    expect([r.rc, r.saida.includes("nao_existe")]).toEqual([1, true]);
  });

  test("dado nenhum argumento, então lista todos os códigos", () => {
    const r = roda([]);
    expect([r.rc, r.saida.includes(`(${knownCodes().length})`)]).toEqual([0, true]);
  });

  test("dado argumento demais, então é erro de uso", () => {
    expect(roda(["a", "b"]).rc).toBe(2);
  });
});

describe("hook: renderHook", () => {
  test("dado a recusa, então a primeira linha é o que foi barrado e o bloco diz o que fazer no lugar", () => {
    const text = renderHook("hades-guard: polling barrado (sleep).", HOOK_ERRORS.pollingBlocked);
    const lines = text.trimEnd().split("\n");
    expect(lines[0]).toBe("hades-guard: polling barrado (sleep).");
    expect(text).toContain("O que fazer no lugar:");
    expect(text.endsWith("\n")).toBe(true);
  });

  test("dado uma ação própria, então ela troca a do catálogo", () => {
    expect(renderHook("x", HOOK_ERRORS.pollingBlocked, "rode hades wait proc 'x'")).toContain("rode hades wait proc 'x'");
  });
});

describe("painel: send anexa explain", () => {
  async function corpo(status: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return (await send(status, body).json()) as Record<string, unknown>;
  }

  test("dado status de erro com code, então o corpo ganha explain e mantém o resto", async () => {
    const body = await corpo(409, { error: "nota recusada", code: NOTE_ROUTE_ERRORS.staleRevision });
    expect(body.error).toBe("nota recusada");
    expect(body.code).toBe(NOTE_ROUTE_ERRORS.staleRevision);
    expect((body.explain as { code: string }).code).toBe(NOTE_ROUTE_ERRORS.staleRevision);
  });

  test("dado sucesso, então não leva explain", async () => {
    expect((await corpo(200, { ok: true, code: "x" })).explain).toBeUndefined();
  });

  test("dado erro sem code, então não inventa explain", async () => {
    expect((await corpo(500, { error: "falhou" })).explain).toBeUndefined();
  });

  test("dado code fora do catálogo, então o explain é o fallback", async () => {
    const e = (await corpo(400, { error: "x", code: "sem_entrada" })).explain as { code: string; title: string };
    expect(e.code).toBe("sem_entrada");
    expect(e.title).toContain("ainda não tem explicação");
  });
});

describe("sugestão de subcomando", () => {
  const nomes = ["install", "doctor", "panel", "explain"];

  test("dado um erro de digitação, então sugere o nome mais perto", () => {
    expect(suggestName("doctr", nomes)).toBe("doctor");
    expect(suggestName("explian", nomes)).toBe("explain");
  });

  test("dado um nome sem parecido, então não sugere nada", () => {
    expect(suggestName("descobrir", nomes)).toBeUndefined();
  });

  test("dado nome vazio, então não sugere nada", () => {
    expect(suggestName("", nomes)).toBeUndefined();
  });
});

// ------------------------------------------------------------------ componente do painel (kit/panel/ui/parts/erro.tsx)

interface View { message: string; title: string; cause: string; action: string; ref: string; code: string; command: string; known: boolean }
interface Parts {
  erroView(input: unknown): View;
  firstCommand(action: string): string;
  UNREACHABLE: { code: string; title: string; cause: string; action: string; ref: string };
  ErroExplicado(props: { error: unknown; title?: string; onRetry?: () => void }): unknown;
}

function carregaParts(): Parts {
  const src = readFileSync(join(ROOT, "kit/panel/ui/parts/erro.tsx"), "utf8");
  const js = new Bun.Transpiler({ loader: "tsx", tsconfig: { compilerOptions: { jsx: "react" } } }).transformSync(src);
  const holder = globalThis as unknown as { HadesParts?: Parts; HadesCore?: unknown };
  const anterior = holder.HadesParts;
  new Function("React", js)({ createElement: () => null });
  const parts = holder.HadesParts as Parts;
  holder.HadesParts = anterior;
  return parts;
}

const parts = carregaParts();

describe("componente: erroView", () => {
  test("dado o espelho de panel_unreachable, então é igual à entrada do catálogo", () => {
    const { code, title, cause, action, ref } = parts.UNREACHABLE;
    const { title: t, cause: c, action: a, ref: r } = explain(code);
    expect({ title, cause, action, ref }).toEqual({ title: t, cause: c, action: a, ref: r });
  });

  test("dado um Error com explain, então a visão traz o texto do explain e o comando para copiar", () => {
    const e = Object.assign(new Error("nota recusada"), { code: "x", explain: { code: "x", title: "T", cause: "C", action: "Rode `hades doctor --quick` agora", ref: "reference/erros.md §Como funciona" } });
    expect(parts.erroView(e)).toMatchObject({ message: "nota recusada", title: "T", cause: "C", command: "hades doctor --quick", code: "x", known: true });
  });

  test("dado TypeError de rede, então vira o texto de painel não respondeu", () => {
    const v = parts.erroView(new TypeError("Failed to fetch"));
    expect([v.code, v.known]).toEqual(["panel_unreachable", true]);
  });

  test("dado SyntaxError (resposta que não é JSON), então também é painel não respondeu", () => {
    expect(parts.erroView(new SyntaxError("Unexpected token <")).code).toBe("panel_unreachable");
  });

  test("dado uma string, então ela é a mensagem e o resto é genérico", () => {
    const v = parts.erroView("deu ruim");
    expect([v.message, v.known, v.command]).toEqual(["deu ruim", false, "hades doctor"]);
  });

  test("dado nada, então não quebra e usa o título como mensagem", () => {
    const v = parts.erroView(undefined);
    expect(v.message).toBe(v.title);
  });

  test("dado o corpo de uma resposta ({error, code}), então a mensagem sai de error", () => {
    expect(parts.erroView({ error: "recusado", code: "abc" })).toMatchObject({ message: "recusado", code: "abc", known: false });
  });
});

describe("componente: firstCommand", () => {
  test("dado uma ação com vários trechos, então vale o primeiro que começa por programa da Hades", () => {
    expect(parts.firstCommand("Veja `Configurações` e rode `hades doctor` ou `git status`")).toBe("hades doctor");
  });

  test("dado uma ação sem comando, então é vazio", () => {
    expect(parts.firstCommand("Recarregue a página.")).toBe("");
  });
});

describe("componente: ErroExplicado (marcação)", () => {
  type Node = { type: unknown; props: Record<string, unknown> };
  function renderiza(props: Parameters<Parts["ErroExplicado"]>[0]): string {
    const React = {
      createElement: (type: unknown, p: Record<string, unknown> | null, ...kids: unknown[]): Node => ({ type, props: { ...(p ?? {}), children: kids } }),
      Fragment: "frag",
    };
    const src = readFileSync(join(ROOT, "kit/panel/ui/parts/erro.tsx"), "utf8");
    const js = new Bun.Transpiler({ loader: "tsx", tsconfig: { compilerOptions: { jsx: "react" } } }).transformSync(src);
    const holder = globalThis as unknown as { HadesParts?: Parts; HadesCore?: unknown };
    const anterior = { parts: holder.HadesParts, core: holder.HadesCore };
    const nome = (name: string) => (p: { children?: unknown; label?: string; text?: string }) => ({ type: name, props: { ...p, children: [p.children] } });
    holder.HadesCore = {
      I: new Proxy({}, { get: (_t, name) => nome(`icone-${String(name)}`) }),
      Button: nome("Button"), CopyButton: nome("CopyButton"), Mono: nome("Mono"),
    };
    try {
      new Function("React", js)(React);
      return texto(((holder.HadesParts as Parts).ErroExplicado as (p: typeof props) => unknown)(props));
    } finally {
      holder.HadesParts = anterior.parts;
      holder.HadesCore = anterior.core;
    }
  }
  function texto(node: unknown): string {
    if (node === null || node === undefined || typeof node === "boolean") return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(texto).join("");
    const n = node as Node;
    if (typeof n.type === "function") return texto((n.type as (p: unknown) => unknown)(n.props));
    const own = n.props ?? {};
    const marcas = [typeof own.role === "string" ? `[role=${own.role}]` : "", own.text ? `[copia:${String(own.text)}]` : "", typeof n.type === "string" && n.type === "Button" ? "[botão]" : ""];
    return marcas.join("") + texto(own.children);
  }

  test("dado um erro com explain e onRetry, então mostra por quê, o que fazer, referência, código, copiar e tentar de novo", () => {
    const html = renderiza({
      error: Object.assign(new Error("recusou"), { explain: { code: "k", title: "Titulo", cause: "porque sim", action: "Rode `hades doctor`", ref: "reference/erros.md §Como funciona" } }),
      onRetry: () => undefined,
    });
    for (const parte of ["[role=alert]", "Titulo", "recusou", "porque sim", "hades doctor", "[copia:hades doctor]", "reference/erros.md", "k", "[botão]"]) expect(html).toContain(parte);
  });

  test("dado um erro sem onRetry, então não oferece tentar de novo", () => {
    expect(renderiza({ error: "x" })).not.toContain("[botão]");
  });
});
