// Checks da Porta em TypeScript: cada guarda (`hades cerberus-check porta/<guarda>`) roda no mesmo repositório e ambiente
// fechado e o veredito (uma linha JSON) e o código de saída têm de sair iguais ao gravado em loop/test/golden/legado/.
// `gh` e `devtunnel` são stubs no PATH.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { planSha } from "../../../src/commands/agent";
import { checksRig } from "./lib/checks-rig";
import { legado } from "./lib/legado";

const { T, PACKS, next, git, repo, same, resultado } = checksRig(legado(import.meta.path), "porta");

describe("remote-push", () => {
  test("HEAD destacado barra", () => {
    const d = repo();
    git(d, "checkout", "-q", "--detach");
    expect(resultado(same("remote-push", { dir: d }))).toBe("barra");
  });
  test("sem remote configurado avisa", () => expect(resultado(same("remote-push", { dir: repo() }))).toBe("aviso"));
  test("pushRemote no_push barra", () => {
    const d = repo();
    git(d, "config", "branch.feature.pushRemote", "no_push");
    expect(resultado(same("remote-push", { dir: d }))).toBe("barra");
  });
  test("remote com pushurl no_push barra", () => {
    const d = repo();
    git(d, "config", "branch.feature.remote", "origin");
    git(d, "remote", "set-url", "--push", "origin", "no_push");
    expect(resultado(same("remote-push", { dir: d }))).toBe("barra");
  });
  test("remote inexistente barra", () => {
    const d = repo();
    git(d, "config", "branch.feature.pushRemote", "fantasma");
    expect(resultado(same("remote-push", { dir: d }))).toBe("barra");
  });
  test("remote com url de push passa", () => {
    const d = repo();
    git(d, "config", "branch.feature.remote", "origin");
    expect(resultado(same("remote-push", { dir: d }))).toBe("ok");
  });
});

describe("upstream-push", () => {
  const withUpstream = (merge: string) => {
    const d = repo();
    git(d, "config", "branch.feature.remote", "origin");
    git(d, "config", "branch.feature.merge", `refs/heads/${merge}`);
    return d;
  };
  test("sem a PR do contexto avisa", () => expect(resultado(same("upstream-push", { dir: withUpstream("feature") }))).toBe("aviso"));
  test("upstream igual à branch da PR passa", () => expect(resultado(same("upstream-push", { dir: withUpstream("feature"), ctx: { head: "feature" } }))).toBe("ok"));
  test("upstream de outra branch barra", () => expect(resultado(same("upstream-push", { dir: withUpstream("outra"), ctx: { head: "feature" } }))).toBe("barra"));
  test("sem upstream e mesmo nome da PR passa", () => expect(resultado(same("upstream-push", { dir: repo(), ctx: { head: "feature" } }))).toBe("ok"));
  test("sem upstream e nome diferente barra", () => expect(resultado(same("upstream-push", { dir: repo(), ctx: { head: "x" } }))).toBe("barra"));
  test("headRefName lido pela PR do contexto", () => {
    const env = { STUB_HEAD: "feature" };
    expect(resultado(same("upstream-push", { dir: repo(), ctx: { pr: "7" }, env }))).toBe("ok");
    same("upstream-push", { dir: repo(), ctx: { pr: "7" } });
  });
  test("HEAD destacado barra", () => {
    const d = repo();
    git(d, "checkout", "-q", "--detach");
    expect(resultado(same("upstream-push", { dir: d, ctx: { head: "feature" } }))).toBe("barra");
  });
});

describe("branch-protegida", () => {
  const onto = (merge: string, origin?: string) => {
    const d = repo(origin);
    git(d, "config", "branch.feature.remote", "origin");
    git(d, "config", "branch.feature.merge", `refs/heads/${merge}`);
    return d;
  };
  test("nome de tronco barra", () => expect(resultado(same("branch-protegida", { dir: onto("main") }))).toBe("barra"));
  test("branch protegida no GitHub barra", () => expect(resultado(same("branch-protegida", { dir: onto("release"), env: { STUB_PROTEGIDA: "true" } }))).toBe("barra"));
  test("branch desprotegida passa", () => expect(resultado(same("branch-protegida", { dir: onto("feature") }))).toBe("ok"));
  test("API falha: avisa", () => expect(resultado(same("branch-protegida", { dir: onto("feature"), env: { STUB_PROTEGIDA: "erro" } }))).toBe("aviso"));
  test("origin sem owner/repo: avisa", () => expect(resultado(same("branch-protegida", { dir: onto("feature", "solto") }))).toBe("aviso"));
  test("destino vindo do contexto", () => { same("branch-protegida", { dir: repo(), ctx: { head: "develop" } }); });
  test("HEAD destacado sem contexto barra", () => {
    const d = repo();
    git(d, "checkout", "-q", "--detach");
    expect(resultado(same("branch-protegida", { dir: d }))).toBe("barra");
  });
});

