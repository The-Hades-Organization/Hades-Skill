// `hades write-check [--changelog] [--json] <arquivo>...`: varre texto em pt-BR atrás dos padrões de escrita de IA que um grep decide
// (guia: reference/escrita.md). Código, aspas retas e comentário HTML ficam de fora, para o guia poder citar o que bane. O que
// exige juízo (voz, ritmo, fato sem fonte) não é daqui: passa pelo checklist de entrega do guia.
import { existsSync, readFileSync } from "node:fs";
import { EXIT, out, warn } from "../lib/output.ts";

export type Gravidade = "bloqueante" | "aviso";
export interface Achado { linha: number; codigo: string; gravidade: Gravidade; trecho: string; reparo: string }
export interface Opcoes { changelog?: boolean }

interface Regra { codigo: string; gravidade: Gravidade; re: RegExp; reparo: string; historico?: boolean }

const PALAVRA = "[\\p{L}\\p{N}]";
const sem = (s: string) => new RegExp(`(?<!${PALAVRA})(?:${s})(?!${PALAVRA})`, "iu");

// Regras por linha. `historico`: valem em documento, não em CHANGELOG (onde a mudança é o assunto).
const REGRAS: Regra[] = [
  { codigo: "travessao", gravidade: "bloqueante", re: /(?<=\S) [—–] (?=\S)|(?<=\S) -- (?=\S)/u, reparo: "vírgula, dois-pontos, ponto ou parênteses" },
  { codigo: "aspas-curvas", gravidade: "aviso", re: /[“”‘’]/u, reparo: "aspas retas" },
  { codigo: "residuo-de-chat", gravidade: "bloqueante", re: sem("espero ter ajudado|[óo]tima pergunta|claro!|com certeza!|aqui est[áa] (uma|um|o|a) (vis[ãa]o|resumo|panorama)|me avise|se quiser que eu|posso (ainda )?(expandir|detalhar)"), reparo: "apague; conversa não entra no texto" },
  { codigo: "gancho", gravidade: "bloqueante", re: sem("e [ée] (aqui|exatamente a[ií]) que|por que isso (muda tudo|importa)|e isso muda tudo|o que ningu[ée]m (te )?(conta|diz)|aqui est[áa] o (que|segredo)|a verdade (inc[ôo]moda )?[ée] que|eis a virada|e ent[ãa]o tudo ficou claro"), reparo: "diga o fato, sem anunciar a revelação" },
  { codigo: "antitese", gravidade: "aviso", re: /(?<!\p{L})n[ãa]o (?:[ée]|foi|s[ãa]o|era) (?:apenas|s[óo]|somente|simplesmente|mais) [^.;:!?\n]{1,70}[,;]? (?:mas|[ée]|e sim)(?!\p{L})|(?<!\p{L})n[ãa]o (?:[ée]|foi|s[ãa]o|era) [^.;:!?\n]{1,50}, (?:[é]|foi|s[ãa]o|era) (?!n[ãa]o)|(?<!\p{L})n[ãa]o se trata (?:apenas |s[óo] |somente )?d[eoa]s? [^.;:!?\n]{1,70}[,;]? (?:mas|e sim)(?!\p{L})|(?<!\p{L})n[ãa]o (?:apenas|s[óo]|somente) [^.;:!?\n]{1,70}, mas (?:tamb[ée]m )?/iu, reparo: "afirme o que é; contraste só quando corrige algo que o leitor acredita" },
  { codigo: "anuncio-de-importancia", gravidade: "aviso", re: sem("[ée] importante (notar|salientar|destacar|ressaltar|lembrar)|vale (a pena )?(destacar|ressaltar|lembrar|notar|mencionar)|cabe (ressaltar|destacar|salientar)|o ponto (central|chave)|o que importa [ée]|o principal aprendizado"), reparo: "diga a consequência concreta" },
  { codigo: "recap", gravidade: "aviso", re: /^\s*(?:[-*]\s+)?(?:em (?:resumo|suma|conclus[ãa]o)|resumindo|no fim das contas|no final das contas)\b/iu, reparo: "termine no último fato" },
  { codigo: "vocabulario-inflado", gravidade: "aviso", re: sem("crucial|robust(?:[oa]s?|ez)|poderos[oa]s?|abrangente|revolucion[áa]ri[oa]|de ponta|inovador(?:a|es|as)?|de classe mundial|state-of-the-art|imperd[ií]vel|sem fric[çc][ãa]o|perfeitamente|seamless|elegante|cen[áa]rio (?:atual|em constante evolu[çc][ãa]o)|no cen[áa]rio atual|jornada|tape[çc]aria|mergulh(?:ar|o) profundo|alavancar|potencializ(?:ar|a|ando)|desbloquear|ponto de virada|papel (?:fundamental|central|crucial)"), reparo: "número, propriedade nomeada ou nada" },
  { codigo: "muleta-formal", gravidade: "aviso", re: sem("no que tange|[àa] luz d[eoa]s?|nesse sentido|neste sentido|tendo em vista que|devido ao fato|com o objetivo de|de forma a (?:garantir|permitir)|possui a capacidade|em virtude d[eoa]|al[ée]m disso|vale ressaltar|no contexto atual"), reparo: "a palavra simples (para, porque, se, agora)" },
  { codigo: "gerundio-final", gravidade: "aviso", re: /, (?:garantindo|permitindo|proporcionando|promovendo|destacando|evidenciando|demonstrando|refletindo|simbolizando|contribuindo|refor[çc]ando|consolidando|facilitando|otimizando|elevando|impulsionando)(?!\p{L})/iu, reparo: "corte a cauda: ela não acrescenta fato" },
  { codigo: "atribuicao-vaga", gravidade: "aviso", re: sem("(?:especialistas|estudos|pesquisas|analistas|observadores|muitos|alguns críticos|a comunidade) (?:dizem|apontam|mostram|acreditam|sugerem|indicam|argumentam)|relat[óo]rios do setor"), reparo: "cite a fonte e o achado, ou assuma como opinião" },
  { codigo: "cabecalho-pergunta", gravidade: "aviso", re: /^#{1,6}\s+.*\?\s*$|^#{1,6}\s+(?:por que|o que significa|por que isso)\b/iu, reparo: "substantivo que nomeia o conteúdo" },
  { codigo: "emoji", gravidade: "aviso", re: /[\u{1F300}-\u{1FAFF}\u{2705}\u{274C}\u{2728}\u{26A1}\u{2B50}]/u, reparo: "marcador simples" },
  { codigo: "residuo-de-producao", gravidade: "aviso", historico: true, re: sem("conforme (?:o )?(?:pedido|solicitado)|como solicitado|a pedido d[eo]|conforme as instru[çc][õo]es|diferente da vers[ãa]o anterior|esta se[çc][ãa]o foi adicionada"), reparo: "a restrição molda o texto e fica invisível" },
  { codigo: "diario-de-edicao", gravidade: "aviso", historico: true, re: sem("foi refatorad[oa] para|agora usa|substitui (?:o|a) (?:antigo|antiga)|antes era|passou a usar"), reparo: "descreva o que o sistema faz; a mudança é do CHANGELOG" },
];

/** Troca por espaços o que o checador não julga: bloco de código, `código`, "aspas retas", comentário HTML, destino de link, metadados. */
export function mascarar(texto: string): string[] {
  const linhas = texto.split("\n");
  const saida: string[] = [];
  let cerca = "";
  let meta = linhas[0] === "---";
  let comentario = false;
  linhas.forEach((original, i) => {
    let l = original;
    if (meta) {
      if (i > 0 && l === "---") meta = false;
      saida.push("");
      return;
    }
    const m = /^\s*(```+|~~~+)/.exec(l);
    if (cerca) {
      if (m && m[1]!.startsWith(cerca[0]!) && m[1]!.length >= cerca.length) cerca = "";
      saida.push("");
      return;
    }
    if (m) {
      cerca = m[1]!;
      saida.push("");
      return;
    }
    const branco = (s: string) => s.replace(/[^\n]/g, " ");
    if (comentario) {
      const fim = l.indexOf("-->");
      if (fim < 0) { saida.push(""); return; }
      l = " ".repeat(fim + 3) + l.slice(fim + 3);
      comentario = false;
    }
    l = l.replace(/<!--.*?-->/g, branco);
    const abre = l.indexOf("<!--");
    if (abre >= 0) { l = l.slice(0, abre); comentario = true; }
    l = l.replace(/`[^`]*`/g, branco).replace(/\]\([^)]*\)/g, (s) => `]${" ".repeat(s.length - 1)}`);
    l = l.replace(/"[^"\n]{0,160}"/g, branco);
    if (/^\s*\|/.test(l)) l = l.replace(/\|\s*[—–]\s*(?=\|)/g, (s) => " ".repeat(s.length));
    saida.push(l);
  });
  return saida;
}

