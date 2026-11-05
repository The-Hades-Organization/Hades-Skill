// Plugin numa instância a mais (HADES_ID): a sub-rede é da instância e do plugin (não do núcleo), `<HU>` vale em
// panel.units[] e o túnel público do front vem desligado. reference/projects.md §Várias instâncias.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandUnit, loadPlugin } from "../../../src/panel/plugin.ts";
import type { PanelEnv } from "../../../src/panel/env.ts";
import { subnetGateway } from "../../../src/commands/onboard.ts";

const KIT = join(import.meta.dir, "../../../kit");
const T = mkdtempSync(join(tmpdir(), "instancia-plugin-"));
afterAll(() => rmSync(T, { recursive: true, force: true }));

const sh = (script: string, env: Record<string, string> = {}) => {
  const run = Bun.spawnSync(["bash", "-c", script], { env: { PATH: process.env.PATH ?? "", ...env } });
  return { out: run.stdout.toString().trim(), rc: run.exitCode };
};

/** docker de mentira: `network inspect` responde com NET_SUBNET (se houver) e `exec` grava os argumentos em DOCKER_LOG. */
function dockerStub(tag: string): { path: string; log: string } {
  const bin = join(T, `bin-${tag}`);
  mkdirSync(bin, { recursive: true });
  const log = join(T, `docker-${tag}.log`);
  writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash
case "$1 $2" in
  "network inspect") [[ -n \${NET_SUBNET:-} ]] && echo "$NET_SUBNET " || exit 1 ;;
  "exec "*) echo "$*" >> "${log}" ;;
