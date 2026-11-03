// Varredura da contribuição antes de qualquer sugestão: nome de projeto, domínio e segredo, pelos mesmos termos do
// `hades skill-release check`, mais caminho da máquina, e-mail e credencial. Só linha posta conta; o achado diz
// arquivo:linha e o tipo, nunca o trecho (o segredo não é repetido na saída).
import type { FileDiff } from "./contrib-diff.ts";
import { globRegex, identityPattern, type GuardTerms } from "./release-guard.ts";

export interface Finding {
  file: string;
  /** 0 = o achado é do próprio caminho */
  line: number;
  kind: string;
}

export interface Text {
  label: string;
  text: string;
}

const MACHINE_PATH = /\/(?:home|Users)\/[A-Za-z0-9._-]+\//;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const EMAIL_NEUTRAL = /^(?:noreply|no-reply)@|@(?:example\.(?:com|org|net|invalid)|[a-z.]*invalid)$/i;
const CREDENTIAL_PATTERNS: RegExp[] = [
  /\bgh[opsur]_[A-Za-z0-9]{30,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/,
  /\b(?:password|passwd|senha|secret|token|api[_-]?key)\b["']?\s*[:=]\s*["'][^"'\s]{8,}["']/i,
];

function compile(source: string, flags: string, what: string): RegExp {
  try {
    return new RegExp(source, flags);
  } catch (error) {
    throw new Error(`termo de ${what} não compila (${source}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

interface Matchers {
  names: RegExp[];
  vocab: RegExp[];
  domain: RegExp[];
  allow: RegExp[];
  identity: RegExp;
  slug: string;
}

function matchers(terms: GuardTerms): Matchers {
  const escape = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    names: terms.names.map((t) => compile(escape(t), "i", "nome")),
    vocab: terms.vocab.map((t) => compile(t, "i", "vocabulário")),
    domain: terms.domain.map((t) => compile(t, "i", "domínio")),
    allow: terms.allow.map(globRegex),
    identity: compile(identityPattern(), "", "identidade"),
    slug: terms.slug.toLowerCase(),
  };
}

/** Um tipo de achado por linha (o primeiro que casa), na ordem: segredo, caminho da máquina, e-mail, nome, domínio. */
function kindOf(line: string, m: Matchers, allowDomain: boolean): string | undefined {
  if (m.identity.test(line) || CREDENTIAL_PATTERNS.some((p) => p.test(line))) return "credencial";
  if (MACHINE_PATH.test(line)) return "caminho da máquina";
  if ([...line.matchAll(EMAIL)].some((e) => !EMAIL_NEUTRAL.test(e[0]))) return "e-mail";
  const exempt = m.slug !== "" && line.toLowerCase().includes(m.slug);
  if (!exempt && [...m.names, ...m.vocab].some((p) => p.test(line))) return "nome de projeto";
  if (allowDomain && m.domain.some((p) => p.test(line))) return "domínio de projeto";
  return undefined;
}

/** Varre o título, o corpo e as linhas postas do núcleo; devolve os achados (vazio = pode gerar). */
export function scanContribution(core: FileDiff[], texts: Text[], terms: GuardTerms): Finding[] {
  const m = matchers(terms);
  const findings: Finding[] = [];
  for (const { label, text } of texts) {
    text.split("\n").forEach((line, i) => {
      const kind = kindOf(line, m, true);
      if (kind) findings.push({ file: label, line: i + 1, kind });
    });
  }
  for (const file of core) {
    if ([...m.names, ...m.vocab].some((p) => p.test(file.path))) findings.push({ file: file.path, line: 0, kind: "nome de projeto (caminho)" });
    const allowDomain = !m.allow.some((re) => re.test(file.path));
    for (const added of file.added) {
      const kind = kindOf(added.text, m, allowDomain);
      if (kind) findings.push({ file: file.path, line: added.line, kind });
    }
  }
  return findings;
}

export function formatFinding(f: Finding): string {
  return f.line === 0 ? `${f.file}  ${f.kind}` : `${f.file}:${f.line}  ${f.kind}`;
}
