/* Regras puras da voz do Mark no navegador (reference/argos.md §Mark §Voz): o protocolo de segurar-para-falar com a fila até o
 * `ready`, a decisão de mandar ou descartar quadro, o recuo da religação, o texto de erro e o nível do medidor. Sem DOM, sem
 * áudio e sem rede: voice.tsx liga isto ao WebSocket e aos worklets, e o bun test carrega o mesmo arquivo.
 * Script clássico: publica window.ArgosVoiceLogic. */
(() => {
/** Mesmos limites que o painel confere na entrada (src/panel/mark-voice-logic.ts); o servidor os confirma em GET /api/mark/voice. */
const FRAME_BYTES_MAX = 3200;
const MODES = ['ptt', 'open'];
const RECONNECT_MS = [1000, 2000, 4000, 8000, 15000];
/** Tentativas seguidas antes de desistir e mostrar o erro: a rede móvel cai e volta, mas não para sempre. */
const RECONNECT_TRIES = 5;
const VOICE_PATH = '/api/mark/voice';
const INFO_TIMEOUT_MS = 6000;
/** Botão apertado (ou conversa aberta) sem nenhum quadro do worklet por este tempo = o navegador não entrega o microfone.
 * Fica bem abaixo dos 5 s do idle_timeout do Mark, para o erro certo chegar antes do genérico. */
const MIC_SILENT_MS = 1500;
/** Códigos em que religar não adianta: a causa é de quem fala (microfone, vaga ocupada) ou o tempo da sessão acabou. */
const FATAL_CODES = new Set([
  'mark_voice_busy', 'mark_voice_too_long', 'mark_voice_mic_denied', 'mark_voice_mic_missing', 'mark_voice_insecure_context',
  'mark_voice_unavailable', 'mark_voice_mic_silent', 'mark_voice_bad_mode', 'mark_voice_hello_required',
]);

const reconnectMs = (attempt) => RECONNECT_MS[Math.min(Math.max(attempt, 0), RECONNECT_MS.length - 1)];
const isFatalCode = (code) => FATAL_CODES.has(code);

/** `ws:` ou `wss:` conforme a página; o cookie do painel e o túnel seguem o mesmo caminho do resto da UI. */
const voiceUrl = (loc) => `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}${VOICE_PATH}`;

/** Erro de `getUserMedia` → código do catálogo (o texto vem de GET /api/mark/voice, campo `explain`). */
function micErrorCode(err, secure) {
  if (secure === false) return 'mark_voice_insecure_context';
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'mark_voice_mic_denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return 'mark_voice_mic_missing';
  return 'mark_voice_failed';
}

/** Texto do erro: o do servidor (`explain` do `error`/`busy`) vence; senão o do catálogo servido pela rota; senão um genérico. */
function explainFor(code, served, texts) {
  if (served && typeof served === 'object' && served.title) return served;
  const hit = texts && texts[code];
  if (hit) return hit;
  return { code, title: 'Voz indisponível', cause: 'O painel não conseguiu abrir a voz do Mark.', action: 'Tente de novo; se repetir, rode o diagnóstico (doctor).', ref: '' };
}

/** Nível 0..1 de um bloco PCM16 (RMS, com folga para a fala normal encher o medidor). */
function levelOfPcm16(samples) {
  const n = samples.length;
  if (n === 0) return 0;
  let acc = 0;
  for (let i = 0; i < n; i++) acc += samples[i] * samples[i];
  return Math.min(1, (Math.sqrt(acc / n) / 32768) * 4);
}

/**
 * Máquina do protocolo. `send(obj)` manda JSON ao painel. Antes do `ready` só o `hello` sai; `ptt` e `mode` pedidos nesse
 * intervalo guardam o último valor e saem juntos, em ordem, quando o `ready` chega. Quadro de áudio só passa com `ready`
 * e (conversa aberta, ou botão apertado).
 */
function createVoiceProtocol(send, initialMode) {
  let mode = MODES.includes(initialMode) ? initialMode : 'ptt';
  let ready = false;
  let down = false;
  let pendingMode = null;
  let pendingDown = null;
  let bye = false;

  const flush = () => {
    if (pendingMode !== null) send({ type: 'mode', mode: pendingMode });
    if (pendingDown !== null) send({ type: 'ptt', down: pendingDown });
    pendingMode = null;
    pendingDown = null;
  };
  return {
    hello() { send({ type: 'hello', mode }); },
    ptt(value) {
      down = !!value;
      if (!ready) { pendingDown = down; return; }
      send({ type: 'ptt', down });
    },
    setMode(next) {
      if (!MODES.includes(next) || next === mode) return;
      mode = next;
      if (!ready) { pendingMode = next; return; }
      send({ type: 'mode', mode: next });
    },
    /** Devolve o que a vista precisa saber da mensagem: `{kind:'ready'|'state'|'interrupted'|'busy'|'error'|'ignored', ...}`. */
    receive(msg) {
      if (!msg || typeof msg !== 'object') return { kind: 'ignored' };
      if (msg.type === 'ready') { ready = true; flush(); return { kind: 'ready', maxS: Number.isFinite(msg.max_s) ? msg.max_s : null }; }
      if (msg.type === 'state') return { kind: 'state', state: msg };
      if (msg.type === 'interrupted') return { kind: 'interrupted' };
      if (msg.type === 'busy' || msg.type === 'error') return { kind: msg.type, code: String(msg.code || 'mark_voice_failed'), explain: msg.explain || null };
      return { kind: 'ignored' };
    },
    /** Pode mandar este quadro agora? (`bytes` = tamanho do quadro PCM16.) */
    canSend(bytes) {
      if (!ready || bye || bytes <= 0 || bytes > FRAME_BYTES_MAX || bytes % 2 !== 0) return false;
      // em `open` o Mark descarta sozinho o que chega enquanto fala; o cliente segue mandando para não estourar o idle_timeout (5 s)
      return mode === 'open' || down;
    },
    bye() { bye = true; send({ type: 'bye' }); },
    get mode() { return mode; },
    get ready() { return ready; },
    get down() { return down; },
  };
}

/**
 * Vigia do microfone mudo. O worklet de captura posta quadros o tempo todo, com ou sem botão; se nenhum chega enquanto o dono
 * quer falar, o áudio não está fluindo (contexto suspenso, nó nunca processado). `now` é injetado (ms) para o teste.
 */
function createMicWatchdog(now) {
  let armedAt = null;
  let lastFrameAt = null;
  return {
    /** Liga quando o botão é apertado ou a conversa abre; desliga ao soltar/fechar. Rearmar já armado não zera a contagem. */
    arm(on) {
      if (!on) { armedAt = null; return; }
      if (armedAt === null) armedAt = now();
    },
    frame() { lastFrameAt = now(); },
    silent() {
      if (armedAt === null) return false;
      const since = lastFrameAt !== null && lastFrameAt > armedAt ? lastFrameAt : armedAt;
      return now() - since >= MIC_SILENT_MS;
    },
  };
}

/** Linha de diagnóstico da folha: só estado do contexto, taxa e contagem; nenhum áudio. */
const diagLine = (d) => `áudio: ${d.state} · ${d.rate > 0 ? d.rate : '—'} Hz · ${d.frames} quadros enviados`;

/** Espaço segurado fala no desktop, mas nunca enquanto o foco está num campo de texto. */
function isTypingTarget(target) {
  if (!target || !target.tagName) return false;
  const tag = String(target.tagName).toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
}

window.ArgosVoiceLogic = {
  FRAME_BYTES_MAX, MODES, RECONNECT_TRIES, VOICE_PATH, INFO_TIMEOUT_MS, MIC_SILENT_MS,
  reconnectMs, isFatalCode, voiceUrl, micErrorCode, explainFor, levelOfPcm16, createVoiceProtocol, isTypingTarget,
  createMicWatchdog, diagLine,
};
})();
