/* Criar, editar e fechar o terminal do canvas (nó `terminal`): o cliente das rotas de terminais, papéis e predefinições, o
 * modal (abas Detalhes e Aparência) e os fluxos que a página chama. As rotas são do servidor (`/api/argos/terminals*`,
 * `/api/argos/roles*`, `/api/argos/presets*`); aqui só se monta o corpo, se lê a resposta e se pede a confirmação do dono.
 * Script clássico carregado sob demanda pela página (lista fechada em pages/argos.tsx). Expõe window.ArgosTerminalCreate. */
(() => {
const { useState, useEffect, I, cn, Button, Input, Dialog, DialogHeader, DialogFooter, Segmented, Select } = HadesCore;
const NT = () => window.ArgosNodeTerminal;

/** Códigos de erro das rotas (contrato do servidor) mais os do cliente; quem consome ramifica por eles, nunca pelo texto. */
const TERMINAL_ERRORS = Object.freeze({
  invalid: 'invalid', notFound: 'not-found', confirmRequired: 'confirm-required', herdrFailed: 'herdr-failed', rateLimited: 'rate-limited',
  network: 'terminal_network', timeout: 'terminal_timeout', badResponse: 'terminal_bad_response',
});
const ERROR_TEXT = Object.freeze({
  [TERMINAL_ERRORS.invalid]: 'O painel recusou os dados.',
  [TERMINAL_ERRORS.notFound]: 'Predefinição, papel ou terminal não encontrado.',
  [TERMINAL_ERRORS.confirmRequired]: 'Pelo acesso remoto é preciso confirmar com o nome.',
  [TERMINAL_ERRORS.herdrFailed]: 'O herdr não conseguiu fazer isso.',
  [TERMINAL_ERRORS.network]: 'Sem resposta do painel.',
  [TERMINAL_ERRORS.timeout]: 'O painel demorou demais para responder.',
  [TERMINAL_ERRORS.badResponse]: 'O painel respondeu fora do contrato.',
});
const CODE_BY_STATUS = Object.freeze({ 400: TERMINAL_ERRORS.invalid, 404: TERMINAL_ERRORS.notFound, 403: TERMINAL_ERRORS.confirmRequired, 429: TERMINAL_ERRORS.rateLimited, 502: TERMINAL_ERRORS.herdrFailed });
const KNOWN_CODES = new Set(Object.values(TERMINAL_ERRORS));
// as leituras e o fechar: mais folga que as do canvas
const TIMEOUT_MS = 20_000;
// criar e trocar o papel esperam o shell e o agente subirem pelo herdr; acima do prazo do servidor (TERMINAL_REQUEST_TIMEOUT_S)
const START_TIMEOUT_MS = 130_000;
const URL = Object.freeze({
  presets: '/api/argos/presets', presetsDelete: '/api/argos/presets/delete',
  roles: '/api/argos/roles', rolesDelete: '/api/argos/roles/delete', rolesDiscover: '/api/argos/roles/discover', rolesImport: '/api/argos/roles/import',
  create: '/api/argos/terminals', close: '/api/argos/terminals/close', role: '/api/argos/terminals/role',
});
const COLOR_SWATCHES = Object.freeze(['#e5484d', '#f76b15', '#ffc53d', '#46a758', '#12a594', '#0090ff', '#8e4ec6', '#d6409f']);
// `rate-limited` (criar e fechar com teto de taxa) fica sem texto próprio: a mensagem do servidor diz quando tentar de novo
const errorText = (r) => ERROR_TEXT[r.code] || r.message || 'A ação falhou.';
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Cliente das rotas. `fetch` é o da página (leva o token); nunca rejeita: devolve `{ ok: true, value }` ou
 * `{ ok: false, code, message }`, com `code` de TERMINAL_ERRORS. Cada chamada tem prazo (`timeoutMs`).
 */
function createTerminalClient({ fetch, timeoutMs = TIMEOUT_MS, startTimeoutMs = START_TIMEOUT_MS }) {
  async function call(url, body, read, ms = timeoutMs) {
    let r;
    try {
      r = await fetch(url, body === undefined ? { cache: 'no-store', signal: AbortSignal.timeout(ms) }
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
    } catch (e) {
      const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      return { ok: false, code: timedOut ? TERMINAL_ERRORS.timeout : TERMINAL_ERRORS.network, message: '' };
    }
    const d = await r.json().catch(() => null);
    if (!r.ok) {
      const code = isObj(d) && KNOWN_CODES.has(d.code) ? d.code : CODE_BY_STATUS[r.status] || TERMINAL_ERRORS.badResponse;
      return { ok: false, code, message: isObj(d) && typeof d.error === 'string' ? d.error : '' };
    }
    const value = isObj(d) ? read(d) : undefined;
    return value === undefined ? { ok: false, code: TERMINAL_ERRORS.badResponse, message: '' } : { ok: true, value };
  }
  const listOf = (key) => (d) => (Array.isArray(d[key]) ? d[key].filter((x) => isObj(x) && typeof x.slug === 'string' && typeof x.name === 'string') : undefined);
  const one = (key) => (d) => (isObj(d[key]) && typeof d[key].slug === 'string' ? d[key] : undefined);
  const okay = (d) => (d.ok === true ? true : undefined);
  const herdrOf = (d) => NT().herdrRefOf(d.herdr) || undefined;
  return {
    presets: () => call(URL.presets, undefined, listOf('presets')),
    savePreset: (preset, slug) => call(URL.presets, slug ? { preset, slug } : { preset }, one('preset')),
    deletePreset: (slug) => call(URL.presetsDelete, { slug }, okay),
    roles: () => call(URL.roles, undefined, listOf('roles')),
    saveRole: (role, slug) => call(URL.roles, slug ? { role, slug } : { role }, one('role')),
    deleteRole: (slug, confirm) => call(URL.rolesDelete, { slug, confirm }, okay),
    discoverRoles: (cwd) => call(URL.rolesDiscover, { cwd }, (d) => (Array.isArray(d.found) ? d.found.filter((f) => isObj(f) && typeof f.path === 'string' && isObj(f.role)) : undefined)),
    importRoles: (paths) => call(URL.rolesImport, { paths }, (d) => (Array.isArray(d.imported) ? { imported: d.imported, skipped: Array.isArray(d.skipped) ? d.skipped : [] } : undefined)),
    create: (body) => call(URL.create, body, (d) => {
      const herdr = herdrOf(d);
      // `orchestrator` só quando o servidor confirmou que as instruções de gerente entraram no papel do processo
      return herdr && typeof d.agent === 'string' ? { herdr, agent: d.agent, model: d.model, effort: d.effort, role: d.role, ...(d.orchestrator === true && { orchestrator: true }) } : undefined;
    }, startTimeoutMs),
    close: (body) => call(URL.close, body, okay),
    setRole: (body) => call(URL.role, body, (d) => { const herdr = herdrOf(d); return herdr ? { herdr, ...(d.orchestrator === true && { orchestrator: true }) } : undefined; }, startTimeoutMs),
  };
}

/* ------------------------------------------------------------ formulário (regra pura) */
// '' = não escolhido: o campo não vai ao corpo nem ao nó e segue a predefinição ou o padrão global
// `orchestrator` é a caixa Orquestrador (D7): o único campo que não é texto
const EMPTY_FORM = Object.freeze({ preset: '', name: '', icon: '', color: '', theme: '', themeBg: '', themeFg: '', font: '', role: '', agent: '', model: '', effort: '', cwd: '', orchestrator: false });
const APPEARANCE_KEYS = Object.freeze(['icon', 'color', 'theme', 'themeBg', 'themeFg', 'font']);
const PRESET_KEYS = Object.freeze(['agent', 'model', 'effort', 'icon', 'color', 'theme', 'font', 'role']);

/** Formulário inicial: vazio, ou o `data` do nó (edição). */
function formOf(data) {
  const d = data ? NT().readTerminalData(data) : {};
  const out = { ...EMPTY_FORM };
  for (const k of Object.keys(EMPTY_FORM)) if (typeof d[k] === 'string') out[k] = d[k];
  out.orchestrator = d.orchestrator === true;
  return out;
}

/** Escolher a predefinição sugere os valores dela; o que o dono já tinha escolhido à mão (`touched`) fica. */
function applyPreset(form, preset, touched = new Set()) {
  const next = { ...form, preset: preset ? preset.slug : '' };
  for (const k of PRESET_KEYS) if (!touched.has(k)) next[k] = preset && typeof preset[k] === 'string' ? preset[k] : '';
  if (preset && !touched.has('name') && !form.name.trim()) next.name = preset.name;
  return next;
}

/** O que impede enviar o formulário, em texto para o dono; `null` se está bom. */
function formProblem(form) {
  const name = form.name.trim();
  if (!name) return 'Dê um nome ao terminal.';
  if (name.length > NT().TERMINAL_NAME_MAX) return `Nome com mais de ${NT().TERMINAL_NAME_MAX} caracteres.`;
  if (form.theme === 'custom' && (!form.themeBg || !form.themeFg)) return 'O tema personalizado precisa da cor de fundo e da cor do texto.';
  return null;
}

/** Corpo do POST /api/argos/terminals: só o escolhido (campo vazio segue a predefinição e, sem ela, o padrão global). */
function createBody(form) {
  const body = { name: form.name.trim() };
  for (const k of ['cwd', 'preset', 'agent', 'model', 'effort', 'role']) if (form[k].trim()) body[k] = form[k].trim();
  if (form.orchestrator === true) body.orchestrator = true;
  return body;
}

/** `data` do nó: aparência escolhida, o que o servidor confirmou (agente, modelo, esforço, papel) e o par do herdr. */
function nodeDataOf(form, created) {
  const raw = { name: form.name.trim(), preset: form.preset || undefined };
  for (const k of APPEARANCE_KEYS) if (form[k]) raw[k] = form[k];
  if (form.theme !== 'custom') { delete raw.themeBg; delete raw.themeFg; }
  for (const k of ['agent', 'model', 'effort', 'role']) if (typeof created[k] === 'string' && created[k]) raw[k] = created[k];
  raw.herdr = created.herdr;
  // a caixa vale só se o servidor confirmou (as instruções de gerente entraram no papel do processo)
  if (created.orchestrator === true) raw.orchestrator = true;
  const clean = NT().readTerminalData(raw);
  return Object.fromEntries(Object.entries(clean).filter(([, v]) => v !== null && v !== undefined));
}

/** `data` do nó editado: nome e aparência do formulário; agente, papel e o par do herdr ficam como estavam. */
function editedData(data, form) {
  const kept = NT().readTerminalData(data);
  const next = { ...kept, name: form.name.trim() };
  for (const k of APPEARANCE_KEYS) { if (form[k]) next[k] = form[k]; else delete next[k]; }
  if (next.theme !== 'custom') { delete next.themeBg; delete next.themeFg; }
  return Object.fromEntries(Object.entries(NT().readTerminalData(next)).filter(([, v]) => v !== null && v !== undefined));
}

/** Nome livre para o terminal novo: `base`, e com sufixo ` 2`, ` 3`… se já houver no canvas (o fechar confirma pelo nome). */
function nextTerminalName(base, taken) {
  const root = (typeof base === 'string' && base.trim() ? base.trim() : 'terminal').slice(0, NT().TERMINAL_NAME_MAX - 4);
  const names = new Set(taken);
  if (!names.has(root)) return root;
  let i = 2;
  while (names.has(`${root} ${i}`)) i += 1;
  return `${root} ${i}`;
}

/* ------------------------------------------------------------ fluxos (a página fornece as portas) */
/**
 * Manda a rota e, se o servidor pedir confirmação (acesso remoto), pergunta ao dono o nome e repete uma vez com `confirm`.
 * `askName(name)` → o texto digitado ou `null` (cancelou).
 */
async function withConfirm(send, name, askName) {
  const first = await send(undefined);
  if (first.ok || first.code !== TERMINAL_ERRORS.confirmRequired) return first;
  const typed = await askName(name);
  if (typed === null) return { ok: false, code: 'cancelled', message: '' };
  return send(typed);
}

/** Cria o terminal pelo servidor; devolve o `data` do nó novo ou o erro. */
async function createTerminal({ client, form, askName }) {
  const body = createBody(form);
  const r = await withConfirm((confirm) => client.create(confirm === undefined ? body : { ...body, confirm }), body.name, askName);
  return r.ok ? { ok: true, data: nodeDataOf(form, r.value) } : r;
}

/** Fecha o pane do nó. O diálogo com o nome (D2) vem antes, sempre: o nome digitado vai como `confirm`. */
async function closeTerminal({ client, data, askName }) {
  const d = NT().readTerminalData(data);
  const name = d.name || 'terminal';
  const typed = await askName(name);
  if (typed === null) return { ok: false, code: 'cancelled', message: '' };
  // nó sem pane (fechado fora, ou cópia): só sai do documento
  if (!d.herdr) return { ok: true, value: true };
  return client.close({ session: d.herdr.session, pane: d.herdr.pane, name, confirm: typed });
}

/**
 * Troca o papel (ou tira, com `role = null`) e, com `orchestrator` booleano, liga ou desliga a caixa Orquestrador: o servidor
 * reinicia só o processo e devolve o par novo do herdr. `orchestrator` ausente mantém o que o terminal tinha.
 */
async function changeRole({ client, data, role, orchestrator, askName }) {
  const d = NT().readTerminalData(data);
  if (!d.herdr) return { ok: false, code: TERMINAL_ERRORS.notFound, message: 'nó sem pane do herdr' };
  const name = d.name || 'terminal';
  const body = { session: d.herdr.session, pane: d.herdr.pane, name, role, ...(typeof orchestrator === 'boolean' ? { orchestrator } : {}) };
  const r = await withConfirm((confirm) => client.setRole(confirm === undefined ? body : { ...body, confirm }), name, askName);
  if (!r.ok) return r;
  const next = { ...d, herdr: r.value.herdr };
  if (role) next.role = role; else delete next.role;
  if (r.value.orchestrator === true) next.orchestrator = true; else delete next.orchestrator;
  return { ok: true, data: Object.fromEntries(Object.entries(next).filter(([, v]) => v !== null && v !== undefined)) };
}

/* ------------------------------------------------------------ modal */
const FIELD = 'h-8 w-full min-w-0 border border-border-strong bg-background px-2 t-body max-md:h-11';
const RING = 'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

function Row({ label, hint, children }) {
  return <label className="grid gap-1.5"><span className="t-label">{label}</span>{children}{hint ? <span className="t-meta text-muted-foreground">{hint}</span> : null}</label>;
}

function IconPicker({ value, onChange }) {
  return <div role="radiogroup" aria-label="Ícone" className="flex flex-wrap gap-1">
    {[['', 'Padrão'], ...NT().TERMINAL_ICONS.map((n) => [n, n])].map(([name, label]) => {
      const Icon = I[name || 'SquareTerminal'] || I.SquareTerminal;
      return <button key={name || 'default'} type="button" role="radio" aria-checked={value === name} aria-label={label} title={label} onClick={() => onChange(name)}
        className={cn('inline-flex size-8 items-center justify-center border', RING, value === name ? 'border-foreground bg-accent' : 'border-border text-muted-foreground hover:bg-accent/60')}>
        {name ? <Icon aria-hidden="true" className="size-4" /> : <span className="t-micro">—</span>}
      </button>;
    })}
  </div>;
}

function ColorPicker({ label, value, onChange, allowDefault = true }) {
  return <div role="radiogroup" aria-label={label} className="flex flex-wrap items-center gap-1">
    {allowDefault ? <button type="button" role="radio" aria-checked={value === ''} onClick={() => onChange('')}
      className={cn('h-7 border px-2 t-meta', RING, value === '' ? 'border-foreground bg-accent' : 'border-border text-muted-foreground')}>Padrão</button> : null}
    {COLOR_SWATCHES.map((c) => <button key={c} type="button" role="radio" aria-checked={value === c} aria-label={c} title={c} onClick={() => onChange(c)}
      className={cn('size-7 border-2', RING, value === c ? 'border-foreground' : 'border-transparent')} style={{ background: c }} />)}
    <input type="color" aria-label={`${label}: outra cor`} value={value || '#808080'} onChange={(e) => onChange(e.target.value)} className={cn('h-7 w-9 cursor-pointer border border-border bg-transparent', RING)} />
  </div>;
}

function Preview({ form }) {
  const style = NT().terminalThemeStyle({ ...form, name: form.name || 'terminal' }, typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches);
  const Icon = (form.icon && I[form.icon]) || I.SquareTerminal;
  return <div aria-label="Prévia" className="border" style={style}>
    <div className="flex items-center gap-1.5 border-b bg-card px-2 py-1 t-meta" style={{ boxShadow: form.color ? `inset 0 3px 0 ${form.color}` : undefined }}>
      <Icon aria-hidden="true" className="size-3.5" style={form.color ? { color: form.color } : undefined} />
      <span className="truncate font-medium">{form.name.trim() || 'terminal'}</span>
    </div>
    <pre className="m-0 bg-term px-2 py-1.5 text-term-foreground" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
      <span className="text-term-muted">$ </span>claude{'\n'}<span className="text-term-muted">› pronto para trabalhar</span>
    </pre>
  </div>;
}

/**
 * Modal de criar (`mode = 'create'`) e editar (`'edit'`). Detalhes: predefinição, nome, papel e (na criação) agente, modelo,
 * esforço e diretório. Aparência: ícone, cor de destaque, tema e fonte. `onSubmit(form)` → Promise de `{ ok, code?, message? }`;
 * o modal fica aberto e mostra o erro quando não deu.
 */
function TerminalDialog({ open, mode = 'create', tab: initialTab = 'details', initial, presets = [], roles = [], onSubmit, onSavePreset, onManageRoles, onClose }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [tab, setTab] = useState(initialTab);
  const [touched, setTouched] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (open) { setForm(initial ? { ...EMPTY_FORM, ...initial } : EMPTY_FORM); setTab(initialTab); setTouched(new Set()); setError(''); setBusy(false); } }, [open]);
  if (!open) return <Dialog open={false} onClose={onClose} label="Terminal" />;
  const set = (k) => (v) => { setForm((f) => ({ ...f, [k]: v })); setTouched((t) => new Set(t).add(k)); };
  const text = (k) => (e) => set(k)(e.target.value);
  const problem = formProblem(form);
  const create = mode === 'create';
  const pickPreset = (slug) => setForm((f) => applyPreset(f, presets.find((p) => p.slug === slug) || null, touched));
  const submit = async (e) => {
    e?.preventDefault();
    if (problem || busy) { setError(problem || ''); return; }
    setBusy(true);
    setError('');
    const r = await onSubmit(form);
    setBusy(false);
    if (r && !r.ok && r.code !== 'cancelled') setError(errorText(r));
  };
  const presetHint = (k) => { const p = presets.find((x) => x.slug === form.preset); return p && p[k] ? `Da predefinição: ${p[k]}` : 'Vazio segue o padrão global.'; };
  return <Dialog open onClose={onClose} label={create ? 'Novo terminal' : 'Editar o terminal'} className="sm:max-w-xl">
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader icon={I.SquareTerminal} title={create ? 'Novo terminal' : 'Editar o terminal'}
        description={create ? 'Sobe um agente pelo herdr no retângulo que você desenhou.' : 'Nome, aparência e a caixa Orquestrador; o papel muda pelo menu do nó.'} />
      <Segmented label="Aba" value={tab} onChange={setTab} items={[{ value: 'details', label: 'Detalhes' }, { value: 'appearance', label: 'Aparência' }]} />
      {tab === 'details' ? <div className="grid gap-3">
        {create ? <Row label="Predefinição" hint="Sugere agente, modelo, esforço, papel e aparência.">
          <Select size="sm" label="Predefinição" className="w-full min-w-0" value={form.preset} onChange={pickPreset}
            items={[{ value: '', label: 'Nenhuma' }, ...presets.map((p) => ({ value: p.slug, label: p.name }))]} />
        </Row> : null}
        <Row label="Nome"><Input autoFocus value={form.name} onInput={text('name')} maxLength={NT().TERMINAL_NAME_MAX} aria-label="Nome" /></Row>
        {create ? <Row label="Papel" hint="Instruções injetadas quando o agente inicia.">
          <div className="flex gap-2">
            <Select size="sm" label="Papel" className="w-full min-w-0" value={form.role} onChange={set('role')}
              items={[{ value: '', label: 'Sem papel' }, ...roles.map((r) => ({ value: r.slug, label: r.name }))]} />
            {onManageRoles ? <Button type="button" size="sm" variant="outline" onClick={onManageRoles}>Papéis…</Button> : null}
          </div>
        </Row> : null}
        {create ? <div className="grid gap-3 sm:grid-cols-3">
          <Row label="Agente" hint={presetHint('agent')}><Input value={form.agent} onInput={text('agent')} placeholder="claude" aria-label="Agente" /></Row>
          <Row label="Modelo" hint={presetHint('model')}><Input value={form.model} onInput={text('model')} aria-label="Modelo" /></Row>
          <Row label="Esforço" hint={presetHint('effort')}><Input value={form.effort} onInput={text('effort')} aria-label="Esforço" /></Row>
        </div> : null}
        {create ? <Row label="Diretório" hint="Vazio = o worktree do canvas aberto ou o clone do projeto."><Input value={form.cwd} onInput={text('cwd')} aria-label="Diretório" /></Row> : null}
        <label className="flex items-start gap-2">
          <input type="checkbox" checked={form.orchestrator === true} onChange={(e) => set('orchestrator')(e.target.checked)} className={cn('mt-0.5 size-4 shrink-0 accent-foreground', RING)} />
          <span className="grid gap-0.5">
            <span className="t-label">Orquestrador</span>
            <span className="t-meta text-muted-foreground">
              {create ? 'O agente recebe instruções de gerente: recruta, liga notas, reatribui e dispensa terminais pelo hades canvas.'
                : 'Mudar a caixa reinicia só o processo do agente; nome, posição e conexões ficam.'} Escreva @orquestrador no prompt para lembrá-lo.
            </span>
          </span>
        </label>
      </div> : <div className="grid gap-3">
        <Row label="Ícone"><IconPicker value={form.icon} onChange={set('icon')} /></Row>
        <Row label="Cor de destaque"><ColorPicker label="Cor de destaque" value={form.color} onChange={set('color')} /></Row>
        <Row label="Tema">
          <Segmented label="Tema" value={form.theme || 'default'} onChange={(v) => set('theme')(v === 'default' ? '' : v)}
            items={[{ value: 'default', label: 'Padrão' }, ...NT().TERMINAL_THEMES.map((t) => ({ value: t, label: NT().TERMINAL_THEME_LABELS[t] }))]} />
        </Row>
        {form.theme === 'custom' ? <div className="grid gap-3 sm:grid-cols-2">
          <Row label="Fundo"><ColorPicker label="Fundo" value={form.themeBg} onChange={set('themeBg')} allowDefault={false} /></Row>
          <Row label="Texto"><ColorPicker label="Texto" value={form.themeFg} onChange={set('themeFg')} allowDefault={false} /></Row>
        </div> : null}
        <Row label="Fonte" hint="A grade conta 0,6 em por célula: fonte que não cumpre isso desalinha.">
          <Select size="sm" label="Fonte" className="w-full min-w-0" value={form.font} onChange={set('font')}
            items={[{ value: '', label: 'Padrão' }, ...Object.keys(NT().TERMINAL_FONTS).map((f) => ({ value: f, label: NT().TERMINAL_FONT_LABELS[f] }))]} />
        </Row>
        <Preview form={form} />
      </div>}
      {error ? <p role="alert" className="t-body text-bad">{error}</p> : null}
      <DialogFooter>
        {create && onSavePreset ? <Button type="button" variant="ghost" disabled={!!problem || busy} onClick={() => onSavePreset(form)}>Salvar como predefinição</Button> : null}
        <Button type="button" variant="outline" onClick={onClose}>Cancelar</Button>
        <Button type="submit" disabled={!!problem || busy}>{busy ? 'Aguarde…' : create ? 'Criar terminal' : 'Salvar'}</Button>
      </DialogFooter>
    </form>
  </Dialog>;
}

/** Predefinição a partir do formulário (Salvar como predefinição): só os campos escolhidos. */
function presetOf(form) {
  const p = { name: form.name.trim(), agent: form.agent.trim() || 'claude' };
  for (const k of ['model', 'effort', 'icon', 'color', 'theme', 'font', 'role']) if (form[k]) p[k] = form[k];
  return p;
}

window.ArgosTerminalCreate = {
  TERMINAL_ERRORS, ERROR_TEXT, EMPTY_FORM, COLOR_SWATCHES, errorText,
  createTerminalClient, formOf, applyPreset, nextTerminalName, formProblem, createBody, nodeDataOf, editedData, presetOf,
  createTerminal, closeTerminal, changeRole, TerminalDialog, ColorPicker,
};
})();
