// Termos e padrões da guarda de nome, domínio e segredo: a mesma do `hades skill-release check` e da varredura de
// `hades contrib`. Aqui só mora o que as duas compartilham (os termos, o padrão de identidade, o glob do @allow).
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { readText } from "./fs.ts";
import { domainTerms, nameTerms, vocabulary } from "./profile.ts";

// marcadores de segredo montados em partes: o pacote não pode conter o literal que a própria varredura procura
const SECRET_PARTS = [
  ["Hds!", "[A-Za-z0-9]"], ["eyJh", "bGci"], ["BEGIN (RSA|OPENSSH) ", "PRIVATE"],
] as const;
const SECRET_TAIL = String.raw`devtunnels\.ms/?[^ ]*[a-z0-9]{8}-|\b(JWT_SECRET|INTERNAL_SERVICE_TOKEN|MINIO_ROOT_PASSWORD)=[A-Za-z0-9_-]{8,}`;
const SLUG_KEY = "HADES_VERSION_CHECK_REPO";

const byCodepoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface GuardTerms {
  /** nomes e apelidos dos projetos (termo fixo, sem diferenciar caixa) */
  names: string[];
  /** vocabulário do projeto (ERE) */
  vocab: string[];
  /** termos de domínio (ERE) */
  domain: string[];
  /** globs de arquivos do núcleo isentos da guarda de domínio (@allow) */
  allow: string[];
  /** slug do repositório da própria skill: a linha que a cita não conta */
  slug: string;
}

/** Os termos dos perfis instalados; `roots` são as pastas de onde ler o slug da skill (config.tsv do kit). */
export function guardTerms(roots: string[]): GuardTerms {
  const { terms: domain, allow } = domainTerms();
  return {
    names: [...new Set(nameTerms().flatMap((p) => p.terms))].sort(byCodepoint),
    vocab: vocabulary().filter(Boolean),
    domain,
    allow: allow.filter(Boolean),
    slug: skillRepoSlug(roots),
  };
}

/** Padrão do repo da skill no config.tsv (HADES_VERSION_CHECK_REPO). */
export function skillRepoSlug(roots: string[]): string {
  for (const root of roots) {
    const row = (readText(join(root, "kit", "config.tsv")) ?? "").split("\n").map((l) => l.split("\t")).find((f) => f[0] === SLUG_KEY);
    if (row) return row[1] ?? "";
  }
  return "";
}

/** ERE só dos marcadores de segredo (sem usuário nem host): o que o pacote do Caronte varre nos arquivos e no patch. */
export function secretPattern(): string {
  return [...SECRET_PARTS.map((p) => p.join("")), SECRET_TAIL].join("|");
}

/** ERE de segredo e identidade da máquina (usuário e host desta máquina incluídos): nada disso pode ir no pacote. */
export function identityPattern(): string {
  let host = (readText("/etc/hostname") ?? "").replace(/[\r\n]/g, "");
  if (!host || host === "sandbox" || host === "localhost") host = hostname();
  if (host === "sandbox" || host === "localhost") host = "";
  const parts = SECRET_PARTS.map((p) => p.join(""));
  return [parts[0], parts[1], parts[2], `/home/${userInfo().username}/`, ...(host ? [host] : []), SECRET_TAIL].join("|");
}

/** glob do bash (`*` cobre `/`) → regex ancorada */
export function globRegex(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string;
    if (ch === "*") source += ".*";
    else if (ch === "?") source += ".";
    else if (ch === "[") {
      const end = glob.indexOf("]", i + 2);
      if (end < 0) source += "\\[";
      else {
        source += `[${glob.slice(i + 1, end).replace(/^!/, "^")}]`;
        i = end;
      }
    } else source += ch.replace(/[\\^$.|+(){}]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}
