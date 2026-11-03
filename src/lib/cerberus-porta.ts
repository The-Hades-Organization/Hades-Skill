// Guardas da Porta em TypeScript (porte de loop/cerberus/porta/checks/*.py; reference/cerberus/porta.md). Cada guarda é uma
// função do ambiente injetado (CheckEnv) que devolve o veredito; o mesmo contrato de entrada e saída do check exec.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { planSha } from "../commands/agent.ts";
import { config } from "./cerberus.ts";
import {
  branchInfo, exec, ev, fnmatchCase, ghRepoSlug, git, headRef, profileField, verdict, type CheckEnv, type CheckVerdict, type Evid,
} from "./cerberus-check.ts";
import { splitLines } from "./pyjson.ts";
import { skillRoot } from "./paths.ts";

type Guard = (ce: CheckEnv) => CheckVerdict;

const TRONCOS = ["main", "master", "trunk", "develop"];
const NO_PUSH = "no_push";
const GUARD_TIMEOUT_S = 90;
const MAX_SCANNED_FILES = 2000;
const MAX_EVIDENCE = 20;
const MASK_PREFIX = 4;

// ---------------------------------------------------------------- branch-protegida

const branchProtegida: Guard = (ce) => {
  const bi = branchInfo(ce);
  const dest = bi.merge || ce.ctx.head || bi.branch;
  if (!dest) return verdict("barra", [ev("HEAD destacado e sem head no contexto: destino desconhecido", "git symbolic-ref HEAD")]);
  const base = profileField(ce, "flow.base");
  const evid = [ev(`destino do push = ${dest}`, "upstream da branch (git config branch.<b>.merge), ou head do contexto")];
  if (base) {
    evid.push(ev(`base do projeto (flow.base) = ${base}`, "perfil ativo: hades project get flow.base"));
    if (dest === base) return verdict("barra", evid, "o destino é a base do projeto");
  } else {
    evid.push(ev("perfil sem flow.base (ou sem perfil): só os nomes comuns de tronco e a API", "hades project get flow.base"));
  }
  if (TRONCOS.includes(dest)) return verdict("barra", evid, `${dest} é nome de tronco`);
  const slug = ghRepoSlug(ce);
  if (!slug) {
    return verdict("aviso", [...evid, ev("remote.origin.url sem owner/repo: não deu para perguntar ao GitHub", "git config remote.origin.url")],
      "proteção da branch não conferida");
  }
  const api = `repos/${slug}/branches/${dest}`;
  const r = exec(["gh", "api", api, "--jq", ".protected"], ce);
  if (r.code !== 0) {
    // branch ainda inexistente no remoto responde 404: não é protegida, mas a falha entra na evidência
    return verdict("aviso", [...evid, ev(`não consegui ler a proteção de ${dest}: ${r.stderr || "resposta vazia"}`, `gh api ${api}`)],
      "proteção da branch não conferida");
  }
  if (r.stdout.trim() === "true") return verdict("barra", [...evid, ev(`${dest} protegida no GitHub`, `gh api ${api}`)], "branch protegida");
  return verdict("ok", [...evid, ev(`${dest} não está protegida`, `gh api ${api} --jq .protected`)]);
};

// ---------------------------------------------------------------- conta-gh

