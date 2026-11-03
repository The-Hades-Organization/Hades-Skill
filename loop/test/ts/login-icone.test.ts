// Grupo login-icone: a tela da chave do acesso remoto leva o ícone do painel, servido sem a chave (a página vem antes da
// autenticação); só esse arquivo de ui/ abre sem ela. O README mostra o mesmo ícone, por caminho relativo do repo.
import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { Rig, SKILL } from "./lib/rig";
import { remoteHeaders, startTestPanel, widgetData } from "./lib/widget-rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());

describe("login-icone", () => {
  test("a tela da chave referencia o ícone, que abre sem a chave; o resto de ui/ segue 401", async () => {
    const { D } = widgetData(r, "login-icone");
    mkdirSync(`${D}/panel/ui/brand`, { recursive: true });
    for (const f of ["hades.svg", "cerberus.svg"]) copyFileSync(`${SKILL}/kit/panel/ui/brand/${f}`, `${D}/panel/ui/brand/${f}`);
    const P = await startTestPanel(D);
    try {
      const h = remoteHeaders(D, false);
      const page = await fetch(`${P.base}/`, { headers: h });
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('src="/ui/brand/hades.svg"');
      const icon = await fetch(`${P.base}/ui/brand/hades.svg`, { headers: h });
      expect(icon.status).toBe(200);
      expect(icon.headers.get("content-type")).toContain("image/svg+xml");
      expect(await icon.text()).toBe(readFileSync(`${SKILL}/kit/panel/ui/brand/hades.svg`, "utf8"));
      expect((await fetch(`${P.base}/ui/brand/cerberus.svg`, { headers: h })).status).toBe(401);
    } finally { P.stop(); }
  });

  test("o README abre só com o banner e o banner embute o ícone, sem referência externa", () => {
    const readme = readFileSync(`${SKILL}/README.md`, "utf8");
    expect(readme).not.toContain("brand/hades.svg");
    expect(readme).toContain('src="assets/banner.svg"');
    const banner = readFileSync(`${SKILL}/assets/banner.svg`, "utf8");
    expect(banner).not.toMatch(/<use[\s>]|<image[\s>]|\shref=/);
    expect(existsSync(`${SKILL}/kit/panel/ui/brand/hades.svg`)).toBe(true);
  });
});
