/* Reprodução da voz do Mark: recebe PCM16 mono a 24 kHz pela porta, converte para a taxa do AudioContext (interpolação linear)
 * e toca de uma fila com buffer de jitter curto. Começa a tocar com PREBUFFER_MS acumulados; se a fila seca, volta a esperar
 * o mesmo tanto (silêncio em vez de estalo). A fila tem teto: passando dele a fala mais velha sai, porque voz atrasada é pior
 * que cortada. `{clear:true}` esvazia tudo (o Mark avisou `interrupted`). Roda no AudioWorkletGlobalScope; o bun test carrega
 * o mesmo arquivo com `registerProcessor` falso. */
const SOURCE_RATE = 24000;
const PREBUFFER_MS = 120;
const MAX_QUEUE_MS = 3000;

class PlayQueue {
  constructor(outRate) {
    this.step = SOURCE_RATE / outRate;
    this.prebuffer = Math.round((SOURCE_RATE * PREBUFFER_MS) / 1000);
    this.max = Math.round((SOURCE_RATE * MAX_QUEUE_MS) / 1000);
    this.chunks = [];
    this.queued = 0;
    this.pos = 0;
    this.playing = false;
  }

  /** `pcm`: Int16Array a 24 kHz. */
  push(pcm) {
    if (pcm.length === 0) return;
    this.chunks.push(pcm);
    this.queued += pcm.length;
    while (this.queued - this.pos > this.max && this.chunks.length > 1) {
      this.queued -= this.chunks[0].length;
      this.chunks.shift();
      this.pos = 0;
    }
  }

  clear() {
    this.chunks = [];
    this.queued = 0;
    this.pos = 0;
    this.playing = false;
  }

  /** Amostra na posição fracionária `p` da fila (a partir do começo do primeiro bloco), ou null se faltar. */
  sampleAt(p) {
    let i = Math.floor(p);
    const frac = p - i;
    let a = null;
    let b = null;
    for (const chunk of this.chunks) {
      if (i < chunk.length) {
        a = chunk[i];
        b = i + 1 < chunk.length ? chunk[i + 1] : null;
        if (b === null) {
          const next = this.chunks[this.chunks.indexOf(chunk) + 1];
          b = next ? next[0] : a;
        }
        break;
      }
      i -= chunk.length;
    }
    if (a === null) return null;
    return ((a + (b - a) * frac) / 32768);
  }

  /** Preenche `out` (Float32); o que falta vira silêncio. */
  pull(out) {
    if (!this.playing) {
      if (this.queued - this.pos < this.prebuffer) { out.fill(0); return; }
      this.playing = true;
    }
    for (let n = 0; n < out.length; n++) {
      const v = this.sampleAt(this.pos);
      if (v === null) {
        out.fill(0, n);
        this.clear();
        return;
      }
      out[n] = v;
      this.pos += this.step;
      // descarta bloco inteiro já tocado
      while (this.chunks.length > 0 && this.pos >= this.chunks[0].length) {
        this.pos -= this.chunks[0].length;
        this.queued -= this.chunks[0].length;
        this.chunks.shift();
      }
    }
  }
}

class VoicePlay extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = new PlayQueue(sampleRate);
    this.port.onmessage = (event) => {
      const data = event.data;
      if (data && data.clear) this.queue.clear();
      else if (data instanceof ArrayBuffer && data.byteLength >= 2) this.queue.push(new Int16Array(data, 0, data.byteLength >> 1));
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (out) this.queue.pull(out);
    return true;
  }
}

registerProcessor('voice-play', VoicePlay);
