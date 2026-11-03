// Grupo contrib-acesso: o acesso de escrita ao repositório da skill vem de `gh api repos/<repo>` (permissions.push);
// sem gh, sem login ou sem permissão é o caminho "sem acesso", nunca um erro.
import { describe, expect, test } from "bun:test";
import { detectAccess, type GhRun } from "../../../src/lib/contrib-access";

const resposta = (status: number, stdout = "", stderr = ""): GhRun => () => ({ status, stdout, stderr, timedOut: false });
const REPO = "Dono/Skill";

describe("contrib-acesso", () => {
  test("push true: com acesso, e a branch padrão vem da mesma resposta", () => {
    const a = detectAccess(REPO, { hasGh: true, run: resposta(0, JSON.stringify({ default_branch: "trunk", permissions: { push: true } })) });
    expect(a).toEqual({ kind: "push", repo: REPO, defaultBranch: "trunk" });
  });

  test("push false: sem acesso por permissão", () => {
    const a = detectAccess(REPO, { hasGh: true, run: resposta(0, JSON.stringify({ default_branch: "main", permissions: { push: false, pull: true } })) });
    expect(a).toMatchObject({ kind: "sem-acesso", reason: "sem-permissao" });
  });

  test("resposta sem o campo permissions (anônima) é sem permissão", () => {
    expect(detectAccess(REPO, { hasGh: true, run: resposta(0, JSON.stringify({ default_branch: "main" })) })).toMatchObject({ reason: "sem-permissao" });
  });

  test("sem gh no PATH: nem tenta chamar", () => {
    let chamadas = 0;
    const a = detectAccess(REPO, { hasGh: false, run: () => { chamadas++; return { status: 0, stdout: "", stderr: "", timedOut: false }; } });
    expect(a).toMatchObject({ kind: "sem-acesso", reason: "sem-gh" });
    expect(chamadas).toBe(0);
  });

  test("sem login: a mensagem do gh manda autenticar", () => {
    const a = detectAccess(REPO, { hasGh: true, run: resposta(4, "", "To get started with GitHub CLI, please run:  gh auth login") });
    expect(a).toMatchObject({ reason: "sem-login" });
  });

  test("repositório que o gh não enxerga (404) é sem permissão", () => {
    expect(detectAccess(REPO, { hasGh: true, run: resposta(1, "", "gh: Not Found (HTTP 404)") })).toMatchObject({ reason: "sem-permissao" });
  });

  test("timeout, saída que não é JSON e erro desconhecido caem em indisponível, sem lançar", () => {
    expect(detectAccess(REPO, { hasGh: true, run: () => ({ status: 1, stdout: "", stderr: "", timedOut: true }) })).toMatchObject({ reason: "indisponivel" });
    expect(detectAccess(REPO, { hasGh: true, run: resposta(0, "<html>") })).toMatchObject({ reason: "indisponivel" });
    expect(detectAccess(REPO, { hasGh: true, run: resposta(1, "", "boom") })).toMatchObject({ reason: "indisponivel" });
  });

  test("repo fora do formato dono/nome não chega ao gh", () => {
    let chamadas = 0;
    const a = detectAccess("x; rm -rf /", { hasGh: true, run: () => { chamadas++; return { status: 0, stdout: "", stderr: "", timedOut: false }; } });
    expect(a).toMatchObject({ reason: "repo-invalido" });
    expect(chamadas).toBe(0);
  });

  test("a chamada é gh api repos/<repo>", () => {
    let args: string[] = [];
    detectAccess(REPO, { hasGh: true, run: (_c, a) => { args = a; return { status: 1, stdout: "", stderr: "", timedOut: false }; } });
    expect(args).toEqual(["api", `repos/${REPO}`]);
  });
});
