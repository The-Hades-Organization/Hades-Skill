/* Página Argos (#/argos): canvas dos agentes, painel do nó ao vivo e ações. Usa a base (ui/app.js) pelo HadesCore, a regra de
 * ui/argos/logic.js, as peças de ui/argos/parts.js, a barra de leitura de ui/argos/reading-bar.js (layout, filtros, busca,
 * vistas) com o executor de ui/argos/reading-runner.js e o canvas (window.CanvasModel + window.ArgosCanvas), e se registra
 * pelo registerPage dela. A regra do canvas (estado, sincronia, gravação) é de src/lib/canvas-store.ts. Monta no registro os
 * comandos de organização (ui/argos/commands-canvas.js) e os tipos de nó do usuário e vivos (types-user.js, types-live.js), e
 * põe sobre o canvas as camadas de ui/argos/canvas-overlays.js (menu de contexto, balão, permissão no nó, minimapa).
 * Contrato: reference/argos.md. */
(() => {
const { useState, useEffect, useRef, useMemo, useCallback, I, cn, post, getJSON, Button, Skeleton,
  Empty, useApp, useWide, Choice } = HadesCore;
const L = window.ArgosLogic;
const P = window.ArgosParts;
const CC = window.ArgosCanvasControls;
const R = window.ArgosReading;
const M = window.CanvasModel;
// gaveta do nó dentro do canvas (canvas-focus.js)
const FOCUS = window.ArgosFocus;
const MOUNT_PARTS = { canvasCommands: window.ArgosCanvasCommands, typesUser: window.ArgosTypesUser, typesLive: window.ArgosTypesLive };
// nó de agente como terminal (node-terminal.js): o host dos terminais é da página, um por abertura
const NT = window.ArgosNodeTerminal;
// terminal criado no canvas: barra de ferramentas, modal e tela de papéis carregam sob demanda, na primeira vista do canvas
// (lista fechada, o index.html não muda); cada script registra o próprio window.Argos*
const TERMINAL_SCRIPTS = Object.freeze(['canvas-toolbar', 'terminal-create', 'terminal-roles']);
const TERMINAL_ID_PREFIX = 'term';
// compositor flutuante do terminal (canvas-composer.js) e popover de conexões (canvas-links.js), carregados pelo index.html
const CMP = window.ArgosCanvasComposer;
const LINKS = window.ArgosLinks;
// ocultos do canvas (canvas-hidden.js): comandos de ocultar e reexibir e a lista "Ocultos (N)" da barra
const HID = window.ArgosCanvasHidden;
// supervisor do canvas (supervisor.js, carregado pelo index.html antes da página): painel flutuante que observa os terminais
const SUP = window.ArgosSupervisor;
const NOTE_ID_PREFIX = 'note';
// pedaço aleatório do nome do arquivo da nota nova (freshNoteName pede minúsculas e números, de 6 a 32)
const noteToken = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);
// notas soltas de fora nascem em escada a partir do ponto do soltar (unidades do mundo), para uma não cobrir a outra
const DROP_STEP = 24;
const DROP_TYPES = Object.freeze(['Files', 'text/uri-list']);
// comandos montados aqui que entram no menu do nó, por tipo (o menu do tipo fica como está; o que já está nele não repete)
const MOUNTED_NODE_MENU = Object.freeze({
  agent: Object.freeze([L.TERM_OPEN_SHELL, L.TERM_OPEN_CLIENT]),
  [NT.TERMINAL_TYPE]: Object.freeze(['tty:link']),
  [M.note.NOTE_TYPE]: Object.freeze(['term:connections', 'tty:link', 'tty:close']),
});
const withMountedMenu = (type) => {
  const extra = (MOUNTED_NODE_MENU[type.type] || []).filter((id) => !type.menu.includes(id));
  return extra.length ? { ...type, menu: [...type.menu, ...extra] } : type;
};
let terminalScripts = null;
function loadTerminalScripts() {
  terminalScripts ??= Promise.all(TERMINAL_SCRIPTS.map((name) => new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = `/ui/argos/${name}.js`;
    el.onload = () => resolve();
    el.onerror = () => reject(Object.assign(new Error(`o script ${name} não carregou`), { code: 'terminal_script_failed' }));
    document.body.appendChild(el);
  })));
  return terminalScripts;
}

// forma do nó no desenho de longe, vinda do tipo; fora do componente para a identidade não mudar a cada render
const nodeShape = (n) => M.argos.typeLook(n.type).shape;
const POLL_MS = 4000;
const DETAIL_POLL_MS = 10000;
const CLOCK_MS = 15000;
const RUNS_KEEP = 8;
const CANVAS_URL = '/api/canvas';
const CANVAS_TIMEOUT_MS = 10000;
// stream que avisa `{ id, rev }` a cada gravação de documento (e `registry` quando os terminais mudam); o polling de POLL_MS é a reserva
const CANVAS_STREAM_URL = '/api/canvas/stream';
// canvases por worktree/rodada (W2) e filtros salvos da instância (L5): mesma família de rotas, mesmo prazo do canvas
const CANVASES_URL = '/api/canvases';
// terminais registrados e vivos sem nó em canvas nenhum (`checked: false` quando o servidor não pôde afirmar)
const ORPHANS_URL = '/api/argos/terminals/orphans';
/** Conferência dos órfãos e dos panes encerrados com a aba visível: o pane que morre por fora não avisa o painel. */
const ORPHANS_POLL_MS = 30_000;
const SCOPE_URL = '/api/canvases/_scope';
const FILTERS_URL = '/api/canvases/_filters';
const FILTERS_UNREACHABLE = 'saved_filters_unreachable';
const SCOPE_UNEXPECTED = 'canvas_scope_unexpected_response';
const SWITCH_UNSAVED = 'canvas_switch_unsaved';
// valor da opção "Rodada…" no seletor de canvas: id de canvas nunca é vazio
const ROUND_OPTION = '';
const PORTAL_POLICY_URL = '/api/canvas/portal/policy';
const PORTAL_POLICY_TIMEOUT_MS = 8000;
const ACTION_URL = '/api/argos/action';
// teto da rota das ações (HADES_ARGOS_ACTION_TIMEOUT_S, 1200 s: resume e park esperam o turno do agente) e uma folga
const BATCH_ACTION_TIMEOUT_MS = 1230000;
// o keepalive do fetch aceita corpo de até 64 KiB; maior que isso, a saída da aba grava sem ele
const KEEPALIVE_MAX_BYTES = 60000;
// teclas que o motor trata quando o foco está no canvas (docs: Teclado e leitor de tela): a página não as pega
const ENGINE_KEYS = new Set(['Enter', 'Escape', ' ', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', '+', '-', '=', '0', 'ContextMenu']);
const SUPPORTED_V = 1;
const ALL = 'all';
// Concluídos ficam a um clique ('Todos'), fora da vista de abertura; arquivados, atrás de "Mostrar arquivados" em qualquer preset.
const DEFAULT_STATE = 'active';
const SEARCH_DEBOUNCE_MS = 250;
const CAMERA_HASH_DEBOUNCE_MS = 500;
// zoom máximo ao enquadrar os achados da busca: um achado só não enche a tela
const SEARCH_FRAME_MAX_ZOOM = 1;
const STORE_LAYOUT = 'hades.argos.layout';
const STORE_PINS = 'hades.argos.pins';
const STORE_VIEWS = 'hades.argos.views';
// "Esconder controles" lembrado entre aberturas (chave e `focus=1` de antes, mesmo sentido novo); o endereço com focus=1 liga mesmo sem a preferência
const STORE_FOCUS = 'hades.argos.focus';
// encaixe magnético como modo (Shift+M), lembrado entre aberturas; Ctrl ao arrastar encaixa com ele desligado
const STORE_SNAP = 'hades.argos.snap';
const STORE_DETAIL = 'hades.argos.fullDetail';
// panes do herdr dos nós de agente: a visão geral relida a cada TTY_TARGETS_MS, só com nó de agente no canvas
const HERDR_OVERVIEW_URL = '/api/herdr';
const HERDR_INPUT_URL = '/api/herdr/input';
const HERDR_SIZE_URL = '/api/herdr/size';
const TTY_TARGETS_MS = 15000;
const HERDR_TIMEOUT_MS = 8000;
// seletor do terminal com o teclado (node-tty.js): com o foco dentro, só os comandos tty:* passam pela página
const TTY_FOCUSED = '[data-tty-focused="true"]';
// armazenamento do navegador: pode faltar (aba privada, bloqueio); sem ele a página segue com o padrão e avisa no console
const readStored = (key) => { try { return JSON.parse(localStorage.getItem(key) ?? 'null'); } catch (e) { console.warn('argos: leitura do armazenamento falhou', key, e && e.name); return null; } };
const writeStored = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { console.warn('argos: gravação no armazenamento falhou', key, e && e.name); } };
const isArgosHash = (hash) => hash.split('?')[0] === M.urlstate.URLSTATE_BASE;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const isEditable = (t) => !!t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
const codeOf = (d, status) => (d && typeof d.code === 'string' ? d.code : `http_${status}`);
const codedError = (message, code) => Object.assign(new Error(message), { code });
// o canvas padrão segue na rota de sempre; os de worktree/rodada (e os demais) vão por /api/canvases/<id>
const canvasUrl = (id) => (id === M.store.DEFAULT_CANVAS_ID ? CANVAS_URL : `${CANVASES_URL}/${encodeURIComponent(id)}`);
// o preset de estado só vai ao endereço quando não é o de abertura: links antigos e o endereço padrão ficam iguais
const linkPreset = (state) => (state !== DEFAULT_STATE && M.urlstate.URLSTATE_PRESETS.includes(state) ? state : undefined);
// fluxo SSE que solta a conexão com a aba escondida (stream-logic.tsx): o teto de 6 conexões por servidor é do navegador inteiro
const openSse = (url) => (window.PanelStream ? window.PanelStream.open(url) : new EventSource(url));
const withTimeout = (signal) => AbortSignal.any([signal, AbortSignal.timeout(CANVAS_TIMEOUT_MS)]);

// entrada do terminal do nó: rejeita com o código (ou a mensagem) do servidor, para o nó mostrar o motivo
async function sendHerdrInput(body) {
  const r = await tokenFetch(HERDR_INPUT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(HERDR_TIMEOUT_MS) });
  if (r.ok) return;
  const d = await r.json().catch(() => null);
  throw codedError(d && typeof d.error === 'string' ? d.error : `o painel respondeu ${r.status}`, codeOf(d, r.status));
}

// grade do terminal do nó (ou a liberação): rejeita com o código do servidor; `herdr-unsupported` é o herdr sem pane.set_size
async function sendHerdrSize(body) {
  const r = await tokenFetch(HERDR_SIZE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(HERDR_TIMEOUT_MS) });
  if (r.ok) return;
  const d = await r.json().catch(() => null);
  throw codedError(d && typeof d.error === 'string' ? d.error : `o painel respondeu ${r.status}`, codeOf(d, r.status));
}

// visão geral do herdr (sessão e panes); falha vira Error e quem chama mantém os alvos de antes
async function getHerdrOverview(signal) {
  const r = await tokenFetch(HERDR_OVERVIEW_URL, { cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(HERDR_TIMEOUT_MS)]) });
  if (!r.ok) throw codedError(`visão do herdr: ${r.status}`, `http_${r.status}`);
  return r.json();
}

// GET do documento do canvas; falha vira Error com o código estável
async function getCanvas(url) {
  const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(CANVAS_TIMEOUT_MS) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || `HTTP ${r.status}`), { code: codeOf(d, r.status) });
  return M.doc.readCanvasDoc(d);
}

// PUT do documento; devolve a resposta que o gravador entende (gravou, revisão velha, falhou)
async function putCanvas(url, doc, { leaving }, meta = {}) {
  const body = JSON.stringify(doc);
  // causa, tamanho do grafo lido e confirmação de remoção em massa vão ao servidor, que os põe no diário (panel.log)
  const extra = { ...(meta.cause ? { 'X-Canvas-Cause': meta.cause } : {}), ...(Number.isInteger(meta.graphSize) ? { 'X-Canvas-Graph-Size': String(meta.graphSize) } : {}), ...(meta.confirmRemoval ? { 'X-Canvas-Confirm-Removal': '1' } : {}) };
  const send = () => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Panel-Token': window.__TOKEN, ...extra }, body,
    keepalive: leaving && body.length < KEEPALIVE_MAX_BYTES, signal: AbortSignal.timeout(CANVAS_TIMEOUT_MS) });
  try {
    let r = await send();
    let d = await r.json().catch(() => ({}));
    // painel reiniciado com a aba aberta: o token da página ficou velho (mesma troca do post da base)
    if (r.status === 403 && d.error === 'token') {
      const t = await fetch('/api/token', { cache: 'no-store' }).then((x) => x.json()).catch(() => ({}));
      if (t.token && t.token !== window.__TOKEN) { window.__TOKEN = t.token; r = await send(); d = await r.json().catch(() => ({})); }
    }
    if (r.ok) return { kind: 'saved', rev: d.rev };
    if (r.status === 409 && Number.isInteger(d.rev)) return { kind: 'stale', rev: d.rev };
    return { kind: 'failed', code: codeOf(d, r.status) };
  } catch (e) {
    console.error('canvas: gravação sem resposta', e && e.name);
    return { kind: 'failed', code: M.store.SAVE_ERRORS.unreachable };
  }
}

// fetch das peças do canvas com o token da sessão; painel reiniciado (403 token): busca o token novo e repete uma vez
async function tokenFetch(url, init = {}) {
  const send = () => fetch(url, { ...init, headers: { ...(init.headers || {}), 'X-Panel-Token': window.__TOKEN } });
  const r = await send();
  if (r.status !== 403) return r;
  const d = await r.clone().json().catch(() => ({}));
  if (d.error !== 'token') return r;
  const t = await fetch('/api/token', { cache: 'no-store' }).then((x) => x.json()).catch(() => ({}));
  if (!t.token || t.token === window.__TOKEN) return r;
  window.__TOKEN = t.token;
  return send();
}

// política do portal (hosts que o nó portal embute); até responder e em qualquer erro vale a vazia (falha fechada)
async function getPortalPolicy(signal) {
  try {
    const r = await tokenFetch(PORTAL_POLICY_URL, { cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(PORTAL_POLICY_TIMEOUT_MS)]) });
    if (!r.ok) { console.warn('argos: política do portal recusada', r.status); return L.emptyPortalPolicy(); }
    return L.readPortalPolicy(await r.json());
  } catch (e) {
    if (!signal.aborted) console.warn('argos: política do portal sem resposta', e && e.name);
    return L.emptyPortalPolicy();
  }
}

// canvas do escopo (cria na primeira vez, reabre depois): o id sai da chave no servidor
async function postScope(scope, signal) {
  const r = await tokenFetch(SCOPE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scope), signal: withTimeout(signal) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw codedError(L.errorText(codeOf(d, r.status), 'O painel recusou o canvas desse escopo.'), codeOf(d, r.status));
  if (typeof d.id !== 'string' || !d.id || typeof d.name !== 'string') throw codedError('Resposta inesperada do painel.', SCOPE_UNEXPECTED);
  return { id: d.id, name: d.name };
}

// filtros salvos da instância: leitura validada na fronteira; gravação com a revisão lida (409 = outra aba gravou antes)
async function getSavedFilters(signal) {
  const r = await tokenFetch(FILTERS_URL, { cache: 'no-store', signal: withTimeout(signal) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw codedError(`HTTP ${r.status}`, codeOf(d, r.status));
  return M.savedFilters.readSavedFilters(d);
}
async function putSavedFilters(set, signal) {
  try {
    const r = await tokenFetch(FILTERS_URL, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(set), signal: withTimeout(signal) });
    const d = await r.json().catch(() => ({}));
    if (r.ok && Number.isInteger(d.rev)) return { ok: true, rev: d.rev };
    return { ok: false, code: codeOf(d, r.status) };
  } catch (e) {
    if (signal.aborted) throw e;
    console.warn('argos: filtros salvos sem resposta', e && e.name);
    return { ok: false, code: FILTERS_UNREACHABLE };
  }
}

// lote: um POST por agente, em sequência (uma conexão só); o pedido sem resposta conta como status 0
async function sendBatch(requests, signal) {
  const out = [];
  for (const req of requests) {
    if (signal.aborted) { out.push({ id: req.node, status: 0 }); continue; }
    try {
      const r = await tokenFetch(ACTION_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req),
        signal: AbortSignal.any([signal, AbortSignal.timeout(BATCH_ACTION_TIMEOUT_MS)]) });
      out.push({ id: req.node, status: r.status, body: await r.json().catch(() => undefined) });
    } catch (e) {
      console.warn('argos: lote sem resposta', req.action, e && e.name);
      out.push({ id: req.node, status: 0 });
    }
  }
  return out;
}

// o nó do grafo como as ações, o lote e a fila do dono o leem
const actionNode = (n) => ({ id: n.id, type: n.type, label: n.label, state: n.state, registryState: n.registryState ?? null, herdrState: n.herdrState ?? null,
  lastEventTs: n.lastEventTs, pendingPermission: n.pendingPermission, gateFailed: n.gate === 'failed' });
const NOTE_LEVEL_TOAST = { info: 'info', warn: 'warn', error: 'bad' };

const graphSnapshot = (graph) => ({ nodes: L.validNodes(graph).map((n) => ({ id: n.id, type: n.type, ...(n.orchestrator ? { orchestrator: n.orchestrator } : {}), ...(n.herdr ? { herdr: n.herdr } : {}) })), edges: graph.edges || [] });

// apagar de propósito: o gesto é um `delete` (ou um lote com `delete`); só ele confirma a remoção em massa no servidor
const deletesNodes = (op) => op.kind === 'delete' || (op.kind === 'batch' && op.ops.some(deletesNodes));

const NO_NODES = [];
const NO_DRAFTS = {};

