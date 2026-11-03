// Atividade de uma PR lida do GraphQL do gh (reviews, comentários, threads): os ids que o watch e o wait comparam.
import type { Json } from "./work.ts";

export function text(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function nodeIds(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [];
  const nodes = (value as { nodes?: unknown }).nodes;
  return Array.isArray(nodes) ? nodes.map((n: unknown) => text((n as { id?: unknown } | null)?.id)).filter(Boolean) : [];
}

export interface PullRequestView {
  state: string;
  ids: string[];
}

/** state da PR ("null" se o GraphQL não trouxe) e os ids de reviews, comentários e comentários de thread; undefined se não é JSON. */
export function parsePullRequest(raw: string): PullRequestView | undefined {
  try {
    const pr = ((JSON.parse(raw) as { data?: { repository?: { pullRequest?: Json } } }).data?.repository?.pullRequest) ?? {};
    const threads = Array.isArray((pr.reviewThreads as { nodes?: unknown } | undefined)?.nodes)
      ? ((pr.reviewThreads as { nodes: unknown[] }).nodes).flatMap((t) => nodeIds((t as { comments?: unknown }).comments))
      : [];
    return { state: text(pr.state) || "null", ids: [...nodeIds(pr.reviews), ...nodeIds(pr.comments), ...threads] };
  } catch {
    return undefined;
  }
}
