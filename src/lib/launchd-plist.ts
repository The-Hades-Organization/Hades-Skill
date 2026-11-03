// launchd: rótulo, plist e leitura das saídas de `launchctl print` e `launchctl list`. Só texto e parsers, sem processo
// nem disco: quem fala com o launchctl é service-manager-launchd.ts.
import { EXIT, HadesError } from "./output.ts";

/** Prefixo dos rótulos do Hades; o rótulo é `com.hades.<HU>.<sufixo>` e a unit equivalente do systemd é `<HU>-<sufixo>`. */
export const LABEL_PREFIX = "com.hades.";

/** `hds_alfa-panel` → `com.hades.hds_alfa.panel`. O HU não tem `-`, então o primeiro `-` separa o sufixo. */
export function launchdLabel(unit: string): string {
  const dash = unit.indexOf("-");
  return dash < 0 ? `${LABEL_PREFIX}${unit}` : `${LABEL_PREFIX}${unit.slice(0, dash)}.${unit.slice(dash + 1)}`;
}

/** O inverso de launchdLabel; undefined para um rótulo que não é do Hades. */
export function unitOfLabel(label: string): string | undefined {
  if (!label.startsWith(LABEL_PREFIX)) return undefined;
  const rest = label.slice(LABEL_PREFIX.length);
  const dot = rest.indexOf(".");
  return dot < 0 ? rest : `${rest.slice(0, dot)}-${rest.slice(dot + 1)}`;
}

export interface PlistSpec {
  label: string;
  argv: string[];
  workdir?: string;
  env?: ReadonlyArray<readonly [string, string]>;
  stdin?: string;
  stdout?: string;
  stderr?: string;
  /** reinicia quando sai com falha (o Restart=on-failure do systemd); o serviço transitório não reinicia */
  keepAliveOnFailure: boolean;
  /** segundos entre uma saída e o reinício (RestartSec) */
  throttleSec?: number;
  /** sobe ao carregar o plist: no login quando ele mora em ~/Library/LaunchAgents */
  runAtLoad: boolean;
  /** roda a cada N segundos (o timer por intervalo) */
  startIntervalSec?: number;
  /** prioridade baixa de CPU e de disco (o Nice=10 e o IOSchedulingClass=idle do systemd) */
  lowPriority?: boolean;
}

const SECONDS_PER_UNIT: Readonly<Record<string, number>> = {
  us: 1e-6, usec: 1e-6, ms: 1e-3, msec: 1e-3,
  s: 1, sec: 1, second: 1, seconds: 1,
  m: 60, min: 60, minute: 60, minutes: 60,
  h: 3600, hr: 3600, hour: 3600, hours: 3600,
  d: 86400, day: 86400, days: 86400,
  w: 604800, week: 604800, weeks: 604800,
  month: 2629800, months: 2629800,
  y: 31557600, year: 31557600, years: 31557600,
};
/** `M` (mês de 30,44 dias) e `m` (minuto) só se distinguem pela caixa, como no systemd.time. */
const SECONDS_PER_MONTH_LETTER = 2629800;
const SECONDS_PER_BARE_NUMBER = 1;
/** O StartInterval é um inteiro de 32 bits com sinal. */
const MAX_START_INTERVAL_SEC = 2 ** 31 - 1;

/**
 * Segundos de um intervalo no formato de HADES_CLEAN_EVERY (6h, 1d, 30min, 1h 30min, 90, 500ms, 1M, 1y): o que o systemd lê
 * em OnUnitActiveSec, para o StartInterval do launchd (número sem unidade = segundos). Unidade desconhecida, sem número,
 * zero ou além do inteiro de 32 bits: undefined.
 */
