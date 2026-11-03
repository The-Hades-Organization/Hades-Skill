// Citação de argumento como o `printf %q` do bash (saída de dry-run que o dono pode copiar e colar).
const SAFE = /^[A-Za-z0-9_@%+=:./-]$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

function ansiC(arg: string): string {
  const escaped = [...arg].map((ch) => {
    if (ch === "'") return "\\'";
    if (ch === "\\") return "\\\\";
    if (ch === "\n") return "\\n";
    if (ch === "\t") return "\\t";
    if (ch === "\r") return "\\r";
    if (CONTROL.test(ch)) return `\\${ch.charCodeAt(0).toString(8).padStart(3, "0")}`;
    return ch;
  });
  return `$'${escaped.join("")}'`;
}

export function shellQuote(arg: string): string {
  if (arg === "") return "''";
  if (CONTROL.test(arg)) return ansiC(arg);
  return [...arg].map((ch, index) => (SAFE.test(ch) || ch.charCodeAt(0) > 127 || ((ch === "~" || ch === "#") && index > 0) ? ch : `\\${ch}`)).join("");
}
