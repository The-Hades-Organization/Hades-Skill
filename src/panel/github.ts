// PRs abertas pelo `gh api` (busca de issues: filtra por autor e pagina no servidor do GitHub), com cache em memória e em
// disco (logs/panel-cache/github.json) por GH_TTL: trocar de página e voltar, ou reabrir o painel, não gasta outra requisição.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readText } from "../lib/fs.ts";
import { pyJsonDumps } from "../lib/kit.ts";
import type { PanelEnv } from "./env.ts";
import { exec } from "./exec.ts";
import { BadRequest } from "./http.ts";

type Dict = Record<string, unknown>;

const GH_TTL_S = 300;
const ME_TTL_S = 86_400;
const QUERIES_MAX = 200;
const AUTHORS_MAX = 12;
const TEXT_MAX = 80;
const LABELS_MAX = 4;
const TOTAL_MAX = 1000;
const ME_TIMEOUT_MS = 15_000;
const SEARCH_TIMEOUT_MS = 25_000;
const AUTHOR = /^(@me|[A-Za-z0-9-]{1,39})$/;

interface Cached {
  t: number;
  v: Dict;
}
interface Store {
  queries: Record<string, Cached>;
  authors: string[];
  me?: { t: number; login: string };
}

export interface GitHub {
  me(): Promise<string | null>;
  authors(): string[];
  prs(opts: { author: string; page: number; per: number; text: string; drafts: boolean; refresh: boolean }): Promise<Dict>;
}

export function createGitHub(env: PanelEnv): GitHub {
  const dir = join(env.dir, "logs", "panel-cache");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "github.json");
  let data: Store = { queries: {}, authors: [] };
  try {
    const parsed = JSON.parse(readText(path) ?? "") as Partial<Store>;
    data = { ...parsed, queries: parsed.queries ?? {}, authors: parsed.authors ?? [] };
  } catch {
    // sem cache em disco (ou ilegível): começa vazio
  }
  const save = (): void => {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, pyJsonDumps(data));
    renameSync(tmp, path);
  };
  const now = (): number => Date.now() / 1000;

  async function slug(): Promise<string | null> {
    const url = (await exec(["git", "-C", env.worktree, "config", "--get", "remote.origin.url"])).stdout.trim();
    return /github\.com[:/]([^/]+\/[^/.]+)/.exec(url)?.[1] ?? null;
  }

  async function me(): Promise<string | null> {
    if (data.me && now() - data.me.t < ME_TTL_S) return data.me.login;
    const login = (await exec(["gh", "api", "user", "-q", ".login"], { timeoutMs: ME_TIMEOUT_MS })).stdout.trim() || null;
    if (login) {
      data.me = { t: now(), login };
      save();
    }
    return login;
  }

  async function prs(opts: { author: string; page: number; per: number; text: string; drafts: boolean; refresh: boolean }): Promise<Dict> {
    const repo = await slug();
    if (!repo) throw new BadRequest("remote origin do worktree não é do GitHub");
    const { author, page, per, drafts, refresh } = opts;
    if (author && !AUTHOR.test(author)) throw new BadRequest("autor inválido");
    const text = opts.text.replace(/[^\p{L}\p{N}_ #.:/-]/gu, " ").slice(0, TEXT_MAX).trim();
    const query = `repo:${repo} is:pr is:open${author ? ` author:${author}` : ""}${drafts ? "" : " draft:false"}${text ? ` ${text}` : ""}`;
    const key = `${query}|${page}|${per}`;
    const t = now();
    const hit = data.queries[key];
    if (hit && !refresh && t - hit.t < GH_TTL_S) return { ...hit.v, cachedAt: hit.t, fromCache: true };
    const r = await exec(["gh", "api", "-X", "GET", "search/issues", "-f", `q=${query}`, "-f", "sort=updated", "-f", "order=desc", "-f", `per_page=${per}`, "-f", `page=${page}`], {
      timeoutMs: SEARCH_TIMEOUT_MS,
      cwd: env.worktree,
    });
    if (r.status !== 0) {
      const last = (r.stderr || r.stdout).trim().split("\n").filter(Boolean).pop();
      // sem rede ou sem cota: devolve o último resultado, mesmo vencido, avisando
      if (hit) return { ...hit.v, cachedAt: hit.t, fromCache: true, stale: true, error: last ?? "gh falhou" };
      throw new BadRequest(`gh api falhou: ${last ?? `rc=${r.status}`}`);
    }
    const body = JSON.parse(r.stdout) as { items?: Dict[]; total_count?: number };
    const items = (body.items ?? []).map((i) => ({
      number: i.number, title: i.title, author: (i.user as Dict).login, draft: Boolean(i.draft), updatedAt: i.updated_at, createdAt: i.created_at,
      comments: i.comments ?? 0, url: i.html_url,
      labels: ((i.labels as Dict[] | undefined) ?? []).map((l) => ({ name: l.name, color: l.color ?? null })).slice(0, LABELS_MAX),
    }));
    const v: Dict = { items, total: Math.min(body.total_count ?? 0, TOTAL_MAX), page, per, query };
    data.queries[key] = { t, v };
    // o cache não cresce sem fim: só as consultas mais recentes
    const keys = Object.keys(data.queries);
    if (keys.length > QUERIES_MAX) {
      for (const k of keys.sort((a, b) => (data.queries[a] as Cached).t - (data.queries[b] as Cached).t).slice(0, keys.length - QUERIES_MAX)) delete data.queries[k];
    }
    if (author && author !== "@me") data.authors = [author, ...data.authors.filter((a) => a !== author).slice(0, AUTHORS_MAX - 1)];
    save();
    return { ...v, cachedAt: t, fromCache: false };
  }

  return { me, authors: () => [...data.authors], prs };
}
