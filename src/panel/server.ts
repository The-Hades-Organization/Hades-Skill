// Servidor do painel (Bun.serve): escuta só em 127.0.0.1, confere o Host (DNS rebinding) e o Origin, e toda ação exige o
// token da sessão (embutido na página servida) em POST JSON.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { hadesHome, home } from "../lib/paths.ts";
import { run } from "../lib/proc.ts";
import { type Auth, createAuth, safeEqual } from "./auth.ts";
import { type Built, buildAction, pyStr } from "./actions.ts";
import { type PanelEnv, panelEnv, readEnvSh } from "./env.ts";
import { createGateWatch, workRoot } from "./gatewatch.ts";
import { createGitHub } from "./github.ts";
import { createWidget } from "./widget.ts";
import { createHerdr, createHerdrSocket } from "./herdr.ts";
import { createHerdrPage } from "./herdr-page.ts";
import { createHerdrStream } from "./herdr-stream.ts";
import { exec } from "./exec.ts";
import { createArgos } from "./argos.ts";
import { createCanvasRoutes } from "./canvas.ts";
import { createCanvasHub } from "./canvas-stream.ts";
import { createCanvasContentRoutes } from "./canvas-content.ts";
import { createCanvasNotesRoutes } from "./canvas-notes.ts";
import { DEFAULT_CANVAS_ID } from "../lib/canvas-store.ts";
import { readCanvasDoc } from "../lib/canvas-doc.ts";
import { createCanvasPortalRoutes } from "./canvas-portal.ts";
import { agentWorktrees, createArgosTerminalsRoutes, TERMINAL_REQUEST_TIMEOUT_S, TERMINALS_PATH } from "./argos-terminals.ts";
// compositor do canvas: seletor de arquivos do terminal e anexos (canvas-files.ts)
import { createCanvasFilesRoutes, paneCwdOf } from "./canvas-files.ts";
// supervisor do canvas: cartão local de fim/pausa, consulta e resumo das notas pelo claude -p (argos-supervisor.ts)
import { createSupervisorRoutes } from "./argos-supervisor.ts";
import { notifyVia } from "./argos-actions.ts";
import { CaronteRouteError, createCaronteRoutes } from "./caronte.ts";
import { loadWorkEnv } from "../lib/work.ts";
import { registriesOf } from "./argos-graph.ts";
import { createMoiraiRoutes, MoiraiError } from "./moirai.ts";
import { ChatBusy, createChat, sendOptions } from "./chat.ts";
import { createJobs } from "./jobs.ts";
import { createOrchestration } from "./orchestration.ts";
import { createThanatosRoutes } from "./thanatos.ts";
import { loadPlugin, readManifest, routeKey, unitNamePattern } from "./plugin.ts";
import { PluginError, PluginRefused, type PluginState, startPluginHost } from "./plugin-host.ts";
import { PluginsRefused, createPluginsPage } from "./plugins-page.ts";
import { createMisc } from "./routes-misc.ts";
import { createSampler } from "./sampler.ts";
import { BadRequest, CTYPES, readForm, readJsonBody, queryOf, send } from "./http.ts";
import { LOGIN_ICON, loginPage } from "./login.ts";
import { log } from "./log.ts";
import * as core from "./routes-core.ts";
import { CANVAS_HARNESS_HTML, createCanvasModuleBundler, createUiTranspiler } from "./ui-transpile.ts";
import { TOURS_MARKER, tourScriptTags } from "./ui-tours.ts";
import { createTerm } from "./term.ts";
import { createTermHttp, type TermSocketData } from "./term-http.ts";
import { TERM_PATHS } from "./term-protocol.ts";

const AUTH_DELAY_MS = 1000;
const NOTIFY_APPLY_TIMEOUT_MS = 30_000;
const SESSION_MAX_AGE_S = 2_592_000;
const VENDOR_CACHE = "public, max-age=86400";
const NO_CACHE = "no-cache";

export interface Panel {
  stop(): void;
  port: number;
  token: string;
}

/** unquote_plus do Python: + vira espaço e %XX é decodificado; sequência inválida fica como veio. */
function unquotePlus(text: string): string {
  const spaced = text.replaceAll("+", " ");
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced;
  }
}

const isUnder = (child: string, parent: string): boolean => child.startsWith(parent + sep);

/** Hash dos arquivos da UI: a versão do cache do service worker. Ordem por partes do caminho, como o sorted(Path) do original. */
function uiHash(ui: string): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path.slice(ui.length + 1));
    }
  };
  walk(ui);
  files.sort((a, b) => {
    const x = a.split(sep);
    const y = b.split(sep);
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return (x[i] as string) < (y[i] as string) ? -1 : 1;
    return x.length - y.length;
  });
  const hash = createHash("sha256");
  for (const rel of files) hash.update(Buffer.concat([Buffer.from(`${rel.split(sep).join("/")}\0`), readFileSync(join(ui, rel))]));
  return hash.digest("hex").slice(0, 12);
}