const contaGh: Guard = (ce) => {
  const user = profileField(ce, "identity.gh.user");
  const tokenEnv = profileField(ce, "identity.gh.tokenEnv");
  const perfil = ev(`perfil declara user=${user || "-"} tokenEnv=${tokenEnv || "-"}`, "hades project get identity.gh.*");
  if (!user && !tokenEnv) return verdict("aviso", [perfil], "o perfil não declara a conta do gh: nada com o que comparar a conta que empurra");
  const env: Record<string, string> = {};
  if (tokenEnv) {
    const token = ce.env[tokenEnv] ?? "";
    if (!token) return verdict("barra", [perfil, ev(`variável ${tokenEnv} vazia ou ausente no ambiente`, "ambiente da avaliação")], "o token do perfil não está disponível");
    env.GH_TOKEN = token;
  }
  const r = exec(["gh", "api", "user", "--jq", ".login"], ce, { env });
  if (r.code !== 0 || !r.stdout.trim()) {
    return verdict("aviso", [perfil, ev(`não consegui ler a conta do gh: ${r.stderr || "resposta vazia"}`, "gh api user --jq .login")], "conta do gh não conferida");
  }
  const login = r.stdout.trim();
  const onde = `gh api user --jq .login${tokenEnv ? ` (com o token de ${tokenEnv})` : ""}`;
  if (user && login.toLowerCase() !== user.toLowerCase()) {
    return verdict("barra", [perfil, ev(`conta que empurra = ${login}, perfil declara ${user}`, onde)], "conta do gh diferente da do perfil");
  }
  return verdict("ok", [perfil, ev(`conta que empurra = ${login}`, onde)]);
};

// ---------------------------------------------------------------- nome-dominio

const nomeDominio: Guard = (ce) => {
  const top = git(ce, "rev-parse", "--show-toplevel");
  const raiz = top.code === 0 ? top.stdout.trim() : ce.dir;
  const script = join(raiz, "kit", "skill-release.sh");
  if (!existsSync(script)) {
    return verdict("ok", [ev(`${raiz} não é o núcleo da skill (sem kit/skill-release.sh): a regra de nome e de domínio vale só para ele`, script)]);
  }
  const r = exec(["bash", script, "guard", raiz], ce, { cwd: raiz, timeoutS: GUARD_TIMEOUT_S });
  const linhas = splitLines(`${r.stdout}\n${r.stderr}`).filter((l) => l.trim());
  const onde = "kit/skill-release.sh guard";
  const evidOf = (max: number): Evid[] => linhas.slice(0, max).map((l) => ev(l.trim(), onde));
  if (r.code === null) return verdict("barra", [ev(`a guarda não rodou: ${r.stderr}`, onde)], "nome e domínio não conferidos");
  if (r.code !== 0) {
    const evid = evidOf(MAX_EVIDENCE);
    return verdict("barra", evid.length ? evid : [ev(`saiu ${r.code} sem saída`, onde)], "o núcleo cita nome de projeto ou termo de domínio");
  }
  if (linhas.some((l) => l.includes("nenhum perfil instalado"))) {
    return verdict("aviso", evidOf(5), "sem perfil instalado a guarda de nome não tem termos a procurar");
  }
  const evid = evidOf(5);
  return verdict("ok", evid.length ? evid : [ev("saiu 0", onde)]);
};

// ---------------------------------------------------------------- plano-aprovado

function workRoot(ce: CheckEnv): string {
  if (ce.env.HADES_WORK_ROOT) return ce.env.HADES_WORK_ROOT;
  try {
    const first = (readFileSync(join(homedir(), ".claude/hades/work-root"), "utf8").split("\n")[0] ?? "").trim();
    if (first) return first;
  } catch {
    // sem work-root gravado: vale o padrão
  }
  return join(homedir(), ".claude/hades/work");
}

/** O diretório avaliado é o git local da skill (o mesmo deste código)? */
function isSkillRepo(ce: CheckEnv): boolean {
  const here = git(ce, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const there = exec(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], ce, { cwd: skillRoot });
  return here.code === 0 && there.code === 0 && here.stdout.trim() === there.stdout.trim();
}

interface ApprovalRecord { path: string; sha: string; approvedAt?: string; by?: unknown }

function readApproval(file: string): ApprovalRecord {
  const reg: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (reg === null || typeof reg !== "object") throw new TypeError("registro não é objeto");
  const { path, sha, approvedAt, by } = reg as Record<string, unknown>;
  for (const [key, value] of [["path", path], ["sha", sha]]) if (typeof value !== "string") throw new Error(value === undefined ? `'${key}'` : `${key} não é texto`);
  return { path: path as string, sha: sha as string, approvedAt: typeof approvedAt === "string" ? approvedAt : undefined, by };
}

