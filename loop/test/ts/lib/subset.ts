// Mesma regra de loop/test/subset.py: todo campo do esperado existe igual no atual (campo novo passa); listas comparam
// por posição e com o mesmo tamanho, porque ordem e quantidade de PRs, achados e avisos são comportamento.
type J = unknown;
const isObj = (v: J): v is Record<string, J> => typeof v === "object" && v !== null && !Array.isArray(v);

export function subsetDiff(exp: J, act: J, path = "$", out: string[] = []): string[] {
  if (isObj(exp)) {
    if (!isObj(act)) { out.push(`${path}: esperado objeto`); return out; }
    for (const [k, v] of Object.entries(exp)) {
      if (!(k in act)) out.push(`${path}.${k}: ausente`); else subsetDiff(v, act[k], `${path}.${k}`, out);
    }
  } else if (Array.isArray(exp)) {
    if (!Array.isArray(act) || act.length !== exp.length) { out.push(`${path}: esperado lista de ${exp.length}`); return out; }
    exp.forEach((e, i) => subsetDiff(e, act[i], `${path}[${i}]`, out));
  } else if (exp !== act) out.push(`${path}: ${JSON.stringify(exp)} → ${JSON.stringify(act)}`);
  return out;
}
