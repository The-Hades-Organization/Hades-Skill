/* Captura da voz do Mark: recebe o microfone na taxa do AudioContext (44,1 ou 48 kHz), reamostra para 16 kHz mono e posta quadros
 * PCM16 little-endian de 30 ms (480 amostras, 960 bytes, dentro do teto de 3200 B do protocolo). Média por janela em vez de
 * pegar uma amostra a cada N: serve de filtro contra aliasing e preserva a amplitude. Nada é guardado além do quadro em
 * montagem. Roda no AudioWorkletGlobalScope (sem DOM); o bun test carrega o mesmo arquivo com `registerProcessor` falso. */
const TARGET_RATE = 16000;
const FRAME_SAMPLES = 480;

class Resampler {
  constructor(inRate) {
    this.ratio = inRate / TARGET_RATE;
    this.sum = 0;
    this.filled = 0;
    this.frame = new Int16Array(FRAME_SAMPLES);
    this.at = 0;
  }

  /** Consome `input` (Float32, -1..1); chama `onFrame(Int16Array)` a cada quadro completo. */
  push(input, onFrame) {
    for (let i = 0; i < input.length; i++) {
      const x = input[i];
      let left = 1;
      while (left > 1e-9) {
        const take = Math.min(left, this.ratio - this.filled);
        this.sum += x * take;
        this.filled += take;
        left -= take;
        if (this.filled >= this.ratio - 1e-9) {
          const v = Math.max(-1, Math.min(1, this.sum / this.ratio));
          this.frame[this.at++] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
          this.sum = 0;
          this.filled = 0;
          if (this.at === FRAME_SAMPLES) {
            onFrame(this.frame);
            this.frame = new Int16Array(FRAME_SAMPLES);
            this.at = 0;
          }
        }
      }
    }
  }
}

class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.resampler = new Resampler(sampleRate);
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.resampler.push(channel, (frame) => this.port.postMessage(frame.buffer, [frame.buffer]));
    return true;
  }
}

registerProcessor('voice-capture', VoiceCapture);
