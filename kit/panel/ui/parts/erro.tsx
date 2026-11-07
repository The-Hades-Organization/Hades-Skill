/* Erro que se explica (reference/erros.md §No painel): título, o que aconteceu, por quê, o que fazer (com o comando para copiar)
 * e onde ler mais. Serve a qualquer página: window.HadesParts.ErroExplicado, também em HadesCore.ErroExplicado.
 *
 *   <ErroExplicado error={e} title="Não foi possível ler o Cerberus" onRetry={load} />
 *
 * `error` é o que a página tiver: Error de post()/fetch (leva `explain` e `code` quando o painel respondeu), o corpo `{ error,
 * code, explain }` de uma resposta, ou só uma string. Sem `explain`, rede caída e resposta que não é JSON viram o texto de
 * `panel_unreachable` (espelho de src/lib/human-errors-catalog.ts, conferido por teste) e o resto mostra só a mensagem.
 * A regra (erroView) não toca DOM nem React: o navegador a carrega junto e o bun test importa o mesmo arquivo. */

(() => {
interface ErroExplain {
  code?: string;
  title?: string;
  cause?: string;
  action?: string;
  ref?: string;
}
interface ErroView {
  /** O que aconteceu: a mensagem original, ou o título da explicação. */
  message: string;
  title: string;
  cause: string;
  action: string;
  ref: string;
  code: string;
  /** Primeiro comando entre crases da ação (`hades doctor`), para o botão de copiar. */
  command: string;
  known: boolean;
}

const UNREACHABLE: Required<ErroExplain> = {
  code: "panel_unreachable",
  title: "O painel não respondeu",
  cause: "O navegador não conseguiu falar com o painel: ele pode estar parado, reiniciando, ou a conexão (túnel, rede) caiu.",
  action: "Espere alguns segundos e tente de novo. Se continuar, rode `hades doctor --quick` na máquina: ele diz se o painel está de pé e como religá-lo.",
  ref: "reference/panel.md §Páginas",
};
const GENERIC: Required<ErroExplain> = {
  code: "",
  title: "Algo falhou",
  cause: "O painel devolveu um erro sem explicação própria; a mensagem acima é o que se sabe.",
  action: "Recarregue a página. Se persistir, rode `hades doctor` para ver se falta algo na máquina.",
  ref: "reference/erros.md §Como acrescentar uma entrada",
};
const NETWORK_FAILURE = /failed to fetch|networkerror|load failed|network request failed/i;

/** Primeiro comando entre crases que começa por um programa da Hades; vazio se não houver. */
function firstCommand(action: string): string {
  for (const m of action.matchAll(/`([^`]+)`/g)) {
    const text = m[1] ?? "";
    if (/^(hades|bun|bash|systemctl|docker|gh|git)\s/.test(text)) return text;
  }
  return "";
}

function erroView(input: unknown): ErroView {
  const raw = (input ?? {}) as { message?: unknown; error?: unknown; code?: unknown; explain?: ErroExplain; name?: unknown };
  const original = typeof input === "string" ? input : String(raw.message ?? raw.error ?? "");
  const code = typeof raw.code === "string" ? raw.code : "";
  const unreachable = raw.name === "TypeError" ? NETWORK_FAILURE.test(original) : raw.name === "SyntaxError" || code === UNREACHABLE.code;
  const from = raw.explain ?? (unreachable ? UNREACHABLE : undefined);
  const e = { ...GENERIC, ...from };
  // "JSON.parse: unexpected character" e "Failed to fetch" são texto do navegador: o "Por quê" já diz o que houve
  const message = from === UNREACHABLE ? "" : original;
  return {
    message: message || e.title,
    title: e.title,
    cause: e.cause,
    action: e.action,
    ref: e.ref,
    code: e.code || code,
    command: firstCommand(e.action),
    known: from !== undefined,
  };
}

/** Trechos entre crases viram `Mono`; o resto segue como texto. */
function comCodigo(text: string, Mono: PanelComponent): ReactNode[] {
  return text.split(/(`[^`]+`)/).filter(Boolean).map((part, i) => (part.startsWith("`") ? <Mono key={i}>{part.slice(1, -1)}</Mono> : part));
}

interface ErroProps {
  error: unknown;
  /** Título da página para a falha ("Não foi possível ler o Cerberus"); sem ele vale o da explicação. */
  title?: string;
  onRetry?: () => void;
}

function ErroExplicado({ error, title, onRetry }: ErroProps) {
  const { I, Button, CopyButton, Mono } = HadesCore;
  const v = erroView(error);
  const heading = title ?? v.title;
  const showMessage = v.message !== heading && v.message !== v.title;
  return <div role="alert" className="grid min-w-0 justify-items-start gap-1.5 py-3 t-body">
    <div className="flex items-baseline gap-2">
      <I.CircleX className="size-4 shrink-0 translate-y-0.5 text-destructive" aria-hidden="true" />
      <span className="min-w-0 break-words font-medium">{heading}</span>
    </div>
    {showMessage ? <p className="min-w-0 break-words text-muted-foreground">{v.message}</p> : null}
    <p className="min-w-0 break-words"><span className="font-medium">Por quê: </span>{comCodigo(v.cause, Mono)}</p>
    <div className="flex min-w-0 flex-wrap items-center gap-x-2">
      <p className="min-w-0 break-words"><span className="font-medium">O que fazer: </span>{comCodigo(v.action, Mono)}</p>
      {v.command ? <CopyButton text={v.command} label="Copiar o comando" /> : null}
    </div>
    <p className="t-label min-w-0 break-words text-muted-foreground">
      Saiba mais em <Mono>{v.ref}</Mono>{v.code ? <> · código <Mono>{v.code}</Mono></> : null}
    </p>
    {onRetry ? <Button size="sm" variant="outline" icon={I.RotateCw} onClick={onRetry}>Tentar de novo</Button> : null}
  </div>;
}

const partsGlobal = globalThis as unknown as { HadesParts?: Record<string, unknown> };
partsGlobal.HadesParts = { ...partsGlobal.HadesParts, ErroExplicado, erroView, firstCommand, UNREACHABLE };
})();
