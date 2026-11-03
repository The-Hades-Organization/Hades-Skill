// Quem pode falar com o painel: detecção de acesso remoto (túnel), host, chave e cookie da sessão remota, e o token do widget.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { readText } from "../lib/fs.ts";
import { cookiesOf } from "./http.ts";
import type { PanelEnv } from "./env.ts";

const SESSION_SALT = "hds-panel-session-v1";
const FAIL_LIMIT = 8;
const FAIL_WINDOW_S = 600;
const FAIL_KEEP = 50;

export const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export interface Auth {
  localHosts(port: number): string[];
  publicUrl(): string | undefined;
  publicHost(): string | undefined;
  remoteKey(): string | undefined;
  sessionValue(key: string): string;
  isRemote(headers: Headers, port: number): boolean;
  hostOk(headers: Headers, port: number): boolean;
  authed(headers: Headers, port: number): boolean;
  lockedOut(now?: number): boolean;
  recordFailure(now?: number): void;
  bearer(headers: Headers): string | undefined;
  widgetInfo(): { hash: string; createdAt?: unknown } | undefined;
  widgetTokenValid(token: string | undefined): boolean;
}

export function createAuth(env: PanelEnv): Auth {
  const failures: number[] = [];
  const trimmed = (path: string): string | undefined => readText(path)?.trim() || undefined;

  const auth: Auth = {
    localHosts: (port) => [`127.0.0.1:${port}`, `localhost:${port}`],
    publicUrl: () => trimmed(join(env.dir, "panel-tunnel.url")),
    publicHost() {
      const url = auth.publicUrl();
      if (!url) return undefined;
      try {
        return new URL(url).host;
      } catch {
        return undefined;
      }
    },
    remoteKey: () => trimmed(join(env.panelDir, "remote.key")),
    // cookie derivado da chave: trocar a chave derruba todas as sessões remotas
    sessionValue: (key) => createHmac("sha256", key).update(SESSION_SALT).digest("hex"),
    // pelo túnel: o devtunnel acrescenta X-Forwarded-*; o navegador local nunca manda
    isRemote(headers, port) {
      const forwarded = headers.get("x-forwarded-for") || headers.get("x-forwarded-host") || headers.get("x-forwarded-proto");
      const host = headers.get("host");
      return Boolean(forwarded) || host === null || !auth.localHosts(port).includes(host);
    },
    // remoto só pelo host do túnel do painel, com o túnel no ar e chave criada
    hostOk(headers, port) {
      if (!auth.isRemote(headers, port)) return true;
      const pub = auth.publicHost();
      const host = headers.get("x-forwarded-host") || headers.get("host");
      return Boolean(pub) && host !== null && [pub, ...auth.localHosts(port)].includes(host) && auth.remoteKey() !== undefined;
    },
    authed(headers, port) {
      if (!auth.isRemote(headers, port)) return true;
      const key = auth.remoteKey();
      if (!key) return false;
      return safeEqual(cookiesOf(headers.get("cookie"))[env.cookie] ?? "", auth.sessionValue(key));
    },
    lockedOut(now = Date.now() / 1000) {
      return failures.filter((t) => now - t < FAIL_WINDOW_S).length >= FAIL_LIMIT;
    },
    recordFailure(now = Date.now() / 1000) {
      failures.push(now);
      if (failures.length > FAIL_KEEP) failures.shift();
    },
    // token do widget: só no cabeçalho Authorization (na query ele iria parar em log de proxy e de túnel)
    bearer(headers) {
      const value = headers.get("authorization") ?? "";
      return value.slice(0, 7).toLowerCase() === "bearer " ? value.slice(7).trim() : undefined;
    },
    widgetInfo() {
      const text = readText(join(env.panelDir, "widget-token.json"));
      if (text === undefined) return undefined;
      try {
        const info: unknown = JSON.parse(text);
        const hash = typeof info === "object" && info !== null ? (info as { hash?: unknown }).hash : undefined;
        return typeof hash === "string" && hash ? (info as { hash: string; createdAt?: unknown }) : undefined;
      } catch {
        return undefined;
      }
    },
    widgetTokenValid(token) {
      const info = auth.widgetInfo();
      return Boolean(info && token) && safeEqual(createHash("sha256").update(token as string).digest("hex"), (info as { hash: string }).hash);
    },
  };
  return auth;
}