function approvedBy(by: unknown): string {
  if (by && typeof by === "object") {
    const who = by as Record<string, unknown>;
    const name = who.user || who.usuario || "?";
    return ` por ${String(name)} (${String(who.origem ?? "origem não registrada")})`;
  }
  return by ? ` por ${String(by)}` : "";
}

const planoAprovado: Guard = (ce) => {
  let file: string;
  if (ce.ctx.plano) {
    file = ce.ctx.plano;
  } else {
    const url = git(ce, "config", "--get", "remote.origin.url");
    const m = url.code === 0 ? /[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/.exec(url.stdout.trim()) : null;
    // plano da skill: raiz de trabalho própria (_skill), a que o skill-release procura
    file = isSkillRepo(ce) || !m ? join(workRoot(ce), "_skill", "orchestration", "plan.json") : join(workRoot(ce), `${m[1]}__${m[2]}`, "orchestration", "plan.json");
  }
  const onde = `plan.json em ${file}`;
  const procurado = ce.ctx.plano ? `${file} (--ctx plano=)` : file;
  if (!existsSync(file) || !statSync(file).isFile()) {
    return verdict("barra", [ev(`não existe registro de plano aprovado (procurei ${procurado})`, "hades agent plan-approve <plan.md>")],
      `sem o ok do dono registrado para ${ce.momento || "o momento"}`);
  }
  let reg: ApprovalRecord;
  try {
    reg = readApproval(file);
  } catch (error) {
    return verdict("barra", [ev(`plan.json ilegível ou sem path/sha: ${(error as Error).message}`, onde)], "registro de aprovação inválido");
  }
  const quando = reg.approvedAt ?? "?";
  if (!existsSync(reg.path) || !statSync(reg.path).isFile()) return verdict("barra", [ev(`o plano aprovado ${reg.path} não existe mais`, onde)], "plano aprovado sumiu");
  if (planSha(readFileSync(reg.path, "utf8")) !== reg.sha) {
    return verdict("barra", [ev(`o plano ${reg.path} mudou depois da aprovação de ${quando}`, onde)], "aprove de novo com o dono (plan-approve)");
  }
  const por = approvedBy(reg.by);
  return verdict("ok", [ev(`plano ${reg.path} aprovado em ${quando}${por}, íntegro (sha confere)`, onde)],
    por ? undefined : "o registro não guarda quem aprovou (só o dono roda plan-approve)");
};

// ---------------------------------------------------------------- remote-push

const remotePush: Guard = (ce) => {
  const bi = branchInfo(ce);
  if (!bi.branch) return verdict("barra", [ev("HEAD destacado: sem remote de push", "git symbolic-ref HEAD")]);
  const remote = bi.pushRemote;
  const cfgWhere = "git config branch.<b>.pushRemote, remote.pushDefault, branch.<b>.remote";
  if (!remote) {
    return verdict("aviso", [ev(`branch ${bi.branch} sem remote configurado (sem pushRemote, pushDefault nem upstream)`, cfgWhere)],
      "o remote só se define no comando do push: confira-o");
  }
  if (remote === NO_PUSH) return verdict("barra", [ev(`remote de push da branch ${bi.branch} = ${NO_PUSH}`, cfgWhere)], "push desligado nesta branch");
  const urls = git(ce, "remote", "get-url", "--push", "--all", remote);
  const where = `git remote get-url --push ${remote}`;
  if (urls.code !== 0) return verdict("barra", [ev(`remote ${remote} não existe: ${urls.stderr || "sem url de push"}`, where)]);
  const list = urls.stdout.split(/\s+/).filter(Boolean);
  const bad = list.find((u) => u.startsWith(NO_PUSH));
  if (bad) return verdict("barra", [ev(`url de push do remote ${remote} = ${bad}`, where)], "remote travado para push");
  return verdict("ok", [ev(`remote de push = ${remote}, url de push ${list[0] ?? "?"}`, where)]);
};

// ---------------------------------------------------------------- segredo-diff

/** Marcador montado em partes: este arquivo não casa com a própria varredura de segredos do release. */
const PRIVATE_KEY_MARK = String.raw`-----BEGIN [A-Z ]*` + "PRIVATE" + String.raw` KEY-----`;
const SECRET_PATTERNS: [string, RegExp][] = [
  ["token do GitHub", /gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}/],
  ["chave da AWS", /(AKIA|ASIA)[0-9A-Z]{16}/],
  ["token do Slack", /xox[abposr]-[A-Za-z0-9-]{10,}/],
  ["chave de API (sk-)", /sk-[A-Za-z0-9_-]{32,}/],
  ["token do Google", /AIza[0-9A-Za-z_-]{35}/],
  ["chave privada", new RegExp(PRIVATE_KEY_MARK)],
  ["credencial na URL", /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s:@]{6,}@[^/\s]+/],
  ["atribuição de segredo", /(secret|token|passw(or)?d|api[_-]?key)["']?\s*[:=]\s*["'][^"'\s]{16,}["']/i],
];
// valor que declara ser exemplo não é segredo (o arquivo de exemplo de ambiente só leva marcador)
const FALSE_POSITIVE = /exemplo|example|placeholder|changeme|xxxx|<[^>]+>|\$\{|\$\(|your[_-]|\*{4}/i;

function mask(text: string): string {
  return `${[...text].slice(0, MASK_PREFIX).join("")}…(${[...text].length} caracteres)`;
}

function secretIn(line: string): { name: string; match: string } | undefined {
  for (const [name, pattern] of SECRET_PATTERNS) {
    const m = pattern.exec(line);
    if (m && !FALSE_POSITIVE.test(m[0])) return { name, match: m[0] };
  }
  return undefined;
}

function pushRange(ce: CheckEnv): { range: string; why: string } | undefined {
  if (ce.ctx.range) return { range: ce.ctx.range, why: "intervalo do contexto (--ctx range=)" };
  if (git(ce, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}").code === 0) {
    return { range: "@{upstream}..HEAD", why: "o que o push leva: @{upstream}..HEAD" };
  }
  const tag = git(ce, "describe", "--tags", "--abbrev=0");
  if (tag.code === 0 && tag.stdout.trim()) return { range: `${tag.stdout.trim()}..HEAD`, why: `desde a última tag (${tag.stdout.trim()})` };
  const base = profileField(ce, "flow.base");
  const candidates = [base ? `origin/${base}` : "", base ?? "", "origin/main", "main", "origin/master", "master"].filter(Boolean);
  for (const b of candidates) {
    if (git(ce, "rev-parse", "--verify", "-q", b).code === 0 && git(ce, "rev-parse", "HEAD").stdout !== git(ce, "rev-parse", b).stdout) {
      return { range: `${b}..HEAD`, why: `desde a base ${b}` };
    }
  }
  return undefined;
}

function listFiles(root: string): string[] {
  if (statSync(root).isFile()) return [root];
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== ".git") walk(path);
      } else if (entry.isFile()) found.push(path);
    }
  };
  walk(root);
  return found.sort();
}

