// Anel de saída de uma sessão: guarda os últimos `capacity` bytes e conta o total já escrito (offset absoluto), para o
// cliente retomar de onde parou depois de reconectar.
export interface Ring {
  /** offset do byte mais antigo ainda guardado */
  readonly start: number;
  /** offset logo depois do último byte escrito */
  readonly end: number;
  write(data: Uint8Array): void;
  /** até `max` bytes a partir de `from` (já recortado ao que existe); vazio se `from` está no fim */
  read(from: number, max: number): Uint8Array;
}

export function createRing(capacity: number): Ring {
  const buf = new Uint8Array(capacity);
  let end = 0;
  const start = (): number => Math.max(0, end - capacity);
  return {
    get start() { return start(); },
    get end() { return end; },
    write(data) {
      // um bloco maior que o anel só deixa a cauda; o contador anda o que foi recebido
      const tail = data.length > capacity ? data.subarray(data.length - capacity) : data;
      const skipped = data.length - tail.length;
      const pos = (end + skipped) % capacity;
      const first = Math.min(tail.length, capacity - pos);
      buf.set(tail.subarray(0, first), pos);
      buf.set(tail.subarray(first), 0);
      end += data.length;
    },
    read(from, max) {
      const lo = Math.max(from, start());
      const n = Math.min(max, end - lo);
      if (n <= 0) return new Uint8Array(0);
      const out = new Uint8Array(n);
      const pos = lo % capacity;
      const first = Math.min(n, capacity - pos);
      out.set(buf.subarray(pos, pos + first), 0);
      out.set(buf.subarray(0, n - first), first);
      return out;
    },
  };
}
