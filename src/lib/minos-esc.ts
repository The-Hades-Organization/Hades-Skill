// Minos: o escape de todo texto que entra numa página.
const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (value: string): string => value.replace(/[&<>"']/g, (c) => ESCAPES[c] as string);