esac
`);
  chmodSync(join(bin, "docker"), 0o755);
  return { path: `${bin}:${process.env.PATH ?? ""}`, log };
}

describe("<HU> em panel.units[] do plugin.json", () => {
  const units = (hu: string, list: string[]) =>
    [...loadPlugin({ hu, dir: T } as PanelEnv, undefined, { panel: { units: list } }).units].sort();

  test("dada a instância hds_app2, <HU>-x vira hds_app2-x", () => {
    expect(units("hds_app2", ["<HU>-event-console", "<HU>-asc-bus"])).toEqual(["hds_app2-asc-bus", "hds_app2-event-console"]);
  });
  test("dada a original, <HU>-x vira hds-x", () => {
    expect(units("hds", ["<HU>-event-console"])).toEqual(["hds-event-console"]);
  });
  test("plugin antigo com hds-* literal segue valendo na original e não vale na instância a mais", () => {
    expect([units("hds", ["hds-alarm-sim"]), units("hds_app2", ["hds-alarm-sim"])]).toEqual([["hds-alarm-sim"], []]);
  });
  test("<HU> fora do começo do nome, ou sem hífen, não é expandido nem aceito", () => {
    expect(units("hds_app2", ["x-<HU>-y", "<HU>x", "<HU>", "<HU>-"])).toEqual([]);
    expect(expandUnit("x-<HU>-y", "hds")).toBe("x-<HU>-y");
  });
  test("o manifesto público leva os nomes já expandidos", () => {
    const plugin = loadPlugin({ hu: "hds_app2", dir: T } as PanelEnv, undefined, { panel: { units: ["<HU>-asc-bus"] } });
    expect(plugin.public().units).toEqual(["hds_app2-asc-bus"]);
  });
});

describe("sub-rede da instância no firewall (kit/lib-checks.sh)", () => {
  const gateway = (subnet: string) => sh(`source '${KIT}/lib-checks.sh'; fw_gateway '${subnet}'`);

  test.each([
    ["172.18.0.0/16", "172.18.0.1"],
    ["172.21.0.0/16", "172.21.0.1"],
    ["10.99.0.0/24", "10.99.0.1"],
    ["192.168.5.7/20", "192.168.0.1"],
  ])("dada a sub-rede %s, o gateway é %s", (subnet, expected) => {
    expect(gateway(subnet)).toEqual({ out: expected, rc: 0 });
  });
  test.each(["bad", "300.1.1.1/16", "1.2.3.4/31", "1.2.3.4"])("sub-rede inválida '%s' não tem gateway", (subnet) => {
    expect(gateway(subnet).rc).not.toBe(0);
  });

  test("fw_test mede o gateway da sub-rede da instância, não o 172.18.0.1", () => {
    const d = dockerStub("fw1");
    const run = sh(`source '${KIT}/lib-checks.sh'; fw_test`, { PATH: d.path, HADES_FW_PROBE: "ctr:21101", HADES_DOCTOR_SUBNET: "172.21.0.0/16" });
    const log = readFileSync(d.log, "utf8");
    expect([run.rc, log.includes("/dev/tcp/172.21.0.1/21101"), log.includes("172.18.0.1")]).toEqual([0, true, false]);
  });
  test("fw_test sem HADES_DOCTOR_SUBNET usa a sub-rede da rede <projeto>_default", () => {
    const d = dockerStub("fw2");
    sh(`source '${KIT}/lib-checks.sh'; fw_test`, { PATH: d.path, HADES_FW_PROBE: "ctr:21101", HPROJ: "hades_x", NET_SUBNET: "172.25.0.0/16" });
    expect(readFileSync(d.log, "utf8")).toContain("/dev/tcp/172.25.0.1/21101");
  });
  test("fw_test sem sub-rede e sem rede docker é não medível (rc=2) e não chama o container", () => {
    const d = dockerStub("fw3");
    const run = sh(`source '${KIT}/lib-checks.sh'; fw_test`, { PATH: d.path, HADES_FW_PROBE: "ctr:21101", HPROJ: "hades_x" });
    expect(run.rc).toBe(2);
    expect(() => readFileSync(d.log, "utf8")).toThrow();
  });
  test("fw_cmd propõe a sub-rede da instância; sem sub-rede, o texto genérico", () => {
    const d = dockerStub("fw4");
    const cmd = (extra: Record<string, string>) => sh(`source '${KIT}/lib-checks.sh'; fw_cmd`, { PATH: d.path, ...extra }).out;
    expect(cmd({ HADES_DOCTOR_SUBNET: "172.21.0.0/16" })).toContain("172.21.0.0/16");
    expect(cmd({ HADES_DOCTOR_SUBNET: "172.21.0.0/16" })).not.toContain("172.18.");
    expect(cmd({ HPROJ: "hades_x" })).toStartWith("libere a rede docker do Hades");
  });
});

describe("gateway da sub-rede no onboarding (src/commands/onboard.ts)", () => {
  test.each([
    ["172.18.0.0/16", "172.18.0.1"],
    ["10.99.0.0/24", "10.99.0.1"],
    ["192.168.5.7/20", "192.168.0.1"],
    ["1.2.3.4/31", undefined],
    ["300.1.1.1/16", undefined],
    ["", undefined],
  ])("dada a sub-rede '%s', o gateway é %p", (subnet, expected) => {
    expect(subnetGateway(subnet)).toBe(expected);
  });
});

describe("padrões do catálogo: sub-rede é do plugin e o túnel vem desligado", () => {
  /** Valor efetivo da chave: catálogo do núcleo, mais o config.tsv do plugin e o config.env do dono, se houver. */
  function effective(key: string, opts: { plugin?: string; owner?: string } = {}): string {
    const d = mkdtempSync(join(T, "cfg-"));
    for (const f of ["config.sh", "config.tsv"]) copyFileSync(join(KIT, f), join(d, f));
    if (opts.plugin !== undefined) { mkdirSync(join(d, "plugin")); writeFileSync(join(d, "plugin/config.tsv"), opts.plugin); }
    if (opts.owner !== undefined) writeFileSync(join(d, "config.env"), opts.owner);
    return sh(`export D='${d}'; source '${d}/config.sh'; printf %s "\${${key}-<sem>}"`).out;
  }
  const subnetRow = "HADES_DOCTOR_SUBNET\t172.18.0.0/16\tcidr\tDiagnóstico\tSub-rede docker do ambiente\tnext\tda original\n";

  test("o núcleo sozinho não fixa sub-rede", () => {
    expect(effective("HADES_DOCTOR_SUBNET")).toBe("");
  });
  test("o config.tsv do plugin dá o padrão da sub-rede; o do dono (instância a mais) vence", () => {
    expect([effective("HADES_DOCTOR_SUBNET", { plugin: subnetRow }), effective("HADES_DOCTOR_SUBNET", { plugin: subnetRow, owner: "HADES_DOCTOR_SUBNET=172.21.0.0/16\n" })])
      .toEqual(["172.18.0.0/16", "172.21.0.0/16"]);
  });
  test("o túnel público do front vem desligado", () => {
    expect(effective("HADES_RUN_TUNNEL")).toBe("0");
  });
  test("quem gravou HADES_RUN_TUNNEL=1 no config.env segue com o túnel ligado", () => {
    expect(effective("HADES_RUN_TUNNEL", { owner: "HADES_RUN_TUNNEL=1\n" })).toBe("1");
  });
});