const CABECALHO = /^#{1,6}\s/;
const NEGRITO_ABRE = /^\s*(?:[-*]|\d+\.)\s+(?:\*\*[^*\n]+[:.]\*\*|\*\*[^*\n]+\*\*\s*[:.—-])/;

/** Title Case em cabeçalho: duas ou mais palavras (fora a primeira) iniciadas em maiúscula, sem serem sigla nem sigla com dígito. */
function titleCase(l: string): boolean {
  const palavras = l.replace(/^#{1,6}\s+/, "").split(/\s+/).slice(1).filter((p) => /^\p{L}{4,}$/u.test(p));
  return palavras.filter((p) => /^\p{Lu}\p{Ll}+$/u.test(p)).length >= 2;
}

export function checar(texto: string, o: Opcoes = {}): Achado[] {
  const achados: Achado[] = [];
  const linhas = mascarar(texto);
  const cru = texto.split("\n");
  const add = (linha: number, codigo: string, gravidade: Gravidade, trecho: string, reparo: string) =>
    achados.push({ linha, codigo, gravidade, trecho: trecho.trim().slice(0, 90), reparo });
  linhas.forEach((l, i) => {
    if (!l.trim()) return;
    const cab = CABECALHO.test(l);
    for (const r of REGRAS) {
      if (o.changelog && r.historico) continue;
      if (cab && r.codigo === "travessao") continue;
      if (!cab && r.codigo === "cabecalho-pergunta") continue;
      const m = r.re.exec(l);
      if (m) add(i + 1, r.codigo, r.gravidade, cru[i]!.slice(Math.max(0, m.index - 12), m.index + m[0].length + 24), r.reparo);
    }
    if (cab && titleCase(l)) add(i + 1, "title-case", "aviso", cru[i]!, "maiúscula só na primeira palavra e nos nomes próprios");
  });
  if (!o.changelog) {
    // Três itens seguidos com rótulo em negrito: a lista é subseção disfarçada.
    for (let i = 0; i + 2 < linhas.length; i++) {
      if (![0, 1, 2].every((k) => NEGRITO_ABRE.test(cru[i + k]!) && linhas[i + k]!.trim())) continue;
      let fim = i + 3;
      while (fim < linhas.length && NEGRITO_ABRE.test(cru[fim]!)) fim++;
      add(i + 1, "negrito-de-rotulo", "aviso", cru[i]!, `${fim - i} itens abrem com rótulo em negrito: itens paralelos sem rótulo ou subseções`);
      i = fim - 1;
    }
  }
  return achados.sort((a, b) => a.linha - b.linha);
}

const USO = "uso: hades write-check [--changelog] [--json] <arquivo>...   (0 limpo · 1 achados · 2 uso)";

export function writeCheckCommand(args: string[]): number {
  const o: Opcoes = {};
  let json = false;
  const arquivos: string[] = [];
  for (const a of args) {
    if (a === "--changelog") o.changelog = true;
    else if (a === "--json") json = true;
    else if (a === "-h" || a === "--help") { out(USO); return EXIT.ok; }
    else if (a.startsWith("--")) { warn(`opção desconhecida: ${a}\n${USO}`); return EXIT.usage; }
    else arquivos.push(a);
  }
  if (arquivos.length === 0) { warn(USO); return EXIT.usage; }
  const faltando = arquivos.filter((f) => !existsSync(f));
  if (faltando.length) { warn(`arquivo inexistente: ${faltando.join(", ")}`); return EXIT.usage; }
  const resultado = arquivos.map((arquivo) => ({ arquivo, achados: checar(readFileSync(arquivo, "utf8"), o) }));
  const total = resultado.reduce((n, r) => n + r.achados.length, 0);
  if (json) out(JSON.stringify(resultado, null, 2));
  else {
    for (const r of resultado) for (const a of r.achados) out(`${r.arquivo}:${a.linha}: ${a.gravidade} [${a.codigo}] ${a.trecho} => ${a.reparo}`);
    const bloqueantes = resultado.reduce((n, r) => n + r.achados.filter((a) => a.gravidade === "bloqueante").length, 0);
    out(total === 0 ? "write-check: limpo" : `write-check: ${total} achado(s), ${bloqueantes} bloqueante(s). O resto (voz, ritmo, fato sem fonte) é do checklist do guia.`);
  }
  return total === 0 ? EXIT.ok : EXIT.fail;
}