function scanContent(alvo: string, ctxKey: "texto" | "arquivo"): CheckVerdict {
  if (!existsSync(alvo)) {
    return verdict("barra", [ev(`${alvo} não existe: não há como conferir o que sai`, `--ctx ${ctxKey}=`)], "conteúdo a sair não encontrado");
  }
  const onde = `conteúdo de ${alvo}`;
  const files: { path: string; lines: string[] }[] = [];
  for (const path of listFiles(alvo).slice(0, MAX_SCANNED_FILES)) {
    try {
      files.push({ path, lines: splitLines(readFileSync(path, "utf8")) });
    } catch (error) {
      return verdict("barra", [ev(`não consegui ler ${path}: ${(error as NodeJS.ErrnoException).code ?? "erro"}`, path)], "conteúdo a sair ilegível");
    }
  }
  const found: Evid[] = [];
  for (const { path, lines } of files) {
    lines.forEach((line, i) => {
      const hit = secretIn(line);
      if (hit) found.push(ev(`${hit.name} em ${path}:${i + 1}: ${mask(hit.match)}`, onde));
    });
  }
  if (found.length) {
    return verdict("barra", found.slice(0, MAX_EVIDENCE), `${found.length} linha(s) com padrão de segredo no que sai; tratar como credencial queimada se já foi publicado`);
  }
  const total = files.reduce((n, f) => n + f.lines.length, 0);
  return verdict("ok", [ev(`${total} linha(s) em ${files.length} arquivo(s) sem padrão de token ou chave (${SECRET_PATTERNS.length} padrões)`, onde)]);
}