describe("conta-gh", () => {
  function perfil(extra: Record<string, unknown>): string {
    const slug = `acme-${next()}`;
    mkdirSync(join(PACKS, slug), { recursive: true });
    writeFileSync(join(PACKS, slug, "profile.json"), JSON.stringify({ name: slug, identity: { repo: `acme/${slug}`, gh: extra } }));
    return repo(`git@github.com:acme/${slug}.git`);
  }
  test("sem perfil avisa", () => expect(resultado(same("conta-gh", { dir: repo() }))).toBe("aviso"));
  test("conta que empurra igual à do perfil passa", () => expect(resultado(same("conta-gh", { dir: perfil({ user: "Dev" }), env: { STUB_LOGIN: "dev" } }))).toBe("ok"));
  test("conta diferente barra", () => expect(resultado(same("conta-gh", { dir: perfil({ user: "dev" }), env: { STUB_LOGIN: "outro" } }))).toBe("barra"));
  test("gh sem resposta avisa", () => expect(resultado(same("conta-gh", { dir: perfil({ user: "dev" }) }))).toBe("aviso"));
  test("tokenEnv ausente barra", () => expect(resultado(same("conta-gh", { dir: perfil({ tokenEnv: "TOKEN_DO_TESTE" }) }))).toBe("barra"));
  test("tokenEnv presente passa", () => expect(resultado(same("conta-gh", { dir: perfil({ user: "dev", tokenEnv: "TOKEN_DO_TESTE" }), env: { TOKEN_DO_TESTE: "t", STUB_LOGIN: "dev" } }))).toBe("ok"));
});

describe("nome-dominio", () => {
  const withScript = (body: string) => {
    const d = repo();
    mkdirSync(join(d, "kit"));
    writeFileSync(join(d, "kit", "skill-release.sh"), `#!/usr/bin/env bash\n${body}\n`);
    return d;
  };
  test("fora do núcleo da skill passa", () => expect(resultado(same("nome-dominio", { dir: repo() }))).toBe("ok"));
  test("guarda limpa passa", () => expect(resultado(same("nome-dominio", { dir: withScript("echo limpo; exit 0") }))).toBe("ok"));
  test("guarda que acha termo barra", () => expect(resultado(same("nome-dominio", { dir: withScript("echo 'a.md:1: termo'; exit 1") }))).toBe("barra"));
  test("saída 1 sem texto barra", () => expect(resultado(same("nome-dominio", { dir: withScript("exit 1") }))).toBe("barra"));
  test("sem perfil instalado avisa", () => expect(resultado(same("nome-dominio", { dir: withScript("echo 'guarda de nome: nenhum perfil instalado'") }))).toBe("aviso"));
  test("guarda ok sem saída passa", () => expect(resultado(same("nome-dominio", { dir: withScript("exit 0") }))).toBe("ok"));
});

