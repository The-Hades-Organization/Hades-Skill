// Leituras de processo, memória e portas (src/lib/proc.ts): os parsers da saída do ss, netstat, ps e vm_stat, gravada,
// e a regra que separa o processo vivo do pid reciclado. Puros: rodam igual no Linux e no macOS.
import { describe, expect, test } from "bun:test";
import { parseLstartUtc, parseNetstatListeners, parseSsListeners, pidAlive, sameProcess, startConfirms, vmStatAvailableMb } from "../../../src/lib/proc.ts";

describe("proc: ss -Hltnp", () => {
  test("porta, pid e nome; IPv6 e sem processo visível", () => {
    const text = [
      'LISTEN 0      4096       127.0.0.1:5432       0.0.0.0:*    users:(("postgres",pid=812,fd=6))',
      "LISTEN 0      511             [::]:8080          [::]:*",
      'LISTEN 0      128    0.0.0.0:22   0.0.0.0:*    users:(("sshd",pid=1,fd=3),("sshd",pid=2,fd=3))',
      "",
    ].join("\n");
    expect(parseSsListeners(text)).toEqual([
      { port: 5432, pid: "812", name: "postgres" },
      { port: 8080, pid: "", name: "" },
      { port: 22, pid: "1", name: "sshd" },
    ]);
  });
  test("saída vazia ou sem porta numérica: nada", () => {
    expect(parseSsListeners("")).toEqual([]);
    expect(parseSsListeners("LISTEN 0 1 *:* *:*\n")).toEqual([]);
  });
});

describe("proc: netstat -anv -p tcp (macOS)", () => {
  const header =
    "Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)          rxbytes      txbytes  rhiwat  shiwat          process:pid    state  options           gencnt    flags   flags1 usecnt rtncnt fltrs";
  const row = (local: string, state: string, owner: string) =>
    `tcp4       0      0  ${local}        *.*                    ${state}                 0            0  131072  131072 ${owner}   00100 00000006 000000000039bd73 00000001 00000800      1      0 000000`;

  test("só LISTEN; porta depois do último ponto; nome com espaço", () => {
    const text = ["Active Internet connections (including servers)", header,
      row("*.52085", "LISTEN", "rapportd:619"),
      row("127.0.0.1.5432", "LISTEN", "Google Chrome H:4242"),
      row("::1.3000", "LISTEN", "node:28140"),
      row("192.168.7.2.52192", "ESTABLISHED", "curl:1"),
      "udp4       0      0  *.5353                 *.*                                   0            0  786896    9216        mDNSResponder:503    00000 00000000",
    ].join("\n");
    expect(parseNetstatListeners(text)).toEqual([
      { port: 52085, pid: "619", name: "rapportd" },
      { port: 5432, pid: "4242", name: "Google Chrome H" },
      { port: 3000, pid: "28140", name: "node" },
    ]);
  });
  test("cabeçalho sem process:pid (formato antigo): porta sem dono", () => {
    const old = "Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)     rhiwat shiwat    pid   epid  state    options";
    expect(parseNetstatListeners(`${old}\ntcp4 0 0 *.8080 *.* LISTEN 131072 131072 77 0 0x0100 0x00000006\n`)).toEqual([{ port: 8080, pid: "", name: "" }]);
  });
  test("saída vazia: nada", () => expect(parseNetstatListeners("")).toEqual([]));
});

describe("proc: ps -o lstart= com TZ=UTC", () => {
  test("data em epoch de segundos, lida como UTC", () => {
    expect(parseLstartUtc("Thu Oct 29 19:53:09 2026\n")).toBe(String(Date.UTC(2026, 9, 29, 19, 53, 9) / 1000));
    expect(parseLstartUtc("Fri Oct  9 04:01:09 2026")).toBe(String(Date.UTC(2026, 9, 9, 4, 1, 9) / 1000));
  });
  test("vazio ou fora do formato: undefined", () => {
    expect(parseLstartUtc("")).toBeUndefined();
    expect(parseLstartUtc("ontem")).toBeUndefined();
  });
});

describe("proc: vm_stat (macOS)", () => {
  test("livres + inativas + especulativas vezes o tamanho da página", () => {
    const text = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free:                               10240.",
      "Pages active:                             99999.",
      "Pages inactive:                           20480.",
      "Pages speculative:                         2048.",
    ].join("\n");
    expect(vmStatAvailableMb(text)).toBe(((10240 + 20480 + 2048) * 16384) / (1024 * 1024));
  });
  test("sem o tamanho da página: 0", () => expect(vmStatAvailableMb("Pages free: 10.\n")).toBe(0));
});

describe("proc: vivo ou reciclado", () => {
  test("marca gravada e lida diferentes: reciclado; sem uma das duas: vale o pid vivo", () => {
    expect(startConfirms("100", "100")).toBe(true);
    expect(startConfirms("100", "200")).toBe(false);
    expect(startConfirms("", "200")).toBe(true);
    expect(startConfirms("100", undefined)).toBe(true);
  });
  test("o próprio processo está vivo; pid vazio, inválido ou inexistente não", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(sameProcess(String(process.pid), "")).toBe(true);
    expect(sameProcess("", "")).toBe(false);
    expect(sameProcess("abc", "")).toBe(false);
    expect(pidAlive(-1)).toBe(false);
    expect(pidAlive(2 ** 22 + 12345)).toBe(false);
  });
});
