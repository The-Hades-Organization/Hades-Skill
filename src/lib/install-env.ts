// env.sh da instância: render do modelo (kit/env.template.sh, que fica em bash porque o kit, os pacotes e as units o
// fazem `source`) e os acréscimos que mantêm um env.sh antigo em dia. O env.sh existente nunca é reescrito.

export interface EnvValues {
  wt: string;
  data: string;
  gateLock: string;
  locks: string;
  nodeBin: string;
  id: string;
}

/** Substitui os marcadores do modelo pelo valor literal (caminho com `#`, `&` ou `\` não tem significado aqui). */
export function renderEnvSh(template: string, values: EnvValues): string {
  const byMarker: Record<string, string> = {
    HADES_WT: values.wt,
    HADES_DATA: values.data,
    GATE_LOCK: values.gateLock,
    LOCKS: values.locks,
    NODE_BIN: values.nodeBin,
    HADES_ID: values.id,
  };
  return template.replace(/__(HADES_WT|HADES_DATA|GATE_LOCK|LOCKS|NODE_BIN|HADES_ID)__/g, (_all, marker: string) => byMarker[marker] as string);
}

const CONFIG_SOURCE_LINE = /^\[\[ -f \$D\/config\.sh \]\]/;
const LEGACY_ID_LINE = 'HADES_ID=""   # acrescentado pelo install.sh (env.sh anterior à 4.7.0): a instância original';

/** Acrescenta ao env.sh o que ele ainda não tem (config.sh, HADES_ID, NODE_BIN); idempotente. */
export function upgradeEnvSh(text: string, nodeBin: string): string {
  let result = text;
  if (!result.includes("config.sh")) {
    result += '\n# acrescentado pelo install.sh: configurações do painel\n[[ -f $D/config.sh ]] && source "$D/config.sh"\n';
  }
  if (!/^HADES_ID=/m.test(result)) {
    const lines = result.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    const at = lines.findIndex((line) => CONFIG_SOURCE_LINE.test(line));
    if (at >= 0) lines.splice(at, 0, LEGACY_ID_LINE);
    result = `${lines.join("\n")}\n`;
  }
  if (!/^NODE_BIN=/m.test(result)) {
    result += `\n# acrescentado pelo install.sh (env.sh anterior à 1.4.0)\nNODE_BIN="${nodeBin}"\nexport PATH="$(dirname "$NODE_BIN"):$PATH"\n`;
  }
  if (!/^export RTK_RECALL_DB=/m.test(result)) {
    result += '\n# acrescentado pelo install.sh: onde o rtk guarda a saída inteira que um filtro cortou\nexport RTK_RECALL_DB="$D/rtk/recall.db" RTK_TEE_DIR="$D/rtk/tee"\n';
  }
  return result;
}
