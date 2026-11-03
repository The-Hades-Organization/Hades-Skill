/* Number Ticker (Magic UI), reinterpretado sem o motion: o número que mudou conta do valor anterior até o novo em
 * 600 ms com saída exponencial. O primeiro valor aparece direto (conta só na mudança, não na chegada), e o movimento
 * reduzido troca direto. Exposto em window.HadesFx.NumberTicker; HadesCore.Num o usa quando chegou. */
(() => {
const { useEffect, useRef, useState } = React;
const DURATION_MS = 600;
const easeOut = (t) => 1 - Math.pow(2, -10 * t);
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function NumberTicker({ value, format = (v) => String(v), decimals = 0 }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = from.current;
    from.current = value;
    if (start === value || reduced()) { setShown(value); return undefined; }
    const t0 = performance.now(), k = 10 ** decimals;
    let frame = requestAnimationFrame(function tick(now) {
      const t = Math.min(1, (now - t0) / DURATION_MS);
      setShown(Math.round((start + (value - start) * easeOut(t)) * k) / k);
      if (t < 1) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [value, decimals]);
  return <span className="tnum">{format(shown)}</span>;
}

window.HadesFx = { ...window.HadesFx, NumberTicker };
})();