function staticFile(root: string, rel: string, allow: (name: string, ext: string) => boolean): { bytes: Buffer; ext: string; real: string } | undefined {
  let real: string;
  try {
    real = realpathSync(join(root, rel));
  } catch {
    return undefined;
  }
  const base = realpathSync(root);
  const ext = real.slice(real.lastIndexOf("."));
  if (!isUnder(real, base) || !statSync(real).isFile() || !allow(real.slice(real.lastIndexOf(sep) + 1), ext)) return undefined;
  return { bytes: readFileSync(real), ext, real };
}

export async function startPanel(dir: string, port: number): Promise<Panel> {
  const env: PanelEnv = panelEnv(dir);
  const auth: Auth = createAuth(env);
  const token = randomBytes(24).toString("base64url");
  const jobs = createJobs(env);
  const herdr = createHerdr();
  const herdrSocket = createHerdrSocket();
  const herdrPage = createHerdrPage(env, herdr, herdrSocket);
  const herdrStream = createHerdrStream({ socket: herdrSocket, socketOf: herdrPage.socketOf });
  const chatUnit = process.env.HADES_CHAT_UNIT || `${env.hu}-chat`;
  const chat = createChat({ env, unit: chatUnit, config: () => core.configValues(env) });
  const uiTranspiler = createUiTranspiler({ isolate: [join(env.ui, "argos")] });
  // os módulos do modelo do canvas (src/lib) que a UI usa, da mesma fonte que o servidor
  const canvasModules = createCanvasModuleBundler(join(import.meta.dir, "..", "lib"));
  const manifest = readManifest(env);
  const pluginHost = await startPluginHost(env, typeof manifest.panel === "object" && manifest.panel !== null && Object.keys(manifest.panel).length > 0);
  const plugin = loadPlugin(env, pluginHost.functions, manifest);
  /** O que o `ctx` do api.ts lê do painel: vai junto de cada chamada ao auxiliar. */
  const pluginState = (): PluginState => ({
    config: core.configValues(env), snapshot: sampler.snapshot(), containers: containerNames(),
  });
  const sampler = createSampler({
    env, plugin, jobs, herdr,
    configValues: () => core.configValues(env),
    publicUrl: auth.publicUrl,
    pluginSample: (ctx) => pluginHost.sample({
      ...pluginState(),
      units: ctx.units,
      unitViews: Object.fromEntries(Object.keys(ctx.units).map((name) => [name, ctx.unitView(name)])),
      unitViewDefault: ctx.unitView(""),
    }),
    chatUnit,
  });
  const gatewatch = createGateWatch({
    dir: env.dir, locks: env.locks, gateLock: readEnvSh(env.dir).GATE_LOCK, fallbackGates: sampler.gateQueue,
    // o amostrador lê WORK_ROOT/<owner__repo>/locks: o pai da pasta de locks do env.sh
    root: env.locks ? dirname(dirname(env.locks)) : workRoot(process.env, home()),
  });
  const orchestration = createOrchestration(env, () => core.configValues(env));
  const thanatos = createThanatosRoutes(env);
  const widget = createWidget({
    env, auth, config: () => core.configValues(env), panelPort: port, orchestration: () => orchestration.snapshot(),
    gates: () => gatewatch.detail(), sampler: () => sampler.snapshot(), optionalContainers: () => plugin.optionalContainers,
  });
  const containerNames = (): string[] => ((sampler.snapshot().containers as { name: string }[] | undefined) ?? []).map((c) => c.name);
  const argos = createArgos({
    env, herdr, herdrPage, config: () => core.configValues(env), gates: () => (gatewatch.detail().gates as Record<string, unknown>[] | undefined) ?? [],
    workRoot: env.locks ? dirname(dirname(env.locks)) : workRoot(process.env, home()),
  });
  // empurrão do canvas: a página abre /api/canvas/stream e é avisada de cada gravação (reference/argos.md §Releitura do documento)
  const canvasHub = createCanvasHub();
  const canvas = createCanvasRoutes(env.dir, undefined, { onWrite: (id, rev) => canvasHub.publishCanvas(id, rev) });
  const canvasFiles = createCanvasFilesRoutes({ dataDir: env.dir, paneCwd: (session, pane) => paneCwdOf(herdr, session, pane) });
  const canvasContent = createCanvasContentRoutes({
    registries: () => registriesOf(env.locks, env.locks ? dirname(dirname(env.locks)) : workRoot(process.env, home())),
    plansDir: join(hadesHome(), "plans"),
  });
  // as notas leem o documento do canvas pela própria rota (mesma leitura, migração e validação), sem tocar no módulo dele
  const canvasNotes = createCanvasNotesRoutes(env.dir, {
    async loadDoc(canvasId) {
      const res = canvasId === DEFAULT_CANVAS_ID ? canvas.get() : canvas.getMany(`/api/canvases/${canvasId}`);
      if (!res?.ok) return undefined;
      try {
        return readCanvasDoc(await res.json());
      } catch (error) {
        log("error", "canvas ilegível para a nota", { canvas: canvasId, reason: error instanceof Error ? error.message : String(error) });
        return undefined;
      }
    },
  });
  const canvasPortal = createCanvasPortalRoutes({
    hosts: () => {
      const publicHost = auth.publicHost();
      return { hadesHosts: publicHost ? [publicHost.replace(/:\d+$/, "")] : [], extraHosts: core.configValues(env).HADES_CANVAS_PORTAL_HOSTS ?? "" };
    },
  });
  // terminais criados no canvas: papéis, predefinições, criar/fechar e trocar papel (reference/argos.md §Terminais criados no canvas)
  const argosTerminals = createArgosTerminalsRoutes({
    dir: env.dir,
    herdr,
    roots: () => [env.worktree, ...agentWorktrees(registriesOf(env.locks, env.locks ? dirname(dirname(env.locks)) : workRoot(process.env, home())).map((r) => r.orch))],
    notify: async (what, target) => {
      await exec(
        ["bash", join(env.dir, "notify.sh"), "send", "herdr", "warn", `ação remota: ${what} em ${target}`, "--obj", "herdr", "--state", `${what}:${target}`],
        { timeoutMs: NOTIFY_APPLY_TIMEOUT_MS, env: { ...process.env, HADES_DATA: env.dir } },
      );
    },
    signal: (pid) => process.kill(pid, "SIGTERM"),
    sleep: (ms) => Bun.sleep(ms),
    now: () => Date.now(),
    log,
    onRegistryChange: () => canvasHub.publishRegistry(),
    canvasPanes: () => canvas.terminalPanes(),
  });
  // terminal de verdade (reference/panel.md §Terminal): PTYs sob a unit do painel, desligado por padrão (HADES_TERMINAL)
  const term = createTerm({
    dataDir: env.dir,
    config: () => core.configValues(env),
    roots: () => [env.worktree, ...agentWorktrees(registriesOf(env.locks, env.locks ? dirname(dirname(env.locks)) : workRoot(process.env, home())).map((r) => r.orch)), env.dir],
    defaultCwd: env.worktree,
    notify: async (what, state) => {
      await exec(
        ["bash", join(env.dir, "notify.sh"), "send", "herdr", "warn", what, "--obj", "terminal", "--state", state],
        { timeoutMs: NOTIFY_APPLY_TIMEOUT_MS, env: { ...process.env, HADES_DATA: env.dir } },
      );
    },
    log,
  });
  const termHttp = createTermHttp({ term, auth, port });
  // supervisor do canvas (reference/argos.md §Supervisor): só lê o pane (a leitura do /api/herdr/read) e as notas
  const supervisor = createSupervisorRoutes({
    dir: env.dir,
    config: () => core.configValues(env),
    readPane: async (session, pane, lines) => String((await herdrPage.read(session, pane, String(lines))).text ?? ""),
    async loadDoc(canvasId) {
      const res = canvasId === DEFAULT_CANVAS_ID ? canvas.get() : canvas.getMany(`/api/canvases/${canvasId}`);
      return res?.ok ? readCanvasDoc(await res.json()) : undefined;
    },
    async readNote(name) {
      const res = canvasNotes.get(`/api/canvas-notes/${name}`);
      if (!res?.ok) return undefined;
      const note = (await res.json()) as { text?: unknown; title?: unknown };
      return typeof note.text === "string" ? { text: note.text, title: typeof note.title === "string" && note.title ? note.title : name } : undefined;
    },
    notify: async (what, target) => {
      await exec(
        ["bash", join(env.dir, "notify.sh"), "send", "herdr", "warn", `ação remota: supervisor (${what}) em ${target}`, "--obj", "herdr", "--state", `supervisor:${target}`],
        { timeoutMs: NOTIFY_APPLY_TIMEOUT_MS, env: { ...process.env, HADES_DATA: env.dir } },
      );
    },
    log,
  });
  const caronte = createCaronteRoutes({
    plansDir: join(hadesHome(), "plans"),
    outDir: () => core.configValues(env).HADES_CARONTE_OUT_DIR || join(hadesHome(), "caronte"),
    work: () => loadWorkEnv({ skillOk: true, skillForce: true }),
    config: () => core.configValues(env),
    logFile: join(env.dir, "logs", "panel-argos.log"),
    notify: notifyVia(env.dir, undefined),
  });
  const moirai = createMoiraiRoutes({
    registries: () => registriesOf(env.locks, env.locks ? dirname(dirname(env.locks)) : workRoot(process.env, home())), config: () => core.configValues(env),
  });
  const misc = createMisc({ env, jobs, config: () => core.configValues(env), containerNames, unitName: unitNamePattern(env.hu) });
  const github = createGitHub(env);
  const actionContext = {
    env, plugin,
    config: () => core.configValues(env),
    containerNames,
    baseRef: sampler.baseRef,
    pluginAction: async (action: string, body: Record<string, unknown>): Promise<Built> => {
      try {
        const [title, script, exclusive] = await pluginHost.action(action, body, pluginState());
        return { title, script, exclusive };
      } catch (error) {
        if (error instanceof PluginRefused) throw new BadRequest(error.message);
        throw error;
      }
    },
  };

  /** Título do job exclusivo ou processo da skill em curso (o ambiente só faz uma coisa pesada por vez), ou undefined. */
  async function envBusy(): Promise<string | undefined> {
    const running = (await jobs.list()).filter((j) => j.state === "rodando" && j.exclusive);
    if (running[0]) return running[0].title;
    return sampler.skillProcs()[0]?.cmd;
  }

  const pluginsPage = createPluginsPage({ env, config: () => core.configValues(env), busy: envBusy });

  const widgetScopeRefused = (req: Request): Response | undefined => {
    const bearer = auth.bearer(req.headers);
    return bearer && auth.widgetTokenValid(bearer)
      ? send(403, { error: "o token do widget só vale em GET /api/widget", code: "widget_token_scope" })
      : undefined;
  };

  /** Rota declarada pelo plugin. Chega aqui só depois da chave (GET e POST) e do token (POST). */
  async function pluginRoute(method: "GET" | "POST", path: string, data: Record<string, unknown>, remote: boolean): Promise<Response> {
    const route = plugin.routes.get(routeKey(method, path));
    if (!route) return send(404, { error: "rota do plugin desconhecida", code: "plugin_not_found" });
    if (route.local && remote) return send(403, { error: "esta rota do plugin só responde no painel local", code: "plugin_local_only" });
    try {
      return send(200, (await pluginHost.route(route.fn, data, pluginState())) as Record<string, unknown>);
    } catch (error) {
      if (error instanceof PluginRefused) throw new BadRequest(error.message);
      throw error;
    }
  }

  const refusedPlugins = (error: PluginsRefused): Response => send(error.status, { error: error.message, code: error.code });

  async function pluginsList(remote: boolean): Promise<Response> {
    try {
      return send(200, await pluginsPage.list(remote));
    } catch (error) {
      if (error instanceof PluginsRefused) return refusedPlugins(error);
      throw error;
    }
  }

  async function pluginsAct(body: Record<string, unknown>, remote: boolean): Promise<Response> {
    try {
      const { out, job } = await pluginsPage.act(body, remote);
      return send(200, job ? { ...out, job: await jobs.launch("plugins", job.title, job.script, true) } : out);
    } catch (error) {
      if (error instanceof PluginsRefused) return refusedPlugins(error);
      throw error;
    }
  }

  const login = (message = ""): Response => send(message ? 401 : 200, new TextEncoder().encode(loginPage(message)), CTYPES[".html"]);

  async function get(req: Request, url: URL): Promise<Response> {
    const remote = auth.isRemote(req.headers, port);
    const query = queryOf(url);
    const path = url.pathname;
    // o /api/widget tem a autenticação própria (token do widget), antes da chave remota
    const refused = widgetScopeRefused(req);
    if (refused) return refused;
    if (!auth.authed(req.headers, port)) {
      if (path === LOGIN_ICON) {
        const icon = staticFile(env.ui, "brand/hades.svg", () => true);
        if (icon) return send(200, icon.bytes, CTYPES[icon.ext] as string, NO_CACHE);
      }
      return path === "/" || path === "/index.html" ? login() : send(401, { error: "acesso remoto exige a chave" });
    }
    // o token muda a cada start do painel: a aba aberta antes do restart relê daqui (sem CORS, só a própria origem lê)
    if (path === "/api/token") return send(200, { token });
    if (path === "/api/snapshot") return send(200, sampler.snapshot());
    if (path === "/api/widget/token") return send(200, widget.status());
    if (path === "/api/widget/apk") return send(200, widget.apkInfo());
    if (path === "/api/widget/apk/download") return widget.apkDownload(false);
    if (path === "/api/gates") return send(200, gatewatch.detail());
    if (path === "/api/claude") return send(200, await chat.overview(remote));
    if (path === "/api/claude/stream") return chat.stream(req, query.id ?? "", query.offset);
    if (path === TERM_PATHS.list) return termHttp.list();
    if (path === "/api/journal/stream") return misc.journal.stream(req, query);
    if (path === "/api/herdr/stream") return herdrStream.open(req, query);
    if (path.startsWith("/api/argos/")) {
      const terminalsRead = argosTerminals.get(path);
      if (terminalsRead) return terminalsRead;
      const orphansRead = argosTerminals.orphans(path);
      if (orphansRead) return orphansRead;
      const composerFiles = await canvasFiles.get(path, query);
      if (composerFiles) return composerFiles;
      // supervisor do canvas: estado da chave e cartão local (só leitura do pane)
      const supervisorRead = supervisor.get(path, query, { remote });
      if (supervisorRead) return supervisorRead;
      const routed = await argos.get(path, query);
      if (routed) return routed;
    }
    if (path.startsWith("/api/canvas-content/")) {
      const routed = await canvasContent.get(path, query);
      if (routed) return routed;
    }
    if (path === "/api/canvas") return canvas.get();
    if (path === "/api/canvas/stream") return canvasHub.open(req);
    if (path === "/api/canvas/portal/policy") return canvasPortal.policy();
    // notas do canvas: a listagem (paginada) é a única rota da família com query
    if (path === "/api/canvas-notes") return canvasNotes.list(query);
    const noteRead = canvasNotes.get(path);
    if (noteRead) return noteRead;
    const manyCanvases = canvas.getMany(path);
    if (manyCanvases) return manyCanvases;
    if (path === "/api/caronte" || path.startsWith("/api/caronte/plan/")) {
      try {
        return send(200, path === "/api/caronte" ? caronte.list() : caronte.plan(decodeURIComponent(path.slice("/api/caronte/plan/".length))));
      } catch (error) {
        if (error instanceof CaronteRouteError) return send(error.status, { error: error.message, code: error.code });
        if (error instanceof URIError) return send(400, { error: "nome de plano inválido", code: "invalid_plan" });
        throw error;
      }
    }
    if (path === "/api/moirai/plan") return send(200, moirai.plan());
    if (path.startsWith("/api/moirai/unit/")) {
      try {
        return send(200, moirai.unit(decodeURIComponent(path.slice("/api/moirai/unit/".length)), query.registry));
      } catch (error) {
        if (error instanceof MoiraiError) return send(error.status, { error: error.message, code: error.code });
        if (error instanceof URIError) return send(400, { error: "nome de unidade inválido", code: "invalid_unit" });
        throw error;
      }
    }
    if (path === "/api/remote") {
      const key = auth.remoteKey();
      // a chave só é revelada no painel local
      return send(200, { url: auth.publicUrl() ?? null, remote, hasKey: key !== undefined, key: remote ? null : (key ?? null) });
    }
    if (path === "/api/plugin") return send(200, plugin.public());
    if (path === "/api/plugins") return pluginsList(remote);
    if (path.startsWith("/api/plugin/")) return pluginRoute("GET", path.slice("/api/plugin/".length), query, remote);
    try {
      if (path === "/api/thanatos") return send(200, thanatos.list());
      if (path.startsWith("/api/thanatos/")) {
        const found = thanatos.one(path.slice("/api/thanatos/".length));
        return found ? send(200, found) : send(404, { error: "post-mortem não encontrado" });
      }
      const routed = await getMisc(path, query, remote);
      if (routed) return routed;
      if (path === "/api/config") return send(200, core.configState(env));
      if (path === "/api/quality") return send(200, core.qualityState(env));
      if (path === "/api/cerberus") return send(200, { ...core.cerberusState(env), remote });
      if (path === "/api/config/export") return send(200, core.configExport(env, query, remote), "text/plain; charset=utf-8");
      if (path === "/api/doctor") return send(200, core.doctorState(env));
      if (path === "/api/docs") return send(200, core.docsIndex(env));
      if (path === "/api/doc") return send(200, core.docText(env, query.id ?? ""));
    } catch (error) {
      if (error instanceof BadRequest) return send(400, { error: error.message });
      throw error;
    }
    if (path.startsWith("/ui/lib/")) return canvasModuleRoute(path.slice("/ui/lib/".length));
    if (path === "/dev/canvas") return send(200, new TextEncoder().encode(CANVAS_HARNESS_HTML), CTYPES[".html"], NO_CACHE);
    return staticRoute(url, path);
  }

  /** `/ui/lib/<nome>`: só o pacote da lista; o resto (outro nome, `..`, subpasta) é 404 sem ler disco. */
  async function canvasModuleRoute(name: string): Promise<Response> {
    let js: string | undefined;
    try {
      js = await canvasModules.bundle(name);
    } catch (error) {
      log("error", "módulos da UI não empacotaram", { reason: error instanceof Error ? error.message : String(error) });
      return send(500, { error: "falha interna", code: "ui_module_build_failed" });
    }
    return js === undefined ? send(404, { error: "not found" }) : send(200, new TextEncoder().encode(js), CTYPES[".js"], NO_CACHE);
  }

  /** Rotas de leitura que consultam scripts e serviços da máquina; erro de entrada ou de arquivo vira 400 (o ValueError/OSError do original). */
  async function getMisc(path: string, query: Record<string, string>, remote: boolean): Promise<Response | undefined> {
    switch (path) {
      case "/api/log": return send(200, await misc.readLog(query.src ?? "", query.n ?? "400", query.offset));
      case "/api/log-files": return send(200, misc.logSources());
      case "/api/notify": return send(200, (await misc.notifyStatus(remote)) as Record<string, unknown>);
      case "/api/notify/qr": {
        const qr = await misc.notifyQr(remote);
        return qr.body instanceof Uint8Array ? send(qr.status, qr.body, "image/svg+xml") : send(qr.status, qr.body);
      }
      case "/api/disk": return send(200, await misc.diskStatus(query.refresh === "1"));
      case "/api/disk/preview": return send(200, await misc.diskPreview(query.op ?? "", query.cat ?? ""));
      case "/api/usage": return send(200, misc.usage());
      case "/api/limits": return send(200, misc.limits());
      case "/api/journal": return send(200, misc.journal.list(query));
      case "/api/orchestration": return send(200, await orchestration.snapshot());
      case "/api/orchestration/file": return send(200, orchestration.file(query.name ?? "", query.file ?? ""));
      case "/api/orchestration/terminal": return send(200, await orchestration.terminal(query.name ?? ""));
      case "/api/herdr": return send(200, await herdrPage.overview(query.session));
      case "/api/herdr/read": return send(200, await herdrPage.read(query.session, query.pane, query.lines));
      case "/api/herdr/scrollback": return send(200, await herdrPage.scrollback(query.session, query.pane, query.lines));
      case "/api/reviews": return send(200, await misc.reviews());
      case "/api/review/report": return send(200, misc.reviewReport(query.id ?? ""));
      case "/api/onboard": return send(200, (await misc.onboardStatus(query.quick === "1")) as Record<string, unknown>);
      case "/api/github/authors": return send(200, { me: await github.me(), recent: github.authors() });
      case "/api/github/prs": {
        const int = (text: string | undefined, fallback: number): number => {
          if (text === undefined) return fallback;
          if (!/^\s*[+-]?\d+\s*$/.test(text)) throw new BadRequest(`invalid literal for int() with base 10: '${text}'`);
          return Number.parseInt(text, 10);
        };
        return send(200, await github.prs({
          author: (query.author ?? "").trim(), page: Math.max(1, Math.min(50, int(query.page, 1))), per: Math.max(5, Math.min(50, int(query.per, 20))),
          text: query.q ?? "", drafts: (query.drafts ?? "1") === "1", refresh: query.refresh === "1",
        }));
      }
      default: return undefined;
    }
  }

  function staticRoute(url: URL, path: string): Response {
    if (path === "/" || path === "/index.html") {
      const html = readFileSync(join(env.ui, "index.html"), "utf8").replaceAll("__PANEL_TOKEN__", token).replace(TOURS_MARKER, tourScriptTags(env.ui));
      return send(200, new TextEncoder().encode(html), CTYPES[".html"]);
    }
    if (path === "/sw.js") {
      // na raiz para o escopo ser "/"; no-cache para o navegador conferir a versão a cada abertura
      const js = readFileSync(join(env.ui, "sw.js"), "utf8").replaceAll("__UI_HASH__", uiHash(env.ui));
      return send(200, new TextEncoder().encode(js), CTYPES[".js"], NO_CACHE);
    }
    if (path.startsWith("/plugin/ui/")) {
      // scripts das páginas do plugin, com a mesma contenção do /ui/ (só .js de dentro de $D/plugin/panel/ui)
      const file = staticFile(join(env.dir, "plugin", "panel", "ui"), path.slice("/plugin/ui/".length), (_, ext) => ext === ".js");
      if (file) return send(200, file.bytes, CTYPES[".js"], NO_CACHE);
    }
    if (path.startsWith("/ui/")) {
      const rel = path.slice("/ui/".length);
      // `x.js` com `x.tsx` ao lado: o fonte vence (um .js de instalação antiga não sombreia a UI atual); mesma contenção de caminho
      const source = rel.endsWith(".js") ? staticFile(env.ui, rel.replace(/\.js$/, ".tsx"), (_, ext) => ext === ".tsx") : undefined;
      if (source) return send(200, new TextEncoder().encode(uiTranspiler.transpile(source.real)), CTYPES[".js"], NO_CACHE);
      // só arquivos de dentro de ui/, com tipo conhecido; as bibliotecas (vendor/) não mudam entre versões do kit
      const file = staticFile(env.ui, rel, (name, ext) => ext in CTYPES && name !== "index.html");
      if (file) return send(200, file.bytes, CTYPES[file.ext] as string, path.includes("/vendor/") ? VENDOR_CACHE : NO_CACHE);
    }
    return send(404, { error: "not found" });
  }

  async function post(req: Request, url: URL, method: "POST" | "PUT"): Promise<Response> {
    const remote = auth.isRemote(req.headers, port);
    const origin = req.headers.get("origin");
    const pub = auth.publicHost();
    const allowed = [`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...(pub && remote ? [`https://${pub}`] : [])];
    if (!auth.hostOk(req.headers, port) || (origin && !allowed.includes(origin))) return send(403, { error: "origem" });
    const refused = widgetScopeRefused(req);
    if (refused) return refused;
    const path = url.pathname;
    if (path === "/auth" && remote) {
      if (auth.lockedOut()) return login("Muitas tentativas erradas. Espere 10 minutos.");
      const form = await readForm(req);
      const key = auth.remoteKey();
      // parse_qs já decodifica; o original decodificava de novo (unquote_plus) e a chave guardada nunca tem % nem +
      const typed = unquotePlus(form.key ?? "").trim();
      if (key && safeEqual(typed, key)) {
        return new Response(null, {
          status: 303,
          headers: {
            Location: "/",
            "Set-Cookie": `${env.cookie}=${auth.sessionValue(key)}; Max-Age=${SESSION_MAX_AGE_S}; Path=/; HttpOnly; Secure; SameSite=Strict`,
          },
        });
      }
      auth.recordFailure();
      await Bun.sleep(AUTH_DELAY_MS);
      return login("Chave incorreta.");
    }
    if (!auth.authed(req.headers, port)) return send(401, { error: "acesso remoto exige a chave" });
    if (req.headers.get("x-panel-token") !== token || !(req.headers.get("content-type") ?? "").includes("application/json")) {
      return send(403, { error: "token" });
    }
    // PUT é só do documento do canvas (corpo próprio, com teto maior que o dos demais POST)
    if (method === "PUT") {
      const noteWrite = canvasNotes.write(path, req, { remote });
      if (noteWrite) return noteWrite;
      if (path === "/api/canvas") return canvas.put(req, { remote });
      return (await canvas.writeMany(method, path, queryOf(url), req, { remote })) ?? send(404, { error: "not found" });
    }
    // os POST das notas (bloquear, renomear, mover, imagem, apagar, apontar) leem o próprio corpo, com teto por ação
    const noteAction = canvasNotes.action(path, req, { remote });
    if (noteAction) return noteAction;
    // os POST de /api/canvases/* (criar, renomear, apagar, importar) leem o próprio corpo, como o PUT
    const manyWrite = canvas.writeMany(method, path, queryOf(url), req, { remote });
    if (manyWrite) return manyWrite;
    // o anexo do compositor lê o próprio corpo (teto de anexo, maior que o dos demais POST)
    const composerAttachment = method === "POST" ? canvasFiles.post(path, req, { remote }) : undefined;
    if (composerAttachment) return composerAttachment;
    // o anexo do chat também lê o próprio corpo (JSON com base64, teto de HADES_CHAT_ATTACH_MB)
    if (method === "POST" && path === "/api/claude/attach") return chat.attach(req, remote);
    const body = await readJsonBody(req);
    if (body === undefined) return send(400, { error: "json" });
    // confere só os cabeçalhos da URL do nó portal; a origem do painel, como o navegador do chamador a vê, vem do Host já validado pelo hostOk
    if (path === "/api/canvas/portal/check") {
      const host = req.headers.get("host");
      return canvasPortal.check(body, { remote, ancestorOrigin: remote ? (pub ? `https://${pub}` : undefined) : host ? `http://${host}` : undefined });
    }
    // o ip é só para o log do Argos; quem decide o acesso remoto é o auth acima, nunca o cabeçalho
    const terminalsWrite = argosTerminals.post(path, body, { remote });
    if (terminalsWrite) return terminalsWrite;
    const termWrite = await termHttp.post(path, body, remote);
    if (termWrite) return termWrite;
    // supervisor do canvas: consulta e resumo das notas pelo claude -p (D1 pelo acesso remoto)
    const supervisorWrite = supervisor.post(path, body, { remote });
    if (supervisorWrite) return supervisorWrite;
    if (path === "/api/argos/action") return argos.act(body, { remote, ip: req.headers.get("cf-connecting-ip") ?? undefined });
    if (path === "/api/caronte/park") {
      try {
        return send(200, await caronte.park(body, { remote, ip: req.headers.get("cf-connecting-ip") ?? undefined }));
      } catch (error) {
        if (error instanceof CaronteRouteError) return send(error.status, { error: error.message, code: error.code });
        throw error;
      }
    }
    try {
      return await postRoute(path, body, remote);
    } catch (error) {
      if (error instanceof BadRequest) return send(400, { error: error.message });
      throw error;
    }
  }

  const REMOTE_REFUSALS: [(body: Record<string, unknown>) => boolean, string][] = [
    [(b) => b.action === "panel-tunnel", "o túnel e a chave do painel só se controlam pelo painel local"],
    [(b) => b.action === "clean" && b.op === "yes", "apagar imagens, pacotes e worktrees só se faz pelo painel local"],
    [(b) => b.action === "notify" && b.op === "rotate", "o tópico do ntfy só se troca pelo painel local"],
    [(b) => b.action === "config-apply" && b.op === "autostart", "o início automático do painel só se aplica pelo painel local"],
  ];

  async function postRoute(path: string, body: Record<string, unknown>, remote: boolean): Promise<Response> {
    if (path === "/api/action") {
      if (remote) for (const [matches, message] of REMOTE_REFUSALS) if (matches(body)) throw new BadRequest(message);
      const { title, script, exclusive } = await buildAction(actionContext, body);
      if (exclusive) {
        const who = await envBusy();
        if (who) return send(409, { error: `ambiente ocupado: ${who}` });
      }
      return send(200, { job: await jobs.launch(pyStr(body.action), title, script, exclusive) });
    }
    if (path === "/api/job/stop") {
      const id = pyStr(body.id ?? "");
      if (!/^[\w-]+$/.test(id)) throw new BadRequest("job inválido");
      await jobs.stop(id);
      return send(200, { ok: true });
    }
    if (path === "/api/config") {
      const refusal = remote ? core.remoteConfigRefusal(core.configKeys(body)) : undefined;
      if (refusal) throw new BadRequest(refusal);
      const { apply, keys } = core.configSave(env, body);
      if (keys.includes("HADES_NOTIFY")) {
        // liga/desliga o vigia na hora (as demais chaves ele relê sozinho)
        run("bash", [join(env.dir, "notify.sh"), "apply"], { timeoutMs: NOTIFY_APPLY_TIMEOUT_MS });
      }
      if (keys.includes("HADES_ORCH_AUTO_START")) {
        // a regra allow do settings.json acompanha o toggle (só chega aqui pelo painel local)
        try {
          (await import("../commands/agent-autonomy.ts")).syncAutoStartRule();
        } catch (error) {
          throw new BadRequest(`toggle gravado, mas a regra allow não: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      await sampler.sample();
      return send(200, { items: core.configState(env).items, apply });
    }
    if (path === "/api/widget/token") {
      if (remote) return send(403, { error: "o token do widget só se cria e revoga pelo painel local", code: "widget_local_only" });
      return send(200, widget.tokenAct(body.op));
    }
    if (path === "/api/quality") return send(200, core.qualityAct(env, body));
    if (path === "/api/cerberus") {
      if (remote) throw new BadRequest("exceção do Cerberus só se abre pelo painel local");
      return send(200, core.cerberusAct(env, body));
    }
    if (path === "/api/claude/send" || path === "/api/claude/stop" || path === "/api/claude/delete") {
      const sid = pyStr(body.id || "");
      if (sid && !chat.isId(sid)) throw new BadRequest("sessão inválida");
      try {
        if (path.endsWith("/send")) return send(200, { id: await chat.send(sid, pyStr(body.text || ""), remote, sendOptions(body)) });
        if (!sid) throw new BadRequest("sessão inválida");
        await (path.endsWith("/stop") ? chat.stop(sid) : chat.remove(sid));
        return send(200, { ok: true });
      } catch (error) {
        if (error instanceof ChatBusy) return send(409, { error: error.message });
        throw error;
      }
    }
    if (path === "/api/orchestration/publish") return send(200, orchestration.publishPage());
    if (path === "/api/herdr/act") return send(200, await herdrPage.act(body, remote));
    if (path === "/api/herdr/input") {
      const target = await herdrPage.input(body, remote);
      herdrStream.nudge(target.session, target.pane);
      return send(200, { ok: true });
    }
    if (path === "/api/herdr/admin") return send(200, await herdrPage.admin(body, remote));
    if (path === "/api/herdr/session") return send(200, await herdrPage.sessionAct(body, remote));
    if (path === "/api/onboard") return send(200, await misc.onboardApply(body, remote));
    if (path === "/api/config/preview") return send(200, core.configPreview(env, body, remote));
    if (path === "/api/plugins") return pluginsAct(body, remote);
    if (path.startsWith("/api/plugin/")) return pluginRoute("POST", path.slice("/api/plugin/".length), body, remote);
    return send(404, { error: "not found" });
  }

  async function handle(req: Request, clientIp: string | undefined): Promise<Response> {
    const url = new URL(req.url);
    const hostGate = (): Response | undefined => (auth.hostOk(req.headers, port) ? undefined : send(403, { error: "host" }));
    if (req.method === "GET") {
      // o /api/widget tem a autenticação própria (token do widget), antes da chave remota
      return hostGate() ?? (url.pathname === "/api/widget" ? widget.handle(req, clientIp) : await get(req, url));
    }
    if (req.method === "POST") return post(req, url, "POST");
    if (req.method === "PUT") return post(req, url, "PUT");
    if (req.method === "HEAD") {
      // só o download do APK responde HEAD; o resto é 404
      const refused = hostGate() ?? widgetScopeRefused(req);
      if (refused) return refused;
      if (!auth.authed(req.headers, port)) return send(401, { error: "acesso remoto exige a chave" });
      return url.pathname === "/api/widget/apk/download" ? widget.apkDownload(true) : send(404, { error: "not found" });
    }
    return new Response("método não suportado", { status: 501 });
  }

  // a primeira amostra sai antes de atender, como no original: o primeiro /api/snapshot já vem cheio
  await sampler.sample();
  const server = Bun.serve<TermSocketData>({
    hostname: "127.0.0.1",
    port,
    websocket: termHttp.websocket,
    async fetch(req, srv) {
      // o WebSocket do terminal confere host, chave, Origin e a chave HADES_TERMINAL antes de trocar de protocolo
      if (req.method === "GET" && termHttp.isSocketPath(new URL(req.url).pathname)) {
        return widgetScopeRefused(req) ?? termHttp.upgrade(req, srv);
      }
      // o Bun corta em 10 s a requisição sem resposta; criar ou trocar o papel de um terminal espera o shell e o agente subirem
      if (req.method === "POST" && new URL(req.url).pathname.startsWith(TERMINALS_PATH)) srv.timeout(req, TERMINAL_REQUEST_TIMEOUT_S);
      try {
        return await handle(req, srv.requestIP(req)?.address);
      } catch (error) {
        if (error instanceof PluginError) return send(500, { error: "falha no plugin do projeto (detalhe no log do painel)", code: "plugin_error" });
        // detalhe só no log: a resposta leva uma mensagem genérica e um código (o original derrubava a conexão)
        log("error", "requisição falhou", { method: req.method, path: new URL(req.url).pathname, reason: error instanceof Error ? error.message : String(error) });
        return send(500, { error: "erro interno do painel (detalhe no log)", code: "internal_error" });
      }
    },
  });
  sampler.start();
  gatewatch.start();
  term.start();
  const widgetListener = widget.serve();
  return { stop: () => { sampler.stop(); gatewatch.stop(); term.stop(); pluginHost.stop(); widgetListener?.stop(); herdrStream.stop(); void server.stop(true); }, port: server.port ?? port, token };
}