describe("plano-aprovado", () => {
  const plano = join(T, "plan.md");
  const registro = (body: unknown) => {
    const f = join(T, `plan-${next()}.json`);
    writeFileSync(f, typeof body === "string" ? body : JSON.stringify(body));
    return f;
  };
  writeFileSync(plano, "# Plano\n\n## Objetivo\nx\n\n## Estado atual\nv1\n");
  const sha = planSha("# Plano\n\n## Objetivo\nx\n\n## Estado atual\nv1\n");
  test("sem registro barra", () => expect(resultado(same("plano-aprovado", { dir: repo(), ctx: { plano: join(T, "nao-existe.json") } }))).toBe("barra"));
  test("registro íntegro passa", () => expect(resultado(same("plano-aprovado", { dir: repo(), ctx: { plano: registro({ path: plano, sha, approvedAt: "2026-01-01T00:00:00Z", by: { user: "dono", origem: "painel" } }) } }))).toBe("ok"));
  test("registro sem quem aprovou passa com detalhe", () => { same("plano-aprovado", { dir: repo(), ctx: { plano: registro({ path: plano, sha }) } }); });
  test("aprovador em texto", () => { same("plano-aprovado", { dir: repo(), ctx: { plano: registro({ path: plano, sha, by: "dono" }) } }); });
  test("só a seção Estado atual mudou: continua íntegro", () => {
    const p = join(T, "plan-estado.md");
    writeFileSync(p, "# Plano\n\n## Objetivo\nx\n\n## Estado atual (27/10)\nv2\n");
    expect(resultado(same("plano-aprovado", { dir: repo(), ctx: { plano: registro({ path: p, sha }) } }))).toBe("ok");
  });
  test("plano alterado depois da aprovação barra", () => {
    const p = join(T, "plan-mudou.md");
    writeFileSync(p, "# Plano\n\n## Objetivo\ny\n");
    expect(resultado(same("plano-aprovado", { dir: repo(), ctx: { plano: registro({ path: p, sha }) } }))).toBe("barra");
  });
  test("plano sumiu barra", () => expect(resultado(same("plano-aprovado", { dir: repo(), ctx: { plano: registro({ path: join(T, "sumiu.md"), sha }) } }))).toBe("barra"));
  // o texto do erro do parser de JSON é do Python/Bun: o resto do veredito é idêntico
  const semDetalheDoParser = (s: string) => s.replace(/(sem path\/sha: )[^"]*/, "$1<erro do parser>");
  test("registro ilegível barra", () => expect(resultado(same("plano-aprovado", { dir: repo(), ctx: { plano: registro("{não é json") } }, semDetalheDoParser))).toBe("barra"));
  test("registro sem sha barra", () => expect(resultado(same("plano-aprovado", { dir: repo(), ctx: { plano: registro({ path: plano }) } }))).toBe("barra"));
  test("sem contexto procura na raiz de trabalho do projeto", () => { same("plano-aprovado", { dir: repo() }); });
});

describe("segredo-diff", () => {
  // montado em partes: o arquivo do teste não casa com a varredura de segredos do release
  const tokenGh = `${"gh"}${"p_"}${"a1B2".repeat(9)}`;
  const chavePrivada = `-----BEGIN ${"RSA"} ${"PRIV"}ATE KEY-----`;
  const arquivo = (nome: string, texto: string) => {
    const f = join(T, `${next()}-${nome}`);
    writeFileSync(f, texto);
    return f;
  };
  test("arquivo com token barra", () => expect(resultado(same("segredo-diff", { dir: repo(), ctx: { texto: arquivo("c.txt", `olha ${tokenGh}\n`) } }))).toBe("barra"));
  test("arquivo limpo passa", () => expect(resultado(same("segredo-diff", { dir: repo(), ctx: { arquivo: arquivo("l.txt", "nada aqui\n") } }))).toBe("ok"));
  test("alvo inexistente barra", () => expect(resultado(same("segredo-diff", { dir: repo(), ctx: { arquivo: join(T, "nada") } }))).toBe("barra"));
  test("pasta é varrida e .git é ignorado", () => {
    const d = join(T, `pasta-${next()}`);
    mkdirSync(join(d, ".git"), { recursive: true });
    mkdirSync(join(d, "sub"));
    writeFileSync(join(d, ".git", "x"), `${chavePrivada}\n`);
    writeFileSync(join(d, "sub", "y.txt"), `${chavePrivada}\n`);
    expect(resultado(same("segredo-diff", { dir: repo(), ctx: { arquivo: d } }))).toBe("barra");
  });
  test("valor de exemplo não é segredo", () => expect(resultado(same("segredo-diff", { dir: repo(), ctx: { texto: arquivo("e.txt", `token = "${"x".repeat(20)}"\nurl=https://u:<senha>@h\n`) } }))).toBe("ok"));
  test("atribuição de segredo e credencial na URL", () => { same("segredo-diff", { dir: repo(), ctx: { texto: arquivo("a.txt", `api_key: "${"Zq9".repeat(8)}"\nhttps://dev:${"s3gredo"}@host.io/x\n`) } }); });
  test("sem upstream, tag nem base avisa", () => {
    const d = repo("");
    git(d, "branch", "-m", "solta");
    expect(resultado(same("segredo-diff", { dir: d }))).toBe("aviso");
  });
  test("diff do intervalo do contexto acha a linha adicionada", () => {
    const d = repo();
    const base = git(d, "rev-parse", "HEAD");
    writeFileSync(join(d, "b.txt"), `linha\n${tokenGh}\n`);
    git(d, "add", "-A");
    git(d, "commit", "-qm", "vaza");
    expect(resultado(same("segredo-diff", { dir: d, ctx: { range: `${base}..HEAD` } }))).toBe("barra");
  });
  test("diff limpo do intervalo passa", () => {
    const d = repo();
    const base = git(d, "rev-parse", "HEAD");
    writeFileSync(join(d, "b.txt"), "limpo\n");
    git(d, "add", "-A");
    git(d, "commit", "-qm", "ok");
    expect(resultado(same("segredo-diff", { dir: d, ctx: { range: `${base}..HEAD` } }))).toBe("ok");
  });
  test("intervalo inválido barra", () => expect(resultado(same("segredo-diff", { dir: repo(), ctx: { range: "nao..existe" } }))).toBe("barra"));
  test("sem upstream usa a última tag", () => {
    const d = repo();
    git(d, "tag", "v1");
    writeFileSync(join(d, "c.txt"), `${tokenGh}\n`);
    git(d, "add", "-A");
    git(d, "commit", "-qm", "depois da tag");
    expect(resultado(same("segredo-diff", { dir: d }))).toBe("barra");
  });
});

describe("tunel-acesso", () => {
  const d = repo();
  test("sem host barra", () => expect(resultado(same("tunel-acesso", { dir: d }))).toBe("barra"));
  test("lista vazia fecha", () => expect(resultado(same("tunel-acesso", { dir: d, ctx: { host: "a.devtunnels.ms" }, env: { HADES_CERBERUS_PORTA_TUNEL_HOSTS: "" } }))).toBe("barra"));
  test("host fora da lista barra", () => expect(resultado(same("tunel-acesso", { dir: d, ctx: { host: "evil.example.com", acesso: "autenticado" } }))).toBe("barra"));
  test("host na lista com acesso autenticado passa", () => expect(resultado(same("tunel-acesso", { dir: d, ctx: { host: "https://a.devtunnels.ms/x", acesso: "autenticado" } }))).toBe("ok"));
  test("acesso anônimo barra", () => expect(resultado(same("tunel-acesso", { dir: d, ctx: { host: "a.devtunnels.ms", acesso: "anonimo" } }))).toBe("barra"));
  test("acesso não declarado barra", () => expect(resultado(same("tunel-acesso", { dir: d, ctx: { host: "a.devtunnels.ms" } }))).toBe("barra"));
  test("acesso lido do túnel: anônimo barra, autenticado passa", () => {
    expect(resultado(same("tunel-acesso", { dir: d, ctx: { host: "a.devtunnels.ms", tunel: "t1" } }))).toBe("barra");
    expect(resultado(same("tunel-acesso", { dir: d, ctx: { host: "a.devtunnels.ms", tunel: "t1" }, env: { STUB_TUNEL: "Tenant  Connect" } }))).toBe("ok");
  });
  test("devtunnel falha: avisa", () => expect(resultado(same("tunel-acesso", { dir: d, ctx: { host: "a.devtunnels.ms", tunel: "t1" }, env: { STUB_TUNEL: "erro" } }))).toBe("aviso"));
  test("curinga com ? e [seq]", () => {
    same("tunel-acesso", { dir: d, ctx: { host: "a1.devtunnels.ms", acesso: "autenticado" }, env: { HADES_CERBERUS_PORTA_TUNEL_HOSTS: "a?.devtunnels.ms" } });
    same("tunel-acesso", { dir: d, ctx: { host: "b.x.io", acesso: "autenticado" }, env: { HADES_CERBERUS_PORTA_TUNEL_HOSTS: "[ab].x.io" } });
    same("tunel-acesso", { dir: d, ctx: { host: "c.x.io", acesso: "autenticado" }, env: { HADES_CERBERUS_PORTA_TUNEL_HOSTS: "[!ab].x.io" } });
  });
});
