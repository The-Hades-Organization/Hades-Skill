// 5.5.2: o doctor não cobra mais o rsync (o install copia em TS pelo manifesto), mas segue cobrando jq e unzip.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { Rig } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const data = `${r.T}/data-doctor`;
mkdirSync(data, { recursive: true });
writeFileSync(`${data}/env.sh`, `W="${r.C}"\n`);

/** PATH só com as ferramentas pedidas: nunca o rsync, e o unzip só quando o caso o quer. */
function binarios(nome: string, ferramentas: string[]): string {
  const dir = `${r.T}/doctor-${nome}`;
  mkdirSync(dir, { recursive: true });
  for (const n of ferramentas) symlinkSync(Bun.which(n) ?? `/usr/bin/${n}`, `${dir}/${n}`);
  return dir;
}
const doctor = (path: string) => r.hades(["doctor", "--quick", "--json"], { env: { PATH: path, HADES_DATA: data } }).out;

describe("doctor: ferramentas", () => {
  test("nenhum item cobra o rsync, e jq e unzip seguem checados", () => {
    const out = doctor(binarios("com", ["jq", "unzip", "git", "node"]));
    expect(out).toContain("jq disponível");
    expect(out).toContain("unzip disponível");
    expect(out).not.toContain("rsync");
  });
  test("sem o unzip no PATH o doctor ainda reclama dele", () => {
    const out = doctor(binarios("sem", ["jq", "git", "node"]));
    expect(out).toContain("unzip não encontrado");
    expect(out).not.toContain("rsync");
  });
});
