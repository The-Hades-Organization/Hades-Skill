/* Regra pura do Terminal do painel: retomada por offset, recuo da reconexão, decisão por código de fechamento e de recusa,
 * colar grande partido no limite do quadro. Sem DOM, sem React e sem xterm: o navegador carrega como script
 * (window.TermLogic, antes do term.js) e o bun test importa o mesmo arquivo. Os números espelham
 * src/panel/term-protocol.ts (o teste confere os dois lados). Contrato: reference/panel.md §Terminal › Interface. */

type TermCloseAction = "reconnect" | "stop";
/** Por que o socket não volta sozinho (ou "drop": caiu, volta). */
type TermCloseReason = "exited" | "replaced" | "closed" | "expired" | "shutdown" | "protocol" | "drop";
interface TermCloseDecision { action: TermCloseAction; reason: TermCloseReason }
/** Offset absoluto: `base` é o do primeiro byte binário depois do último hello/warn com offset, `got` o que veio desde então. */
interface TermOffsetState { base: number | null; got: number }
interface TermHelloLike { offset: number }
interface TermWarnLike { code: string; offset?: number; lost?: number }
type TermRefusalKind = "disabled" | "limit" | "rate" | "cwd" | "kind" | "unknown_session" | "origin" | "failed" | "request";
interface TermRefusal { kind: TermRefusalKind; title: string; hint: string; retryAfterS?: number }
/** Mesa da página Herdr: abas (ids de sessão), a ativa e, opcionalmente, uma segunda lado a lado. */
interface TermLayout { tabs: string[]; active: string | null; split: string | null }
interface TermLink { start: number; end: number; url: string }

