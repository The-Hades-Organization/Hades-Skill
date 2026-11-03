// Nó portal do canvas (reference/argos.md §Portal web): uma página web embutida num nó. Aqui ficam as regras puras, sem Node
// e sem DOM: que URL se aceita, quais hosts valem, se uma página pode ser embutida (a partir dos cabeçalhos que a rota lê) e
// a criação do nó pela pilha de desfazer. Quem busca os cabeçalhos é `src/panel/canvas-portal.ts`.
import { CANVAS_LIMITS, type CanvasDoc, type CanvasNode } from "./canvas-doc.ts";
import { type AtomicOp, opCreate, opUpdate } from "./canvas-history.ts";

export const PORTAL_NODE_TYPE = "portal";

export const PORTAL_LIMITS = {
  urlChars: 2048,
  /** Entradas lidas da chave de configuração; as que passam disto vão para `ignored`, nunca somem em silêncio. */
  extraHosts: 100,
  hostChars: 253,
  redirects: 3,
} as const;

export const PORTAL_DEFAULT_SIZE = { w: 640, h: 420 } as const;

/** Códigos estáveis: só ganham valores, nunca renomeiam. */
export const PORTAL_ERRORS = {
  invalidUrl: "portal_invalid_url",
  urlTooLong: "portal_url_too_long",
  scheme: "portal_scheme",
  credentials: "portal_credentials",
  hostNotAllowed: "portal_host_not_allowed",
  invalidNode: "portal_invalid_node",
} as const;
export type PortalErrorCode = (typeof PORTAL_ERRORS)[keyof typeof PORTAL_ERRORS];

export class PortalError extends Error {
  readonly code: PortalErrorCode;
  constructor(code: PortalErrorCode, message: string) {
    super(message);
    this.name = "PortalError";
    this.code = code;
  }
}

/** Por que uma página vira link em vez de embutida. Só ganha valores. */
export const PORTAL_BLOCKS = {
  frameOptionsDeny: "frame_options_deny",
  frameOptionsSameOrigin: "frame_options_sameorigin",
  frameOptionsUnknown: "frame_options_unknown",
  cspFrameAncestors: "csp_frame_ancestors",
  redirectOutside: "redirect_outside",
  redirectLimit: "redirect_limit",
  mixedContent: "mixed_content",
  remoteLoopback: "remote_loopback",
  unreachable: "unreachable",
  timeout: "timeout",
} as const;
export type PortalBlock = (typeof PORTAL_BLOCKS)[keyof typeof PORTAL_BLOCKS];

const fail = (code: PortalErrorCode, message: string): never => {
  throw new PortalError(code, message);
};

// ---- hosts permitidos ----

/** `localhost` e os dois endereços de loopback: a porta é livre (os serviços do Hades sobem em portas próprias). */
export const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];

const LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
const HOST_EXACT = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);
/** `*.exemplo.com`: o sufixo tem de ter pelo menos dois rótulos (`*.com` abriria a internet inteira). */
const HOST_WILDCARD = new RegExp(`^\\*\\.(${LABEL}(?:\\.${LABEL})+)$`);

export interface PortalPolicy {
  /** Hosts exatos, em minúsculas (inclui os de loopback). */
  readonly exact: ReadonlySet<string>;
  /** Sufixos de `*.sufixo`, sem o `*.`. */
  readonly suffixes: readonly string[];
  /** Entradas da configuração descartadas (formato inválido, coringa largo demais ou acima do teto). */
  readonly ignored: readonly string[];
}

export interface PortalPolicyInput {
  /** Hosts dos serviços do Hades que não são loopback (por exemplo o do túnel do painel). */
  hadesHosts?: readonly string[];
  /** Valor cru da chave `HADES_CANVAS_PORTAL_HOSTS`: hosts separados por vírgula, `*.exemplo.com` aceito. */
  extraHosts?: string;
}

const hostOnly = (raw: string): string => raw.trim().toLowerCase().replace(/\.$/, "");