function Argos() {
  const { toast, go, frozen, setFrozen, toggleTheme, openNav } = useApp();
  const desk = useWide(768);
  const deskRef = useRef(desk);
  deskRef.current = desk;
  const [graph, setGraph] = useState(null);
  const [loadError, setLoadError] = useState(null);   // código estável do erro de leitura do grafo (L.graphErrorText traduz)
  const graphOkAt = useRef(null);
  const reloadGraph = useRef(() => {});
  const reloadOrphans = useRef(async () => {});
  const [orphans, setOrphans] = useState([]);
  // pares sessão/pane dos nós `terminal` cujo processo o servidor confirmou encerrado (conferência dos órfãos)
  const [deadPanes, setDeadPanes] = useState([]);
  const orphansToldRef = useRef(new Set());
  const [saveFails, setSaveFails] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  // vista no endereço (#/argos?v=1&…, canvas-urlstate): lida uma vez na abertura; endereço ilegível abre a vista padrão
  const [urlRead] = useState(() => M.urlstate.parseUrlState(location.hash));
  const [stateFilter, setStateFilter] = useState(() => urlRead.state.preset ?? DEFAULT_STATE);
  const [chips, setChips] = useState(() => urlRead.state.filters);
  const [search, setSearch] = useState(() => urlRead.state.search);
  const [searchTerm, setSearchTerm] = useState(() => urlRead.state.search);
  const [selection, setSelection] = useState(() => (urlRead.state.node ? [urlRead.state.node] : NO_NODES));
  // o canvas nunca some: a lista é um painel por cima dele (lateral na mesa, folha no celular), aberto sob demanda
  const [listOpen, setListOpen] = useState(false);
  const view = 'graph';
  const setView = (v) => setListOpen(v === 'list');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(() => !!urlRead.state.node);
  // esconder controles: só o canvas, sem ilhas, ferramentas nem gaveta (100% de canvas)
  const [focus, setFocusState] = useState(() => urlRead.state.focus === true || readStored(STORE_FOCUS) === true);
  const setFocus = (on) => { setFocusState(on); writeStored(STORE_FOCUS, on); };
  const focusRef = useRef(null);
  focusRef.current = { on: focus, available: true };
  const bare = focus;
  // com vários selecionados, a gaveta mostra um deles (o primário), escolhido na faixa do próprio painel
  const [focusPick, setFocusPick] = useState(null);
  const [themeTick, setThemeTick] = useState(0);
  const [layout, setLayout] = useState(() => L.readLayout(readStored(STORE_LAYOUT)));
  const [pins, setPins] = useState(() => new Set(L.readPins(readStored(STORE_PINS))));
  const [views, setViews] = useState(() => {
    const read = M.urlstate.readViews(readStored(STORE_VIEWS));
    if (read.dropped) console.warn('argos: vistas salvas recusadas', read.dropped);
    return read.views;
  });
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState(null);
  const pendingCamera = useRef(urlRead.state.camera);
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState(null);
  const [history, setHistory] = useState([]);
  const [liveEvents, setLiveEvents] = useState([]);
  const [live, setLive] = useState(false);
  const [action, setAction] = useState(null);
  const [runs, setRuns] = useState({});
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [file, setFile] = useState(null);
  const [menu, setMenu] = useState(null);
  const [cstate, setCstate] = useState(null);
  const [canvasError, setCanvasError] = useState(null);
  const [saveStatus, setSaveStatus] = useState({ kind: 'idle' });
  const saveStatusRef = useRef(saveStatus);
  // nós `terminal` do canvas aberto cujo pane o servidor confirmou encerrado (ocultos inclusive): o banner oferece tirá-los
  const deadIds = useMemo(() => (cstate ? NT.deadTerminalIds(cstate.doc, deadPanes) : NO_NODES), [cstate, deadPanes]);
  const deadIdsRef = useRef(deadIds);
  deadIdsRef.current = deadIds;
  const deadHidden = cstate ? deadIds.filter((id) => (cstate.doc.hidden ?? NO_NODES).includes(id)).length : 0;
  // canvas aberto (W2): o padrão ou o de uma worktree/rodada; o gravador e a leitura usam o id da ref
  const canvasIdRef = useRef(M.store.DEFAULT_CANVAS_ID);
  const [canvasInfo, setCanvasInfo] = useState(() => ({ id: M.store.DEFAULT_CANVAS_ID, name: 'Canvas padrão' }));
  // encaixe magnético (O3) e elevar/acoplar (O7): estado de tela, fora do documento
  const [snapOn, setSnapOn] = useState(() => readStored(STORE_SNAP) === true);
  // escala em que o nó aparece completo (conteúdo de terminal, nota e o resto): uma só para todos os tipos
  const [fullDetail, setFullDetailState] = useState(() => M.camera.fullDetailScale(readStored(STORE_DETAIL)));
  const setFullDetail = (k) => { const next = M.camera.fullDetailScale(k); setFullDetailState(next); writeStored(STORE_DETAIL, next); };
  const snapRef = useRef(snapOn);
  snapRef.current = snapOn;
  const [dockState, setDockState] = useState(() => M.dock.emptyDock());
  const dockRef = useRef(dockState);
  // filtros salvos da instância (L5): o conjunto lido do servidor e a seleção de chips que os comandos leem na hora
  const [savedFilters, setSavedFilters] = useState(() => M.savedFilters.emptySavedFilters());
  const savedRef = useRef(savedFilters);
  const chipsRef = useRef(chips);
  chipsRef.current = chips;
  const runSeq = useRef(0);
  const nowRef = useRef(now);
  nowRef.current = now;
  const cstateRef = useRef(null);
  const graphRef = useRef(null);
  graphRef.current = graph;
  const apiRef = useRef(null);
  const [canvasApi, setCanvasApi] = useState(null);
  const staleRef = useRef(() => {});
  // seleção lida pelos comandos do canvas na hora de rodar (o setState só redesenha depois)
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const portalPolicy = useRef(L.emptyPortalPolicy());
  // o que a montagem chama e só existe mais abaixo no render (commit, forças, toast, diálogos): reatribuído a cada render
  const host = useRef(null);
  const [ask, setAsk] = useState(null);
  const askRef = useRef(null);
  // camadas sobre o canvas: o quadro posicionado onde elas ficam, o balão aberto (id do agente) e os rascunhos por agente
  const stageRef = useRef(null);
  const [balloonId, setBalloonId] = useState(null);
  const [drafts, setDrafts] = useState(NO_DRAFTS);
  // painel do supervisor aberto ou fechado (a camada fica montada e observa os terminais mesmo fechada)
  const [supOpen, setSupOpen] = useState(false);
  // compositor flutuante: id do terminal que ele segue (ou null) e os rascunhos por terminal
  const [composer, setComposer] = useState(null);
  const composerRef = useRef(composer);
  composerRef.current = composer;
  const [composerDrafts, setComposerDrafts] = useState(NO_DRAFTS);
  // conexão armada no motor (acende o botão Conexão) e o popover de conexões aberto ({ id, at })
  const [linking, setLinking] = useState(false);
  const onLinkState = useCallback((from) => setLinking(from !== undefined), []);
  const [linksFor, setLinksFor] = useState(null);

  // terminais dos nós de agente: uma conexão SSE para os panes dos nós montados, foco do teclado, atenção e salto
  const ttyHost = useMemo(() => NT.createTtyHost({
    openStream: (url) => openSse(url),
    sendInput: sendHerdrInput,
    sendSize: sendHerdrSize,
    openPath: (id, path) => host.current.openTerminalFile(id, path),
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (h) => clearTimeout(h),
    nodeRect: (id) => cstateRef.current?.doc.nodes.find((n) => n.id === id),
    liveState: (id) => L.validNodes(graphRef.current).find((n) => n.id === id)?.state,
  }), []);
  useEffect(() => () => ttyHost.destroy(), [ttyHost]);
  useEffect(() => ttyHost.subscribe(() => setComposer((c) => (c === null ? null : CMP.followTarget(c, ttyHost.focused())))), [ttyHost]);

  // registros (tipos e comandos) e gravador: um de cada por abertura da página
  const registries = useMemo(() => {
    const baseRender = P.makeNodeRender(() => nowRef.current);
    // nó de agente com pane do herdr conhecido desenha o terminal; sem pane, o desenho de sempre (o fallback)
    const render = (type) => (type !== 'agent' ? baseRender(type) : (input) => <NT.AgentTtyNode key={input.id} input={input} host={ttyHost}
      fallback={baseRender(type)(input)} agentView={(kind, at) => window.ArgosTypesLive.agentView(liveDeps, kind, at)} grow={call('growNode')} />);
    const made = M.argos.createArgosRegistries({ actions: L.ACTIONS, stateFilters: L.STATE_FILTERS, render });
    // comando da leitura com atalho já tomado (RegistryError): fica de fora e o resto da página segue
    for (const def of L.readingCommandDefs()) {
      try { made.commands.register(def); } catch (e) { console.error('argos: comando da leitura recusado', def.id, e && e.code); }
    }
    // "Abrir terminal" / "Abrir cliente do herdr" no menu do agente: abre a sessão e leva à página Herdr
    const termOpenPort = { node: (id) => L.validNodes(graphRef.current).find((n) => n.id === id), open: (spec) => host.current.openTerminal(spec) };
    for (const def of L.termOpenCommandDefs(termOpenPort)) {
      try { made.commands.register(def); } catch (e) { console.error('argos: comando de abrir terminal recusado', def.id, e && e.code); }
    }
    const hiddenPort = { targets: (id) => host.current.hideTargets(id), hide: (ids) => host.current.hideNodes(ids),
      unhideAll: () => host.current.unhideNodes(host.current.hiddenIds()), count: () => host.current.hiddenIds().length, openList: () => host.current.openHiddenList() };
    for (const def of HID.hiddenCommandDefs(hiddenPort)) {
      try { made.commands.register(def); } catch (e) { console.error('argos: comando dos ocultos recusado', def.id, e && e.code); }
    }
    const call = (name) => (...args) => host.current[name](...args);
    const docNow = () => cstateRef.current?.doc ?? null;
    const api = {
      doc: { doc: () => docNow() ?? M.doc.emptyCanvasDoc(), selection: () => selectionRef.current, select: call('selectIds'), commit: call('commitOp'),
        reveal: (id) => apiRef.current?.revealNode(id, true), notify: call('notify') },
      dialogs: { askText: (r) => call('ask')({ kind: 'text', ...r }), choose: (r) => call('ask')({ kind: 'choose', ...r }), confirm: (r) => call('ask')({ kind: 'confirm', ...r }) },
      owner: { nodes: () => L.validNodes(graphRef.current).map(actionNode) },
      snap: { enabled: () => snapRef.current, setEnabled: call('setSnap') },
      dock: { state: () => dockRef.current, set: call('setDock') },
      savedFilters: { set: () => savedRef.current, current: () => chipsRef.current, apply: call('applyChips'), save: call('saveFilters'), reload: call('reloadFilters') },
      scope: { options: call('scopeOptions'), current: () => canvasIdRef.current, open: call('openScope'), openDefault: call('openDefaultCanvas') },
      sketch: { at: call('viewCenter') },
      tty: { nextAttention: call('ttyNextAttention'), jump: call('ttyJump'), release: () => ttyHost.focus(null), focused: () => ttyHost.focused() !== null,
        zoomable: () => host.current.ttyZoomTarget() !== null, zoomText: call('ttyZoomText') },
      focus: { enabled: () => focusRef.current.on, available: () => focusRef.current.available, setEnabled: call('setFocus') },
      terminals: { armTool: call('termArm'), target: () => host.current.termTarget(), edit: call('termEdit'), role: call('termRole'),
        connections: call('openLinks'), close: call('termClose'), roles: call('termRolesOpen'),
        closable: (id) => !!host.current.termClosable?.(id) },
      composer: { toggle: call('composerToggle'), available: () => host.current.composerAvailable() },
      supervisor: { toggle: call('supervisorToggle') },
      links: { start: () => host.current.linkStart() },
      notes: { target: () => host.current.noteTarget(), close: call('noteClose') },
      batch: {
        nodes: (ids) => { const byId = new Map(L.validNodes(graphRef.current).map((n) => [n.id, n])); return ids.map((id) => byId.get(id)).filter(Boolean).map(actionNode); },
        context: () => L.actionContextOf(graphRef.current),
        filteredIds: () => [...host.current.filteredIds()],
        confirm: (plan) => call('ask')({ kind: 'confirm', title: 'Confirmar o lote', text: plan.effect, phrase: plan.confirmPhrase })
          .then((ok) => ({ confirmed: ok, typed: ok ? plan.confirmPhrase : undefined })),
        send: call('sendBatch'),
        show: call('showBatch'),
      },
    };
    // texto dos nós do usuário: cada edição é um passo do desfazer (update) e o texto esvaziado apaga o nó (delete)
    const text = L.userTextHost({ note: M.note, history: M.history }, { doc: docNow, commit: call('commitOp'), fail: call('opFailed') });
    const userDeps = { fetch: tokenFetch, now: () => Date.now(), copy: call('copyText'), onTextChange: text.onTextChange, onRemove: text.onRemove,
      band: { doc: () => docNow() ?? undefined, live: call('bandLive'), focus: call('select') } };
    const liveDeps = { fetch: tokenFetch, now: () => Date.now(), get portalPolicy() { return portalPolicy.current; }, onOpen: call('openAgentFile') };
    // nó `terminal` (criado pela ferramenta Terminal): desenho do node-terminal; o menu são os comandos T2 de commands-canvas.
    // Registra antes dos tipos vivos, que mantêm o tipo já registrado; o nó no formato deles segue com o desenho deles.
    // o badge conta as conexões (arestas `link`), as mesmas linhas do popover que ele abre
    const terminalDeps = { roleOf: (slug) => host.current.termRoleOf(slug), linksOf: (id) => { const d = docNow(); return d ? M.links.linkCount(d, id) : 0; },
      onConnections: (id) => host.current.termRun(() => host.current.openLinks(id)), grow: call('growNode'),
      remove: (id) => host.current.termRun(() => host.current.termRemoveEnded([id])) };
    const liveTerminal = MOUNT_PARTS.typesLive.liveTypeDefs(liveDeps).find((d) => d.type === NT.TERMINAL_TYPE);
    let terminalDef = null;
    try {
      terminalDef = NT.registerTerminalType(made.types, (input) => (liveTerminal && NT.isLiveTerminalData(input.data) ? liveTerminal.draw.render(input)
        : <NT.TerminalNode key={input.id} input={input} host={ttyHost} deps={terminalDeps} />));
    } catch (e) { if (!e || typeof e.code !== 'string') throw e; console.error('argos: tipo terminal recusado', e.code); }
    const report = L.mountCanvasRegistries(made, MOUNT_PARTS, { api, userDeps, liveDeps });
    for (const r of report.refused) console.error('argos: comando ou tipo do canvas recusado', r.id, r.code);
    try {
      if (terminalDef) made.commands.checkTypeMenu(terminalDef);
    } catch (e) { if (!e || typeof e.code !== 'string') throw e; console.error('argos: menu do tipo terminal recusado', e.code); }
    return { ...made, userText: text };
  }, []);
  const { types, commands, userText } = registries;
  useMemo(() => CC.registerCameraCommands(commands), [commands]);
  // quando a tela relê o documento que mudou por fora (aviso do servidor, conferência de POLL_MS, volta da aba, gravador ocioso)
  const [externalStale, setExternalStale] = useState(false);
  const reloadRef = useRef(async () => true);
  // por que o documento vai ser gravado (user, undo, graph) e se o dono apagou de propósito; o gravador leva ao servidor e zera
  // (a causa e a confirmação ficam até o servidor aceitar: o reenvio depois de um 409 leva os mesmos cabeçalhos)
  const saveMeta = useMemo(() => M.store.createSaveMeta(), []);
  const graphSizeRef = useRef(null);
  const busyStateRef = useRef(() => null);
  const watch = useMemo(() => NT.createCanvasWatch({
    now: () => Date.now(), busy: () => busyStateRef.current(), reload: () => reloadRef.current(), onStale: setExternalStale,
    log: (reason) => console.debug('canvas: releitura pulada', reason),
  }), []);
  const saver = useMemo(() => M.store.createDocSaver({ put: (doc, options) => { const sent = saveMeta.peek(); return putCanvas(canvasUrl(canvasIdRef.current), doc, options, { ...sent, graphSize: graphSizeRef.current }).then((reply) => {
    if (reply.kind === 'saved') { saveMeta.saved(sent); watch.saved(reply.rev); }
    return reply;
  }); },
    setTimer: (run, ms) => setTimeout(run, ms), clearTimer: (h) => clearTimeout(h),
    fetchServer: () => getCanvas(canvasUrl(canvasIdRef.current)),
    // edição na fila: a tela não recebe o documento reconciliado (o envio dela já o leva em conta), mas fica atrás do servidor até reler
    onRebased: (doc) => { if (scheduledSeqRef.current !== sentSeqRef.current) { watch.diverged(); return; } const next = M.store.initialCanvasState(doc); cstateRef.current = next; setCstate(next); watch.loaded(doc.rev); },
    onStatus: (status) => {
      // `saving` sai logo depois de o gravador tirar o documento da fila: o que foi agendado até aqui já está a caminho
      if (status.kind === 'saving') sentSeqRef.current = scheduledSeqRef.current;
      saveStatusRef.current = status; setSaveStatus(status);
      // falhas seguidas: o selo só vira texto vermelho depois de L.SAVE_LOUD_AFTER; gravar de novo zera
      if (status.kind === 'error') setSaveFails((n) => n + 1); else if (status.kind === 'idle') setSaveFails(0);
      // volta a idle com a tela atrás do servidor (mudança por fora durante o envio): relê agora
      if (status.kind === 'idle') watch.settled({ hidden: document.hidden }).catch((e) => console.warn('canvas: releitura depois do envio falhou', e && e.name));
    }, onStale: (rev) => staleRef.current(rev) }), []);
  // há edição agendada e ainda não enviada (o gravador só diz `saving` depois do atraso de agrupamento)
  const scheduledSeqRef = useRef(0);
  const sentSeqRef = useRef(0);
  const scheduleSave = useCallback((doc) => { scheduledSeqRef.current += 1; saver.schedule(doc); }, [saver]);
  // por que o gravador não está livre: o estado dele (saving, error…), `fila` se há edição agendada e ainda não enviada, ou null
  const busyState = () => (saveStatusRef.current.kind !== 'idle' ? saveStatusRef.current.kind : scheduledSeqRef.current !== sentSeqRef.current ? 'fila' : null);
  busyStateRef.current = busyState;
  // portas do motor: identidade fixa (o motor as recebe por update); o estado lido sai das refs na hora
  const engineSnap = useMemo(() => ({ enabled: () => snapRef.current, move: M.snap.snapSelectionMove }), []);
  const engineDock = useMemo(() => ({
    edgeZone: M.dock.DOCK_LIMITS.edgeZone,
    edgeAt: (point, view) => M.dock.dockEdgeAt(point, view),
    toggleElevated: (id) => host.current.changeDock((state, doc) => M.dock.toggleElevated(state, doc, id)),
    dock: (id, edge) => host.current.changeDock((state, doc) => M.dock.dockNode(state, doc, id, edge)),
  }), []);

  // grava e guarda o estado novo do canvas (a fonte única é cstateRef; o setState só redesenha)
  const commit = useCallback((next, meta = {}) => {
    cstateRef.current = next; setCstate(next);
    // gesto do dono vence: grafo e gesto no mesmo envio contam como gesto; a confirmação só vale para apagar de propósito
    saveMeta.note(meta, scheduledSeqRef.current !== sentSeqRef.current);
    scheduleSave(next.doc);
  }, [scheduleSave, saveMeta]);

  // layout de forças: a simulação anda em fatias por quadro (reading-runner) e o resultado entra na pilha de desfazer como
  // um passo só. `reading` é o que as funções daqui leem do render atual (filtro, layout, pins)
  const reading = useRef({ visibleIds: new Set(), edges: [], layout: 'free', pins: new Set(), view: 'graph' });
  const runBase = useRef(null);
  const commitPlacements = (placements) => {
    const cur = cstateRef.current;
    if (!cur) return;
    const changed = L.changedPlacements(cur.doc.nodes, placements);
    if (!changed.length) return;
    try {
      const moves = changed.map((p) => M.history.opMove(cur.doc, p.id, p));
      commit(M.store.commitGesture(cur, moves.length === 1 ? moves[0] : M.history.opBatch(moves)));
    } catch (e) {
      console.error('canvas: posições das forças recusadas', e && e.code);
      toast({ kind: 'bad', title: 'Não deu para gravar o layout', desc: L.errorText(e && e.code, 'O canvas recusou as posições.') });
    }
  };
  const runFailed = (e) => {
    runBase.current = null; setRunning(false);
    console.error('canvas: forças pararam', e && e.code);
    toast({ kind: 'bad', title: 'O layout de forças parou', desc: L.errorText(e && e.code, 'A simulação falhou; as posições ficaram como estavam.') });
    const cur = cstateRef.current;
    if (cur) apiRef.current?.showDoc(M.store.projectView(cur.doc, reading.current.visibleIds, reading.current.edges));
  };
  const runDone = (result) => { runBase.current = null; setRunning(false); setLastRun(result); commitPlacements(result.placements); };
  const runHooks = useRef(null);
  runHooks.current = { done: runDone, fail: runFailed };
  const runner = useMemo(() => window.ArgosReadingRunner.createForceRunner({
    frame: (run) => requestAnimationFrame(run), cancel: (h) => cancelAnimationFrame(h), clock: () => performance.now(), reducedMotion: reducedMotion(),
    show: (placements) => { const base = runBase.current; if (base) apiRef.current?.showDoc({ ...base, nodes: L.withPositions(base.nodes, placements) }); },
    onDone: (result) => runHooks.current.done(result),
    onError: (e) => runHooks.current.fail(e),
  }), []);
  // para onde está e grava o parcial: gesto do dono, troca de layout, vista Lista, sincronia, saída da página
  const stopRun = () => {
    const partial = runner.stop();
    if (!partial) return;
    runBase.current = null; setRunning(false); setLastRun(partial);
    commitPlacements(partial.placements);
  };
  // `make(doc, neighbors)` cria a simulação sobre o que está visível; entrada recusada (ForceError) vira aviso e nada roda
  const startRun = (make) => {
    stopRun();
    const cur = cstateRef.current;
    const { visibleIds, edges, view: shownAs } = reading.current;
    if (!cur || shownAs !== 'graph' || !apiRef.current) return;
    const base = M.store.projectView(cur.doc, visibleIds, edges);
    let sim;
    try { sim = make(base, L.neighborMap(edges)); } catch (e) { runFailed(e); return; }
    runBase.current = base; setRunning(true);
    runner.start(sim);
  };
  const arrange = (pinned) => startRun((doc, neighbors) => M.force.startArrange({ doc, neighbors }, { pinned: pinned || reading.current.pins }));
  const stopRef = useRef(stopRun);
  stopRef.current = stopRun;
  // declarado antes do efeito do gravador: na saída, o parcial entra na fila antes do flush
  useEffect(() => () => stopRef.current(), []);
  // nó de agente novo nasce no tamanho que cabe o terminal (NT.AGENT_NODE_SIZE); os demais tipos, o padrão do registro
  // o rastreador conta leituras seguidas do grafo sem o nó (uma só leitura ruim não tira ninguém do canvas)
  const absence = useMemo(() => M.sync.createAbsenceTracker(), []);
  const syncOptions = useMemo(() => ({ layout: M.layout.FREE_LAYOUT, absence, trusted: !loadError, sizeOf: (type) => (type === 'agent' ? { ...NT.AGENT_NODE_SIZE } : types.sizeOf(type)) }), [types, absence, loadError]);
  const reconcile = useCallback((state) => {
    const g = graphRef.current;
    if (!g || g.v !== SUPPORTED_V) return state;
    return M.store.reconcileGraph(state, graphSnapshot(g), syncOptions).state;
  }, [syncOptions]);

  // documento do servidor; a pilha de desfazer recomeça (ela vale para o documento que o dono viu)
  // devolve false quando descartou a leitura: o dono editou (ou o gravador abriu) enquanto ela ia, e aplicar o documento lido
  // jogaria fora a edição da tela e, com ela, o nó recém-criado; o envio reconcilia com o servidor
  const loadCanvas = useCallback(async () => {
    const seq = scheduledSeqRef.current;
    try {
      const doc = await getCanvas(canvasUrl(canvasIdRef.current));
      if (cstateRef.current && (scheduledSeqRef.current !== seq || busyState() !== null)) {
        console.debug('canvas: leitura descartada, o gravador não estava livre', busyState());
        return false;
      }
      saver.setRev(doc.rev, doc);
      watch.loaded(doc.rev);
      const fresh = M.store.initialCanvasState(doc);
      const synced = reconcile(fresh);
      cstateRef.current = synced; setCstate(synced); setCanvasError(null);
      if (synced !== fresh) scheduleSave(synced.doc);
      reloadOrphans.current().catch((e) => console.warn('argos: órfãos indisponíveis', e && e.name));
      return true;
    } catch (e) {
      console.error('canvas: leitura falhou', e && e.code);
      setCanvasError(L.errorText(e && e.code, 'Não deu para ler o canvas.'));
      return false;
    }
  }, [saver, watch, reconcile, scheduleSave]);
  reloadRef.current = loadCanvas;
  staleRef.current = () => {
    toast({ kind: 'warn', title: 'Canvas atualizado', desc: 'Outra aba gravou antes: mostrando a versão dela.' });
    loadCanvas();
  };
  useEffect(() => { loadCanvas(); }, [loadCanvas]);
  // dono dos pedidos da página (política do portal, lote, escopo, filtros salvos): saem juntos na desmontagem
  const pageAbort = useMemo(() => new AbortController(), []);
  useEffect(() => () => pageAbort.abort(), [pageAbort]);
  const setDock = (next) => { dockRef.current = next; setDockState(next); };
  // nó que saiu do documento sai também da coluna e do painel elevado
  useEffect(() => {
    if (!cstate) return;
    const next = M.dock.reconcileDock(dockRef.current, cstate.doc);
    if (next !== dockRef.current) setDock(next);
  }, [cstate]);
  const commitSaved = (set) => { savedRef.current = set; setSavedFilters(set); };
  const reloadFilters = async () => { commitSaved(await getSavedFilters(pageAbort.signal)); };
  // na abertura: o filtro padrão vale só se o endereço não trouxe filtro e o dono ainda não mexeu nos chips
  useEffect(() => {
    const urlFiltered = M.filters.activeFilterCount(urlRead.state.filters) > 0;
    getSavedFilters(pageAbort.signal).then((set) => {
      if (pageAbort.signal.aborted) return;
      commitSaved(set);
      const initial = M.savedFilters.defaultSelection(set);
      if (initial && !urlFiltered && M.filters.activeFilterCount(chipsRef.current) === 0) setChips(initial);
    }).catch((e) => {
      if (pageAbort.signal.aborted) return;
      console.warn('argos: filtros salvos sem leitura', e && e.code);
      toast({ kind: 'warn', title: 'Filtros salvos indisponíveis', desc: L.errorText(e && e.code, 'Não deu para ler os filtros salvos.') });
    });
  }, [pageAbort]);
  const saveFilters = async (next) => {
    const result = await putSavedFilters(next, pageAbort.signal);
    if (!result.ok) return result;
    commitSaved({ ...next, rev: result.rev });
    return { ok: true };
  };
  // troca de canvas: grava o atual antes (gravação pendente que não sai impede a troca: iria para o canvas novo)
  const openCanvas = async (id, name) => {
    if (id === canvasIdRef.current) return;
    stopRun();
    await saver.flush();
    if (saveStatusRef.current.kind === 'error') throw codedError('O canvas atual não foi gravado: troque depois que gravar.', SWITCH_UNSAVED);
    canvasIdRef.current = id;
    setCanvasInfo({ id, name });
    cstateRef.current = null; setCstate(null);
    setDock(M.dock.emptyDock());
    selectionRef.current = NO_NODES; setSelection(NO_NODES);
    await loadCanvas();
  };
  const openScope = async (scope) => {
    const { id, name } = await postScope(scope, pageAbort.signal);
    await openCanvas(id, name);
  };
  const openDefaultCanvas = () => openCanvas(M.store.DEFAULT_CANVAS_ID, 'Canvas padrão');
  useEffect(() => {
    getPortalPolicy(pageAbort.signal).then((policy) => { if (!pageAbort.signal.aborted) portalPolicy.current = policy; });
  }, [pageAbort]);
  useEffect(() => {
    const leave = () => { saver.flush({ leaving: true }); };
    const hide = () => { if (document.visibilityState === 'hidden') leave(); };
    // recarregar ou fechar com edição que o servidor ainda não tem: o navegador pergunta antes (a nota nova sumia no reload)
    const guard = (e) => { if (busyStateRef.current() === null) return; leave(); e.preventDefault(); e.returnValue = ''; };
    addEventListener('pagehide', leave);
    addEventListener('beforeunload', guard);
    document.addEventListener('visibilitychange', hide);
    return () => {
      removeEventListener('pagehide', leave);
      removeEventListener('beforeunload', guard);
      document.removeEventListener('visibilitychange', hide);
      // sai da página com mudança na fila: grava antes de largar o gravador (flush nunca rejeita)
      saver.flush({ leaving: true }).then(() => saver.dispose());
    };
  }, [saver]);

  // grafo: a cada POLL_MS, parado com a aba escondida
  useEffect(() => {
    let alive = true;
    const f = () => {
      if (document.hidden) return;
      getJSON('/api/argos/graph').then((g) => { if (!alive) return; if (g && g.error) throw codedError(g.error, typeof g.code === 'string' ? g.code : String(g.error)); graphOkAt.current = Date.now(); setGraph(g); setLoadError(null); })
        .catch((e) => alive && setLoadError(typeof e.code === 'string' ? e.code : 'graph_unreachable'));
    };
    reloadGraph.current = f;
    f();
    const t = setInterval(f, POLL_MS);
    document.addEventListener('visibilitychange', f);
    return () => { alive = false; clearInterval(t); document.removeEventListener('visibilitychange', f); };
  }, []);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), CLOCK_MS); return () => clearInterval(t); }, []);
  // documento gravado por fora da página (a CLI `hades canvas` do orquestrador recruta, liga e dispensa; um agente; outra aba): o
  // servidor empurra `{ id, rev }` pelo stream e a tela relê na hora; a conferência de POLL_MS e a volta da aba são a reserva
  // (stream caído, painel reiniciado). Quem decide reler ou pular, e por quê, é NT.createCanvasWatch.
  useEffect(() => {
    let alive = true;
    const swallow = (what) => (e) => console.warn(`canvas: ${what} falhou`, e && e.name);
    const check = async () => {
      if (document.hidden) { watch.skip('hidden'); return; }
      const list = await getJSON(CANVASES_URL);
      const row = list && Array.isArray(list.canvases) ? list.canvases.find((c) => c && c.id === canvasIdRef.current) : null;
      if (alive && row) await watch.observe({ serverRev: row.rev, hidden: document.hidden });
    };
    const t = setInterval(() => { check().catch(swallow('conferência da revisão')); }, POLL_MS);
    const visible = () => { if (!document.hidden) check().catch(swallow('conferência ao voltar à aba')); };
    document.addEventListener('visibilitychange', visible);
    let stream = null;
    try {
      stream = openSse(CANVAS_STREAM_URL);
      stream.addEventListener('canvas', (ev) => {
        let d = null;
        try { d = JSON.parse(ev.data); } catch (e) { console.warn('canvas: aviso do servidor ilegível', e && e.name); }
        if (alive && d && d.id === canvasIdRef.current) watch.observe({ serverRev: d.rev, hidden: document.hidden }).catch(swallow('releitura pelo aviso'));
      });
      // registro de terminais (argos/terminals.json) mudou: vive fora do documento, então o grafo se relê
      stream.addEventListener('registry', () => { if (alive) { reloadGraph.current(); reloadOrphans.current().catch(swallow('leitura dos órfãos')); } });
      // (re)ligou: confere o que passou enquanto o stream estava fora
      stream.addEventListener('open', () => { check().catch(swallow('conferência ao ligar o stream')); });
    } catch (e) {
      console.warn('canvas: stream indisponível, fica o polling', e && e.name);
    }
    return () => { alive = false; clearInterval(t); document.removeEventListener('visibilitychange', visible); if (stream) stream.close(); };
  }, [watch]);
  // "o canvas mudou por fora": grava o que está na fila e relê; com o gravador em erro a releitura jogaria a edição fora, então só avisa
  const swallowReload = (e) => console.error('canvas: recarregar falhou', e && e.name);
  const reloadExternal = async () => {
    await saver.flush();
    if (saveStatusRef.current.kind === 'error') { toast({ kind: 'warn', title: 'Canvas sem gravar', desc: 'Há edição sua que não foi gravada: resolva o erro de gravação antes de recarregar.' }); return; }
    await loadCanvas();
  };

  // panes do herdr dos nós de agente: a visão geral só é lida com nó de agente no canvas
  const hasAgentNode = !!cstate && cstate.doc.nodes.some((n) => n.type === 'agent');
  const [herdrTargets, setHerdrTargets] = useState(null);
  useEffect(() => {
    if (!hasAgentNode) return undefined;
    const abort = new AbortController();
    const read = () => {
      if (document.hidden) return;
      getHerdrOverview(abort.signal).then((overview) => setHerdrTargets(NT.ttyTargetsOf(overview)), (e) => {
        if (!abort.signal.aborted) console.warn('argos: visão do herdr indisponível; os terminais seguem com os panes de antes', e && e.code);
      });
    };
    read();
    const t = setInterval(read, TTY_TARGETS_MS);
    return () => { abort.abort(); clearInterval(t); };
  }, [hasAgentNode]);
  // panes dos nós `terminal`: o par que a criação gravou no documento (a chave só muda quando um par muda)
  const docTargetsKey = useMemo(() => JSON.stringify([...NT.ttyTargetsOfDoc(cstate?.doc)]), [cstate]);
  useEffect(() => {
    const next = new Map(JSON.parse(docTargetsKey));
    for (const n of L.validNodes(graph)) {
      const target = NT.ttyTargetOf(herdrTargets, n);
      if (target) next.set(n.id, target);
    }
    ttyHost.setTargets(next);
    ttyHost.refreshStates();
  }, [ttyHost, herdrTargets, graph, docTargetsKey]);
  // motor: a alça não encolhe o nó-terminal abaixo do mínimo, e o zoom decide o desenho só de cabeçalho
  useEffect(() => {
    if (!canvasApi) return undefined;
    canvasApi.setMinSize((node) => ((node.type === 'agent' || node.type === NT.TERMINAL_TYPE) && ttyHost.target(node.id) ? NT.ttyMinNodeSize(ttyHost.frameOf(node.id)) : undefined));
    ttyHost.setZoom(canvasApi.getCamera().k);
    const off = canvasApi.onCamera((cam) => ttyHost.setZoom(cam.k));
    return () => { off(); canvasApi.setMinSize(null); };
  }, [canvasApi, ttyHost]);

  // sincronia ao vivo: nó novo entra perto dos vizinhos, nó sumido sai, o que já tem posição não se move
  const loaded = cstate !== null;
  // Com forças: a rodada em curso grava o parcial antes, e nó novo se acomoda com os que já estavam fixos.
  const syncRef = useRef(null);
  syncRef.current = (snapshot) => {
    const first = cstateRef.current;
    if (!first) return;
    const r0 = M.store.reconcileGraph(first, snapshot, syncOptions);
    if (!r0.changed) return;
    const wasRunning = runner.running();
    stopRun();
    const cur = cstateRef.current;
    const r = cur === first ? r0 : M.store.reconcileGraph(cur, snapshot, syncOptions);
    if (!r.changed) return;
    const before = new Set(cur.doc.nodes.map((n) => n.id));
    graphSizeRef.current = snapshot.nodes.length;
    commit(r.state, { cause: 'graph' });
    if (reading.current.layout !== 'force') return;
    const fresh = r.state.doc.nodes.some((n) => !before.has(n.id));
    if (fresh) arrange(new Set([...before, ...reading.current.pins]));
    else if (wasRunning) arrange();
  };
  useEffect(() => {
    if (!cstateRef.current || !graph || graph.v !== SUPPORTED_V) return;
    syncRef.current(graphSnapshot(graph));
  }, [graph, loaded]);

  // filtro em duas camadas: o preset de estado (Choice) e, por cima, os chips (canvas-filters); filtrado some do desenho e do Tab
  // ocultos (tirados pelo dono) nunca entram; arquivados e "Última atividade" valem sobre o agente em qualquer preset
  const hiddenList = cstate?.doc.hidden;
  const hiddenSet = useMemo(() => new Set(hiddenList ?? NO_NODES), [hiddenList]);
  const agentPasses = useCallback((n) => M.filters.passesAgentDims(n, chips, now), [chips, now]);
  const activity = M.filters.activityOf(chips);
  const preset = useMemo(() => L.filterGraph(graph, { registry: ALL, role: ALL, state: stateFilter, hidden: hiddenSet, agent: agentPasses,
    narrowing: activity !== M.filters.ACTIVITY_ANY.id }, now), [graph, stateFilter, now, hiddenSet, agentPasses, activity]);
  const chipNodes = useMemo(() => L.filterNodes(preset.nodes), [preset]);
  // orquestrador → agente: o terminal do canvas no pane que o registro do agente gravou (o grafo só liga agente → agente)
  const orchDoc = cstate?.doc;
  const orchEdges = useMemo(() => (orchDoc ? M.recruit.orchestrationEdges(orchDoc, preset.nodes) : NO_NODES), [orchDoc, preset]);
  const presetEdges = useMemo(() => (orchEdges.length ? [...preset.edges, ...orchEdges] : preset.edges), [preset, orchEdges]);
  const chipResult = useMemo(() => M.filters.applyFilters(chipNodes, presetEdges, chips, now), [chipNodes, presetEdges, chips, now]);
  const filterDims = useMemo(() => M.filters.buildFilterBar(chipNodes, presetEdges, chips, now), [chipNodes, presetEdges, chips, now]);
  const shown = useMemo(() => ({
    nodes: preset.nodes.filter((n) => chipResult.visible.has(n.id)),
    // o terminal não passa pelos filtros (é nó do usuário): a aresta dele fica enquanto o agente estiver visível
    edges: [...chipResult.edges, ...orchEdges.filter((e) => chipResult.visible.has(e.to))],
  }), [preset, chipResult, orchEdges]);
  const chipCount = M.filters.activeFilterCount(chips);
  // nó do usuário (nota, texto, desenho, portal…) não passa pelos filtros do grafo: fica sempre na vista
  const userIds = useMemo(() => (cstate ? cstate.doc.nodes.filter((n) => !M.doc.isLiveNodeType(n.type) && !hiddenSet.has(n.id)).map((n) => n.id) : NO_NODES), [cstate, hiddenSet]);
  const visibleIds = useMemo(() => new Set([...shown.nodes.map((n) => n.id), ...userIds]), [shown, userIds]);
  const graphById = useMemo(() => new Map(L.validNodes(graph).map((n) => [n.id, n])), [graph]);
  // worktrees de agente que o grafo mostra, para o seletor de canvas (W2); chave acima do limite do servidor fica de fora
  const scopeOptions = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const n of L.validNodes(graph)) {
      if (n.type !== 'agent' || !n.registry || !n.label) continue;
      const key = `${n.registry}:${n.label}`;
      if (seen.has(key) || key.length > M.store.CANVAS_STORE_LIMITS.scopeKeyChars) continue;
      seen.add(key);
      out.push({ kind: 'worktree', key, label: n.shortId || `${n.label} · ${n.registry === '_skill' ? 'a própria skill' : n.registry}` });
    }
    // uma entrada por rodada com plano aprovado (o grafo traz o id curto pelo hash do plano)
    for (const r of Array.isArray(graph?.registries) ? graph.registries : []) {
      const round = r && r.round;
      if (!round || typeof round.id !== 'string' || typeof round.name !== 'string' || seen.has(`round:${round.id}`)) continue;
      seen.add(`round:${round.id}`);
      out.push({ kind: 'round', key: round.id, label: `Rodada ${round.name} · ${round.id}` });
    }
    return out;
  }, [graph]);
  // o filtro só esconde: a posição fica no documento
  const viewDoc = useMemo(() => (cstate ? M.store.projectView(cstate.doc, visibleIds, shown.edges) : null), [cstate, visibleIds, shown]);
  const engineSelection = useMemo(() => M.store.visibleSelection(selection, visibleIds), [selection, visibleIds]);
  const sel = M.store.primarySelection(selection);
  // os selecionados visíveis, na ordem da seleção, como a gaveta os lista
  const focusNodes = useMemo(() => (engineSelection.map((id) => {
    const g = graphById.get(id);
    if (g) return { id, label: g.label, type: g.type, state: g.state };
    const own = cstate?.doc.nodes.find((n) => n.id === id);
    return own ? { id, label: types.get(own.type)?.label || own.type, type: own.type } : null;
  }).filter(Boolean)), [engineSelection, graphById, cstate, types]);
  const focusPrimary = sel && focusNodes.some((n) => n.id === sel) ? sel
    : (focusNodes.find((n) => n.id === focusPick) || focusNodes[0] || null)?.id ?? null;
  const order = useMemo(() => (viewDoc ? M.selection.tabOrder(viewDoc.nodes).map((id) => graphById.get(id)).filter(Boolean) : []), [viewDoc, graphById]);
  // o nó da gaveta: o primário (as ações do painel e do teclado agem sobre ele)
  const panelId = focusPrimary;
  const selected = panelId ? graphById.get(panelId) || null : null;
  const agentSel = selected && selected.type === 'agent' ? selected : null;
  const actions = useMemo(() => L.availableActions(agentSel, detail), [agentSel, detail]);
  reading.current = { visibleIds, edges: shown.edges, layout, pins, view };

  // forças: vista Lista para a rodada (o motor saiu da tela) e grava onde parou
  useEffect(() => { if (view !== 'graph') stopRef.current(); }, [view]);
  const setLayoutMode = (next) => {
    if (next === layout) return;
    setLayout(next); writeStored(STORE_LAYOUT, next);
    reading.current = { ...reading.current, layout: next };
    if (next === 'force') arrange(); else stopRun();
  };
  const togglePin = (id) => {
    const next = pins.has(id) ? M.force.releaseNode(pins, id) : M.force.pinNode(pins, id);
    setPins(next); writeStored(STORE_PINS, [...next]);
  };

  // busca: termo com espera curta; acende os achados e enquadra a caixa deles (Enter reenquadra)
  useEffect(() => { const t = setTimeout(() => setSearchTerm(search), SEARCH_DEBOUNCE_MS); return () => clearTimeout(t); }, [search]);
  const searchIndex = useMemo(() => M.search.createSearchIndex(viewDoc ? L.searchItems(shown.nodes, viewDoc.nodes) : []), [shown, viewDoc]);
  const searchResult = useMemo(() => (searchTerm.trim() ? searchIndex.search(searchTerm) : null), [searchIndex, searchTerm]);
  const searchRef = useRef(searchResult);
  searchRef.current = searchResult;
  const frameSearch = () => {
    const box = searchRef.current?.box;
    const api = apiRef.current;
    if (box && api && reading.current.view === 'graph') api.fitRect(L.frameBox(box, api.viewport(), SEARCH_FRAME_MAX_ZOOM), true);
  };
  useEffect(() => { frameSearch(); }, [searchTerm]);
  const clearSearch = () => { setSearch(''); setSearchTerm(''); };

  // destaque: busca com achado vence; senão a vizinhança da seleção (2 saltos); sem os dois, tudo normal
  const emphasis = useMemo(() => {
    if (!viewDoc) return null;
    const ids = viewDoc.nodes.map((n) => n.id);
    const hood = engineSelection.length ? M.neighbors.neighborhood(engineSelection, shown.edges, ids) : null;
    return L.emphasisFor(hood, searchResult ? searchResult.ids : null, ids);
  }, [viewDoc, engineSelection, shown, searchResult]);
  const emphasisRef = useRef(emphasis);
  emphasisRef.current = emphasis;
  useEffect(() => { apiRef.current?.setEmphasis(emphasis); }, [emphasis]);

  // vistas salvas (câmera com nome) no armazenamento do navegador; a regra e os códigos de erro são de canvas-urlstate
  const changeViews = (change) => {
    if (!change.ok) return change.code;
    setViews(change.views); writeStored(STORE_VIEWS, change.views);
    return null;
  };
  const applyCamera = (camera, animate = true) => {
    if (reading.current.view === 'graph' && apiRef.current) apiRef.current.setCamera(camera, animate);
    else { pendingCamera.current = camera; setView('graph'); }
  };
  const applyView = (name) => { const v = views.find((x) => x.name === name); if (v) applyCamera(v.camera); };
  const [saveAsk, setSaveAsk] = useState(0);
  // pedidos de fora para abrir um item dentro de um popover (limpos quando o popover fecha)
  const [hiddenWanted, setHiddenWanted] = useState(false);
  const [saveWanted, setSaveWanted] = useState(false);

  // vista no endereço: câmera e busca trocam a entrada atual do histórico; filtro e nó abrem uma nova (Voltar desfaz).
  // O que a própria página escreveu não volta a ser aplicado; endereço de outra página não é lido nem escrito
  const lastHash = useRef(null);
  const cameraTimer = useRef(null);
  const urlRef = useRef(null);
  urlRef.current = { filters: chips, search: searchTerm, node: sel, focus };
  // preset ausente = estado padrão: o hash sem preset é o mesmo de antes e links já emitidos seguem valendo
  const presetInLink = linkPreset(stateFilter);
  if (presetInLink) urlRef.current.preset = presetInLink;
  const writeHash = (push) => {
    if (!isArgosHash(location.hash)) return;
    const api = reading.current.view === 'graph' ? apiRef.current : null;
    let hash;
    try { hash = M.urlstate.serializeUrlState({ ...urlRef.current, camera: api ? api.getCamera() : null }); } catch (e) {
      console.warn('argos: vista fora do endereço', e && e.code);
      return;
    }
    if (hash === location.hash) return;
    lastHash.current = hash;
    // `history` aqui é o estado de eventos da página: o do navegador vai por window
    window.history[push ? 'pushState' : 'replaceState'](window.history.state, '', hash);
  };
  const writeRef = useRef(writeHash);
  writeRef.current = writeHash;
  const firstWrite = useRef(true);
  useEffect(() => { writeRef.current(!firstWrite.current); firstWrite.current = false; }, [chips, sel, focus]);
  // o preset abre entrada nova como o filtro; na montagem quem escreve é o efeito acima, e mudança junto com os chips
  // não empilha duas entradas (o segundo write acha o hash igual e sai)
  const presetWritten = useRef(presetInLink);
  useEffect(() => {
    if (presetWritten.current === presetInLink) return;
    presetWritten.current = presetInLink;
    writeRef.current(true);
  }, [presetInLink]);
  useEffect(() => { writeRef.current(false); }, [searchTerm]);
  const applyUrl = (st) => {
    setChips(st.filters); setSearch(st.search); setSearchTerm(st.search);
    setStateFilter(st.preset ?? DEFAULT_STATE);
    setSelection(st.node ? [st.node] : NO_NODES); setPanelOpen(!!st.node);
    // Voltar e Avançar restauram o foco de cada entrada; a preferência lembrada só muda pelo botão, comando ou tecla
    setFocusState(st.focus === true);
    // sem animação: a câmera já está no destino quando o efeito de escrita compara o endereço
    if (st.camera) movedBy('url', () => applyCamera(st.camera, false));
    // link com nó e sem câmera: leva até o nó, como na abertura
    else if (st.node) movedBy('url', () => apiRef.current?.revealNode(st.node, false));
  };
  const applyUrlRef = useRef(applyUrl);
  applyUrlRef.current = applyUrl;
  const warnUrl = (code) => toast({ kind: 'warn', title: 'Vista do endereço ignorada', desc: L.errorText(code, 'Endereço ilegível.') });
  useEffect(() => { if (urlRead.warning) warnUrl(urlRead.warning); }, []);
  useEffect(() => {
    const onNav = () => {
      const hash = location.hash;
      if (!isArgosHash(hash) || hash === lastHash.current) return;
      lastHash.current = hash;
      const read = M.urlstate.parseUrlState(hash);
      if (read.warning) warnUrl(read.warning);
      else applyUrlRef.current(read.state);
    };
    addEventListener('hashchange', onNav);
    addEventListener('popstate', onNav);
    return () => { removeEventListener('hashchange', onNav); removeEventListener('popstate', onNav); clearTimeout(cameraTimer.current); };
  }, []);
  const onCanvasReady = (api) => {
    apiRef.current = api;
    setCanvasApi(api);
    const id = M.store.primarySelection(engineSelection);
    if (id) api.revealNode(id, false);
    api.setEmphasis(emphasisRef.current);
    // câmera do endereço ou de uma vista: depois da câmera de abertura do CanvasPane (que espera o contêiner ter área)
    const cam = pendingCamera.current;
    pendingCamera.current = null;
    if (cam) {
      const place = () => { const v = api.viewport(); if (v.w <= 0 || v.h <= 0) return false; api.setCamera(cam, false); return true; };
      if (!place()) { const off = api.onFrame(() => { if (place()) off(); }); }
    }
    api.onFrame(() => {
      clearTimeout(cameraTimer.current);
      cameraTimer.current = setTimeout(() => writeRef.current(false), CAMERA_HASH_DEBOUNCE_MS);
    });
  };
  const saveView = (name) => (apiRef.current && view === 'graph' ? changeViews(M.urlstate.addView(views, name, apiRef.current.getCamera())) : M.urlstate.VIEW_ERRORS.invalidCamera);

  // detalhe do nó (histórico, herdr, PR, arquivos) e o SSE do diário; fecha ao trocar de nó e ao desmontar
  const selId = agentSel?.id || null;
  useEffect(() => {
    setDetail(null); setDetailError(null); setHistory([]); setLiveEvents([]); setLive(false);
    if (!selId) return;
    let alive = true;
    const f = () => getJSON(`/api/argos/node/${encodeURIComponent(selId)}?limit=100`).then((d) => {
      if (!alive) return;
      if (d.error) { setDetailError(L.errorText(d.code, d.error)); return; }
      setDetail(d); setDetailError(null); setHistory(d.timeline?.events || []);
    }).catch((e) => alive && setDetailError(String(e.message || e)));
    f();
    const t = setInterval(f, DETAIL_POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [selId]);
  // Moirai: estimado × real da unidade (só leitura; 404 = unidade sem registro, sem estimativa = sem seção)
  const [moirai, setMoirai] = useState(null);
  const selName = agentSel?.label || null, selRegistry = agentSel?.registry || null;
  useEffect(() => {
    setMoirai(null);
    if (!selName) return;
    let alive = true;
    const f = () => getJSON(`/api/moirai/unit/${encodeURIComponent(selName)}?registry=${encodeURIComponent(selRegistry || '')}`)
      .then((d) => alive && setMoirai(d && !d.error ? d : null)).catch(() => alive && setMoirai(null));
    f();
    const t = setInterval(f, DETAIL_POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [selName, selRegistry]);
  const streamUrl = detail?.timeline?.stream;
  useEffect(() => {
    if (!streamUrl) return;
    const es = openSse(streamUrl);
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    es.onmessage = (m) => {
      let ev = null;
      try { ev = JSON.parse(m.data); } catch (e) { return; }
      if (ev && typeof ev === 'object') setLiveEvents((cur) => L.mergeEvents(cur, [ev]));
    };
    return () => { es.close(); setLive(false); };
  }, [streamUrl]);
  const events = useMemo(() => L.mergeEvents(history, liveEvents), [history, liveEvents]);

  // a câmera leva o nó para a área livre ao lado da gaveta (mesa) ou acima da folha (celular), em vez de deixá-lo debaixo dela
  // todo movimento de câmera que não é pan/zoom do dono passa por aqui: com `argos.cameraDebug` ligado no localStorage, o console
  // mostra a origem, a câmera de partida e a seleção antes e depois (a prova de qual caminho moveu a câmera)
  const cameraTrace = useRef(M.camera.createCameraTrace());
  const movedBy = useCallback((origin, move) => {
    const api = apiRef.current;
    const entry = { origin, from: api?.getCamera(), selectionBefore: selectionRef.current };
    move();
    if (!api) return;
    cameraTrace.current.push({ ...entry, selectionAfter: selectionRef.current });
    try { if (localStorage.getItem('argos.cameraDebug')) console.debug('argos: câmera', cameraTrace.current.entries.at(-1)); } catch (e) { /* sem armazenamento, sem depuração */ }
  }, []);
  const revealFree = useCallback((id) => {
    const api = apiRef.current;
    const node = cstateRef.current?.doc.nodes.find((n) => n.id === id);
    if (!api || !node) return;
    const v = api.viewport();
    const free = deskRef.current || !FOCUS ? { ...v, w: v.w - (FOCUS ? FOCUS.focusPanelPx(v.w) : 0) } : { ...v, h: v.h * (1 - FOCUS.SHEET_MAX) };
    if (free.w <= 0 || free.h <= 0) return;
    api.setCamera(M.camera.revealRect(api.getCamera(), node, free), true);
  }, []);
  const select = useCallback((id) => {
    setSelection(id ? [id] : NO_NODES); setPanelOpen(!!id);
    if (id) movedBy('select', () => { apiRef.current?.revealNode(id, true); revealFree(id); });
  }, [revealFree, movedBy]);
  // a gaveta abre com a seleção (um ou vários: a faixa dela escolhe o primário); sem seleção ela não existe. Abre sem nó escolhido
  const onSelectionChange = useCallback((ids, origin = 'command') => {
    // a seleção que a sincronia com o grafo poda ou refaz não leva a câmera ao nó que sobrou
    const reveals = M.camera.selectionRevealsCamera(origin) && ids.length === 1;
    setSelection(ids.length ? ids : NO_NODES);
    setPanelOpen(ids.length >= 1);
    if (reveals) movedBy(`selection:${origin}`, () => revealFree(ids[0]));
  }, [revealFree, movedBy]);
  const step = (dir) => select(L.neighbor(order, sel, dir));

  const run = useCallback(async (act, args, typed) => {
    if (!agentSel) return;
    const node = agentSel;
    const id = ++runSeq.current;
    const label = `${act.label} · ${node.label}`;
    const put = (r) => setRuns((cur) => ({ ...cur, [node.id]: [{ id, label, ...r }, ...(cur[node.id] || []).filter((x) => x.id !== id)].slice(0, RUNS_KEEP) }));
    put({ status: 'running', at: Date.now() });
    try {
      const res = await post('/api/argos/action', L.buildBody(node, act, args, typed));
      put({ status: 'ok', at: Date.now(), output: res.output || '' });
      toast({ kind: 'ok', title: act.label, desc: node.label });
    } catch (e) {
      const text = L.errorText(e.code, e.message);
      put({ status: 'error', at: Date.now(), output: text });
      toast({ kind: 'bad', title: L.actionFailTitle(act.id), desc: text });
    }
  }, [agentSel, toast]);
  const pick = useCallback((a) => setAction(a), []);

  // desfazer e refazer: o passo que aponta para um nó que já saiu do grafo é descartado (canvas-store)
  const stepHistory = (direction) => {
    stopRun();
    const cur = cstateRef.current;
    const next = cur && M.store.stepHistory(cur, direction);
    if (next) commit(next, { cause: 'undo' });
  };
  // Gesto do dono vence: a rodada de forças para e grava o parcial antes. Com forças ligadas, o nó arrastado fica fixo onde
  // o dono o soltou e só a vizinhança dele volta a se mexer.
  const afterOwnerMove = (op) => {
    if (reading.current.layout !== 'force') return;
    const moved = L.movedIds(op);
    if (!moved.length) return;
    const pinned = moved.reduce((acc, id) => M.force.pinNode(acc, id), reading.current.pins);
    setPins(pinned); writeStored(STORE_PINS, [...pinned]);
    reading.current = { ...reading.current, pins: pinned };
    startRun((doc, neighbors) => M.force.startReheat({ doc, neighbors, from: moved[0] }, { pinned }));
  };
  const opHooks = useRef(null);
  opHooks.current = { stop: stopRun, after: afterOwnerMove };
  const onOp = useCallback((op) => {
    opHooks.current.stop();
    const cur = cstateRef.current;
    if (!cur) return;
    try { commit(M.store.commitGesture(cur, op), { confirmRemoval: deletesNodes(op) }); } catch (e) {
      console.error('canvas: gesto recusado', e && e.code);
      toast({ kind: 'bad', title: 'Não deu para aplicar a mudança', desc: L.errorText(e && e.code, 'O canvas recusou a mudança.') });
      return;
    }
    opHooks.current.after(op);
  }, [commit, toast]);

  // operação de comando ou de nó do usuário: um passo do desfazer; a recusa sobe com o código para quem chamou
  const commitOp = (op) => {
    stopRun();
    const cur = cstateRef.current;
    if (!cur) throw Object.assign(new Error('canvas ainda não carregado'), { code: M.history.HISTORY_ERRORS.invalidOp });
    commit(M.store.commitGesture(cur, op), { confirmRemoval: deletesNodes(op) });
  };
  // ocultar e reexibir: um passo do desfazer cada; o nó fica no documento (posição guardada), só sai do desenho
  const hideNodes = (ids) => {
    const cur = cstateRef.current;
    if (!cur) return;
    try {
      const op = M.history.opHide(cur.doc, ids);
      if (!op) return;
      commitOp(op);
      toast({ kind: 'info', title: op.ids.length === 1 ? 'Nó oculto do canvas' : `${op.ids.length} nós ocultos do canvas`, desc: 'Ctrl+Z desfaz; "Ocultos do canvas", em Filtros, reexibe.' });
    } catch (e) { if (!e || typeof e.code !== 'string') throw e; opFailed(e.code); }
  };
  const unhideNodes = (ids) => {
    const cur = cstateRef.current;
    if (!cur) return;
    try { const op = M.history.opUnhide(cur.doc, ids); if (op) commitOp(op); } catch (e) { if (!e || typeof e.code !== 'string') throw e; opFailed(e.code); }
  };
  const opFailed = (code) => toast({ kind: 'bad', title: 'Não deu para aplicar a mudança', desc: L.errorText(code, 'O canvas recusou a mudança.') });
  // uma pergunta por vez: a que estava aberta é cancelada pela nova
  const askOwner = (req) => new Promise((answer) => {
    askRef.current?.answer(askRef.current.kind === 'confirm' ? false : null);
    askRef.current = { ...req, answer };
    setAsk(askRef.current);
  });
  const closeAsk = () => { askRef.current = null; setAsk(null); };
  const copyText = (text) => navigator.clipboard.writeText(text).then(() => toast({ kind: 'ok', title: 'Copiado' }),
    () => toast({ kind: 'bad', title: 'Não deu para copiar', desc: 'O navegador bloqueou o acesso à área de transferência. Selecione o texto e copie à mão.' }));
  const docNode = (id) => cstateRef.current?.doc.nodes.find((n) => n.id === id) || null;
  // comandos user:* do menu dos nós do usuário: duplicar, desfocar e excluir são os de organização sobre esse nó
  const userMenu = async (kind, id) => {
    const n = docNode(id);
    if (!n) return;
    const viaCommand = (cmd) => { host.current.selectIds([id]); commands.get(cmd)?.run(ctxFor(null)); };
    if (kind === 'duplicate') viaCommand('clip:duplicate');
    else if (kind === 'blur') viaCommand('blur:toggle');
    else if (kind === 'remove') viaCommand('clip:delete');
    else if (kind === 'edit') {
      const text = await askOwner({ kind: 'text', title: 'Editar o texto', initial: typeof n.data.text === 'string' ? n.data.text : '' });
      if (text === null) return;
      if (text.trim() === '') userText.onRemove(id); else userText.onTextChange(id, { text, style: n.data.style });
    } else if (kind === 'copyCommands') {
      const view = window.ArgosTypesUser.unitSketchView(M, n);
      if (view.ok) copyText(view.text); else toast({ kind: 'bad', title: 'Esboço inválido', desc: view.message || view.code });
    } else if (kind === 'linkNote') {
      const notes = cstateRef.current.doc.nodes.filter((x) => x.type === 'note');
      if (!notes.length) { toast({ kind: 'warn', title: 'Nenhuma nota no canvas' }); return; }
      const noteId = await askOwner({ kind: 'choose', title: 'Ligar qual nota à banda?', options: notes.map((x) => ({ value: x.id, label: String(x.data.note || x.id) })) });
      if (noteId === null || !docNode(id)) return;
      try {
        const op = M.bands.linkBand(cstateRef.current.doc, n.data.group, noteId);
        if (op) commitOp(op); else toast({ kind: 'info', title: 'A nota já está ligada à banda' });
      } catch (e) { if (!e || typeof e.code !== 'string') throw e; opFailed(e.code); }
    }
  };
  // terminal com o teclado: o foco é do host, a câmera leva o nó à tela (e ao detalhe completo, onde ele monta)
  const focusTty = (id) => {
    if (!id) return false;
    ttyHost.focus(id);
    movedBy('tty-jump', () => apiRef.current?.centerNode(id));
    return true;
  };
  // "Ampliar para o terminal": o nó pequeno cresce até o mínimo, um passo do desfazer
  // zoom do texto: o terminal focado no teclado, senão o nó com terminal (agente ou criado no canvas) selecionado sozinho
  const ttyZoomTarget = () => {
    const focusedId = ttyHost.focused();
    if (focusedId && ttyHost.frameOf(focusedId)) return focusedId;
    const ids = selectionRef.current;
    return ids.length === 1 && ttyHost.frameOf(ids[0]) ? ids[0] : null;
  };
  const ttyZoomText = (kind) => {
    const id = ttyZoomTarget();
    const n = id ? docNode(id) : null;
    const frame = id ? ttyHost.frameOf(id) : null;
    if (!n || !frame) return false;
    // herdr com pane.set_size: o zoom muda a fonte e o herdr refaz a grade; o nó não muda de tamanho
    const fontZoom = ttyHost.stepTextZoom(id, kind, NT.TEXT_ZOOM_LIMITS);
    if (fontZoom !== null) {
      toast({ kind: 'info', title: `Texto do terminal em ${Math.round(fontZoom * 100)}%` });
      return true;
    }
    const next = NT.ttyZoomSize({ w: n.w, h: n.h }, frame, kind);
    if (next.w === n.w && next.h === n.h) return true;
    try { commitOp(M.history.opResize(cstateRef.current.doc, id, { x: n.x, y: n.y, w: next.w, h: next.h })); }
    catch (e) { if (!e || typeof e.code !== 'string') throw e; opFailed(e.code); return false; }
    toast({ kind: 'info', title: `Texto do terminal em ${Math.round(next.scale * 100)}%` });
    return true;
  };
  const growNode = (id, min) => {
    const n = docNode(id);
    if (!n) return;
    try { commitOp(M.history.opResize(cstateRef.current.doc, id, { x: n.x, y: n.y, w: Math.max(n.w, min.w), h: Math.max(n.h, min.h) })); }
    catch (e) { if (!e || typeof e.code !== 'string') throw e; opFailed(e.code); }
  };

  // ---- terminal criado no canvas (T2): ferramenta, modal, papel, conexões, fechar e papéis ----
  const [termReady, setTermReady] = useState(false);
  const [termTool, setTermTool] = useState(null);
  const [termDialog, setTermDialog] = useState(null);
  const [rolesOpen, setRolesOpen] = useState(false);
  const [termRoles, setTermRoles] = useState(NO_NODES);
  const [termPresets, setTermPresets] = useState(NO_NODES);
  useEffect(() => {
    if (view !== 'graph' || termReady) return undefined;
    let alive = true;
    loadTerminalScripts().then(() => { if (alive) setTermReady(true); }, (e) => {
      terminalScripts = null;
      console.error('argos: ferramentas do terminal indisponíveis', e && e.code);
    });
    return () => { alive = false; };
  }, [view, termReady]);
  const termClient = useMemo(() => (termReady ? window.ArgosTerminalCreate.createTerminalClient({ fetch: tokenFetch }) : null), [termReady]);
  const reloadTermLists = useCallback(async () => {
    if (!termClient) return;
    const [roles, presets] = await Promise.all([termClient.roles(), termClient.presets()]);
    if (roles.ok) setTermRoles(roles.value);
    if (presets.ok) setTermPresets(presets.value);
    if (!roles.ok || !presets.ok) console.warn('argos: papéis ou predefinições indisponíveis', roles.ok ? presets.code : roles.code);
  }, [termClient]);
  useEffect(() => {
    const check = () => { if (!document.hidden) reloadOrphans.current().catch((e) => console.warn('argos: órfãos indisponíveis', e && e.name)); };
    check();
    const timer = setInterval(check, ORPHANS_POLL_MS);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => { reloadTermLists().catch((e) => console.error('argos: leitura dos papéis falhou', e && e.name)); }, [reloadTermLists]);
  const termFailed = (r) => {
    if (r.code === 'cancelled') return;
    toast({ kind: 'bad', title: 'Não deu para criar o terminal', desc: window.ArgosTerminalCreate.errorText(r) });
  };
  // erro de programa num fluxo do terminal: registra e avisa, a página segue
  const termRun = (task) => { task().catch((e) => { console.error('argos: fluxo do terminal falhou', e); opFailed(e && e.code); }); };
  const termLoaded = () => {
    if (termClient) return true;
    toast({ kind: 'info', title: 'As ferramentas do terminal ainda estão carregando' });
    return false;
  };
  // confirmação pelo nome (D2 e o acesso remoto): o diálogo só confirma com o nome digitado, que volta como `confirm`
  const askTermName = (title, text) => (name) => askOwner({ kind: 'confirm', title, text, phrase: name }).then((ok) => (ok ? name : null));
  const remoteName = askTermName('Confirmar pelo acesso remoto', 'Pelo acesso remoto, mexer num terminal pede o nome dele.');
  const termCommit = (make) => {
    const cur = cstateRef.current;
    if (!cur) { opFailed(M.history.HISTORY_ERRORS.invalidOp); return false; }
    try { commitOp(make(cur.doc)); return true; } catch (e) { if (!e || typeof e.code !== 'string') throw e; opFailed(e.code); return false; }
  };
  const isTerminal = (id) => { const n = docNode(id); return n?.type === NT.TERMINAL_TYPE && !NT.isLiveTerminalData(n.data); };
  const termTarget = () => {
    const focusedId = ttyHost.focused();
    if (focusedId && isTerminal(focusedId)) return focusedId;
    const ids = selectionRef.current;
    return ids.length === 1 && isTerminal(ids[0]) ? ids[0] : null;
  };
  const terminalNames = () => (cstateRef.current?.doc.nodes || []).filter((n) => n.type === NT.TERMINAL_TYPE).map((n) => NT.readTerminalData(n.data).name).filter(Boolean);
  // cria o processo pelo servidor e só então o nó (um passo do desfazer); o nó novo fica selecionado e na tela
  const placeTerminal = async (form, rect) => {
    const r = await window.ArgosTerminalCreate.createTerminal({ client: termClient, form, askName: remoteName });
    if (!r.ok) return r;
    const wanted = r.data.herdr;
    const isPane = (n) => {
      const h = n.type === NT.TERMINAL_TYPE ? NT.readTerminalData(n.data).herdr : null;
      return !!h && !!wanted && h.pane === wanted.pane && h.session === wanted.session;
    };
    // aplica a inclusão no documento atual; idempotente: se o nó deste pane já está lá (tentativa anterior), devolve o dele
    const apply = () => {
      const doc = cstateRef.current?.doc;
      if (!doc) return null;
      const existing = doc.nodes.find(isPane);
      if (existing) return existing.id;
      const id = M.clipboard.sequentialIds(doc, TERMINAL_ID_PREFIX)('node');
      const top = Math.min(M.doc.CANVAS_LIMITS.layer - 1, doc.nodes.reduce((z, n) => Math.max(z, n.z), 0));
      return termCommit((d) => M.history.opCreate(d, [NT.newTerminalNode({ id, rect, data: r.data, top })])) ? id : null;
    };
    const saved = await NT.ensureNodeSaved({
      apply, has: (d, id) => d.nodes.some((n) => n.id === id && isPane(n)),
      flush: () => saver.flush(), fetchDoc: () => getCanvas(canvasUrl(canvasIdRef.current)), reread: () => loadCanvas(),
    });
    if (!saved.ok) {
      console.error('argos: terminal criado, nó não gravado', saved.code, saved.attempts);
      toast({ kind: 'bad', title: 'Terminal criado, mas o nó não foi gravado', desc: 'O terminal está vivo e aparece como fora do canvas: use "Trazer para o canvas".' });
      reloadOrphans.current().catch((e) => console.warn('argos: órfãos indisponíveis', e && e.name));
      return r;
    }
    host.current.selectIds([saved.id]); apiRef.current?.revealNode(saved.id, true);
    return r;
  };
  // órfãos: terminal registrado e vivo sem nó em canvas nenhum; o aviso vem do servidor, a tela só mostra e oferece trazer
  reloadOrphans.current = async () => {
    const res = await tokenFetch(ORPHANS_URL, { cache: 'no-store', signal: AbortSignal.timeout(CANVAS_TIMEOUT_MS) });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { name: `http_${res.status}` });
    const d = await res.json();
    const list = d && d.checked === true && Array.isArray(d.orphans) ? d.orphans : [];
    setOrphans(list);
    const dead = d && d.checked === true && Array.isArray(d.dead) ? d.dead : [];
    setDeadPanes(dead);
    ttyHost.markExited(dead.map((p) => p && p.pane));
    const fresh = list.filter((o) => !orphansToldRef.current.has(`${o.session}\0${o.pane}`));
    fresh.forEach((o) => orphansToldRef.current.add(`${o.session}\0${o.pane}`));
    if (fresh.length > 0) toast({ kind: 'warn', title: 'Terminal fora do canvas', desc: fresh.map((o) => o.name).join(', ') });
  };
  const bringOrphans = () => termRun(async () => {
    const c = host.current.viewCenter();
    for (const [i, o] of orphans.entries()) {
      const id = M.clipboard.sequentialIds(cstateRef.current.doc, TERMINAL_ID_PREFIX)('node');
      const rect = { x: c.x - NT.TERMINAL_SIZE.w / 2 + i * 24, y: c.y - NT.TERMINAL_SIZE.h / 2 + i * 24, ...NT.TERMINAL_SIZE };
      const top = Math.min(M.doc.CANVAS_LIMITS.layer - 1, cstateRef.current.doc.nodes.reduce((z, n) => Math.max(z, n.z), 0));
      if (!termCommit((d) => M.history.opCreate(d, [NT.newTerminalNode({ id, rect, data: NT.orphanNodeData(o), top })]))) return;
    }
    await saver.flush();
    await reloadOrphans.current();
  });
  // o que o retângulo solto faz, por ferramenta da barra (ArgosCanvasToolbar.registerTool): (retângulo da tela, câmera)
  const toolRect = {
    terminal: (rect, cam) => setTermDialog({ mode: 'create', tab: 'details',
      rect: window.ArgosCanvasToolbar.rectToWorld(cam, rect, { size: NT.TERMINAL_SIZE, min: NT.ttyMinNodeSize(null) }) }),
    note: (rect, cam) => placeNote(rect, cam),
  };
  const onToolRect = (rect) => {
    const run = toolRect[termTool];
    setTermTool(null);
    if (run && apiRef.current) run(rect, apiRef.current.getCamera());
  };
  const quickStart = (preset) => termRun(async () => {
    if (!termLoaded()) return;
    const TC = window.ArgosTerminalCreate;
    const c = host.current.viewCenter();
    const rect = { x: c.x - NT.TERMINAL_SIZE.w / 2, y: c.y - NT.TERMINAL_SIZE.h / 2, ...NT.TERMINAL_SIZE };
    const form = { ...TC.applyPreset(TC.EMPTY_FORM, preset), name: TC.nextTerminalName(preset.name, terminalNames()) };
    const r = await placeTerminal(form, rect);
    if (r.ok) toast({ kind: 'ok', title: 'Terminal criado', desc: form.name }); else termFailed(r);
  });
  const submitTerm = async (form) => {
    const d = termDialog;
    if (!d) return { ok: true };
    if (d.mode === 'create') {
      const r = await placeTerminal(form, d.rect);
      if (r.ok) setTermDialog(null);
      return r;
    }
    const n = docNode(d.id);
    if (!n) return { ok: true };
    const TC = window.ArgosTerminalCreate;
    const current = NT.readTerminalData(n.data);
    let data = n.data;
    // a caixa Orquestrador mudou: o servidor reinicia só o processo com (ou sem) as instruções de gerente
    if (form.orchestrator !== (current.orchestrator === true)) {
      const r = await TC.changeRole({ client: termClient, data: n.data, role: current.role || null, orchestrator: form.orchestrator, askName: remoteName });
      if (!r.ok) return r;
      data = r.data;
    }
    if (docNode(d.id) && termCommit((doc) => M.history.opUpdate(doc, d.id, TC.editedData(data, form)))) setTermDialog(null);
    return { ok: true };
  };
  const savePreset = (form) => termRun(async () => {
    const r = await termClient.savePreset(window.ArgosTerminalCreate.presetOf(form));
    if (!r.ok) { termFailed(r); return; }
    toast({ kind: 'ok', title: 'Predefinição gravada', desc: r.value.name });
    await reloadTermLists();
  });
  const termEdit = async (id, tab) => {
    const n = docNode(id);
    if (!n || !termLoaded()) return;
    setTermDialog({ mode: 'edit', id, tab, initial: window.ArgosTerminalCreate.formOf(n.data) });
  };
  const termRole = async (id) => {
    const n = docNode(id);
    if (!n || !termLoaded()) return;
    const current = NT.readTerminalData(n.data).role || '';
    const options = [{ value: '', label: 'Sem papel' }, ...termRoles.map((r) => ({ value: r.slug, label: r.name }))];
    // o diálogo abre na primeira opção: a atual vem primeiro
    options.sort((a, b) => (b.value === current) - (a.value === current));
    const slug = await askOwner({ kind: 'choose', title: 'Papel do terminal', text: 'Trocar reinicia só o processo do agente; o nó e a conversa no canvas ficam.', options });
    if (slug === null || slug === current) return;
    const r = await window.ArgosTerminalCreate.changeRole({ client: termClient, data: n.data, role: slug || null, askName: remoteName });
    if (!r.ok) { termFailed(r); return; }
    if (docNode(id) && termCommit((doc) => M.history.opUpdate(doc, id, r.data))) toast({ kind: 'ok', title: 'Papel trocado', desc: 'O agente reiniciou com as instruções novas.' });
  };
  const termClose = async (id) => {
    const n = docNode(id);
    if (!n || !termLoaded()) return;
    const name = NT.readTerminalData(n.data).name || 'terminal';
    const r = await window.ArgosTerminalCreate.closeTerminal({ client: termClient, data: n.data,
      askName: askTermName('Fechar terminal', `Encerra o processo do agente no herdr e tira "${name}" do canvas. Desfazer devolve só o nó, sem o processo.`) });
    if (!r.ok) { termFailed(r); return; }
    if (ttyHost.focused() === id) ttyHost.focus(null);
    await removeTermNodes([id], 'O processo foi encerrado, mas o nó não saiu do canvas');
  };
  // o processo já não existe: o nó sai do documento e só termina quando o servidor grava sem ele (um 409 não o devolve)
  const removeTermNodes = async (ids, failTitle) => {
    const removed = await NT.ensureNodeRemoved({
      remove: () => {
        const doc = cstateRef.current?.doc;
        if (!doc) return false;
        const present = ids.filter((id) => doc.nodes.some((n) => n.id === id));
        return present.length === 0 || termCommit((d) => M.history.opDelete(d, present));
      },
      gone: (d) => !d.nodes.some((n) => ids.includes(n.id)),
      flush: () => saver.flush(), fetchDoc: () => getCanvas(canvasUrl(canvasIdRef.current)), reread: () => loadCanvas(),
    });
    if (!removed.ok) {
      console.error('argos: nó do terminal encerrado não saiu', removed.code, removed.attempts);
      toast({ kind: 'bad', title: failTitle, desc: 'Use "Remover do canvas" no nó para tentar de novo.' });
    }
    return removed.ok;
  };
  const termRemoveEnded = async (ids) => {
    if (ids.length === 0) return;
    ids.forEach((id) => { if (ttyHost.focused() === id) ttyHost.focus(null); });
    if (await removeTermNodes(ids, 'Não deu para tirar do canvas os terminais encerrados')) {
      toast({ kind: 'ok', title: ids.length === 1 ? 'Terminal encerrado removido' : `${ids.length} terminais encerrados removidos`, desc: 'Desfazer devolve o nó, sem o processo.' });
    }
  };
  // Delete num terminal com pane fecha o processo (o mesmo diálogo de Ctrl+Alt+W); nó sem pane ou já encerrado só sai do documento
  const termClosable = (id) => {
    const n = docNode(id);
    if (!n || !isTerminal(id) || !NT.readTerminalData(n.data).herdr) return false;
    return !ttyHost.exitedOf(id) && !deadIdsRef.current.includes(id);
  };
  // ---- nota, conexões e compositor montados na página ----
  const noteClient = useMemo(() => {
    const deps = { fetch: tokenFetch, now: () => Date.now() };
    return MOUNT_PARTS.typesUser.createNoteClient(deps, MOUNT_PARTS.typesUser.resolveModel(deps));
  }, []);
  const noteText = (code) => `${MOUNT_PARTS.typesUser.NOTE_MESSAGES[code] ?? 'Não foi possível concluir.'} (${code})`;
  // nome do nó na tela: o rótulo do grafo, o nome do terminal ou o arquivo da nota
  const nodeLabel = (id) => {
    const g = graphById.get(id);
    if (g) return g.label;
    const own = docNode(id);
    if (!own) return undefined;
    if (own.type === NT.TERMINAL_TYPE) return NT.readTerminalData(own.data).name || undefined;
    if (own.type === M.note.NOTE_TYPE && typeof own.data.note === 'string') return own.data.note;
    return types.get(own.type)?.label || own.type;
  };
  const noteTarget = () => {
    const ids = selectionRef.current;
    return ids.length === 1 && docNode(ids[0])?.type === M.note.NOTE_TYPE ? ids[0] : null;
  };
  // ferramenta Nota: o nó nasce no retângulo (um passo do desfazer), em Raw para escrever; o arquivo nasce na 1ª gravação
  const placeNote = (screenRect, cam) => {
    const doc = cstateRef.current?.doc;
    const noteType = types.get(M.note.NOTE_TYPE);
    if (!doc || !noteType) { opFailed(M.history.HISTORY_ERRORS.invalidOp); return; }
    const rect = window.ArgosCanvasToolbar.rectToWorld(cam, screenRect, { size: noteType.defaultSize, min: { w: M.note.NOTE_FILE_LIMITS.minW, h: M.note.NOTE_FILE_LIMITS.minH } });
    const id = M.clipboard.sequentialIds(doc, NOTE_ID_PREFIX)('node');
    let made;
    try { made = M.note.createNoteFromRect(doc, { id, rect, token: noteToken }); } catch (e) { if (!e || typeof e.code !== 'string') throw e; opFailed(e.code); return; }
    window.ArgosNodeNote.rememberMode(made.note, 'raw');
    if (termCommit(() => made.op)) { host.current.selectIds([id]); apiRef.current?.revealNode(id, true); }
  };
  // fechar a nota (mod+alt+w e o menu do nó): confirma, tira o nó e manda apagar o arquivo (a rota só apaga o da pasta padrão)
  const noteClose = async (id) => {
    const before = cstateRef.current?.doc;
    if (!before || !M.note.closeNotePlan(before, id)) return;
    const ok = await askOwner({ kind: 'confirm', title: 'Fechar a nota?',
      text: 'Tira a nota do canvas e apaga o arquivo dela se ele está na pasta padrão das notas; arquivo em outro lugar fica onde está. Desfazer devolve o nó, não o arquivo apagado.' });
    if (!ok) return;
    // o documento pode ter mudado com o diálogo aberto: o plano sai do atual
    const doc = cstateRef.current?.doc;
    const plan = doc && M.note.closeNotePlan(doc, id);
    if (!plan || !termCommit(() => plan.op)) return;
    const r = await noteClient.remove(plan.note);
    if (!r.ok) toast({ kind: 'warn', title: 'A nota saiu do canvas, mas o arquivo ficou', desc: noteText(r.code) });
    else toast({ kind: 'ok', title: 'Nota fechada', desc: r.deleted ? 'O arquivo foi apagado.' : 'O arquivo fica onde está (fora da pasta padrão).' });
  };
  // soltar .md/.markdown/.txt de fora: a nota aponta para o arquivo sem movê-lo; cada uma é um passo do desfazer
  const linkDroppedNotes = async (paths, at) => {
    let placed = 0;
    for (const path of paths) {
      // em sequência: cada nota nova entra no documento que a anterior deixou
      const r = await noteClient.link(path);
      if (!r.ok) { toast({ kind: 'bad', title: 'Não deu para abrir o arquivo como nota', desc: `${path}: ${noteText(r.code)}` }); continue; }
      const doc = cstateRef.current?.doc;
      if (!doc) return;
      const id = M.clipboard.sequentialIds(doc, NOTE_ID_PREFIX)('node');
      const step = placed * DROP_STEP;
      if (termCommit((d) => M.note.createNoteNode(d, { id, note: r.name, x: at.x + step, y: at.y + step }).op)) { placed += 1; host.current.selectIds([id]); }
    }
    if (placed) toast({ kind: 'ok', title: placed === 1 ? 'Nota criada do arquivo' : `${placed} notas criadas dos arquivos`, desc: 'O arquivo fica onde está; a nota aponta para ele.' });
  };
  // o compositor e as notas tratam o próprio soltar (anexo, imagem): o que eles já aceitaram não vira nota
  const acceptsDrop = (e) => !e.isDefaultPrevented() && [...(e.dataTransfer?.types || [])].some((t) => DROP_TYPES.includes(t));
  const onStageDragOver = (e) => {
    if (!acceptsDrop(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'link';
  };
  const onStageDrop = (e) => {
    if (!acceptsDrop(e) || !apiRef.current || !stageRef.current) return;
    e.preventDefault();
    const paths = M.note.noteDropPaths(e.dataTransfer.getData('text/uri-list'));
    if (!paths.length) {
      const noteFiles = [...(e.dataTransfer.files || [])].some((f) => M.note.isNoteFileName(f.name));
      toast(noteFiles ? { kind: 'warn', title: 'Não deu para abrir o arquivo como nota',
        desc: 'O navegador não enviou o caminho do arquivo. Crie a nota pela ferramenta Nota e use "Mover para…".' }
        : { kind: 'info', title: 'Só arquivos .md, .markdown ou .txt viram nota' });
      return;
    }
    const box = stageRef.current.getBoundingClientRect();
    const at = M.camera.screenToWorld(apiRef.current.getCamera(), { x: e.clientX - box.left, y: e.clientY - box.top });
    termRun(() => linkDroppedNotes(paths, at));
  };
  // conexão pelo teclado (mod+l) e pelo botão Conexão: a origem é o terminal focado que conecta, senão o nó selecionado sozinho
  const linkStart = () => {
    const api = apiRef.current;
    if (!api) return false;
    const focusedId = ttyHost.focused();
    const fromTty = focusedId !== null && M.links.canStartLink(docNode(focusedId) ?? undefined) ? focusedId : undefined;
    if (fromTty !== undefined) {
      // o teclado sai do terminal para o canvas, onde ficam o Esc que cancela e o Enter que completa
      ttyHost.focus(null);
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    }
    return api.startLink(fromTty);
  };
  const toggleLink = () => {
    if (linking) { apiRef.current?.cancelLink(); return; }
    commands.get('tty:link')?.run(ctxFor(null));
  };
  const armTool = (id) => {
    if (id !== null) apiRef.current?.cancelLink();
    setTermTool(id);
  };
  // popover de conexões (badge do terminal, "Conexões…" do terminal e da nota): abre no canto de cima à direita do nó
  const openLinks = async (id) => {
    const n = docNode(id);
    const api = apiRef.current;
    if (!n || !api) return;
    setLinksFor({ id, at: M.camera.worldToScreen(api.getCamera(), { x: n.x + n.w, y: n.y }) });
  };
  // popover e compositor somem com o nó que saiu do documento (fechar, desfazer, sincronia)
  useEffect(() => {
    if (!cstate) return;
    const has = (id) => cstate.doc.nodes.some((n) => n.id === id);
    if (linksFor && !has(linksFor.id)) setLinksFor(null);
    if (composer !== null && !has(composer)) setComposer(null);
  }, [cstate, linksFor, composer]);
  // diretório sugerido na descoberta de papéis: a worktree do canvas aberto, quando ele é de uma
  const scopeWorktree = () => L.validNodes(graphRef.current).find((n) => n.type === 'agent' && n.worktree
    && M.store.scopedCanvasId({ kind: 'worktree', key: `${n.registry}:${n.label}` }) === canvasIdRef.current)?.worktree || '';
  host.current = {
    setFocus, growNode,
    termRun, termTarget, termEdit, termRole, termClose, termRemoveEnded, termClosable,
    openLinks, linkStart, noteTarget, noteClose,
    composerToggle: () => setComposer((c) => (c !== null ? null : ttyHost.focused())),
    supervisorToggle: () => setSupOpen((o) => !o),
    composerAvailable: () => composerRef.current !== null || ttyHost.focused() !== null,
    termArm: () => { if (!termLoaded()) return; setView('graph'); setTermTool('terminal'); },
    termRolesOpen: () => { if (termLoaded()) setRolesOpen(true); },
    termRoleOf: (slug) => termRoles.find((r) => r.slug === slug) || null,
    ttyNextAttention: () => focusTty(ttyHost.nextAttention()),
    ttyJump: (n) => focusTty(ttyHost.jumpTarget(n)),
    ttyZoomTarget, ttyZoomText,
    selectIds: (ids) => { selectionRef.current = ids.length ? [...ids] : NO_NODES; onSelectionChange(ids); },
    select, commitOp, opFailed, copyText, ask: askOwner,
    hideTargets: (id) => HID.hideTargets(engineSelection, id), hideNodes, unhideNodes,
    openTerminal: (spec) => { void HadesCore.TermOpen.openAndGo(spec, { toast, go }); },
    // link de caminho no terminal do nó: vira nota ao lado do nó pelo mesmo caminho do soltar; a raiz permitida é o servidor quem decide
    openTerminalFile: (id, path) => {
      const n = cstateRef.current?.doc.nodes.find((x) => x.id === id);
      termRun(() => linkDroppedNotes([path], n ? { x: n.x + n.w + DROP_STEP, y: n.y } : { x: 0, y: 0 }));
    },
    hiddenIds: () => cstateRef.current?.doc.hidden ?? NO_NODES, openHiddenList: () => { setHiddenWanted(true); setFiltersOpen(true); },
    notify: ({ level, text }) => toast({ kind: NOTE_LEVEL_TOAST[level] || 'info', title: text }),
    filteredIds: () => shown.nodes.map((n) => n.id),
    sendBatch: (requests) => {
      toast({ kind: 'busy', title: 'Lote em andamento', desc: plural(requests.length, 'pedido', 'pedidos') });
      return sendBatch(requests, pageAbort.signal);
    },
    showBatch: (result) => {
      const t = result.totals;
      toast({ kind: t.error || t.refused ? 'warn' : 'ok', title: 'Lote concluído',
        desc: [`${t.ok} ok`, t.refused ? `${t.refused} recusados` : null, t.error ? `${t.error} sem sucesso` : null, result.excluded.length ? `${result.excluded.length} de fora` : null].filter(Boolean).join(' · ') });
    },
    bandLive: () => new Map(L.validNodes(graphRef.current).filter((n) => n.type === 'agent').map((n) => [n.id, { state: n.state, waitingOwner: L.needsAttention(n) }])),
    openAgentFile: (t) => {
      if (t.agent && t.role) setFile({ name: t.agent, file: t.role });
      else toast({ kind: 'info', title: 'Arquivo sem leitor no painel', desc: t.path });
    },
    setSnap: (on) => { snapRef.current = on; setSnapOn(on); writeStored(STORE_SNAP, on); },
    setDock,
    // gesto do motor (duplo clique, soltar na borda): erro do modelo (código estável) vira aviso
    changeDock: (next) => {
      const cur = cstateRef.current;
      if (!cur) return;
      try { setDock(next(dockRef.current, cur.doc)); } catch (e) {
        if (!e || typeof e.code !== 'string') throw e;
        toast({ kind: 'warn', title: 'Não deu para elevar ou acoplar', desc: e.message });
      }
    },
    applyChips: (selection) => setChips(selection),
    saveFilters, reloadFilters,
    scopeOptions: () => scopeOptions,
    openScope, openDefaultCanvas,
    viewCenter: () => {
      const api = apiRef.current;
      if (!api) return { x: 0, y: 0 };
      const v = api.viewport();
      return M.camera.screenToWorld(api.getCamera(), { x: v.w / 2, y: v.h / 2 });
    },
  };

  // seletor de canvas na barra do card: padrão, uma entrada por worktree de agente do grafo (chave <registro>:<agente>, rótulo
  // com o id curto), uma por rodada com plano aprovado e "Rodada…" para digitar outra chave
  const canvasItems = [{ value: M.store.DEFAULT_CANVAS_ID, label: 'Canvas padrão' },
    ...scopeOptions.map((o) => ({ value: M.store.scopedCanvasId(o), label: o.label })), { value: ROUND_OPTION, label: 'Abrir rodada…' }];
  if (!canvasItems.some((it) => it.value === canvasInfo.id)) canvasItems.splice(1, 0, { value: canvasInfo.id, label: canvasInfo.name });
  const pickCanvas = (value) => {
    const fail = (e) => { console.error('argos: troca de canvas falhou', e && e.code); toast({ kind: 'bad', title: 'Não deu para abrir o canvas', desc: L.errorText(e && e.code, (e && e.message) || 'A troca falhou.') }); };
    if (value === ROUND_OPTION) {
      askOwner({ kind: 'text', title: 'Chave da rodada' }).then((key) => (key === null ? undefined : openScope({ kind: 'round', key }))).catch(fail);
      return;
    }
    if (value === M.store.DEFAULT_CANVAS_ID) { openDefaultCanvas().catch(fail); return; }
    const option = scopeOptions.find((o) => M.store.scopedCanvasId(o) === value);
    if (option) openScope({ kind: option.kind, key: option.key }).catch(fail);
  };

  const canUndo = !!cstate && M.history.canUndo(cstate.history);
  const canRedo = !!cstate && M.history.canRedo(cstate.history);
  // o que as condições e os rótulos dos comandos leem; `node` é o nó do menu (ou o selecionado)
  const ctxFor = (node) => ({
    selectedLabel: node ? node.label : null,
    availableActions: L.availableActions(node, node && node.id === selId ? detail : null).map((a) => a.id),
    canUndo, canRedo,
    handlers: {
      palette: () => setPalette((p) => !p),
      next: () => step(1),
      prev: () => step(-1),
      open: () => setPanelOpen(!!sel || focusNodes.length > 0),
      close: () => { if (sel) select(null); else if (panelOpen) setPanelOpen(false); },
      fit: () => apiRef.current?.fitAll(true),
      ...CC.cameraHandlers(() => apiRef.current, () => sel),
      toggleView: () => setListOpen((o) => !o),
      help: () => setHelp(true),
      setView,
      openFilters: () => setFiltersOpen(true),
      setStateFilter,
      runAction: (id) => { const a = L.availableActions(agentSel, detail).find((x) => x.id === id); if (a) setAction(a); },
      undo: () => stepHistory('undo'),
      redo: () => stepHistory('redo'),
      toggleLayout: () => setLayoutMode(layout === 'force' ? 'free' : 'force'),
      arrange: () => arrange(),
      stopLayout: stopRun,
      togglePin,
      focusSearch: () => R.focusSearch(),
      clearSearch,
      clearFilters: () => setChips(M.filters.clearChips),
      saveView: () => { setSaveWanted(true); setViewMenuOpen(true); setSaveAsk((n) => n + 1); },
      userMenu: (kind, id) => { userMenu(kind, id).catch((e) => { console.error('argos: comando do nó falhou', kind, e); opFailed(e && e.code); }); },
    },
    reading: { layout, running, nodeId: node ? node.id : null, pinned: !!node && pins.has(node.id), searching: !!search, filtering: chipCount > 0 },
  });
  const ctxRef = useRef(ctxFor);
  ctxRef.current = ctxFor;

  // uma porta só para comandos: a paleta (Ctrl K) junta o canvas e o grupo "Painel" (ir para, tema, congelar)
  const paletteItems = useMemo(() => L.paletteItems({ order, commands: commands.palette(ctxFor(selected)), views,
    panel: L.panelItems({ nav: HadesCore.NAV.filter((n) => n.id !== 'argos').map((n) => ({ id: n.id, label: n.label, desc: n.desc })), frozen, dark: document.documentElement.classList.contains('dark'), tour: HadesCore.hasTour('argos') }) }),
    [order, commands, selected, detail, canUndo, canRedo, selId, views, layout, running, pins, search, chipCount, frozen, themeTick]);
  const runPalette = (item) => {
    setPalette(false);
    const { type, value } = item.run;
    if (type === 'select') select(value);
    else if (type === 'view') applyView(value);
    else if (type === 'panel') {
      if (value.startsWith(L.PANEL_GO)) go(value.slice(L.PANEL_GO.length));
      else if (value === L.PANEL_THEME) { toggleTheme(); setThemeTick((n) => n + 1); }
      else if (value === L.PANEL_FREEZE) setFrozen(!frozen);
      else if (value === L.PANEL_TOUR) HadesCore.startPageTour('argos');
    } else commands.get(value)?.run(ctxFor(selected));
  };
  const helpRows = commands.help(ctxFor(selected));

  // botão direito (ou Enter no nó em foco): nó → ações do agente e comandos do tipo; fundo → comandos do canvas. O ponto
  // chega em pixels da janela e o menu das camadas o quer em pixels do quadro do canvas
  const openMenu = useCallback(({ id, x, y }) => {
    const stage = stageRef.current;
    if (!stage) return;
    const own = id && !graphById.has(id) ? docNode(id) : null;
    const graphNode = id ? graphById.get(id) || null : null;
    const node = graphNode || (own ? { id: own.id, type: own.type, label: types.get(own.type)?.label || own.type } : null);
    // o nó do menu vira o selecionado principal: as ações do agente agem sobre ele
    if (id && M.store.primarySelection(selection) !== id) { setSelection([id]); setPanelOpen(true); }
    const type = node ? types.get(node.type) : null;
    const mounted = type ? withMountedMenu(L.overlayMenuType(type, M.argos.ACTION_COMMAND_PREFIX)) : null;
    // "Ocultar do canvas" em todo tipo, se o comando entrou no registro
    const menuType = mounted && commands.get(HID.HIDE_COMMAND) && !mounted.menu.includes(HID.HIDE_COMMAND)
      ? { ...mounted, menu: [...mounted.menu, HID.HIDE_COMMAND] } : mounted;
    const target = node && menuType ? { kind: 'node', node: graphNode ? actionNode(graphNode) : node, nodeType: menuType } : { kind: 'canvas' };
    const r = stage.getBoundingClientRect();
    setMenu({ target, at: { x: x - r.left, y: y - r.top }, node: target.kind === 'node' ? node : null });
  }, [graphById, selection, types]);
  // ação do agente escolhida no menu: mensagem vai ao balão; a do diálogo da página abre o diálogo; as demais (estacionar)
  // perguntam o campo de texto e a frase, se houver, e vão direto à rota. Diálogo e envio agem sobre o agente selecionado,
  // que o menu tornou o nó dele ao abrir
  const menuAction = async (item, node) => {
    const route = L.overlayActionRoute(item);
    if (route.kind === 'balloon') { setBalloonId(node.id); return; }
    if (route.kind === 'unsupported') { toast({ kind: 'info', title: item.label, desc: 'Abra pelo painel do nó.' }); return; }
    if (agentSel?.id !== node.id) { toast({ kind: 'warn', title: item.label, desc: 'Selecione o agente e abra o menu de novo.' }); return; }
    if (route.kind === 'dialog') {
      const act = L.availableActions(agentSel, detail).find((a) => a.id === route.id);
      if (act) setAction(act); else toast({ kind: 'warn', title: item.label, desc: 'Ação indisponível agora.' });
      return;
    }
    const args = {};
    if (route.textField) {
      const text = await askOwner({ kind: 'text', title: item.label, text: item.hint, initial: '' });
      if (text === null || (route.textField.required && !text.trim())) return;
      if (text.trim()) args[route.textField.name] = text.trim();
    }
    if (route.confirm && !(await askOwner({ kind: 'confirm', title: item.label, text: item.hint, phrase: node.label }))) return;
    run({ id: item.key, label: item.label, destructive: route.confirm }, args, node.label);
  };
  // o balão some com o agente que saiu do grafo
  useEffect(() => { if (balloonId && !graphById.has(balloonId)) setBalloonId(null); }, [balloonId, graphById]);
  const actionCtx = useMemo(() => L.actionContextOf(graph), [graph]);
  const layerNodes = useMemo(() => (viewDoc ? L.overlayNodes(viewDoc.nodes, (id) => { const g = graphById.get(id); return g ? actionNode(g) : null; }) : NO_NODES), [viewDoc, graphById]);

  const blocked = palette || help || !!action || !!file || !!menu || !!ask || !!balloonId || !!termDialog || rolesOpen || !!linksFor || filtersOpen || viewMenuOpen;
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  useEffect(() => {
    // fase de captura: o Ctrl+K da página vence o da base (que volta ao sair da Argos). Com o foco no canvas, as teclas do
    // motor (Tab, setas, Enter, Esc…) são dele; as da página (j, k, f, ?, Ctrl+Z…) passam
    const k = (e) => {
      if (e.key === 'Alt') ttyHost.setAlt(true);
      // terminal com o teclado: tudo é dele (Esc inclusive), menos os comandos tty:* (TTY_GLOBAL_KEYS, que ele não consome)
      const inTty = !!(e.target.closest && e.target.closest(TTY_FOCUSED));
      const plain = !e.ctrlKey && !e.metaKey;
      if (!inTty && plain && ENGINE_KEYS.has(e.key) && e.target.closest && e.target.closest('[role=application]')) return;
      // Esc e Enter da busca e do nome da vista são deles (limpar, reenquadrar, cancelar)
      if ((e.key === 'Escape' || e.key === 'Enter') && e.target.closest && e.target.closest('[data-own-keys]')) return;
      const input = NT.ttyKeyInput(e), editable = isEditable(e.target);
      const cmd = commands.resolveKey(input, { editable, ctx: ctxRef.current(selectedRef.current) });
      if (!cmd) {
        // acorde do canvas sem comando valendo agora: não vira ação do navegador (favorito, troca de aba, extensões)
        const owner = commands.claimedKey(input, { editable });
        if (owner && NT.ttyLetsCommand(inTty, owner.id) && !blockedRef.current) e.preventDefault();
        return;
      }
      if (!NT.ttyLetsCommand(inTty, cmd.id)) return;
      if (blockedRef.current && cmd.id !== 'palette') return;
      e.preventDefault();
      if (cmd.id === 'palette') e.stopImmediatePropagation();
      cmd.run(ctxRef.current(selectedRef.current));
    };
    // os números de salto aparecem só enquanto o Alt está segurado; a janela perdendo o foco solta o Alt
    const up = (e) => { if (e.key === 'Alt') ttyHost.setAlt(false); };
    const lose = () => ttyHost.setAlt(false);
    addEventListener('keydown', k, true);
    addEventListener('keyup', up, true);
    addEventListener('blur', lose);
    return () => { removeEventListener('keydown', k, true); removeEventListener('keyup', up, true); removeEventListener('blur', lose); };
  }, [commands, ttyHost]);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  // F6 / Shift+F6: próxima região (ilhas, chips, ferramentas, canvas, câmera, gaveta). A ordem é a do DOM
  useEffect(() => {
    const FOCUSABLE = 'button:not([disabled]), input, select, [href], [tabindex]:not([tabindex="-1"])';
    const k = (e) => {
      if (e.key !== 'F6' || e.ctrlKey || e.metaKey || e.altKey) return;
      const regions = [...document.querySelectorAll('[data-region], [role=application]')].filter((el) => el.getClientRects().length > 0);
      if (!regions.length) return;
      e.preventDefault();
      const at = regions.findIndex((el) => el.contains(document.activeElement));
      const next = regions[(at + (e.shiftKey ? -1 : 1) + regions.length) % regions.length];
      const target = next.matches('[role=application]') ? next : next.querySelector(FOCUSABLE) || next;
      if (target.tabIndex < 0 && !target.matches(FOCUSABLE)) target.tabIndex = -1;
      target.focus();
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, []);
  // "1 espera por você": filtra e enquadra quem espera; no celular, abre direto o primeiro (a folha)
  const frameAfterFilter = useRef(false);
  useEffect(() => {
    if (!frameAfterFilter.current || !viewDoc) return;
    frameAfterFilter.current = false;
    apiRef.current?.fitAll(true);
  }, [viewDoc]);

  if (!graph && !loadError) return <StageSkeleton />;
  if (!graph) return <div className="grid min-h-0 flex-1 place-items-center"><Empty icon={I.CircleAlert} title="Não deu para carregar os agentes.">
    {L.graphErrorText(loadError)} Tento de novo a cada {L.GRAPH_RETRY_S} s; se persistir, confira se o painel está no ar (/hades env status).{' '}
    <button type="button" onClick={() => reloadGraph.current()} className="cursor-pointer underline underline-offset-3 hover:no-underline max-md:min-h-11">Tentar agora</button>
  </Empty></div>;
  if (graph.v !== SUPPORTED_V) return <div className="grid min-h-0 flex-1 place-items-center"><Empty icon={I.CircleAlert} title="Esta página não entende os dados do Argos.">
    O servidor manda a versão {String(graph.v)}; esta página lê a {SUPPORTED_V}. Atualize o painel: /hades env update.
  </Empty></div>;

  const agents = L.validNodes(graph).filter((n) => n.type === 'agent');
  const attention = agents.filter((n) => L.needsAttention(n)).length;
  const stalled = agents.filter((n) => L.isStalled(n, now)).length;
  const working = agents.filter((n) => n.state === 'working').length;
  const closed = agents.filter((n) => L.matchesState(n, 'done', now)).length;
  const setState = setStateFilter;
  // "Limpar" tira chips e janela de atividade; "Mostrar arquivados" fica como o dono deixou
  const clearAll = () => { setChips((c) => M.filters.setActivity(M.filters.clearChips(c), M.filters.ACTIVITY_ANY.id)); setStateFilter(ALL); };
  // contagens do seletor de estado: só o que pode aparecer (oculto, arquivado sem o toggle e fora da janela não contam)
  const countable = agents.filter((n) => !hiddenSet.has(n.id) && agentPasses(n));
  const archivedOut = M.filters.showsArchived(chips) ? 0 : agents.filter((n) => n.state === M.filters.ARCHIVED_STATE && !hiddenSet.has(n.id)).length;
  const hiddenItems = (hiddenList ?? NO_NODES).map((id) => {
    const g = graphById.get(id);
    const own = g ? null : docNode(id);
    return { id, label: nodeLabel(id) ?? id, kind: g ? (g.type === 'agent' ? `agente · ${g.state}` : g.type) : (own && types.get(own.type)?.label) || '' };
  });
  const activityItems = [M.filters.ACTIVITY_ANY, ...M.filters.ACTIVITY_WINDOWS].map((w) => ({ value: w.id, label: w.label }));
  const jumpWaiting = (v) => {
    setState(v);
    frameAfterFilter.current = true;
    if (!deskRef.current) {
      const first = agents.find((n) => L.matchesState(n, v, now));
      if (first) select(first.id);
    }
  };
  const jump = (v, text, tone) => <button type="button" onClick={() => jumpWaiting(v)} className={cn('min-h-8 cursor-pointer underline underline-offset-3 hover:no-underline outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:min-h-11', tone)}>{text}</button>;
  const main = attention ? jump('attention', `${attention} ${attention === 1 ? 'espera' : 'esperam'} por você`, 'decoration-warn')
    : stalled ? jump('stalled', `${plural(stalled, 'parado', 'parados')} sem evento há ${HadesCore.dur(L.STALL_MS / 1000)}`, 'decoration-bad')
    : working ? `${working} trabalhando` : 'nenhum agente trabalhando';
  const restText = [(attention || stalled) && working ? `${working} trabalhando` : null, attention && stalled ? plural(stalled, 'parado', 'parados') : null,
    plural(agents.length, 'agente', 'agentes'), closed ? `${closed} concluídos ou arquivados` : null, graph.herdr?.available === false ? 'herdr fora do ar' : null].filter(Boolean).join(' · ');
  // QT-2: estado sem contagem zero constante; o que está ligado fica mesmo com zero
  const stateItems = L.STATE_FILTERS.map((it) => ({ ...it, active: it.value === stateFilter,
    count: it.value === 'all' ? undefined : countable.filter((n) => L.matchesState(n, it.value, now)).length }))
    .filter((it) => it.active || it.count === undefined || it.count > 0);
  const actionBar = <P.ActionBar node={agentSel} actions={actions} onPick={pick} />;
  const side = <P.SidePanel node={selected} detail={detail} moirai={moirai} detailError={detailError} events={events} live={live} now={now} onFile={setFile} runs={runs[selId] || []} actions={actionBar} />;
  // gaveta aberta sobre o canvas: o HUD, a câmera e o minimapa andam para a esquerda pela largura dela (só na mesa)
  const drawerOn = !bare && panelOpen && focusNodes.length > 0;
  const focusShift = drawerOn && desk && FOCUS ? FOCUS.FOCUS_PANEL_WIDTH : null;
  const filtered = stateFilter !== DEFAULT_STATE || chipCount > 0 || activity !== M.filters.ACTIVITY_ANY.id;
  const showArchived = M.filters.showsArchived(chips);
  const activeChips = [
    stateFilter !== DEFAULT_STATE ? { key: 'state', label: stateItems.find((it) => it.value === stateFilter)?.label ?? L.STATE_FILTERS.find((it) => it.value === stateFilter)?.label ?? stateFilter, onRemove: () => setState(DEFAULT_STATE) } : null,
    activity !== M.filters.ACTIVITY_ANY.id ? { key: 'activity', label: activityItems.find((it) => it.value === activity)?.label ?? activity, onRemove: () => setChips((c) => M.filters.setActivity(c, M.filters.ACTIVITY_ANY.id)) } : null,
    showArchived ? { key: 'archived', label: 'Com arquivados', onRemove: () => setChips((c) => M.filters.setShowArchived(c, false)) } : null,
    ...filterDims.flatMap((d) => d.chips.filter((c) => c.active).map((c) => ({ key: `${d.dim}:${c.value}`, label: `${d.label}: ${c.label}`, onRemove: () => setChips((cur) => M.filters.toggleFilter(cur, d.dim, c.value)) }))),
  ].filter(Boolean);
  const totalNodes = (graph.nodes || []).length;
  const countSummary = filtered ? `${shown.nodes.length} de ${plural(totalNodes, 'nó', 'nós')}` : plural(shown.nodes.length, 'nó', 'nós');
  const closeFilters = (open) => { setFiltersOpen(open); if (!open) setHiddenWanted(false); };
  const closeViewMenu = (open) => { setViewMenuOpen(open); if (!open) setSaveWanted(false); };
  // compositor: o terminal seguido precisa estar no documento de vista e ter pane no herdr
  const composerNode = composer !== null && ttyHost.target(composer) ? viewDoc?.nodes.find((n) => n.id === composer) ?? null : null;
  const composerTerminals = composerNode && cstate
    ? cstate.doc.nodes.filter((n) => ttyHost.target(n.id)).map((n) => ({ id: n.id, label: nodeLabel(n.id) ?? n.id }))
    : NO_NODES;
  const hasNodes = shown.nodes.length > 0;
  const canvasPane = canvasError ? <Empty icon={I.CircleAlert} title="Não deu para ler o canvas.">
    {canvasError}. A lista continua disponível. <button type="button" onClick={loadCanvas} className="cursor-pointer underline underline-offset-3 hover:no-underline">Tentar de novo</button>
  </Empty> : !viewDoc ? <StageSkeleton inner />
    : <P.CanvasPane doc={viewDoc} selection={engineSelection} onSelectionChange={onSelectionChange} onOp={onOp} graphById={graphById} types={types} now={now}
      onContext={openMenu} onReady={onCanvasReady} onLinkState={onLinkState} nodeShape={nodeShape}
      snap={engineSnap} dock={engineDock} dockState={dockState} onDockState={setDock} fullDetail={fullDetail} />;
  const layersOn = !!viewDoc && !canvasError;
  // vazio de verdade: nem agente nem nó do usuário à vista (a nota sozinha já é canvas, não vazio)
  const emptyStage = !hasNodes && !!viewDoc && viewDoc.nodes.length === 0 && !canvasError;
  const hud = bare ? <Button variant="outline" size="icon-sm" icon={I.PanelTop} aria-label="Mostrar controles" aria-keyshortcuts="Shift+F" title="Mostrar controles (Shift+F)"
    className="pointer-events-auto absolute top-2 right-2 z-30 bg-background/90 max-md:size-11" onClick={() => setFocus(false)} />
    : <div className="pointer-events-none absolute inset-x-2 top-2 z-20 grid gap-1.5">
      <div className="flex items-start justify-between gap-2">
        <R.Island label="Estado do Argos" region="status">
          {!desk ? <Button variant="ghost" size="icon-sm" icon={I.Menu} aria-label="Abrir a navegação" className="max-md:size-11" onClick={openNav} /> : null}
          <span className="marca ml-1 size-5 shrink-0" aria-hidden="true" />
          <span className="max-sm:sr-only px-1 t-label font-medium">Argos</span>
          <span className="flex min-w-0 items-center px-1 t-body tabular-nums" role="status" title={restText}>{main}</span>
          <span className="tabular-nums px-1 t-meta text-muted-foreground max-lg:hidden">{countSummary}</span>
        </R.Island>
        <R.Island label="Leitura do canvas" region="reading">
          <R.SearchBox value={search} onChange={setSearch} onSubmit={frameSearch} hits={searchResult ? searchResult.ids.length : 0} problem={searchResult?.problem} onPalette={() => setPalette(true)} />
          {totalNodes || filtered ? <R.Popover label="Filtros" icon={I.Filter} badge={activeChips.length || null} shortcut="v" open={filtersOpen} onOpenChange={closeFilters} wide>
            <R.FiltersPanel summary={countSummary} states={stateItems} onState={setState} activity={activity} activityItems={activityItems} onActivity={(v) => setChips((c) => M.filters.setActivity(c, v))}
              archived={showArchived} onArchived={(on) => setChips((c) => M.filters.setShowArchived(c, on))} dims={filterDims}
              onToggle={(dim, value) => setChips((c) => M.filters.toggleFilter(c, dim, value))} onClear={clearAll} filtering={filtered}
              hidden={hiddenItems.length ? <HID.HiddenMenu inline defaultOpen={hiddenWanted} items={hiddenItems} onUnhide={unhideNodes} /> : null} />
          </R.Popover> : null}
          <R.Popover label="Vista" icon={I.Eye} open={viewMenuOpen} onOpenChange={closeViewMenu}>
            <div className="grid gap-1.5">
              <span className="t-micro text-muted-foreground">Canvas</span>
              <Choice label="Canvas aberto" value={canvasInfo.id} onChange={pickCanvas} items={canvasItems} className="h-9 w-full max-md:h-11" />
            </div>
            <div className="grid gap-1.5">
              <span className="t-micro text-muted-foreground">Vistas salvas</span>
              <R.ViewsBar views={views} ask={saveWanted ? saveAsk : 0} onApply={applyView} onSave={saveView}
                onRename={(from, to) => changeViews(M.urlstate.renameView(views, from, to))} onRemove={(name) => changeViews(M.urlstate.removeView(views, name))} />
            </div>
            <div className="grid gap-1.5">
              <span className="t-micro text-muted-foreground">Layout</span>
              <R.LayoutSwitch layout={layout} onLayout={setLayoutMode} running={running} onStop={stopRun} last={lastRun} />
            </div>
            <div className="grid gap-1.5">
              <span className="t-micro text-muted-foreground">Conteúdo dos nós</span>
              <R.DetailSwitch value={fullDetail} choices={M.camera.FULL_DETAIL_CHOICES} onChange={setFullDetail} />
            </div>
          </R.Popover>
          <button type="button" aria-pressed={listOpen} aria-keyshortcuts="L" title="Lista de nós (l)" onClick={() => setListOpen((o) => !o)}
            className={cn(R.ISLAND_BUTTON, listOpen && 'bg-accent text-foreground')}>
            <I.List className="size-4" aria-hidden="true" /><span className="max-lg:sr-only">Lista</span>
          </button>
          <Button variant="ghost" size="icon-sm" icon={I.Keyboard} aria-label="Atalhos de teclado" title="Atalhos de teclado (?)" className="max-md:hidden" onClick={() => setHelp(true)} />
        </R.Island>
      </div>
      <R.ActiveChips items={activeChips} onClear={clearAll} />
      {loadError ? <p className="pointer-events-auto flex w-fit items-center gap-2 border border-border-strong bg-background px-2 py-1 t-meta text-bad" role="status">
        <I.CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
        <span>Sem atualizar{graphOkAt.current ? ` desde ${new Date(graphOkAt.current).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : ''}: {L.graphErrorText(loadError)} Mostrando o último grafo.</span>
        <button type="button" onClick={() => reloadGraph.current()} className="cursor-pointer underline underline-offset-3 hover:no-underline max-md:min-h-11">Tentar agora</button>
      </p> : null}
      {orphans.length > 0 ? <p className="pointer-events-auto flex w-fit items-center gap-2 border border-border-strong bg-background px-2 py-1 t-meta text-muted-foreground" role="status">
        <I.CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
        <span>{orphans.length === 1 ? '1 terminal vivo fora do canvas' : `${orphans.length} terminais vivos fora do canvas`}: {orphans.map((o) => o.name).join(', ')}</span>
        <button type="button" onClick={bringOrphans} className="cursor-pointer underline underline-offset-3 hover:no-underline max-md:min-h-11">Trazer para o canvas</button>
      </p> : null}
      {deadIds.length > 0 ? <p className="pointer-events-auto flex w-fit items-center gap-2 border border-border-strong bg-background px-2 py-1 t-meta text-muted-foreground" role="status">
        <I.CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
        <span>{deadIds.length === 1 ? '1 terminal encerrado no canvas' : `${deadIds.length} terminais encerrados no canvas`}{deadHidden > 0 ? ` (${deadHidden} oculto${deadHidden === 1 ? '' : 's'})` : ''}: {deadIds.map((id) => nodeLabel(id) || id).join(', ')}</span>
        <button type="button" onClick={() => termRun(() => termRemoveEnded(deadIds))} className="cursor-pointer underline underline-offset-3 hover:no-underline max-md:min-h-11">Remover do canvas</button>
      </p> : null}
      {externalStale ? <p className="pointer-events-auto flex w-fit items-center gap-2 border border-border-strong bg-background px-2 py-1 t-meta text-muted-foreground" role="status">
        <I.RefreshCw className="size-3.5 shrink-0" aria-hidden="true" />
        <span>O canvas mudou por fora.</span>
        <button type="button" onClick={() => { reloadExternal().catch(swallowReload); }}
          className="cursor-pointer underline underline-offset-3 hover:no-underline max-md:min-h-11">Recarregar</button>
      </p> : null}
      {saveStatus.kind === 'error' ? (() => {
        const badge = L.saveBadgeOf(saveStatus.code, saveFails);
        return <p className={cn('pointer-events-auto flex w-fit items-center gap-2 border border-border-strong bg-background px-2 py-1 t-meta', badge.loud ? 'text-bad' : 'text-muted-foreground')} role="status" title={badge.title}>
          <I.CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
          <span>{badge.label}</span>
          <button type="button" onClick={() => { saver.flush().catch((e) => console.error('canvas: nova tentativa falhou', e && e.name)); }}
            className="cursor-pointer underline underline-offset-3 hover:no-underline max-md:min-h-11">Tentar agora</button>
        </p>;
      })() : null}
    </div>;
  return <div className="relative flex min-h-0 flex-1 flex-col">
    <div ref={stageRef} className="relative min-h-0 flex-1 overflow-hidden" onDragOver={onStageDragOver} onDrop={onStageDrop}>
      {canvasPane}
      {/* camadas, HUD e controles num quadro que encolhe à direita quando a gaveta abre na mesa; fora disso, o palco inteiro */}
      <div className="pointer-events-none absolute inset-y-0 left-0 right-0" style={focusShift ? { right: focusShift } : undefined}>
        {hud}
        {emptyStage ? <div className="pointer-events-none absolute inset-0 grid place-items-center p-4">
          <div className="pointer-events-auto max-w-md border border-border-strong bg-background/95 p-4">
            <Empty icon={I.Network} title={!totalNodes ? 'Nenhum agente ainda.' : filtered ? 'Nenhum nó com esse filtro.' : 'Nenhum agente em andamento.'}>
              {!totalNodes ? 'Os agentes aparecem aqui assim que você criar o primeiro: hades agent new. Você já pode criar um terminal ou uma nota pelas ferramentas.'
                : filtered ? 'Tire um filtro para ver os nós de volta.' : 'Os agentes concluídos continuam no grafo.'}
            </Empty>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {!totalNodes ? <button type="button" onClick={() => copyText('hades agent new')} className="cursor-pointer underline underline-offset-3 hover:no-underline max-md:min-h-11">Copiar o comando</button> : null}
              {totalNodes && filtered ? <button type="button" onClick={clearAll} className="cursor-pointer underline underline-offset-3 hover:no-underline max-md:min-h-11">Limpar os filtros</button> : null}
              {totalNodes && !filtered ? <button type="button" onClick={() => setState('all')} className="cursor-pointer underline underline-offset-3 hover:no-underline max-md:min-h-11">
                {closed ? `Mostrar todos (${plural(closed, 'concluído', 'concluídos')})` : 'Mostrar todos'}</button> : null}
              {archivedOut ? <button type="button" onClick={() => setChips((c) => M.filters.setShowArchived(c, true))} className="cursor-pointer underline underline-offset-3 hover:no-underline max-md:min-h-11">
                {`Mostrar ${archivedOut === 1 ? 'o arquivado' : `os ${archivedOut} arquivados`}`}</button> : null}
            </div>
          </div>
        </div> : null}
        {layersOn ? <>
          <P.CanvasLayers api={canvasApi} nodes={layerNodes}
            menu={menu ? { target: menu.target, at: menu.at, registry: commands, commandCtx: ctxFor(menu.node), actionCtx, onClose: () => setMenu(null),
              onAction: (item, node) => { menuAction(item, node).catch((e) => { console.error('argos: ação do menu falhou', item.key, e); toast({ kind: 'bad', title: L.actionFailTitle(item.key), desc: L.errorText(e && e.code, 'A ação falhou.') }); }); },
              onError: (message) => toast({ kind: 'bad', title: 'Menu do canvas', desc: message }) } : undefined}
            balloon={balloonId && cstate ? { nodeId: balloonId, drafts, onDrafts: setDrafts, doc: cstate.doc, ctx: actionCtx, fetch: tokenFetch, onClose: () => setBalloonId(null),
              onSent: (mode) => toast({ kind: 'ok', title: mode === 'prompt' ? 'Prompt enviado' : 'Texto enviado', desc: graphById.get(balloonId)?.label }) } : undefined}
            permission={{ ctx: actionCtx, fetch: tokenFetch, errorText: L.errorText }}
            minimap={desk ? { onCamera: (cam) => canvasApi?.setCamera(cam, false) } : undefined} />
          {composerNode && canvasApi && cstate ? <div className="pointer-events-auto"><CMP.CanvasComposerLayer api={canvasApi} rect={composerNode}
            terminal={{ id: composerNode.id, label: nodeLabel(composerNode.id) ?? composerNode.id, ...ttyHost.target(composerNode.id),
              orchestrator: NT.readTerminalData(composerNode.data).orchestrator === true }}
            drafts={composerDrafts} onDrafts={setComposerDrafts} doc={cstate.doc} terminals={composerTerminals}
            sendInput={(id, input) => ttyHost.input(id, input)} fetch={tokenFetch} onFocusTerminal={(id) => ttyHost.focus(id)} onClose={() => setComposer(null)} /></div> : null}
          {SUP && canvasApi && cstate ? <div className="pointer-events-auto"><SUP.SupervisorLayer open={supOpen} onOpen={() => setSupOpen(true)} onClose={() => setSupOpen(false)}
            host={ttyHost} terminals={cstate.doc.nodes.filter((n) => ttyHost.target(n.id)).map((n) => ({ id: n.id, label: nodeLabel(n.id) ?? n.id }))}
            doc={cstate.doc} canvasId={canvasIdRef.current} commit={termCommit} center={host.current.viewCenter}
            onJump={(id) => { host.current.selectIds([id]); apiRef.current?.revealNode(id, true); }} fetch={tokenFetch} /></div> : null}
          {linksFor && canvasApi && cstate ? <div className="pointer-events-auto"><LINKS.LinksPopover doc={cstate.doc} nodeId={linksFor.id} at={linksFor.at}
            view={canvasApi.viewport()} describe={nodeLabel} onOp={commitOp} onClose={() => setLinksFor(null)}
            onJump={(to) => { host.current.selectIds([to]); apiRef.current?.revealNode(to, true); }}
            onError={(message) => toast({ kind: 'bad', title: 'Conexões', desc: message })} /></div> : null}
          {!bare ? <>
            {/* grupo da câmera (histórico, zoom, enquadrar); acima do minimapa na mesa, acima das ferramentas no celular */}
            <CC.CanvasControls api={canvasApi} history={{ canUndo, canRedo, onUndo: () => stepHistory('undo'), onRedo: () => stepHistory('redo') }}
              className={cn('pointer-events-auto absolute right-2 z-10 flex items-center border border-border-strong bg-background', desk ? 'bottom-[8.5rem]' : 'bottom-[4.25rem]')} />
            {termReady ? <window.ArgosCanvasToolbar.CanvasToolbar armed={termTool} onArm={armTool} link={{ active: linking, onClick: toggleLink }} onRoles={host.current.termRolesOpen}
              quick={termPresets.map((p) => ({ key: p.slug, label: p.name, icon: p.icon, color: p.color, onClick: () => quickStart(p) }))}
              vertical={desk} className={cn('pointer-events-auto absolute z-10', desk ? 'top-24 left-2 max-h-[calc(100%-8rem)]' : 'bottom-2 left-2 right-2')} /> : null}
          </> : null}
          {termReady && termTool ? <window.ArgosCanvasToolbar.ToolDragLayer tool={window.ArgosCanvasToolbar.listTools().find((t) => t.id === termTool)}
            onRect={onToolRect} onCancel={() => setTermTool(null)} /> : null}
        </> : null}
        {!bare ? <P.ListPanel open={listOpen} phone={!desk} summary={countSummary} onClose={() => setListOpen(false)}>
          <P.NodeList nodes={shown.nodes} order={order} selected={sel} onSelect={(id) => { if (!desk) setListOpen(false); select(id); }} now={now} />
        </P.ListPanel> : null}
      </div>
      {drawerOn && FOCUS ? <FOCUS.FocusPanel open={panelOpen} nodes={focusNodes} primaryId={focusPrimary} onPrimary={setFocusPick} onToggle={setPanelOpen} sheet={!desk}><div className="p-4">{side}</div></FOCUS.FocusPanel> : null}
    </div>
    <P.ActionDialog node={agentSel} action={action} detail={detail} onClose={() => setAction(null)} onRun={run} />
    <P.Palette open={palette} onClose={() => setPalette(false)} items={paletteItems} onRun={runPalette} />
    <P.HelpDialog open={help} onClose={() => setHelp(false)} rows={helpRows} />
    <P.FileSheet src={file} onClose={() => setFile(null)} />
    {termReady ? <window.ArgosTerminalCreate.TerminalDialog open={!!termDialog} mode={termDialog?.mode} tab={termDialog?.tab} initial={termDialog?.initial}
      presets={termPresets} roles={termRoles} onSubmit={submitTerm} onSavePreset={savePreset} onManageRoles={() => setRolesOpen(true)} onClose={() => setTermDialog(null)} /> : null}
    {termReady ? <window.ArgosTerminalRoles.RolesDialog open={rolesOpen} client={termClient} defaultCwd={rolesOpen ? scopeWorktree() : ''}
      askSlug={(slug) => askOwner({ kind: 'confirm', title: 'Apagar o papel?', text: 'O arquivo do papel sai de vez. Terminais que já usam o papel seguem com as instruções que receberam.', phrase: slug }).then((ok) => (ok ? slug : null))}
      confirm={(req) => askOwner({ kind: 'confirm', ...req })} onChanged={setTermRoles} onClose={() => setRolesOpen(false)} /> : null}
    <P.AskDialog ask={ask} onDone={closeAsk} />
  </div>;
}

// carregando na forma final: palco cheio, ilhas e selos nos mesmos cantos (CR-17)
function StageSkeleton({ inner = false }) {
  return <div className={cn('relative min-h-0 flex-1', inner && 'absolute inset-0')} aria-busy="true" aria-label="Carregando o Argos">
    <Skeleton className="absolute inset-0 opacity-40" />
    <Skeleton className="absolute top-2 left-2 h-10 w-64 max-w-[50%]" />
    <Skeleton className="absolute top-2 right-2 h-10 w-80 max-w-[45%]" />
    <Skeleton className="absolute top-24 left-2 h-48 w-10 max-md:hidden" />
    <Skeleton className="absolute right-2 bottom-2 h-28 w-44 max-md:hidden" />
  </div>;
}

HadesCore.registerPage('argos', Argos, { stage: true });
})();
