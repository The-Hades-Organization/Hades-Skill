// Quem é dono de uma porta ocupada, do ponto de vista do doctor: a instância dele, outra instância registrada na
// máquina (reference/projects.md §Várias instâncias) ou ninguém do Hades. Só leitura de /proc e dos registros.
import { readFileSync } from "node:fs";
import { instanceId } from "./config.ts";
import { readText, realpathMissingOk } from "./fs.ts";
import { listInstances } from "./instance.ts";
import { procCmdline } from "./proc.ts";

export interface InstanceIdentity {
  /** $D da instância */
  d: string;
  /** prefixo das units (hds, hds_<id>) */
  hu: string;
  /** nome do slice (hades, hades_<id>) */
  hslice: string;
}

const ID_CHARS = /[^a-z0-9_]/g;
const ID_MAX = 24;
const UNIT_PREFIX = "hds";

/** Mesma regra do unitPrefix (config.ts), mas a partir do HADES_ID gravado no env.sh da instância, não do ambiente de quem roda. */
export function identityOf(d: string): InstanceIdentity {
  const id = instanceId(d).toLowerCase().replace(ID_CHARS, "_").slice(0, ID_MAX);
  const hu = id ? `${UNIT_PREFIX}_${id}` : UNIT_PREFIX;
  return { d, hu, hslice: `hades${hu.slice(UNIT_PREFIX.length)}` };
}

/** Variáveis do ambiente do processo (/proc/<pid>/environ, só do mesmo usuário); vazio sem permissão ou fora do Linux. */
function procEnviron(pid: string): Map<string, string> {
  const vars = new Map<string, string>();
  let raw = "";
  try {
    raw = readFileSync(`/proc/${pid}/environ`, "utf8");
  } catch {
    return vars;
  }
  for (const entry of raw.split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0) vars.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  return vars;
}

/**
 * O processo é da instância quando roda na unit/slice dela, tem o `$D` na linha de comando ou, rodando em primeiro plano
 * (`panel serve` fora de unit, sem `$D` no argv), foi lançado com o HADES_DATA / HADES_KIT_DIR dela no ambiente.
 */
export function belongsTo(pid: string, who: InstanceIdentity): boolean {
  if (!pid) return false;
  const cgroup = readText(`/proc/${pid}/cgroup`) ?? "";
  if (new RegExp(`/${who.hslice}\\.slice/|/${who.hu}-`).test(cgroup)) return true;
  if (procCmdline(Number(pid)).includes(who.d)) return true;
  const environ = procEnviron(pid);
  const target = realpathMissingOk(who.d);
  return ["HADES_DATA", "HADES_KIT_DIR"].some((key) => {
    const value = environ.get(key);
    return value !== undefined && value !== "" && realpathMissingOk(value) === target;
  });
}

/** As outras instâncias registradas nesta máquina (a própria, `d`, fica de fora). */
export function otherInstances(d: string): InstanceIdentity[] {
  const mine = realpathMissingOk(d);
  const seen = new Set<string>([mine]);
  const others: InstanceIdentity[] = [];
  for (const { dir } of listInstances()) {
    const real = realpathMissingOk(dir);
    if (seen.has(real)) continue;
    seen.add(real);
    others.push(identityOf(dir));
  }
  return others;
}