function makeTermLogic() {
  /** Espelho de TERM_CLOSE (term-protocol.ts). */
  const CLOSE = { replaced: 4001, closed: 4002, expired: 4003, shutdown: 4004, protocol: 4005, exited: 1000, tooBig: 1009 } as const;
  /** Espelho de TERM_CODES (term-protocol.ts): só os que a interface ramifica. */
  const CODES = {
    disabled: "term_disabled", badRequest: "term_bad_request", forbiddenCwd: "term_forbidden_cwd", kindUnavailable: "term_kind_unavailable",
    maxSessions: "term_max_sessions", rateLimited: "term_rate_limited", unknownSession: "term_unknown_session", origin: "term_origin",
    spawnFailed: "term_spawn_failed", offsetTruncated: "term_offset_truncated", offsetAhead: "term_offset_ahead", outputTruncated: "term_output_truncated",
  } as const;
  /** Espelho de TERM_LIMITS (term-protocol.ts). */
  const LIMITS = { inputBytes: 65_536, cols: { min: 20, max: 500 }, rows: { min: 5, max: 200 } } as const;
  const BACKOFF = { baseMs: 500, capMs: 15_000, jitter: 0.25, maxAttempts: 8 } as const;
  const RESIZE_DEBOUNCE_MS = 80;
  /** Quadro de ping enquanto conectado: túnel e proxy derrubam socket ocioso. Ping não conta como atividade no servidor. */
  const PING_MS = 25_000;

  /** Mensagem de cada fechamento definitivo, em palavras do usuário. */
  const REASON_TEXT: Readonly<Record<Exclude<TermCloseReason, "drop">, string>> = {
    exited: "O processo terminou.",
    replaced: "Esta sessão foi aberta em outra tela.",
    closed: "A sessão foi fechada.",
    expired: "A sessão expirou por inatividade.",
    shutdown: "O painel está parando.",
    protocol: "O painel recusou uma mensagem desta tela.",
  };

  /** Fechamento do socket: 1000 e 400x são finais e mostram o motivo; qualquer outro (rede, 1006, 1009) volta com o offset. */
  function decideClose(code: number): TermCloseDecision {
    switch (code) {
      case CLOSE.exited: return { action: "stop", reason: "exited" };
      case CLOSE.replaced: return { action: "stop", reason: "replaced" };
      case CLOSE.closed: return { action: "stop", reason: "closed" };
      case CLOSE.expired: return { action: "stop", reason: "expired" };
      case CLOSE.shutdown: return { action: "stop", reason: "shutdown" };
      case CLOSE.protocol: return { action: "stop", reason: "protocol" };
      default: return { action: "reconnect", reason: "drop" };
    }
  }
  const reasonText = (reason: Exclude<TermCloseReason, "drop">): string => REASON_TEXT[reason];

  /** Recuo exponencial com jitter. `rand` (0..1) entra por parâmetro para o teste ser determinístico. */
  function backoffMs(attempt: number, rand: number): number {
    const n = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
    const raw = Math.min(BACKOFF.capMs, BACKOFF.baseMs * 2 ** Math.min(n, 30));
    const spread = raw * BACKOFF.jitter * (Math.min(1, Math.max(0, rand)) * 2 - 1);
    return Math.max(0, Math.round(raw + spread));
  }
  const gaveUp = (attempt: number): boolean => attempt >= BACKOFF.maxAttempts;

  const offsetInitial = (): TermOffsetState => ({ base: null, got: 0 });
  /** hello é sempre o primeiro: o próximo byte binário está em hello.offset. */
  const onHello = (_s: TermOffsetState, h: TermHelloLike): TermOffsetState => ({ base: h.offset, got: 0 });
  const onBytes = (s: TermOffsetState, n: number): TermOffsetState => ({ base: s.base, got: s.got + Math.max(0, n) });
  /** warn com offset zera a contagem; sem offset não mexe. */
  const onWarn = (s: TermOffsetState, w: TermWarnLike): TermOffsetState => (typeof w.offset === "number" ? { base: w.offset, got: 0 } : s);
  /** Offset para reconectar; `undefined` antes do primeiro hello (conecta sem offset e recebe tudo o que o anel guarda). */
  const resumeOffset = (s: TermOffsetState): number | undefined => (s.base === null ? undefined : s.base + s.got);

  /** `warn` que perdeu saída: o texto avisa quanto, para o usuário saber que há um buraco no histórico. */
  function warnNotice(w: TermWarnLike): string | null {
    if (w.code === CODES.offsetTruncated || w.code === CODES.outputTruncated) {
      return typeof w.lost === "number" && w.lost > 0 ? `parte da saída anterior se perdeu (${w.lost} bytes)` : "parte da saída anterior se perdeu";
    }
    return null;
  }

  function socketUrl(loc: { protocol: string; host: string }, id: string, offset: number | undefined): string {
    const scheme = loc.protocol === "https:" ? "wss:" : "ws:";
    const q = `id=${encodeURIComponent(id)}${offset === undefined ? "" : `&offset=${Math.max(0, Math.floor(offset))}`}`;
    return `${scheme}//${loc.host}/api/term/ws?${q}`;
  }

  /** Colar grande: o servidor derruba o socket (1009) acima de 64 KiB por quadro; parte nos limites, sem copiar. */
  function chunkInput(bytes: Uint8Array, max: number = LIMITS.inputBytes): Uint8Array[] {
    if (bytes.length === 0) return [];
    const out: Uint8Array[] = [];
    for (let at = 0; at < bytes.length; at += max) out.push(bytes.subarray(at, Math.min(bytes.length, at + max)));
    return out;
  }

  const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
  /** Tamanho que o servidor aceita; `null` quando a medida ainda não existe (aba oculta, 0 colunas). */
  function clampSize(cols: number, rows: number): { cols: number; rows: number } | null {
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) return null;
    return { cols: clamp(Math.floor(cols), LIMITS.cols.min, LIMITS.cols.max), rows: clamp(Math.floor(rows), LIMITS.rows.min, LIMITS.rows.max) };
  }
  const sameSize = (a: { cols: number; rows: number } | null, b: { cols: number; rows: number } | null): boolean =>
    !!a && !!b && a.cols === b.cols && a.rows === b.rows;

  /** Link clicável só http(s): `javascript:`, `data:`, `file:` e afins nunca abrem. */
  function safeUrl(raw: string): string | null {
    try {
      const u = new URL(raw);
      return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
    } catch {
      return null;
    }
  }
  const URL_RE = /https?:\/\/[^\s<>"'`]+/g;
  const TRAILING = /[.,;:!?)\]}>'"]+$/;
  /** URLs de uma linha do buffer (colunas 0-based, `end` exclusivo); pontuação final não entra. Linha longa demais é ignorada. */
  function findLinks(line: string, maxLen = 4096): TermLink[] {
    if (line.length > maxLen) return [];
    const out: TermLink[] = [];
    for (const m of line.matchAll(URL_RE)) {
      const text = m[0].replace(TRAILING, "");
      const url = safeUrl(text);
      if (url && m.index !== undefined) out.push({ start: m.index, end: m.index + text.length, url });
    }
    return out;
  }

  /** Recusa do `open` (ou do upgrade) pelo `code` estável; o texto do servidor nunca decide. */
  function refusal(code: string | undefined, status: number, retryAfterS?: number): TermRefusal {
    switch (code) {
      case CODES.disabled:
        return { kind: "disabled", title: "O terminal está desligado", hint: "Ligue HADES_TERMINAL em Configurações → Terminal, no painel aberto nesta máquina (a chave não muda pelo acesso remoto)." };
      case CODES.maxSessions:
        return { kind: "limit", title: "Limite de sessões atingido", hint: "Feche uma sessão aberta para abrir outra." };
      case CODES.rateLimited:
        return { kind: "rate", title: "Muitas aberturas seguidas", hint: retryAfterS ? `Tente de novo em ${retryAfterS} s.` : "Espere um pouco e tente de novo.", retryAfterS };
      case CODES.forbiddenCwd:
        return { kind: "cwd", title: "Pasta fora das permitidas", hint: "Escolha uma das pastas da lista (o clone principal, as worktrees de agente e a pasta de dados)." };
      case CODES.kindUnavailable:
        return { kind: "kind", title: "Esse tipo de terminal não está instalado", hint: "O programa (claude ou herdr) não foi encontrado no PATH do painel." };
      case CODES.unknownSession:
        return { kind: "unknown_session", title: "Sessão não existe mais", hint: "Ela foi fechada ou expirou. Abra outra." };
      case CODES.origin:
        return { kind: "origin", title: "Origem não permitida", hint: "Abra o painel pelo endereço dele (127.0.0.1, localhost ou o do túnel)." };
      case CODES.spawnFailed:
        return { kind: "failed", title: "Não foi possível iniciar o terminal", hint: "O detalhe está no log do painel." };
      default:
        return { kind: "request", title: status ? `O painel recusou o pedido (HTTP ${status})` : "O painel recusou o pedido", hint: "Tente de novo." };
    }
  }

  // ------------------------------------------------------------------ mesa de abas e split (página Herdr)
  /** Mesmo formato que o servidor aceita em `resume` (`[A-Za-z0-9_-]{1,64}`). */
  const RESUME_RE = /^[A-Za-z0-9_-]{1,64}$/;
  const layoutEmpty = (): TermLayout => ({ tabs: [], active: null, split: null });
  /** O split nunca repete a aba ativa nem aponta para aba que não existe. */
  const layoutNorm = (l: TermLayout): TermLayout => {
    const active = l.active !== null && l.tabs.includes(l.active) ? l.active : (l.tabs[l.tabs.length - 1] ?? null);
    const split = l.split !== null && l.split !== active && l.tabs.includes(l.split) ? l.split : null;
    return { tabs: l.tabs, active, split };
  };
  const layoutAdd = (l: TermLayout, id: string): TermLayout => layoutNorm({ tabs: l.tabs.includes(id) ? l.tabs : [...l.tabs, id], active: id, split: l.split });
  /** Escolher a aba que está no split troca de lugar com a ativa (a mesma sessão não aparece duas vezes). */
  const layoutSelect = (l: TermLayout, id: string): TermLayout =>
    !l.tabs.includes(id) ? l : layoutNorm({ tabs: l.tabs, active: id, split: id === l.split ? l.active : l.split });
  const layoutSplit = (l: TermLayout, id: string | null): TermLayout => layoutNorm({ ...l, split: id });
  const layoutRemove = (l: TermLayout, id: string): TermLayout => {
    const tabs = l.tabs.filter((t) => t !== id);
    const active = l.active === id ? (l.split !== id ? l.split : null) ?? (tabs[tabs.length - 1] ?? null) : l.active;
    return layoutNorm({ tabs, active, split: l.split === id ? null : l.split });
  };
  /** Troca o id de uma aba no lugar (rascunho que acabou de abrir vira a sessão real). */
  const layoutReplace = (l: TermLayout, from: string, to: string): TermLayout => {
    const swap = (v: string | null): string | null => (v === from ? to : v);
    return layoutNorm({ tabs: l.tabs.map((t) => (t === from ? to : t)), active: swap(l.active), split: swap(l.split) });
  };
  /** Tira da mesa as abas que não existem mais no servidor; rascunho (`isDraft`) fica. */
  const layoutPrune = (l: TermLayout, live: readonly string[], isDraft: (id: string) => boolean): TermLayout =>
    l.tabs.reduce((acc, id) => (live.includes(id) || isDraft(id) ? acc : layoutRemove(acc, id)), l);
  /** Lê o que o sessionStorage guardou; qualquer coisa fora do formato volta mesa vazia. */
  function layoutParse(raw: string | null): TermLayout {
    try {
      const v = JSON.parse(raw ?? "null") as { tabs?: unknown; active?: unknown; split?: unknown } | null;
      if (!v || !Array.isArray(v.tabs)) return layoutEmpty();
      const tabs = v.tabs.filter((t): t is string => typeof t === "string" && /^[0-9a-f]{32}$/.test(t));
      return layoutNorm({ tabs, active: typeof v.active === "string" ? v.active : null, split: typeof v.split === "string" ? v.split : null });
    } catch {
      return layoutEmpty();
    }
  }

  // ------------------------------------------------------------------ celular: barra de teclas, seguir o fim, visualViewport, níveis
  /** Largura (px) abaixo da qual a página usa o layout de celular (uma coisa por vez). */
  const MOBILE_MAX_PX = 768;
  const isMobileWidth = (px: number): boolean => Number.isFinite(px) && px > 0 && px < MOBILE_MAX_PX;

  type KeyGroup = "nav" | "quick" | "tool";
  /** `seq`: bytes enviados; `app`: sequência do modo de cursor de aplicação (setas); `tool`: ação da tela, sem bytes. */
  interface KeyDef { label: string; aria: string; group: KeyGroup; seq?: string; app?: string; tool?: "ctrl" | "paste" | "copy" }
  /** Catálogo da barra: o valor de HADES_TERMINAL_KEYS é uma lista de ids deste mapa. */
  const KEY_DEFS: Readonly<Record<string, KeyDef>> = {
    esc: { label: "Esc", aria: "Escape", group: "nav", seq: "\x1b" },
    tab: { label: "Tab", aria: "Tab", group: "nav", seq: "\t" },
    ctrl: { label: "Ctrl", aria: "Ctrl (vale para a próxima tecla)", group: "nav", tool: "ctrl" },
    up: { label: "↑", aria: "Seta para cima", group: "nav", seq: "\x1b[A", app: "\x1bOA" },
    down: { label: "↓", aria: "Seta para baixo", group: "nav", seq: "\x1b[B", app: "\x1bOB" },
    right: { label: "→", aria: "Seta para a direita", group: "nav", seq: "\x1b[C", app: "\x1bOC" },
    left: { label: "←", aria: "Seta para a esquerda", group: "nav", seq: "\x1b[D", app: "\x1bOD" },
    enter: { label: "Enter", aria: "Enter", group: "nav", seq: "\r" },
    pipe: { label: "|", aria: "Barra vertical", group: "nav", seq: "|" },
    tilde: { label: "~", aria: "Til", group: "nav", seq: "~" },
    slash: { label: "/", aria: "Barra", group: "nav", seq: "/" },
    dash: { label: "-", aria: "Hífen", group: "nav", seq: "-" },
    paste: { label: "Colar", aria: "Colar da área de transferência", group: "tool", tool: "paste" },
    copy: { label: "Copiar", aria: "Copiar a seleção ou a tela", group: "tool", tool: "copy" },
    "1": { label: "1", aria: "Responder 1", group: "quick", seq: "1" },
    "2": { label: "2", aria: "Responder 2", group: "quick", seq: "2" },
    "3": { label: "3", aria: "Responder 3", group: "quick", seq: "3" },
    y: { label: "y", aria: "Responder y", group: "quick", seq: "y" },
    n: { label: "n", aria: "Responder n", group: "quick", seq: "n" },
    "shift-tab": { label: "⇧Tab", aria: "Shift+Tab (trocar de modo no Claude)", group: "quick", seq: "\x1b[Z" },
    "ctrl-c": { label: "Ctrl+C", aria: "Ctrl+C (interromper)", group: "quick", seq: "\x03" },
  };
  const DEFAULT_KEYS = "esc,tab,ctrl,up,down,left,right,enter,pipe,tilde,slash,dash,paste,copy,1,2,3,y,n,shift-tab,ctrl-c";
  const KEYS_MAX = 32;
  interface KeyList { keys: string[]; warning: string | null }
  /** HADES_TERMINAL_KEYS (ids separados por vírgula ou espaço). Vazio usa o padrão; id desconhecido invalida a lista inteira:
   *  cai no padrão com aviso (nunca uma barra pela metade). */
  function parseKeys(raw: string | null | undefined): KeyList {
    const fallback = (warning: string | null): KeyList => ({ keys: DEFAULT_KEYS.split(","), warning });
    const text = (raw ?? "").trim();
    if (text === "") return fallback(null);
    const ids = text.toLowerCase().split(/[\s,]+/).filter(Boolean);
    const bad = ids.find((id) => !Object.hasOwn(KEY_DEFS, id));
    if (bad !== undefined) return fallback(`HADES_TERMINAL_KEYS tem a tecla desconhecida "${bad.slice(0, 20)}"; usando o padrão.`);
    if (ids.length > KEYS_MAX) return fallback(`HADES_TERMINAL_KEYS passa de ${KEYS_MAX} teclas; usando o padrão.`);
    return { keys: [...new Set(ids)], warning: null };
  }
  /** Bytes da tecla (`null` para as de ação da tela). `appCursor`: o programa ligou o modo de cursor de aplicação. */
  function keyBytes(id: string, appCursor = false): string | null {
    const d = Object.hasOwn(KEY_DEFS, id) ? KEY_DEFS[id] : undefined;
    if (!d || d.seq === undefined) return null;
    return appCursor && d.app !== undefined ? d.app : d.seq;
  }
  /** Ctrl fixo de um toque: a próxima tecla de um caractere vira o byte de controle (a-z, @[\]^_ , espaço, ?); o resto passa igual. */
  function applyCtrl(data: string): string {
    if (data.length !== 1) return data;
    const c = data.charCodeAt(0);
    if (data === " ") return "\x00";
    if (data === "?") return "\x7f";
    if (c >= 0x40 && c <= 0x5f) return String.fromCharCode(c & 0x1f);
    if (c >= 0x61 && c <= 0x7a) return String.fromCharCode(c & 0x1f);
    return data;
  }
  /** O terminal segue o fim enquanto a janela está na última linha; rolou para cima, para de seguir e aparece "ir ao fim". */
  const isFollowing = (viewportY: number, baseY: number): boolean => !(viewportY < baseY);

  /** Teclado virtual aberto: a janela útil (visualViewport) fica bem menor que a de layout. */
  const KEYBOARD_MIN_PX = 120;
  const MIN_VIEW_PX = 160;
  interface ViewBox { top: number; left: number; width: number; height: number; keyboard: boolean }
  /** Caixa onde o terminal em tela cheia se encaixa: acompanha altura útil e deslocamento do visualViewport (iOS desloca em vez de encolher). */
  function viewBox(vv: { width: number; height: number; offsetTop: number; offsetLeft: number } | null, win: { innerWidth: number; innerHeight: number }): ViewBox {
    if (!vv || !Number.isFinite(vv.height) || vv.height <= 0) return { top: 0, left: 0, width: win.innerWidth, height: win.innerHeight, keyboard: false };
    const height = Math.max(MIN_VIEW_PX, Math.round(vv.height));
    return { top: Math.max(0, Math.round(vv.offsetTop)), left: Math.max(0, Math.round(vv.offsetLeft)), width: Math.round(vv.width), height,
      keyboard: win.innerHeight - vv.height > KEYBOARD_MIN_PX };
  }

  /** Níveis da página no celular: lista -> detalhe (conversa ou terminal em tela cheia). O voltar do sistema desce um nível sem sair da página. */
  type NavLevel = "list" | "detail";
  type NavEvent = "enter" | "leave" | "pop";
  interface NavStep { level: NavLevel; history: "push" | "back" | null }
  /** `enter` abre o detalhe (empilha uma entrada); `leave` é o voltar da tela (desempilha); `pop` é o voltar do sistema (já desempilhou). */
  function navStep(level: NavLevel, ev: NavEvent): NavStep {
    if (ev === "enter") return level === "detail" ? { level, history: null } : { level: "detail", history: "push" };
    if (ev === "leave") return level === "detail" ? { level: "list", history: "back" } : { level, history: null };
    return { level: "list", history: null };
  }

  // ------------------------------------------------------------------ tecla morta (´ + a = á)
  /** O que a máquina lê de um KeyboardEvent / CompositionEvent / InputEvent (o DOM entrega mais campos; estes bastam). */
  interface ComposeEvent { type: string; key?: string; keyCode?: number; isComposing?: boolean; data?: string | null; inputType?: string }
  /** O campo de texto escondido do xterm, visto só pelo que a máquina precisa: ler o que ele tem e esvaziá-lo. */
  interface ComposeField { value(): string; clear(): void }
  interface ComposeGate {
    /** `true`: o evento é desta máquina, quem o ligou deve impedir que o xterm o veja (sem preventDefault: o navegador segue compondo). */
    handle(e: ComposeEvent): boolean;
    /** Fim da espera pelo texto que o Firefox entrega depois do `compositionend` vazio. */
    settle(): void;
  }
  /**
   * Composição por tecla morta, entregue UMA vez a `emit`. Só a composição que começa logo depois de um keydown `Dead` é daqui:
   * o IME (japonês, chinês…) segue com o xterm, que desenha o texto em composição. Na dead key o navegador manda, no meio da
   * composição, keydown da letra base (Firefox: key `a`, keyCode 65, isComposing true; Chrome: keyCode 229): o xterm o tomaria
   * por uma tecla e mandaria a letra antes do texto composto (`aaá`). O texto composto sai no `compositionend` (Chrome) ou, com o
   * `compositionend` vazio, no `input` insertText que o Firefox manda logo depois. Fonte: sequência medida no Firefox 157 (Wayland).
   */
  const COMPOSE_SETTLE_MS = 100;
  function composeGate(emit: (text: string) => void, field: ComposeField): ComposeGate {
    let dead = false, owned = false, awaitInsert = false;
    const deliver = (text: string): void => { field.clear(); if (text !== "") emit(text); };
    const processKey = (e: ComposeEvent): boolean => e.isComposing === true || e.keyCode === 229 || e.key === "Process" || e.key === "Dead";
    return {
      settle() { awaitInsert = false; },
      handle(e) {
        switch (e.type) {
          case "keydown":
            if (e.key === "Dead") { if (!owned) dead = true; return true; }
            if (owned || awaitInsert) {
              if (processKey(e)) return true;
              awaitInsert = false;
            }
            dead = false;
            return false;
          case "compositionstart":
            if (!dead) return false;
            dead = false; owned = true;
            return true;
          case "compositionupdate":
            return owned;
          case "compositionend": {
            if (!owned) return false;
            owned = false;
            const text = typeof e.data === "string" && e.data !== "" ? e.data : field.value();
            if (text === "") awaitInsert = true;
            deliver(text);
            return true;
          }
          case "beforeinput":
          case "input":
            if (owned) return true;
            if (awaitInsert && e.inputType === "insertCompositionText") return true;
            if (awaitInsert && e.inputType === "insertText") {
              if (e.type === "input" && typeof e.data === "string" && e.data !== "") { awaitInsert = false; deliver(e.data); }
              return true;
            }
            return false;
          default:
            return false;
        }
      },
    };
  }


  // ------------------------------------------------------------------ roda em tela alternativa (#18; a regra do histórico é a do nó do Argos, #12)
  /** Linhas pedidas ao `/api/herdr/scrollback` (teto do servidor: SCROLLBACK_LINES_MAX em herdr-page.ts). */
  const HISTORY_LINES = 1000;
  const HISTORY_URL = "/api/herdr/scrollback";
  /** Altura de uma linha na tela quando a medida não vale (a célula do nó na escala 1). */
  const LINE_PX_DEFAULT = 17;

  /** Linhas de ANSI do histórico (a saída de `pane read --source recent`): sem o fim de linha e sem as linhas vazias do rodapé. */
  function historyLinesOf(ansi: unknown): string[] {
    const lines = String(ansi).split(/\r?\n/);
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines;
  }

  /** Deslocamento (linhas a partir do fim) preso entre 0 e o que o histórico tem acima de uma tela de `rows` linhas. */
  const clampOffset = (offset: number, total: number, rows: number): number => Math.min(Math.max(0, offset), Math.max(0, total - rows));

  /** As `rows` linhas do histórico que terminam `offset` linhas antes do fim. */
  function historyWindow(lines: string[], rows: number, offset: number): string[] {
    const end = lines.length - clampOffset(offset, lines.length, rows);
    return lines.slice(Math.max(0, end - rows), end);
  }

  interface WheelLike { deltaY: number; deltaMode: number }
  /**
   * Linhas inteiras de um giro da roda (positivo = rola para trás no histórico) e o resto em pixels que fica para o próximo giro.
   * `linePx` é a altura de uma linha NA TELA. O trackpad manda dezenas de eventos de poucos pixels: cada um somado ao resto,
   * nunca arredondado para uma linha. Linhas e páginas viram pixels.
   */
  function wheelStep(rest: number, e: WheelLike, rows: number, linePx: number): { lines: number; rest: number } {
    const px = Number.isFinite(linePx) && linePx > 0 ? linePx : LINE_PX_DEFAULT;
    const dy = Number.isFinite(e.deltaY) ? e.deltaY : 0;
    const deltaPx = e.deltaMode === 1 ? dy * px : e.deltaMode === 2 ? dy * rows * px : dy;
    const acc = (Number.isFinite(rest) ? rest : 0) - deltaPx;
    const lines = Math.trunc(acc / px) || 0;
    return { lines, rest: acc - lines * px };
  }

  /**
   * Estado da rolagem: `lines` é o histórico (null = ao vivo), `offset` as linhas a partir do fim e `pending` os passos que
   * chegaram antes de o histórico carregar. Funções puras: a roda dispara em rajada e o estado do render fica velho entre eventos.
   */
  interface ScrollState { lines: string[] | null; offset: number; pending: number }
  const scrollLive = (): ScrollState => ({ lines: null, offset: 0, pending: 0 });

  function wheelScroll(state: ScrollState, step: number, rows: number): ScrollState {
    if (state.lines === null) return { ...state, pending: Math.max(0, state.pending + step) };
    const offset = clampOffset(state.offset + step, state.lines.length, rows);
    return offset === 0 ? scrollLive() : { ...state, offset };
  }

  function historyLoaded(state: ScrollState, lines: string[], rows: number): ScrollState {
    const offset = clampOffset(state.pending, lines.length, rows);
    return offset === 0 ? scrollLive() : { lines, offset, pending: 0 };
  }

  /**
   * Texto que desenha uma tela inteira: atributos zerados, cursor ao canto e tela limpa, as linhas separadas por CRLF, e o cursor
   * (se vier) posicionado e visível. Nunca termina em quebra de linha: a última linha da grade não rola a tela.
   */
  function screenOf(ansi: unknown, cursor: { row: number; col: number } | null = null): string {
    const body = String(ansi).split(/\r?\n/);
    while (body.length > 1 && body[body.length - 1] === "") body.pop();
    const place = cursor ? `\x1b[${cursor.row + 1};${cursor.col + 1}H\x1b[?25h` : "";
    return `\x1b[?25l\x1b[0m\x1b[H\x1b[2J${body.join("\r\n")}\x1b[0m${place}`;
  }

  /** Último caractere de um prompt de shell: o cursor fica um espaço depois dele, e o herdr apara o espaço do fim da linha. */
  const PROMPT_END = /[$#%>❯›»:]$/;
  const ANSI_SEQ = /\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
  const SGR_SEQ = /\x1b\[([0-9;:]*)m/g;
  /** Há SGR 7 (vídeo inverso) no texto. Cor estendida (`38;5;n`, `38;2;r;g;b`) tem o 7 como valor, não como atributo: salta. */
  function hasInverse(ansi: string): boolean {
    for (const m of ansi.matchAll(SGR_SEQ)) {
      const params = m[1].split(";");
      for (let i = 0; i < params.length; i++) {
        const p = params[i];
        if (p === "7") return true;
        if (p === "38" || p === "48" || p === "58") i += params[i + 1] === "2" ? 4 : 2;
      }
    }
    return false;
  }

  /**
   * Onde está o cursor de um quadro do herdr, que não o entrega (0.8.2: `pane.read` traz só texto e revisão). Estimativa pelo
   * texto: a última linha com conteúdo, logo depois do último caractere (um espaço além, se a linha termina em prompt).
   * Quadro com vídeo inverso é de um programa que desenha o próprio cursor (Claude Code, editores): nada é inferido, o
   * cursor dele já está no quadro. Tela vazia: canto superior esquerdo. Sempre dentro da grade.
   */
  function guessCursor(ansi: unknown, cols: number, rows: number): { row: number; col: number } | null {
    if (typeof ansi !== "string" || !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return null;
    if (hasInverse(ansi)) return null;
    const lines = ansi.split(/\r?\n/);
    let row = Math.min(lines.length, rows) - 1;
    while (row >= 0 && lines[row].replace(ANSI_SEQ, "").trim() === "") row -= 1;
    if (row < 0) return { row: 0, col: 0 };
    const text = lines[row].replace(ANSI_SEQ, "").replace(/\s+$/, "");
    const width = [...text].length + (PROMPT_END.test(text) ? 1 : 0);
    return { row, col: Math.min(width, cols - 1) };
  }

  /** Quem recebe a roda: o xterm (buffer normal, comportamento de sempre), o histórico do herdr (tela alternativa com pane) ou o programa (tela alternativa sem pane). */
  type WheelRoute = "xterm" | "history" | "program";
  function wheelRoute(alternate: boolean, hasPane: boolean): WheelRoute {
    if (!alternate) return "xterm";
    return hasPane ? "history" : "program";
  }

  /**
   * O pane do herdr que a sessão PTY mostra. O PTY herda o ambiente do painel (o HERDR_PANE_ID dele seria o do próprio painel,
   * não o da sessão), então só o `herdr-client` tem pane: o que está em foco na sessão do herdr (workspace, aba e pane focados).
   * Sem sessão do herdr ou sem pane focado, `null`.
   */
  interface HerdrTreeLike { tree?: Array<{ focused?: boolean; tabs?: Array<{ focused?: boolean; panes?: Array<{ id?: unknown; focused?: boolean }> }> }> }
  function focusedPaneOf(overview: HerdrTreeLike | null | undefined): string | null {
    const workspace = overview?.tree?.find((w) => w.focused);
    const tab = workspace?.tabs?.find((t) => t.focused);
    const pane = tab?.panes?.find((p) => p.focused);
    return pane && typeof pane.id === "string" && pane.id !== "" ? pane.id : null;
  }

  /** Dica da roda sem pane: aparece na primeira vez que a roda é usada em tela alternativa e não volta. */
  const WHEEL_HINT_TEXT = "A roda vai ao programa. Para ver o histórico, use PageUp/PageDown ou o atalho de rolagem dele.";
  function createWheelHint(): { take(): boolean } {
    let shown = false;
    return { take() { if (shown) return false; shown = true; return true; } };
  }

  return {
    composeGate, COMPOSE_SETTLE_MS,
    RESUME_RE, layoutEmpty, layoutNorm, layoutAdd, layoutSelect, layoutSplit, layoutRemove, layoutReplace, layoutPrune, layoutParse,
    CLOSE, CODES, LIMITS, BACKOFF, RESIZE_DEBOUNCE_MS, PING_MS, decideClose, reasonText, backoffMs, gaveUp,
    offsetInitial, onHello, onBytes, onWarn, resumeOffset, warnNotice, socketUrl, chunkInput, clampSize, sameSize,
    safeUrl, findLinks, refusal,
    MOBILE_MAX_PX, isMobileWidth, KEY_DEFS, DEFAULT_KEYS, parseKeys, keyBytes, applyCtrl, isFollowing, KEYBOARD_MIN_PX, viewBox, navStep,
    HISTORY_LINES, HISTORY_URL, historyLinesOf, clampOffset, historyWindow, wheelStep, scrollLive, wheelScroll, historyLoaded, screenOf, guessCursor,
    wheelRoute, focusedPaneOf, WHEEL_HINT_TEXT, createWheelHint,
  };
}

type TermLogicApi = ReturnType<typeof makeTermLogic>;
(globalThis as unknown as { TermLogicFactory: typeof makeTermLogic }).TermLogicFactory = makeTermLogic;
(globalThis as unknown as { TermLogic: TermLogicApi }).TermLogic = makeTermLogic();
