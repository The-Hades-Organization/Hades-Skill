/** SHA curto do HEAD com dígito e letra: só de dígitos a auditoria não o lê como commit e o veredito sai do gravado. */
export function shaCitavel(wt: string, git: (dir: string, ...args: string[]) => string): string {
  for (;;) {
    const sha = git(wt, "rev-parse", "--short", "HEAD");
    if (/\d/.test(sha) && /[a-f]/.test(sha)) return sha;
    git(wt, "commit", "-q", "--allow-empty", "-m", "outro");
  }
}
