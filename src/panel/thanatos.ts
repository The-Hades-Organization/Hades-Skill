// Rotas do Thanatos (reference/thanatos.md): GET /api/thanatos (lista) e GET /api/thanatos/:id (post-mortem: o `.md` e o
// documento). Só leitura, sobre <work>/<owner>__<repo>/postmortems/ do projeto do painel; a autenticação é a das outras
// rotas GET. O id só chega ao disco depois de passar pelo ID_PATTERN, que não admite barra nem ponto inicial.
import { dirname, join } from "node:path";
import { ID_PATTERN, listPostmortems, readMarkdown, readPostmortem } from "../lib/thanatos.ts";
import type { PanelEnv } from "./env.ts";
import { BadRequest } from "./http.ts";

type Dict = Record<string, unknown>;

export interface ThanatosRoutes {
  list(): Dict;
  /** undefined: não existe (a rota responde 404) */
  one(id: string): Dict | undefined;
}

export function createThanatosRoutes(env: PanelEnv): ThanatosRoutes {
  const dir = env.locks ? join(dirname(env.locks), "postmortems") : undefined;
  return {
    list: () => ({ items: dir ? listPostmortems(dir) : [] }),
    one(id) {
      if (!ID_PATTERN.test(id)) throw new BadRequest(`id inválido: ${id}`);
      if (dir === undefined) return undefined;
      const postmortem = readPostmortem(dir, id);
      const markdown = readMarkdown(dir, id);
      return postmortem === undefined || markdown === undefined ? undefined : { id, markdown, postmortem };
    },
  };
}
