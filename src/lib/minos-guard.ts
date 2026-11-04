// Minos: a guarda antes de toda publicação e atualização. Duas camadas, ambas antes de qualquer arquivo ficar no lugar:
// (1) varredura em memória (credencial, caminho da máquina, e-mail, nome de projeto) mais os valores do `credenciais.md`;
// (2) o momento `artefato` do Cerberus (segredo-diff) sobre a página numa pasta de preparo. O achado diz onde e o tipo,
// nunca o trecho.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate } from "./cerberus.ts";
import { formatFinding, scanContribution, type Text } from "./contrib-scan.ts";
import { guardTerms, type GuardTerms } from "./release-guard.ts";

const MIN_SECRET_LENGTH = 8;
const CREDENTIAL_LINE = /^\s*(?:[-*]\s*)?`?[A-Z][A-Z0-9_]*`?\s*[=:]\s*(.*?)\s*$/;

/** Valores de `credenciais.md` (`CHAVE=valor`) com tamanho para valer como segredo; o valor nunca sai desta função em log. */
export function credentialValues(credentials: string | undefined): string[] {
  return (credentials ?? "").split("\n").flatMap((line) => {
    const value = CREDENTIAL_LINE.exec(line)?.[1]?.replace(/^["'`]|["'`]$/g, "") ?? "";
    return value.length >= MIN_SECRET_LENGTH ? [value] : [];
  });
}

export interface ScanInput {
  texts: Text[];
  credentials?: string;
  terms: GuardTerms;
}

/** Motivos da recusa (vazio = pode sair). Cada um é "rótulo:linha  tipo"; o trecho achado nunca é repetido. */
export function scanOutput(input: ScanInput): string[] {
  const reasons = scanContribution([], input.texts, input.terms).map(formatFinding);
  const values = credentialValues(input.credentials);
  for (const { label, text } of input.texts) {
    text.split("\n").forEach((line, i) => {
      if (values.some((v) => line.includes(v))) reasons.push(`${label}:${i + 1}  valor do credenciais.md`);
    });
  }
  return reasons;
}

interface Verdict { efeito?: unknown; detalhe?: unknown; evidencia?: unknown }

function barredBy(v: Verdict): string[] {
  if (v.efeito !== "barra") return [];
  const evidence = Array.isArray(v.evidencia) ? v.evidencia : [];
  const lines = evidence.flatMap((e) => (typeof e === "object" && e !== null && typeof (e as { conferido?: unknown }).conferido === "string" ? [(e as { conferido: string }).conferido] : []));
  return lines.length ? lines : [typeof v.detalhe === "string" ? v.detalhe : "o Cerberus barrou sem detalhe"];
}

/** O Cerberus (momento `artefato`) sobre a página; a pasta de preparo some em qualquer caso. */
export function cerberusReasons(page: string, cwd: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "minos-"));
  try {
    writeFileSync(join(dir, "index.html"), page);
    const result = evaluate("artefato", { arquivo: dir }, cwd);
    return result.resultado === "barra" ? result.vereditos.flatMap((v) => barredBy(v)) : [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface GuardRequest {
  page: string;
  data: string;
  credentials?: string;
  skillRoots: string[];
  cwd: string;
}

/** Camada 1 e depois 2. Lista vazia = liberado. */
export function guardPublication(request: GuardRequest): string[] {
  const memory = scanOutput({
    texts: [{ label: "página", text: request.page }, { label: "dados", text: request.data }],
    credentials: request.credentials, terms: guardTerms(request.skillRoots),
  });
  return memory.length ? memory : cerberusReasons(request.page, request.cwd);
}
