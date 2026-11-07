/* Links clicáveis e busca do terminal do nó do Argos (reference/argos.md §Links, busca e mouse do terminal do nó). Só regra pura:
 * o desenho (barra de busca, destaque, provedor de links do xterm) é do node-tty.tsx. Script clássico, carregado antes dele.
 * Expõe window.ArgosTtyExtras.
 * Links: URL http(s) (a regra da página Terminal, TermLogic.findLinks) e caminho ABSOLUTO de arquivo. Se o caminho abre, quem
 * decide é o servidor (POST /api/canvas-notes/link: caminho normalizado, real e dentro de uma raiz permitida); aqui só se acha
 * o texto. Busca: sem expressão regular montada com a entrada (indexOf), com teto de consulta, de linhas e de achados. */
(() => {
const { clampOffset } = window.TermLogic;

const QUERY_MAX = 200;
const MATCH_MAX = 2000;
const LINE_MAX = 4096;
// SGR e demais sequências do ANSI que o herdr entrega (mesma família do ANSI_SEQ de term-logic.tsx, que não é exportado)
const ANSI_SEQ = /\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// caminho absoluto: começa em `/` depois de início de linha, espaço ou delimitador de abertura; sem `//` (URL já é do outro padrão)
const PATH_RE = /(?<=^|[\s(\[{"'`=:])\/(?!\/)[\w.@+~%-]+(?:\/[\w.@+~%-]+)*\/?/g;
const PATH_TRAILING = /[.,;:!?)\]}>'"`]+$/;
// `arquivo.ts:12:3` e `arquivo.ts:12`: a posição não faz parte do caminho
const LINE_SUFFIX = /:\d+(?::\d+)?$/;

/** O texto da linha sem as sequências do ANSI. */
const stripAnsi = (line) => String(line).replace(ANSI_SEQ, '');

/** `true` se `[a, b)` encosta em algum intervalo de `taken`. */
const overlaps = (taken, start, end) => taken.some((t) => start < t.end && end > t.start);

/**
 * Links de uma linha de texto puro (colunas 0-based, `end` exclusivo): `{ kind: 'url', start, end, url }` ou
 * `{ kind: 'path', start, end, path }`, em ordem de posição. URL vence caminho quando se sobrepõem. Linha longa demais: nenhum.
 */
function linksOf(line) {
  if (typeof line !== 'string' || line.length === 0 || line.length > LINE_MAX) return [];
  const out = window.TermLogic.findLinks(line, LINE_MAX).map((l) => ({ kind: 'url', start: l.start, end: l.end, url: l.url }));
  for (const m of line.matchAll(PATH_RE)) {
    const withPos = m[0].replace(PATH_TRAILING, '');
    const path = withPos.replace(LINE_SUFFIX, '');
    // só `/` ou `/x` solto não é caminho de arquivo que valha um link
    if (path.length < 2 || m.index === undefined) continue;
    // a posição `:12:3` depois do caminho entra no trecho clicável
    const rest = line.slice(m.index + withPos.length);
    const pos = LINE_SUFFIX.exec(withPos) ? '' : (/^:\d+(?::\d+)?/.exec(rest) || [''])[0];
    const end = m.index + withPos.length + pos.length;
    if (overlaps(out, m.index, end)) continue;
    out.push({ kind: 'path', start: m.index, end, path });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Caminho do arquivo que o servidor decide: só absoluto e sem NUL (a conferência de raiz é dele, nunca daqui). */
const openablePath = (path) => typeof path === 'string' && path.startsWith('/') && !path.includes('\u0000') && path.length <= 1024;

/** Consulta aparada ao teto; `''` quando não há o que procurar. */
const normalizeQuery = (raw) => String(raw == null ? '' : raw).slice(0, QUERY_MAX);

/**
 * Linhas (ANSI) onde procurar: o histórico do `scrollback` com as últimas `rows` linhas trocadas pela tela de agora (o histórico
 * termina na tela e envelhece entre cargas). Sem histórico, ou com o histórico menor que a tela, só a tela, completada com
 * linhas vazias até `rows` (o herdr apara as vazias do fim).
 */
function searchLines(history, screen, rows) {
  const tail = screen.slice(0, rows);
  while (tail.length < rows) tail.push('');
  if (!Array.isArray(history) || history.length <= rows) return tail;
  return history.slice(0, history.length - rows).concat(tail);
}

/**
 * Achados de `query` em `lines` (ANSI; só o texto conta; sem diferenciar maiúscula de minúscula, sem se sobrepor na linha), em ordem de linha e coluna:
 * `{ line, col, len }` (0-based). `truncated` quando passou do teto de achados.
 */
function findMatches(lines, query, max = MATCH_MAX) {
  const q = normalizeQuery(query).toLowerCase();
  const matches = [];
  if (q === '') return { matches, truncated: false };
  for (let line = 0; line < lines.length; line++) {
    const text = stripAnsi(lines[line]).toLowerCase();
    for (let at = text.indexOf(q); at !== -1; at = text.indexOf(q, at + q.length)) {
      if (matches.length >= max) return { matches, truncated: true };
      matches.push({ line, col: at, len: q.length });
    }
  }
  return { matches, truncated: false };
}

/** Próximo (`dir` 1) ou anterior (`dir` -1) achado, dando a volta nas pontas; `-1` quando não há achado. */
function stepMatch(count, current, dir) {
  if (!(count > 0)) return -1;
  if (!(current >= 0 && current < count)) return dir < 0 ? count - 1 : 0;
  return (current + (dir < 0 ? -1 : 1) + count) % count;
}

/** O que a barra mostra: `3/12`, `Sem resultado`, ou `` sem consulta. `truncated` marca o teto (`2000+`). */
function searchCount(query, count, current, truncated) {
  if (normalizeQuery(query) === '') return '';
  if (count === 0) return 'Sem resultado';
  return `${current + 1}/${count}${truncated ? '+' : ''}`;
}

/**
 * Deslocamento do histórico (linhas a partir do fim) que põe a linha `line` de `total` na janela de `rows` linhas, mais ou menos no
 * meio; 0 é o fim (ao vivo, quando a linha já está na tela).
 */
function offsetFor(line, total, rows) {
  const end = Math.min(total, line + Math.ceil(rows / 2));
  return clampOffset(total - end, total, rows);
}

/** Posição do achado na janela de `rows` linhas que termina `offset` antes do fim; `null` se a linha não está nela. */
function matchInWindow(match, total, rows, offset) {
  const end = total - clampOffset(offset, total, rows);
  const first = Math.max(0, end - rows);
  return match.line >= first && match.line < end ? { row: match.line - first, col: match.col, len: match.len } : null;
}

/** Esc fecha a busca, Enter vai ao próximo e Shift+Enter ao anterior; `null` para o resto (vai ao campo). */
function searchKeyIntent(e) {
  if (e.key === 'Escape') return 'close';
  if (e.key === 'Enter') return e.shiftKey ? 'prev' : 'next';
  return null;
}

/** Ctrl+F (e Cmd+F) abre a busca; só vale com o nó focado e sem Shift ou Alt. */
const isSearchChord = (e) => (e.ctrlKey !== e.metaKey) && !e.shiftKey && !e.altKey && typeof e.key === 'string' && e.key.toLowerCase() === 'f';

window.ArgosTtyExtras = { linksOf, openablePath, stripAnsi, normalizeQuery, searchLines, findMatches, stepMatch, searchCount, offsetFor, matchInWindow, searchKeyIntent, isSearchChord, QUERY_MAX, MATCH_MAX };
})();