function scanDiff(ce: CheckEnv): CheckVerdict {
  const picked = pushRange(ce);
  if (!picked) {
    return verdict("aviso", [ev("sem upstream, tag nem base para delimitar o que sai", "git rev-parse @{upstream}, git describe --tags, base do perfil")],
      "diff que sai não delimitado: passe --ctx range=<a>..<b>");
  }
  const { range, why } = picked;
  const d = git(ce, "diff", "--no-color", "--unified=0", "--no-ext-diff", range);
  if (d.code !== 0) return verdict("barra", [ev(`git diff ${range} falhou: ${d.stderr}`, `git diff ${range}`)], "não consegui ler o diff que sai");
  const found: Evid[] = [];
  let file = "";
  let lineNo = 0;
  const lines = splitLines(d.stdout);
  for (const line of lines) {
    if (line.startsWith("+++ ")) {
      file = line.startsWith("+++ b/") ? line.slice(6) : line.slice(4);
    } else if (line.startsWith("@@")) {
      const m = /\+(\d+)/.exec(line);
      lineNo = m ? Number(m[1]) - 1 : 0;
    } else if (line.startsWith("+")) {
      lineNo += 1;
      const hit = secretIn(line.slice(1));
      if (hit) found.push(ev(`${hit.name} em ${file}:${lineNo}: ${mask(hit.match)}`, `git diff ${range}`));
    }
  }
  if (found.length) {
    return verdict("barra", found.slice(0, MAX_EVIDENCE), `${found.length} linha(s) com padrão de segredo no que sai (${why}); tratar como credencial queimada se já foi commitado`);
  }
  return verdict("ok", [ev(`${lines.length} linha(s) de diff sem padrão de token ou chave (${SECRET_PATTERNS.length} padrões)`, `git diff ${range} (${why})`)]);
}

const segredoDiff: Guard = (ce) => {
  const alvo = ce.ctx.texto || ce.ctx.arquivo;
  return alvo ? scanContent(alvo, ce.ctx.texto ? "texto" : "arquivo") : scanDiff(ce);
};

// ---------------------------------------------------------------- tunel-acesso

function hostOf(raw: string): string {
  try {
    return new URL(raw.includes("://") ? raw : `//${raw}`, "http://x").hostname.toLowerCase();
  } catch {
    return "";
  }
}