export function parseEverySeconds(text: string): number | undefined {
  const parts = text.trim().split(/\s+(?=\d)|(?<=[a-z])(?=\d)/i);
  let total = 0;
  for (const part of parts) {
    const m = /^(\d+)\s*([a-z]*)$/i.exec(part);
    if (m?.[1] === undefined) return undefined;
    const name = m[2] ?? "";
    const unit = name === "" ? SECONDS_PER_BARE_NUMBER : name === "M" ? SECONDS_PER_MONTH_LETTER : SECONDS_PER_UNIT[name.toLowerCase()];
    if (unit === undefined) return undefined;
    total += Number.parseInt(m[1], 10) * unit;
  }
  const seconds = Math.floor(total);
  return seconds > 0 && seconds <= MAX_START_INTERVAL_SEC ? seconds : undefined;
}

/** Fora de XML 1.0: controles abaixo de espaço (menos \t, \n e \r), U+FFFE e U+FFFF; um plist com eles não carrega. */
const XML_INVALID = /[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/;

function xmlEscape(text: string): string {
  const bad = XML_INVALID.exec(text);
  if (bad !== null) throw new HadesError(`caractere de controle U+${bad[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")} não cabe em XML 1.0 (plist de ${JSON.stringify(text.slice(0, 40))})`, EXIT.usage);
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\r", "&#13;");
}

const xmlUnescape = (text: string): string => text.replaceAll("&#13;", "\r").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
const str = (text: string): string => `<string>${xmlEscape(text)}</string>`;
const bool = (value: boolean): string => (value ? "<true/>" : "<false/>");

/** O plist do serviço; as chaves saem sempre na mesma ordem, para a regravação sem mudança ser byte a byte igual. */
export function plistText(spec: PlistSpec): string {
  const rows: string[] = [`<key>Label</key>${str(spec.label)}`];
  rows.push(`<key>ProgramArguments</key><array>${spec.argv.map(str).join("")}</array>`);
  if (spec.workdir !== undefined) rows.push(`<key>WorkingDirectory</key>${str(spec.workdir)}`);
  if (spec.env !== undefined && spec.env.length > 0) {
    rows.push(`<key>EnvironmentVariables</key><dict>${spec.env.map(([k, v]) => `<key>${xmlEscape(k)}</key>${str(v)}`).join("")}</dict>`);
  }
  if (spec.stdin !== undefined) rows.push(`<key>StandardInPath</key>${str(spec.stdin)}`);
  if (spec.stdout !== undefined) rows.push(`<key>StandardOutPath</key>${str(spec.stdout)}`);
  if (spec.stderr !== undefined) rows.push(`<key>StandardErrorPath</key>${str(spec.stderr)}`);
  rows.push(`<key>RunAtLoad</key>${bool(spec.runAtLoad)}`);
  if (spec.keepAliveOnFailure) rows.push("<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>");
  if (spec.throttleSec !== undefined) rows.push(`<key>ThrottleInterval</key><integer>${Math.max(1, Math.trunc(spec.throttleSec))}</integer>`);
  if (spec.startIntervalSec !== undefined) rows.push(`<key>StartInterval</key><integer>${Math.max(1, Math.trunc(spec.startIntervalSec))}</integer>`);
  if (spec.lowPriority === true) rows.push("<key>Nice</key><integer>10</integer>", "<key>LowPriorityIO</key><true/>");
  const body = rows.map((r) => `  ${r}`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
</dict>
</plist>
`;
}

/** O valor de uma chave `<key>K</key><string>V</string>` do plist que o próprio Hades gravou (caminho de log, por exemplo). */
export function plistString(text: string, key: string): string | undefined {
  const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(text);
  return m?.[1] === undefined ? undefined : xmlUnescape(m[1]);
}

export interface LaunchdPrint {
  /** valor de `state =` (running, not running, spawn scheduled…) */
  state: string;
  pid?: number;
  lastExitCode?: number;
  runs?: number;
}

/** Saída de `launchctl print <domínio>/<rótulo>`: só as linhas `chave = valor` do serviço, sem entrar nos blocos aninhados. */
export function parseLaunchctlPrint(text: string): LaunchdPrint {
  const field = (key: string): string | undefined => new RegExp(`^\\t${key} = (.+)$`, "m").exec(text)?.[1]?.trim();
  const num = (key: string): number | undefined => {
    const raw = field(key);
    const lead = raw === undefined ? null : /^(-?\d+)/.exec(raw);
    return lead === null ? undefined : Number.parseInt(lead[1] as string, 10);
  };
  return { state: field("state") ?? "", pid: num("pid"), lastExitCode: num("last exit code"), runs: num("runs") };
}

/** O estado no vocabulário do systemd (`is-active`): active | activating | failed | inactive. */
export function activeStateOf(print: LaunchdPrint | undefined): "active" | "activating" | "failed" | "inactive" {
  if (print === undefined) return "inactive";
  if (print.state === "running" || print.pid !== undefined) return "active";
  if (print.state === "spawn scheduled" || print.state === "waiting") return "activating";
  if (print.lastExitCode !== undefined && print.lastExitCode !== 0) return "failed";
  return "inactive";
}

export interface LaunchdListRow {
  label: string;
  /** undefined: carregado e parado (a coluna PID vale `-`) */
  pid?: number;
  status: number;
}

/** Saída de `launchctl list`: `PID<TAB>Status<TAB>Label`, com cabeçalho. */
export function parseLaunchctlList(text: string): LaunchdListRow[] {
  const rows: LaunchdListRow[] = [];
  for (const line of text.split("\n")) {
    const f = line.split("\t");
    if (f.length < 3 || f[0] === "PID") continue;
    const status = Number.parseInt(f[1] ?? "", 10);
    rows.push({ label: (f[2] ?? "").trim(), pid: /^\d+$/.test(f[0] ?? "") ? Number.parseInt(f[0] as string, 10) : undefined, status: Number.isNaN(status) ? 0 : status });
  }
  return rows;
}

/** O `EnvironmentVariables` do plist que o próprio Hades gravou, no texto do `systemctl show -p Environment`: `"K=V" "K=V"`. */
export function plistEnvironment(text: string): string {
  const dict = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(text)?.[1] ?? "";
  const pairs = [...dict.matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g)];
  return pairs.map((m) => `"${xmlUnescape(m[1] ?? "")}=${xmlUnescape(m[2] ?? "")}"`).join(" ");
}

/** Tempo do `ps` (`etime` e `cputime`: `[[dd-]hh:]mm:ss[.cc]`) em segundos; 0 se ilegível. */
export function parsePsClock(text: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text.trim());
  if (m === null) return 0;
  const [, days, hours, minutes, seconds] = m;
  return Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds);
}

export interface PsRow {
  pid: number;
  ppid: number;
  rssKb: number;
  elapsedS: number;
  cpuS: number;
}

/** Saída de `ps -axo pid=,ppid=,rss=,etime=,cputime=`. */
export function parsePsTable(text: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5 || !/^\d+$/.test(f[0] ?? "") || !/^\d+$/.test(f[1] ?? "") || !/^\d+$/.test(f[2] ?? "")) continue;
    rows.push({ pid: Number(f[0]), ppid: Number(f[1]), rssKb: Number(f[2]), elapsedS: parsePsClock(f[3] ?? ""), cpuS: parsePsClock(f[4] ?? "") });
  }
  return rows;
}

/** RSS e CPU somados de um processo e de todos os descendentes (o job é um bash que lança o resto). */
export function treeTotals(rows: readonly PsRow[], pid: number): { rssKb: number; cpuS: number; elapsedS: number } {
  const children = new Map<number, PsRow[]>();
  for (const r of rows) children.set(r.ppid, [...(children.get(r.ppid) ?? []), r]);
  const root = rows.find((r) => r.pid === pid);
  const total = { rssKb: 0, cpuS: 0, elapsedS: root?.elapsedS ?? 0 };
  const seen = new Set<number>();
  const walk = (row: PsRow): void => {
    if (seen.has(row.pid)) return;
    seen.add(row.pid);
    total.rssKb += row.rssKb;
    total.cpuS += row.cpuS;
    for (const child of children.get(row.pid) ?? []) walk(child);
  };
  if (root !== undefined) walk(root);
  return total;
}
