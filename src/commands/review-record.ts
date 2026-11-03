// `hades review-record`: grava o registro `review` no shard da PR (gates.md §4): lê, altera, tmp + mv.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { EXIT, die, out, warn } from "../lib/output.ts";
import { firstLine } from "../lib/fs.ts";
import { hadesHome, home } from "../lib/paths.ts";
import { originOwnerRepo } from "../lib/remote.ts";

const MAX_VERSION = 2;
const VERSION_EXIT = 3;
const SHORT_OID = 8;

type Shard = Record<string, unknown> & { pr?: number; version?: number; reviewRounds?: number };

// Mesma derivação de WORK que o gate-lock.sh; HADES_STATE ou HADES_WORK sobrepõem.
function stateDir(): string {
  if (process.env.HADES_STATE) return process.env.HADES_STATE;
  if (process.env.HADES_WORK) return `${process.env.HADES_WORK}/state`;
  const { owner, repo } = originOwnerRepo();
  return stateDirFor(owner, repo);
}

export function stateDirFor(owner: string, repo: string): string {
  const root = process.env.HADES_WORK_ROOT || firstLine(`${hadesHome()}/work-root`).trim() || `${home()}/.claude/hades/work`;
  return `${root}/${owner}__${repo}/state`;
}

function readShard(file: string): Shard {
  if (!existsSync(file)) return {};
  const data: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (typeof data !== "object" || data === null || Array.isArray(data)) return die(`${file}: o shard não é um objeto`, EXIT.fail);
  return data as Shard; // objeto conferido acima; os campos são lidos com guarda abaixo
}

export function reviewRecordCommand(args: string[]): number {
  const [pr = "", headOid = "", reviewId, verdict, blocking, important, inline, outOfHunk] = args;
  const file = `${stateDir()}/pr-${pr}.json`;
  const shard = readShard(file);
  if (typeof shard.version === "number" && shard.version > MAX_VERSION) {
    warn(`pr-${pr}: version ${shard.version} > ${MAX_VERSION}, nao escrevo`);
    return VERSION_EXIT;
  }
  const rounds = (typeof shard.reviewRounds === "number" ? shard.reviewRounds : 0) + 1;
  shard.pr = Number(pr);
  shard.review = {
    headOid,
    reviewId: Number(reviewId),
    event: "COMMENT",
    verdict,
    blocking: Number(blocking),
    important: Number(important),
    inline: Number(inline),
    outOfHunk: Number(outOfHunk),
    at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
  shard.reviewRounds = rounds;
  writeFileSync(`${file}.tmp`, `${JSON.stringify(shard, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
  out(`pr-${pr}.json gravado: review@${headOid.slice(0, SHORT_OID)} id=${reviewId} ${verdict} 🔴${blocking} 🟡${important} inline=${inline} fora=${outOfHunk} rounds=${rounds}`);
  return EXIT.ok;
}

