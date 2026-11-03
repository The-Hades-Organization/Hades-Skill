// Leitura da saída das rotas de teste (`<caso> <resto>` por linha): `caso(out)(c)` devolve o resto das linhas do caso c.
import { Rig, SKILL } from "./rig";
import { existsSync, writeFileSync } from "node:fs";

export const caso = (out: string) => (c: string): string =>
  out.split("\n").map((l) => l.trim().split(/\s+/)).filter((f) => f[0] === c).map((f) => f.slice(1).join(" ")).join("\n");

/** Instala o kit numa pasta descartável e devolve o $D com a chave do acesso remoto de teste. */
export function installWidget(r: Rig, tag: string): string {
  const wt = `${r.T}/${tag}-wt`, Dw = `${r.T}/${tag}-data`;
  r.must(r.git(r.C, "worktree", "add", "-q", "-b", `${tag}/wt`, wt));
  r.X(["bash", `${SKILL}/kit/install.sh`], { env: { HADES_WT: wt, HADES_DATA: Dw, SKIP_SYSTEMD: "1", SKIP_WORKTREE: "1", SKIP_DOCTOR: "1" } });
  if (!existsSync(`${Dw}/panel`)) throw new Error(`install do ${tag} não gerou ${Dw}/panel`);
  writeFileSync(`${Dw}/panel/remote.key`, "chave-do-teste\n");
  return Dw;
}