const tunelAcesso: Guard = (ce) => {
  let lista: string[];
  try {
    lista = (config(ce.env).HADES_CERBERUS_PORTA_TUNEL_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  } catch (error) {
    return verdict("barra", [ev(`não consegui ler a configuração do Cerberus: ${(error as Error).message}`, "src/lib/cerberus.ts config()")], "lista de hosts não conferida");
  }
  const chave = "Configurações → Cerberus → HADES_CERBERUS_PORTA_TUNEL_HOSTS";
  const host = hostOf((ce.ctx.host ?? "").trim());
  if (!host) return verdict("barra", [ev("sem host no contexto", "CERBERUS_CTX (--ctx host=<host ou URL do túnel>)")], "host do túnel não declarado");
  if (!lista.length) return verdict("barra", [ev(`lista de hosts permitidos vazia; host do túnel = ${host}`, chave)], "sem lista permitida o túnel fecha em vez de abrir");
  if (!lista.some((p) => fnmatchCase(host, p))) return verdict("barra", [ev(`host ${host} fora da lista (${lista.join(", ")})`, chave)], "host do túnel não permitido");
  const evid = [ev(`host ${host} na lista`, chave)];
  let acesso = (ce.ctx.acesso ?? "").trim().toLowerCase();
  if (!acesso && ce.ctx.tunel) {
    const r = exec(["devtunnel", "access", "list", ce.ctx.tunel], ce);
    const onde = `devtunnel access list ${ce.ctx.tunel}`;
    if (r.code !== 0) {
      return verdict("aviso", [...evid, ev(`não consegui ler o acesso do túnel ${ce.ctx.tunel}: ${r.stderr || "saída vazia"}`, onde)], "autenticação do túnel não conferida");
    }
    acesso = r.stdout.toLowerCase().includes("anonymous") ? "anonimo" : "autenticado";
    evid.push(ev(`acesso lido do túnel ${ce.ctx.tunel}: ${acesso}`, onde));
  } else {
    evid.push(ev(`acesso declarado pelo chamador: ${acesso || "não declarado"}`, "CERBERUS_CTX (--ctx acesso=)"));
  }
  if (acesso === "autenticado") return verdict("ok", evid);
  if (["anonimo", "anônimo", "anonymous"].includes(acesso)) return verdict("barra", evid, "o túnel aceita acesso anônimo");
  return verdict("barra", evid, "sem declarar que o acesso exige autenticação (--ctx acesso=autenticado, ou tunel=<id> para ler)");
};

// ---------------------------------------------------------------- upstream-push

const upstreamPush: Guard = (ce) => {
  const bi = branchInfo(ce);
  if (!bi.branch) return verdict("barra", [ev("HEAD destacado: sem branch para empurrar", "git symbolic-ref HEAD")], "push de HEAD destacado");
  const ref = headRef(ce);
  const where = `git config branch.<b>.remote/.merge em ${ce.env.CERBERUS_DIR || "."}`;
  const rastreio = bi.merge ? `${bi.remote}/${bi.merge}` : "";
  if (ref.head === undefined || !ref.headEv) {
    const local = rastreio ? `branch local ${bi.branch}, upstream ${rastreio}` : `branch local ${bi.branch} sem upstream`;
    return verdict("aviso", [ref.error as Evid, ev(local, where)], "sem a PR do contexto não há com o que comparar o upstream");
  }
  if (!bi.merge) {
    if (bi.branch === ref.head) {
      return verdict("ok", [ref.headEv, ev(`branch local ${bi.branch} sem upstream, mesmo nome da PR`, where)], "sem upstream: o primeiro push cria a branch da PR");
    }
    return verdict("barra", [ref.headEv, ev(`branch local ${bi.branch} sem upstream, nome diferente de ${ref.head}`, where)], "push -u criaria outra branch que não é a da PR");
  }
  if (bi.merge === ref.head) return verdict("ok", [ref.headEv, ev(`@{upstream} = ${rastreio}`, where)]);
  return verdict("barra", [ev(`@{upstream} = ${rastreio}, headRefName da PR = ${ref.head}`, where), ref.headEv], "a branch local rastreia outra branch");
};

export const PORTA_GUARDS: Record<string, Guard> = {
  "branch-protegida": branchProtegida,
  "conta-gh": contaGh,
  "nome-dominio": nomeDominio,
  "plano-aprovado": planoAprovado,
  "remote-push": remotePush,
  "segredo-diff": segredoDiff,
  "tunel-acesso": tunelAcesso,
  "upstream-push": upstreamPush,
};

