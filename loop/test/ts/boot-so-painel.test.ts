// Grupo boot-so-painel: a subida completa automática saiu (config, migração do install, doctor, linger); só o painel inicia sozinho.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { Rig, SKILL, STUBS, kv } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const I = `${SKILL}/kit/install.sh`;
const wt = `${r.T}/wt-bsp`, D = `${r.T}/bsp-d`, U = "skilldev-boot-x", SC = `${r.T}/bsp-sc`;
const UD = `${r.H}/.config/systemd/user`, LG = `${r.T}/bsp-linger`, BB = `${r.T}/bsp-bin`;
const count = (text: string, re: RegExp) => text.split("\n").filter((l) => re.test(l)).length;
const rd = (p: string) => readFileSync(p, "utf8");
const st = (p: string) => (existsSync(p) ? "presente" : "ausente");

describe("boot-so-painel", () => {
  // o env.sh põe a pasta do node na frente do PATH: o systemctl falso mora junto de um node (link) para continuar na frente
  mkdirSync(BB, { recursive: true });
  symlinkSync(Bun.which("node") ?? "/usr/bin/node", `${BB}/node`); symlinkSync(`${STUBS}/systemctl`, `${BB}/systemctl`);
  const PB = `${BB}:${r.env0.PATH}`;
  r.must(r.git(r.C, "worktree", "add", "-q", "-b", "bsp/wt", wt));
  const bspIn = () => r.X(["bash", I], { merge: true, env: kv({ PATH: PB, HADES_WT: wt, HADES_DATA: D, HADES_BOOT_UNIT: U, FAKE_SYSTEMCTL_DIR: SC, SKIP_WORKTREE: "1", SKIP_DOCTOR: "1" }) }).out;
  const cfg = (...a: string[]) => r.X(["bash", `${D}/config.sh`, ...a], { merge: true, env: { HADES_DATA: D } });

  test("config.tsv sem HADES_BOOT, HADES_BOOT_DELAY e HADES_BOOT_WAIT_MIN", () => {
    expect(count(rd(`${SKILL}/kit/config.tsv`), /^HADES_BOOT(_DELAY|_WAIT_MIN)?\t/)).toBe(0);
  });
  test("config.tsv sem HADES_NOTIFY_EV_BOOT e notify sem o evento boot", () => {
    const n = ["src/lib/notify.ts", "src/lib/notify-watch.ts", "src/commands/notify.ts"].reduce((a, f) => a + count(rd(`${SKILL}/${f}`), /['"]boot['"]/), 0);
    expect(`${count(rd(`${SKILL}/kit/config.tsv`), /^HADES_NOTIFY_EV_BOOT/)} ${n}`).toBe("0 0");
  });

  describe("instalação descartável com a unit de boot do release anterior habilitada", () => {
    mkdirSync(UD, { recursive: true }); mkdirSync(`${SC}/enabled`, { recursive: true }); mkdirSync(D, { recursive: true });
    writeFileSync(`${UD}/${U}.service`, "[Service]\nExecStart=/bin/true\n"); writeFileSync(`${UD}/${U}.timer`, "[Timer]\nOnStartupSec=2min\n");
    writeFileSync(`${SC}/enabled/${U}.timer`, ""); writeFileSync(`${D}/boot.json`, '{"status":"erro"}\n'); writeFileSync(`${D}/boot.sh`, "velho\n");
    writeFileSync(`${D}/config.env`, "HADES_BOOT=login\nHADES_BOOT_DELAY=5\nHADES_BOOT_WAIT_MIN=10\nHADES_NOTIFY_EV_BOOT=off\n");
    let out = "";
    test("reinstalação: timer desabilitado, unit removida, boot.sh velho sai, boot.json fica", () => {
      out = bspIn();
      expect([existsSync(`${SC}/enabled/${U}.timer`) ? "enabled" : "ausente", existsSync(`${UD}/${U}.timer`) || existsSync(`${UD}/${U}.service`) ? "presente" : "ausente",
        st(`${D}/boot.sh`), st(`${D}/boot.json`)].join(" ")).toBe("ausente ausente ausente presente");
    });
    test("reinstalação: o resumo diz que a subida completa saiu", () => { expect(count(out, new RegExp(`^subida automática do Hades inteiro \\(${U}\\) removida`))).toBe(1); });
    test("reinstalação de novo (idempotente): sem a linha de migração", () => { expect(count(bspIn(), /removida: só o painel/)).toBe(0); });
  });

  describe("config.env antigo com as chaves que saíram: show, set e import não dão erro", () => {
    test("show: sai 0 e não lista as chaves", () => {
      const o = cfg("show"); expect(`${o.rc} ${count(o.out, /HADES_BOOT|EV_BOOT/)}`).toBe("0 0");
    });
    test("set de outra chave: sai 0 e as linhas ficam", () => {
      const o = cfg("set", "HADES_SLICE_SWAP=256M");
      expect(`${o.rc} ${count(rd(`${D}/config.env`), /^(HADES_BOOT|HADES_NOTIFY_EV_BOOT)/)}`).toBe("0 4");
    });
    test("import com HADES_BOOT: sem erro, aviso de chave ignorada, a outra vale", () => {
      writeFileSync(`${r.T}/bsp-imp.env`, "HADES_BOOT=boot\nHADES_PANEL_AUTOSTART=login\n");
      const o = cfg("import", `${r.T}/bsp-imp.env`, "--dry-run");
      expect(`${o.rc} ${count(o.out, /chave desconhecida nesta versão, ignorada: HADES_BOOT/)} ${count(o.out, /HADES_PANEL_AUTOSTART: off → login/)}`).toBe("0 1 1");
    });
  });

  describe("doctor: avisa com o timer sobrando, calado sem ele", () => {
    const sub = () => {
      const o = r.X(["timeout", "60", "bash", `${D}/doctor.sh`, "--quick", "--json"], { env: { PATH: PB, USER: "regressao", HADES_DATA: D, D, HADES_BOOT_UNIT: U, FAKE_SYSTEMCTL_DIR: SC } }).out;
      return (JSON.parse(o).items as { group: string; level: string; id: string }[]).filter((i) => i.group === "Subida").map((i) => `${i.level}:${i.id}`).join(" ");
    };
    test("com hds-boot.timer sobrando: aviso boot", () => { writeFileSync(`${SC}/enabled/${U}.timer`, ""); expect(sub()).toBe("warn:boot"); });
    test("sem o timer: sem aviso de boot", () => { rmSync(`${SC}/enabled/${U}.timer`, { force: true }); expect(sub()).toBe(""); });
  });

  describe("linger: só HADES_PANEL_AUTOSTART=boot o mantém; HADES_BOOT=boot de config.env antigo não conta", () => {
    const lg = (...a: string[]) => r.X(["bash", `${D}/linger.sh`, ...a], { env: { PATH: PB, HADES_DATA: D, HADES_LOGINCTL: `${STUBS}/loginctl`, FAKE_LINGER: LG } }).out.trim();
    test("só HADES_BOOT=boot (antigo), painel off: não liga", () => {
      writeFileSync(`${D}/config.env`, "HADES_BOOT=boot\n"); writeFileSync(LG, "no\n"); rmSync(`${D}/linger.mine`, { force: true });
      lg("sync"); expect(lg("state")).toBe("no");
    });
    test("HADES_PANEL_AUTOSTART=boot liga e marca como do Hades", () => {
      writeFileSync(`${D}/config.env`, "HADES_PANEL_AUTOSTART=boot\n");
      lg("sync"); expect(`${lg("state")} ${existsSync(`${D}/linger.mine`) ? "sim" : "não"}`).toBe("yes sim");
    });
    test("sync repetido mantém", () => { lg("sync"); expect(lg("state")).toBe("yes"); });
    test("tudo off (e HADES_BOOT antigo) desliga o que o Hades ligou", () => {
      writeFileSync(`${D}/config.env`, "HADES_PANEL_AUTOSTART=off\nHADES_BOOT=boot\n");
      lg("sync"); expect(`${lg("state")} ${existsSync(`${D}/linger.mine`) ? "sim" : "não"}`).toBe("no não");
    });
  });
});
