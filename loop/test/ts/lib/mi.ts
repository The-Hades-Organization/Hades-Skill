// Ambiente das provas multi-instância: HOME próprio e comandos falsos do sistema.
import { copyFileSync, mkdirSync, symlinkSync } from "node:fs";
import { Rig, SKILL, STUBS, kv, readJson, writeJson, type Run, SYS_PATH } from "./rig";

export const mi = (r: Rig) => {
  const PR = `${r.T}/mi-packs`, MH = `${r.T}/mi-home`, BB = `${r.T}/mi-bin`, SC = `${r.T}/mi-sc`;
  const NODE_DIR = r.env0.PATH?.split(":")[1] ?? "/usr/bin";
  return {
    PR, MH, BB, SC,
    /** HOME próprio, systemctl/systemd-run/journalctl/devtunnel falsos junto de um node (link). `noSystemd` = `env -u SKIP_SYSTEMD`. */
    MI(argv: string[], extra: Record<string, string> = {}, o: { cwd?: string; noSystemd?: boolean; merge?: boolean } = {}): Run {
      const env = kv({ HOME: MH, HADES_CERBERUS_PORTA: "off", PATH: `${BB}:${STUBS}:${NODE_DIR}:${SYS_PATH}`, HADES_PACKS_ROOT: PR, HADES_SKILL_DIR: SKILL,
        FAKE_SYSTEMCTL_DIR: SC, FAKE_SC_LOG: `${r.T}/mi-systemd-run.log`, FAKE_DT_LOG: `${r.T}/mi-devtunnel.log`, HADES_LOGINCTL: `${STUBS}/loginctl`,
        FAKE_LINGER: `${r.T}/mi-linger`, SKIP_SYSTEMD: "1", SKIP_DOCTOR: "1" }, extra);
      if (o.noSystemd) delete env.SKIP_SYSTEMD;
      return r.X(argv, { env, cwd: o.cwd, merge: o.merge });
    },
  };
};

/** Duas instâncias instaladas (o projeto do clone principal e o outro, com HADES_ID=projb) para as provas que só consultam o registro. */
export function miInstalled(r: Rig, fx: string) {
  const m = mi(r), { PR, MH, BB, SC } = m;
  const D1 = `${r.T}/mi-d1`, D2 = `${r.T}/mi-d2`, wt1 = `${r.T}/wt-mi1`, wt2 = `${r.T}/wt-mi2`;
  for (const d of [`${PR}/example-monorepo`, `${PR}/other-plain`, `${MH}/.claude/skills`, BB, SC]) mkdirSync(d, { recursive: true });
  symlinkSync(SKILL, `${MH}/.claude/skills/hades`);
  symlinkSync(Bun.which("node") ?? "/usr/bin/node", `${BB}/node`); symlinkSync(`${STUBS}/systemctl`, `${BB}/systemctl`);
  copyFileSync(`${fx}/packs/example-monorepo/profile.json`, `${PR}/example-monorepo/profile.json`);
  const op = readJson(`${fx}/packs/example-monorepo/profile.json`); op.name = "other-plain"; op.identity.repo = "other/plain"; op.flow.base = "main"; delete op.branch.base;
  writeJson(`${PR}/other-plain/profile.json`, op);
  r.must(r.git(r.C, "worktree", "add", "-q", "-b", "mi/wt1", wt1)); r.must(r.git(r.P, "worktree", "add", "-q", "-b", "mi/wt2", wt2));
  r.must(m.MI(["bash", `${SKILL}/kit/install.sh`], { HADES_WT: wt1, HADES_DATA: D1 }, { merge: true }));
  r.must(m.MI(["bash", `${SKILL}/kit/install.sh`], { HADES_WT: wt2, HADES_DATA: D2, HADES_ID: "projb", HADES_INSTALL_BUSY_PORTS: "21221" }, { merge: true }));
  return { ...m, D1, D2, wt1, wt2 };
}
