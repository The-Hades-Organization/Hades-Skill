/* Tela de papéis dos terminais do canvas: lista, criar e editar (nome, cor, instruções, agente, modelo, esforço), descobrir
 * `role.json` num diretório com prévia e importação em lote, apagar com confirmação pelo slug; aba Predefinições com apagar.
 * As rotas são do servidor (cliente em terminal-create.tsx); aqui fica o formulário e a seleção. Script clássico carregado
 * sob demanda pela página (lista fechada em pages/argos.tsx). Expõe window.ArgosTerminalRoles. */
(() => {
const { useState, useEffect, I, cn, Button, Input, Dialog, DialogHeader, DialogFooter, Segmented, Checkbox } = HadesCore;
const TC = () => window.ArgosTerminalCreate;

const ROLE_NAME_MAX = 60;
// as instruções vão ao `--append-system-prompt`: teto do lado da tela para não mandar um texto que o servidor recusa
const ROLE_INSTRUCTIONS_MAX = 20_000;
const PREVIEW_CHARS = 280;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const EMPTY_ROLE = Object.freeze({ name: '', color: '', instructions: '', agent: '', model: '', effort: '' });
const OPTIONAL_KEYS = Object.freeze(['agent', 'model', 'effort']);

/** Formulário de um papel existente (ou vazio). */
function roleFormOf(entry) {
  const out = { ...EMPTY_ROLE };
  if (entry) for (const k of Object.keys(EMPTY_ROLE)) if (typeof entry[k] === 'string') out[k] = entry[k];
  return out;
}

/** O que impede gravar o papel, em texto para o dono; `null` se está bom. */
function roleFormProblem(form) {
  const name = form.name.trim();
  if (!name) return 'Dê um nome ao papel.';
  if (name.length > ROLE_NAME_MAX) return `Nome com mais de ${ROLE_NAME_MAX} caracteres.`;
  if (!HEX_COLOR.test(form.color)) return 'Escolha a cor do badge.';
  if (!form.instructions.trim()) return 'Escreva as instruções do papel.';
  if (form.instructions.length > ROLE_INSTRUCTIONS_MAX) return `Instruções com mais de ${ROLE_INSTRUCTIONS_MAX} caracteres.`;
  return null;
}

/** Corpo `role` da rota: obrigatórios aparados e os opcionais só quando escolhidos. */
function roleBodyOf(form) {
  const role = { name: form.name.trim(), color: form.color, instructions: form.instructions.trim() };
  for (const k of OPTIONAL_KEYS) if (form[k].trim()) role[k] = form[k].trim();
  return role;
}

/** Seleção inicial da descoberta: os achados que ainda não existem aqui (importar por cima é escolha do dono). */
const initialPicks = (found) => new Set(found.filter((f) => !f.exists).map((f) => f.path));

/** Começo das instruções para a prévia, sem quebrar no meio de uma palavra longa demais. */
function previewOf(text) {
  const t = typeof text === 'string' ? text.trim() : '';
  return t.length <= PREVIEW_CHARS ? t : `${t.slice(0, PREVIEW_CHARS).trimEnd()}…`;
}

function Swatch({ color }) {
  return <span aria-hidden="true" className="inline-block size-3 shrink-0 border border-border-strong" style={HEX_COLOR.test(color || '') ? { background: color } : undefined} />;
}

function Field({ label, hint, children }) {
  return <label className="grid gap-1.5"><span className="t-label">{label}</span>{children}{hint ? <span className="t-meta text-muted-foreground">{hint}</span> : null}</label>;
}

function RoleEditor({ initial, busy, onSave, onCancel }) {
  const [form, setForm] = useState(() => roleFormOf(initial));
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const text = (k) => (e) => set(k)(e.target.value);
  const problem = roleFormProblem(form);
  const ColorPicker = TC().ColorPicker;
  return <form className="grid gap-3 border p-3" onSubmit={(e) => { e.preventDefault(); if (!problem && !busy) onSave(form); }}>
    <Field label="Nome"><Input autoFocus value={form.name} onInput={text('name')} maxLength={ROLE_NAME_MAX} aria-label="Nome do papel" /></Field>
    <Field label="Cor do badge"><ColorPicker label="Cor do badge" value={form.color} onChange={set('color')} allowDefault={false} /></Field>
    <Field label="Instruções" hint="Injetadas quando o agente inicia. Ficam só no arquivo do papel: não vão a log nem a aviso.">
      <textarea value={form.instructions} onInput={text('instructions')} rows={8} maxLength={ROLE_INSTRUCTIONS_MAX} aria-label="Instruções"
        className="min-h-32 w-full resize-y border border-border-strong bg-background p-2 font-mono t-body outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" />
    </Field>
    <div className="grid gap-3 sm:grid-cols-3">
      <Field label="Agente" hint="Vazio segue a predefinição."><Input value={form.agent} onInput={text('agent')} aria-label="Agente do papel" /></Field>
      <Field label="Modelo"><Input value={form.model} onInput={text('model')} aria-label="Modelo do papel" /></Field>
      <Field label="Esforço"><Input value={form.effort} onInput={text('effort')} aria-label="Esforço do papel" /></Field>
    </div>
    {problem ? <p className="t-meta text-muted-foreground">{problem}</p> : null}
    <div className="flex justify-end gap-2">
      <Button type="button" size="sm" variant="outline" onClick={onCancel}>Cancelar</Button>
      <Button type="submit" size="sm" disabled={!!problem || busy}>{busy ? 'Aguarde…' : 'Gravar papel'}</Button>
    </div>
  </form>;
}

function Discover({ client, defaultCwd, onImported }) {
  const [cwd, setCwd] = useState(defaultCwd || '');
  const [found, setFound] = useState(null);
  const [picks, setPicks] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const search = async (e) => {
    e.preventDefault();
    if (!cwd.trim() || busy) return;
    setBusy(true); setMsg('');
    const r = await client.discoverRoles(cwd.trim());
    setBusy(false);
    if (!r.ok) { setFound(null); setMsg(TC().errorText(r)); return; }
    setFound(r.value);
    setPicks(initialPicks(r.value));
    if (!r.value.length) setMsg('Nenhum role.json até 3 níveis abaixo desse diretório.');
  };
  const toggle = (path) => (on) => setPicks((cur) => { const next = new Set(cur); if (on) next.add(path); else next.delete(path); return next; });
  const importPicked = async () => {
    setBusy(true); setMsg('');
    const r = await client.importRoles([...picks]);
    setBusy(false);
    if (!r.ok) { setMsg(TC().errorText(r)); return; }
    setFound(null);
    setMsg(`${r.value.imported.length} importado(s)${r.value.skipped.length ? `, ${r.value.skipped.length} pulado(s): ${r.value.skipped.map((s) => s.reason).join('; ')}` : ''}.`);
    onImported();
  };
  return <div className="grid gap-3">
    <form className="flex items-end gap-2" onSubmit={search}>
      <Field label="Diretório de trabalho" hint="Procura role.json até 3 níveis abaixo; só dentro do worktree ou do clone.">
        <Input value={cwd} onInput={(e) => setCwd(e.target.value)} aria-label="Diretório de trabalho" />
      </Field>
      <Button type="submit" size="sm" variant="outline" icon={I.FolderSearch} disabled={!cwd.trim() || busy} className="mb-6">Descobrir</Button>
    </form>
    {found && found.length ? <ul className="grid max-h-72 gap-2 overflow-y-auto scrollbar-thin" aria-label="Papéis encontrados">
      {found.map((f) => <li key={f.path} className="grid grid-cols-[auto_minmax(0,1fr)] gap-2 border p-2">
        <Checkbox checked={picks.has(f.path)} onChange={toggle(f.path)} label={`Importar ${f.role.name || f.slug}`} />
        <div className="grid gap-1">
          <span className="flex items-center gap-1.5 t-body font-medium"><Swatch color={f.role.color} />{f.role.name || f.slug}
            {f.exists ? <span className="border px-1 t-micro text-muted-foreground">já existe: importar substitui</span> : null}</span>
          <span className="truncate font-mono t-micro text-muted-foreground" title={f.path}>{f.path}</span>
          <p className="whitespace-pre-line t-meta text-muted-foreground">{previewOf(f.role.instructions)}</p>
        </div>
      </li>)}
    </ul> : null}
    {found && found.length ? <div className="flex justify-end"><Button size="sm" disabled={!picks.size || busy} onClick={importPicked}>Importar {picks.size || ''}</Button></div> : null}
    {msg ? <p role="status" className="t-meta text-muted-foreground">{msg}</p> : null}
  </div>;
}

/**
 * Tela de papéis. `client` = createTerminalClient; `askSlug(slug)` → o texto digitado ou `null` (o servidor exige
 * `confirm === slug` para apagar); `confirm({ title, text })` → booleano; `onChanged(roles)` avisa a página (badges).
 */
function RolesDialog({ open, client, defaultCwd, askSlug, confirm, onChanged, onClose }) {
  const [tab, setTab] = useState('roles');
  const [roles, setRoles] = useState(null);
  const [presets, setPresets] = useState(null);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const reload = async () => {
    const [r, p] = await Promise.all([client.roles(), client.presets()]);
    if (r.ok) { setRoles(r.value); onChanged(r.value); } else setError(TC().errorText(r));
    if (p.ok) setPresets(p.value); else setError(TC().errorText(p));
  };
  useEffect(() => {
    if (!open) return;
    setTab('roles'); setEditing(null); setError(''); setRoles(null); setPresets(null);
    reload().catch((e) => { console.error('argos: leitura dos papéis falhou', e && e.name); setError('A leitura falhou.'); });
  }, [open]);
  if (!open) return <Dialog open={false} onClose={onClose} label="Papéis" />;
  const run = async (task) => {
    setBusy(true); setError('');
    try {
      const r = await task();
      if (r && !r.ok && r.code !== 'cancelled') setError(TC().errorText(r));
      else if (r && r.ok) await reload();
      return r;
    } finally { setBusy(false); }
  };
  const save = (form) => run(async () => {
    const r = await client.saveRole(roleBodyOf(form), editing && editing.slug ? editing.slug : undefined);
    if (r.ok) setEditing(null);
    return r;
  });
  const remove = (entry) => run(async () => {
    const typed = await askSlug(entry.slug);
    if (typed === null) return { ok: false, code: 'cancelled' };
    return client.deleteRole(entry.slug, typed);
  });
  const removePreset = (entry) => run(async () => {
    if (!(await confirm({ title: 'Apagar a predefinição?', text: `"${entry.name}" sai dos botões de início rápido. Terminais já criados não mudam.` }))) return { ok: false, code: 'cancelled' };
    return client.deletePreset(entry.slug);
  });
  return <Dialog open onClose={onClose} label="Papéis dos terminais" className="sm:max-w-2xl">
    <div className="grid gap-4">
      <DialogHeader icon={I.IdCard} title="Papéis dos terminais" description="Instruções injetadas quando o agente inicia. Cada papel é um role.json portátil." />
      <Segmented label="Aba" value={tab} onChange={(v) => { setTab(v); setEditing(null); }}
        items={[{ value: 'roles', label: 'Papéis' }, { value: 'discover', label: 'Descobrir' }, { value: 'presets', label: 'Predefinições' }]} />
      {tab === 'roles' ? <div className="grid gap-2">
        {editing ? <RoleEditor key={editing.slug || 'new'} initial={editing.slug ? editing : null} busy={busy} onSave={save} onCancel={() => setEditing(null)} />
          : <Button size="sm" variant="outline" icon={I.Plus} className="justify-self-start" onClick={() => setEditing({})}>Novo papel</Button>}
        {roles === null ? <p className="t-meta text-muted-foreground">Lendo…</p> : !roles.length ? <p className="t-meta text-muted-foreground">Nenhum papel ainda.</p>
          : <ul className="grid max-h-80 gap-1 overflow-y-auto scrollbar-thin" aria-label="Papéis">
            {roles.map((r) => <li key={r.slug} className="flex items-center gap-2 border px-2 py-1.5">
              <Swatch color={r.color} />
              <span className="min-w-0 flex-1 truncate t-body">{r.name}<span className="ml-2 font-mono t-micro text-muted-foreground">{r.slug}</span></span>
              {r.agent ? <span className="shrink-0 t-micro text-muted-foreground">{[r.agent, r.model, r.effort].filter(Boolean).join(' · ')}</span> : null}
              <Button size="icon-sm" variant="ghost" icon={I.Pencil} aria-label={`Editar ${r.name}`} title="Editar" disabled={busy} onClick={() => setEditing(r)} />
              <Button size="icon-sm" variant="ghost" icon={I.Trash2} aria-label={`Apagar ${r.name}`} title="Apagar (pede o slug)" disabled={busy} onClick={() => remove(r)} />
            </li>)}
          </ul>}
      </div> : tab === 'discover' ? <Discover client={client} defaultCwd={defaultCwd} onImported={() => { setTab('roles'); reload().catch((e) => { console.error('argos: leitura dos papéis falhou', e && e.name); setError('A leitura falhou.'); }); }} />
        : <div className="grid gap-2">
          {presets === null ? <p className="t-meta text-muted-foreground">Lendo…</p> : !presets.length
            ? <p className="t-meta text-muted-foreground">Nenhuma predefinição. Crie pelo modal do terminal, em "Salvar como predefinição".</p>
            : <ul className="grid max-h-80 gap-1 overflow-y-auto scrollbar-thin" aria-label="Predefinições">
              {presets.map((p) => <li key={p.slug} className="flex items-center gap-2 border px-2 py-1.5">
                <Swatch color={p.color} />
                <span className="min-w-0 flex-1 truncate t-body">{p.name}</span>
                <span className="shrink-0 t-micro text-muted-foreground">{[p.agent, p.model, p.effort, p.role ? `papel ${p.role}` : null].filter(Boolean).join(' · ')}</span>
                <Button size="icon-sm" variant="ghost" icon={I.Trash2} aria-label={`Apagar ${p.name}`} title="Apagar" disabled={busy} onClick={() => removePreset(p)} />
              </li>)}
            </ul>}
        </div>}
      {error ? <p role="alert" className="t-body text-bad">{error}</p> : null}
      <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Fechar</Button></DialogFooter>
    </div>
  </Dialog>;
}

window.ArgosTerminalRoles = { ROLE_NAME_MAX, ROLE_INSTRUCTIONS_MAX, EMPTY_ROLE, roleFormOf, roleFormProblem, roleBodyOf, initialPicks, previewOf, RolesDialog };
})();