/** Lê a política uma vez (na subida ou quando a configuração muda); a conferência por URL só consulta o resultado. */
export function buildPortalPolicy(input: PortalPolicyInput = {}): PortalPolicy {
  const exact = new Set<string>(LOOPBACK_HOSTS);
  const suffixes = new Set<string>();
  const ignored: string[] = [];
  const candidates = [...(input.hadesHosts ?? []), ...(input.extraHosts ?? "").split(",")].map(hostOnly).filter((host) => host !== "");
  candidates.forEach((host, index) => {
    if (index >= PORTAL_LIMITS.extraHosts) return void ignored.push(host);
    const wildcard = HOST_WILDCARD.exec(host);
    if (wildcard) return void suffixes.add(wildcard[1] as string);
    if (host.length <= PORTAL_LIMITS.hostChars && HOST_EXACT.test(host)) return void exact.add(host);
    ignored.push(host);
  });
  return { exact, suffixes: [...suffixes], ignored };
}

export function isHostAllowed(hostname: string, policy: PortalPolicy): boolean {
  const host = hostOnly(hostname);
  return policy.exact.has(host) || policy.suffixes.some((suffix) => host.endsWith(`.${suffix}`));
}

export const isLoopbackHost = (hostname: string): boolean => LOOPBACK_HOSTS.includes(hostOnly(hostname));

// ---- URL aceita ----

/**
 * Confere a URL do portal e devolve a forma normalizada. Só http/https, sem usuário nem senha, sem espaço ou caractere de
 * controle, até `urlChars`, e o host na lista. Qualquer outra coisa lança `PortalError` com código estável.
 */
export function checkPortalUrl(raw: unknown, policy: PortalPolicy): URL {
  if (typeof raw !== "string") return fail(PORTAL_ERRORS.invalidUrl, "URL do portal precisa ser texto");
  const text = raw.trim();
  if (text === "") return fail(PORTAL_ERRORS.invalidUrl, "URL do portal vazia");
  if (text.length > PORTAL_LIMITS.urlChars) return fail(PORTAL_ERRORS.urlTooLong, "URL do portal longa demais");
  if (/[\s\u0000-\u001f\u007f]/.test(text)) return fail(PORTAL_ERRORS.invalidUrl, "URL do portal com espaço ou caractere de controle");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return fail(PORTAL_ERRORS.invalidUrl, "URL do portal inválida");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return fail(PORTAL_ERRORS.scheme, "o portal só aceita http ou https");
  if (url.username !== "" || url.password !== "") return fail(PORTAL_ERRORS.credentials, "URL do portal não pode levar usuário nem senha");
  if (!isHostAllowed(url.hostname, policy)) return fail(PORTAL_ERRORS.hostNotAllowed, "host fora da lista permitida do portal");
  return url;
}

/**
 * Destino de um redirecionamento (`Location`, absoluto ou relativo à página de origem), ou `undefined` se ele não é uma URL
 * aceita ou sai da lista: quem segue só segue o que passa por aqui.
 */
export function resolveRedirect(from: URL, location: string | null, policy: PortalPolicy): URL | undefined {
  if (location === null || location.trim() === "") return undefined;
  let target: string;
  try {
    target = new URL(location.trim(), from).href;
  } catch {
    return undefined;
  }
  try {
    return checkPortalUrl(target, policy);
  } catch (error) {
    if (error instanceof PortalError) return undefined;
    throw error;
  }
}

// ---- pode embutir? ----

export interface PortalHeaders {
  /** Valor cru de `X-Frame-Options`, se veio. */
  frameOptions: string | null;
  /** Valor cru de `Content-Security-Policy` (não o `Report-Only`), se veio. */
  csp: string | null;
}

export interface FramingContext {
  /** Origem da página do portal (`URL.origin`). */
  pageOrigin: string;
  /** Origem da página que embute (o painel, como o navegador do chamador o vê); `undefined` se não se sabe. */
  ancestorOrigin: string | undefined;
}

