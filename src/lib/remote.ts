// owner/repo do remote.origin.url do clone atual (o mesmo padrão do gate-lock.sh), para não fixar repositório no código.
import { EXIT, die } from "./output.ts";
import { run } from "./proc.ts";

const OWNER_REPO = /([^/:]+)\/([^/]+?)(?:\.git)?$/;

export interface OwnerRepo {
  owner: string;
  repo: string;
}

export function originOwnerRepo(): OwnerRepo {
  const r = run("git", ["config", "--get", "remote.origin.url"]);
  const url = r.stdout.trim();
  if (r.status !== 0 || !url) return die("não consegui ler remote.origin.url do clone atual", EXIT.fail);
  const m = OWNER_REPO.exec(url);
  const owner = m?.[1];
  const repo = m?.[2];
  if (owner === undefined || repo === undefined) return die(`não consegui derivar owner/repo de '${url}'`, EXIT.fail);
  return { owner, repo };
}
