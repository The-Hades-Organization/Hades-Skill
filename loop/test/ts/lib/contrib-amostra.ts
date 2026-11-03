// Diff de exemplo dos testes de `hades contrib`: texto montado em partes onde o conteúdo é o que a guarda procura.
export const CAMINHO_DE_MAQUINA = ["/ho", "me/fulano/projetos/x"].join("");
export const EMAIL = ["fulano", "@", "empresa.com.br"].join("");
export const TOKEN_GH = ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");
export const SENHA = ["pass", "word = ", "'", "hunter2hunter2", "'"].join("");

/** Um arquivo novo no formato do `git diff`: cada linha de `linhas` vira linha adicionada. */
export function novo(caminho: string, linhas: string[]): string {
  return [`diff --git a/${caminho} b/${caminho}`, "new file mode 100644", "index 0000000..1111111", "--- /dev/null", `+++ b/${caminho}`,
    `@@ -0,0 +1,${linhas.length} @@`, ...linhas.map((l) => `+${l}`)].join("\n") + "\n";
}

/** Edição de um arquivo existente: contexto, uma linha tirada e uma posta, a partir da linha `desde`. */
export function edita(caminho: string, desde: number, tirada: string, posta: string): string {
  return [`diff --git a/${caminho} b/${caminho}`, "index 1111111..2222222 100644", `--- a/${caminho}`, `+++ b/${caminho}`,
    `@@ -${desde},3 +${desde},3 @@`, " antes", `-${tirada}`, `+${posta}`, " depois"].join("\n") + "\n";
}

export function renomeia(de: string, para: string): string {
  return [`diff --git a/${de} b/${para}`, "similarity index 100%", `rename from ${de}`, `rename to ${para}`].join("\n") + "\n";
}

export const TERMOS_VAZIOS = { names: [], vocab: [], domain: [], allow: [], slug: "" };