/** Fonte de `frame-ancestors` contra a origem de quem embute (CSP3 §6.2.2, na parte que vale para http/https). */
function ancestorSourceMatches(source: string, ctx: FramingContext): boolean {
  const lowered = source.toLowerCase();
  if (lowered === "*") return true;
  if (ctx.ancestorOrigin === undefined) return false;
  if (lowered === "'self'") return ctx.ancestorOrigin === ctx.pageOrigin;
  if (lowered.startsWith("'")) return false;
  let ancestor: URL;
  try {
    ancestor = new URL(ctx.ancestorOrigin);
  } catch {
    return false;
  }
  if (/^[a-z][a-z0-9+.-]*:$/.test(lowered)) return ancestor.protocol === lowered;
  const parsed = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|\*\.[^:/*]+|[^:/*]+)(?::(\*|\d{1,5}))?(?:\/.*)?$/.exec(lowered);
  if (!parsed) return false;
  const scheme = parsed[1];
  const host = parsed[2] as string;
  const port = parsed[3];
  if (scheme !== undefined && `${scheme}:` !== ancestor.protocol) return false;
  const hostOk = host === "*" || (host.startsWith("*.") ? ancestor.hostname.endsWith(host.slice(1)) : ancestor.hostname === host);
  if (!hostOk) return false;
  if (port === "*") return true;
  const defaultPort = ancestor.protocol === "https:" ? "443" : "80";
  return (ancestor.port || defaultPort) === (port ?? defaultPort);
}

/** Diretivas `frame-ancestors` de cada política do cabeçalho (políticas separadas por vírgula); a primeira diretiva de cada uma vale. */
function frameAncestorLists(csp: string): string[][] {
  const lists: string[][] = [];
  for (const policy of csp.split(",")) {
    for (const directive of policy.split(";")) {
      const [name, ...sources] = directive.trim().split(/\s+/);
      if (name?.toLowerCase() === "frame-ancestors") {
        lists.push(sources);
        break;
      }
    }
  }
  return lists;
}

/**
 * Pelos cabeçalhos: o motivo de a página não poder ser embutida, ou `undefined` se pode. `frame-ancestors` da CSP, quando
 * existe, vale e o `X-Frame-Options` é ignorado (é o que o navegador faz). Toda política precisa permitir. Valor que não se
 * entende (como o antigo `ALLOW-FROM`) bloqueia: é melhor um link do que um quadro em branco.
 */
export function judgeFraming(headers: PortalHeaders, ctx: FramingContext): PortalBlock | undefined {
  const lists = headers.csp === null ? [] : frameAncestorLists(headers.csp);
  if (lists.length > 0) {
    const allowed = lists.every((sources) => sources.length > 0 && !sources.some((s) => s.toLowerCase() === "'none'") && sources.some((s) => ancestorSourceMatches(s, ctx)));
    return allowed ? undefined : PORTAL_BLOCKS.cspFrameAncestors;
  }
  if (headers.frameOptions === null) return undefined;
  for (const raw of headers.frameOptions.split(",")) {
    const value = raw.trim().toLowerCase();
    if (value === "deny") return PORTAL_BLOCKS.frameOptionsDeny;
    if (value === "sameorigin") {
      if (ctx.ancestorOrigin !== ctx.pageOrigin) return PORTAL_BLOCKS.frameOptionsSameOrigin;
    } else if (value !== "") {
      return PORTAL_BLOCKS.frameOptionsUnknown;
    }
  }
  return undefined;
}

export interface FramingEnvironment {
  /** O chamador chegou pelo acesso remoto (túnel): o navegador dele não é esta máquina. */
  remote: boolean;
  ancestorOrigin: string | undefined;
}

/**
 * O que se sabe sem pedir nada à página. Pelo acesso remoto, `localhost` é a máquina de quem olha, não a do Hades; e página
 * `http` dentro de painel `https` é bloqueada pelo navegador.
 */
export function judgeEnvironment(url: URL, env: FramingEnvironment): PortalBlock | undefined {
  if (env.remote && isLoopbackHost(url.hostname)) return PORTAL_BLOCKS.remoteLoopback;
  if (url.protocol === "http:" && env.ancestorOrigin?.startsWith("https:")) return PORTAL_BLOCKS.mixedContent;
  return undefined;
}

// ---- o nó no documento ----

export interface PortalData {
  url: string;
}

export interface PortalNodeInput {
  id: string;
  x: number;
  y: number;
  url: string;
  w?: number;
  h?: number;
  z?: number;
}

/** `data` do nó: só a URL já normalizada. */
export function portalNodeData(raw: unknown, policy: PortalPolicy): PortalData {
  return { url: checkPortalUrl(raw, policy).href };
}

/** O nó portal pronto para o documento; o tamanho cai no padrão e a camada fica acima de todos. */
export function buildPortalNode(doc: CanvasDoc, input: PortalNodeInput, policy: PortalPolicy): CanvasNode {
  if (doc.nodes.length >= CANVAS_LIMITS.nodes) return fail(PORTAL_ERRORS.invalidNode, "documento no limite de nós");
  if (doc.nodes.some((node) => node.id === input.id)) return fail(PORTAL_ERRORS.invalidNode, "já existe nó com esse id");
  const top = doc.nodes.reduce((max, node) => Math.max(max, node.z), 0);
  return {
    id: input.id,
    type: PORTAL_NODE_TYPE,
    x: input.x,
    y: input.y,
    w: input.w ?? PORTAL_DEFAULT_SIZE.w,
    h: input.h ?? PORTAL_DEFAULT_SIZE.h,
    z: input.z ?? Math.min(top + 1, CANVAS_LIMITS.layer),
    data: { ...portalNodeData(input.url, policy) },
    locked: false,
    blurred: false,
  };
}

/** Criar o portal: um passo da pilha; desfazer tira o nó e deixa o documento igual ao anterior. */
export function opCreatePortal(doc: CanvasDoc, input: PortalNodeInput, policy: PortalPolicy): AtomicOp {
  return opCreate(doc, [buildPortalNode(doc, input, policy)]);
}

/**
 * Troca a URL do portal (`update` do `data`; o nó, o tamanho e os grupos seguem). A URL passa pela mesma conferência da criação.
 * `undefined` quando a URL normalizada é a que o nó já tem. Erros: os de `checkPortalUrl` e `portal_invalid_node` (nó que não
 * existe ou não é portal).
 */
export function opSetPortalUrl(doc: CanvasDoc, id: string, url: string, policy: PortalPolicy): AtomicOp | undefined {
  const node = doc.nodes.find((candidate) => candidate.id === id);
  if (!node || node.type !== PORTAL_NODE_TYPE) return fail(PORTAL_ERRORS.invalidNode, "o nó não existe ou não é um portal");
  const data = portalNodeData(url, policy);
  return node.data.url === data.url ? undefined : opUpdate(doc, id, { ...node.data, ...data });
}

export type PortalView = { state: "ready"; url: string } | { state: "blocked"; code: PortalErrorCode };

/**
 * O que a UI desenha para um nó portal: o documento pode vir de uma importação, então a URL é conferida de novo contra a
 * política de agora (a lista pode ter encolhido) antes de virar `src` de quadro.
 */
export function portalViewOf(node: Pick<CanvasNode, "type" | "data">, policy: PortalPolicy): PortalView {
  if (node.type !== PORTAL_NODE_TYPE) return { state: "blocked", code: PORTAL_ERRORS.invalidNode };
  try {
    return { state: "ready", url: checkPortalUrl(node.data.url, policy).href };
  } catch (error) {
    if (error instanceof PortalError) return { state: "blocked", code: error.code };
    throw error;
  }
}
