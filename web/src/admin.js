// Tables view: a plain admin screen over the same atlas data. Hot-swaps with the 3D view (G).
import { esc, short, ago, KIND } from './hud.js'
import { buildInbox, loadMarks, status } from './inbox.js'

const STL = { open: 'Open', worse: 'Got worse', done: 'Done', snooze: 'Snoozed' }
const badge = (cls, txt) => `<span class="ab ${cls}">${esc(txt)}</span>`
const kindB = (k) => badge('k-' + k, KIND[k]?.[0] || k)
const stB = (s) => badge('s-' + s, STL[s] || s)
const sevB = (s) => badge('v-' + s, s)
const gradeB = (g) => `<span class="ag g-${g}">${g}</span>`
const pct = (x) => `${Math.round((x ?? 0) * 100)}%`
const btn = (attrs, label, cls = 'alink') => `<button class="${cls}" ${attrs}>${label}</button>`
const view = (type, id, label = 'View ↗') => btn(`data-open="${type}" data-id="${esc(id)}"`, label)
const NAV = [
  ['overview', 'Overview'], ['findings', 'Findings'], ['contexts', 'Bounded contexts'], ['modules', 'Modules'],
  ['seams', 'Contract seams'], ['ports', 'Interfaces'], ['flows', 'Use cases'], ['history', 'Commits'],
]

export function createAdmin(root, api) {
  let A = null
  // the Interfaces / Use cases views are named by the profile (e.g. Clankernative: SDK ports, Operations)
  const navLabel = (k, l) => (k === 'ports' ? A?.views?.interfaces?.label : k === 'flows' ? A?.views?.use_cases?.label : null) || l
  let page = 'overview'
  const T = {}
  const cache = {}
  let focusQ = null
  const st = (k) => (T[k] ||= { sort: null, dir: 1, q: '', f: {}, page: 0, sel: new Set(), open: null })
  const label = (k) => A.contexts.find((c) => c.key === k)?.label || k

  // generic table: cols {key,label,html,text,sort,num}, opt {id,filters,tools,select,expand,per,bare,empty}
  function table(key, rows, cols, opt = {}) {
    const s = st(key)
    const q = s.q.trim().toLowerCase()
    const filters = opt.filters || []
    let list = rows.filter((r) => {
      for (const f of filters) if (s.f[f.key] && String(f.get(r)) !== s.f[f.key]) return false
      return !q || cols.some((c) => c.text && String(c.text(r)).toLowerCase().includes(q))
    })
    const sc = cols.find((c) => c.key === s.sort)
    if (sc?.sort) list = [...list].sort((a, b) => { const x = sc.sort(a), y = sc.sort(b); return (x < y ? -1 : x > y ? 1 : 0) * s.dir })
    cache[key] = { rows: list, cols, opt }
    const per = opt.per || 100
    const pages = Math.max(1, Math.ceil(list.length / per))
    if (s.page >= pages) s.page = pages - 1
    const shown = opt.bare ? list : list.slice(s.page * per, (s.page + 1) * per)
    const id = (r) => String(opt.id(r))
    let h = ''
    if (!opt.bare) {
      h += `<div class="atool"><input class="aq" data-q="${key}" placeholder="Search…" value="${esc(s.q)}">`
      for (const f of filters) {
        const vals = [...new Set(rows.map((r) => String(f.get(r))))].sort()
        h += `<select data-f="${key}|${f.key}"><option value="">${esc(f.label)}: all</option>${vals.map((v) => `<option ${s.f[f.key] === v ? 'selected' : ''} value="${esc(v)}">${esc(v)}</option>`).join('')}</select>`
      }
      h += '<span class="asp"></span>'
      for (const t of opt.tools || []) h += btn(`data-tool="${key}|${t.id}"`, esc(typeof t.label === 'function' ? t.label(s) : t.label), 'abtn')
      h += btn(`data-csv="${key}"`, 'Export CSV', 'abtn')
      h += `<span class="acount">${list.length.toLocaleString()} of ${rows.length.toLocaleString()}</span></div>`
    }
    h += '<div class="awrap"><table class="at"><thead><tr>'
    if (opt.select) h += `<th class="ck"><input type="checkbox" data-selall="${key}" ${shown.length && shown.every((r) => s.sel.has(id(r))) ? 'checked' : ''}></th>`
    for (const c of cols) {
      const on = s.sort === c.key
      h += `<th class="${c.num ? 'n' : ''} ${c.sort ? 'srt' : ''}" ${c.sort ? `data-sort="${key}|${c.key}"` : ''}>${esc(c.label)}${on ? (s.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`
    }
    h += '</tr></thead><tbody>'
    const ncol = cols.length + (opt.select ? 1 : 0)
    for (const r of shown) {
      const rid = id(r)
      const exp = opt.expand && s.open === rid
      h += `<tr class="${opt.expand ? 'exp' : ''} ${exp ? 'on' : ''}" ${opt.expand ? `data-row="${key}|${esc(rid)}"` : ''}>`
      if (opt.select) h += `<td class="ck"><input type="checkbox" data-sel="${key}|${esc(rid)}" ${s.sel.has(rid) ? 'checked' : ''}></td>`
      for (const c of cols) h += `<td class="${c.num ? 'n' : ''}">${c.html(r)}</td>`
      h += '</tr>'
      if (exp) h += `<tr class="aexp"><td colspan="${ncol}">${opt.expand(r)}</td></tr>`
    }
    if (!shown.length) h += `<tr><td colspan="${ncol}" class="aempty">${esc(opt.empty || 'Nothing matches.')}</td></tr>`
    h += '</tbody></table></div>'
    if (!opt.bare && pages > 1) {
      h += `<div class="apager">${btn(`data-pg="${key}|${s.page - 1}" ${s.page ? '' : 'disabled'}`, '‹ Prev', 'abtn')}<span>Page ${s.page + 1} of ${pages}</span>${btn(`data-pg="${key}|${s.page + 1}" ${s.page < pages - 1 ? '' : 'disabled'}`, 'Next ›', 'abtn')}</div>`
    }
    return h
  }

  const card = (lbl, val, sub = '', cls = '') => `<div class="acard ${cls}"><span>${esc(lbl)}</span><b>${val}</b>${sub ? `<small>${sub}</small>` : ''}</div>`
  const head = (title, sub) => `<div class="ah2"><h2>${esc(title)}</h2>${sub ? `<p>${sub}</p>` : ''}</div>`

  function findRows() {
    const marks = loadMarks(A), owner = new Map()
    for (const it of buildInbox(A)) for (const i of it.findings) owner.set(i, [it, status(it, marks)])
    return A.violations.map((v, i) => {
      const [it, s] = owner.get(i) || [null, 'open']
      return { i, v, it, st: s, kind: it?.kind || 'improve', ctx: label(v.fromCtx) }
    })
  }

  const P = {}
  P.overview = () => {
    const s = A.score, items = buildInbox(A), marks = loadMarks(A)
    const open = items.filter((it) => ['open', 'worse'].includes(status(it, marks)))
    const n = (k) => open.filter((i) => i.kind === k).length
    const seams = A.seams || []
    const sync = seams.filter((x) => !x.unhandled.length && !x.dead.length).length
    let h = head('Overview', `${esc(A.project.title)} · ${esc(A.project.sha || 'working tree')}`)
    h += '<div class="acards">' +
      card(s.label ? s.label.toLowerCase().replace(/^./, (c) => c.toUpperCase()) : 'Integrity', `${s.withheld ? gradeB('?') : gradeB(s.grade)} ${s.total}`, s.withheld ? '/100 · not enough evidence' : '/100') +
      card('Worst context', s.worst ? `${gradeB(s.worst.grade)} ${esc(s.worst.label)}` : '—', s.worst ? `score ${s.worst.score}` : '') +
      card('To fix', n('fix'), 'breaks the architecture', n('fix') ? 'bad' : '') +
      card('To improve', n('improve'), 'design drift') +
      card('To check', n('check'), 'maybe, or a blind spot') +
      card('Modules', A.modules.length.toLocaleString(), `${s.edges.toLocaleString()} dependencies`) +
      card('Confidence', pct(s.confidence ?? 1), `${s.unknown?.dropped ?? 0} links dropped`) +
      card('Contract seams', `${sync}/${seams.length}`, 'in sync') + '</div>'
    h += '<div class="asec">Inbox</div>' + table('ov-inbox', items.map((it) => ({ it, st: status(it, marks) })), [
      { key: 'kind', label: 'Kind', html: (r) => kindB(r.it.kind), sort: (r) => ({ fix: 0, improve: 1, check: 2 })[r.it.kind] },
      { key: 'title', label: 'Item', html: (r) => `<b>${esc(r.it.title)}</b><div class="asub">${esc(r.it.why)}</div>`, text: (r) => r.it.title },
      { key: 'n', label: 'Count', num: true, html: (r) => r.it.count, sort: (r) => r.it.count, text: (r) => r.it.count },
      { key: 'where', label: 'Where', html: (r) => esc(r.it.where.slice(0, 4).map((w) => w.label).join(', ') + (r.it.where.length > 4 ? ` +${r.it.where.length - 4}` : '')), text: (r) => r.it.where.map((w) => w.label).join(' ') },
      { key: 'st', label: 'Status', html: (r) => stB(r.st), text: (r) => STL[r.st] },
      { key: 'act', label: '', html: (r) => view('item', r.it.id) + (r.it.findings.length ? btn(`data-copyitem="${esc(r.it.id)}"`, 'Copy fix') : '') +
          (['open', 'worse'].includes(r.st) ? btn(`data-mark="done|${esc(r.it.id)}"`, 'Done') + btn(`data-mark="snooze|${esc(r.it.id)}"`, 'Snooze') : btn(`data-mark="|${esc(r.it.id)}"`, 'Reopen')) },
    ], { id: (r) => r.it.id, bare: true })
    const worst = [...A.contexts].sort((a, b) => a.score - b.score).slice(0, 8)
    h += '<div class="asec">Lowest-scoring contexts</div>' + table('ov-worst', worst, [
      { key: 'ctx', label: 'Context', html: (c) => btn(`data-drill="${esc(c.key)}"`, esc(c.label), 'alink strong') },
      { key: 'tier', label: 'Tier', html: (c) => esc(c.tier) },
      { key: 'g', label: 'Grade', html: (c) => gradeB(c.grade) },
      { key: 's', label: 'Score', num: true, html: (c) => c.score },
      { key: 'p', label: 'Purity', num: true, html: (c) => pct(c.purity) },
      { key: 'f', label: 'Findings', num: true, html: (c) => c.crit + c.major + c.minor },
      { key: 'act', label: '', html: (c) => view('ctx', c.key) },
    ], { id: (c) => c.key, bare: true })
    return h
  }

  P.findings = () => head('Findings', 'Every rule break, one row each. Tick rows to copy their fix prompts together.') +
    table('findings', findRows(), [
      { key: 'kind', label: 'Kind', html: (r) => kindB(r.kind), text: (r) => r.kind, sort: (r) => ({ fix: 0, improve: 1, check: 2 })[r.kind] },
      { key: 'sev', label: 'Severity', html: (r) => sevB(r.v.severity), text: (r) => r.v.severity, sort: (r) => ({ critical: 0, major: 1, minor: 2 })[r.v.severity] },
      { key: 'rule', label: 'Rule', html: (r) => `<code>${esc(r.v.rule)}</code>`, text: (r) => r.v.rule, sort: (r) => r.v.rule },
      { key: 'ctx', label: 'Context', html: (r) => esc(r.ctx), text: (r) => r.ctx, sort: (r) => r.ctx },
      { key: 'src', label: 'Source', html: (r) => `<span class="apath">${esc(short(r.v.source))}${r.v.line ? `<i>:${r.v.line}</i>` : ''}</span>`, text: (r) => `${r.v.source}${r.v.line ? ':' + r.v.line : ''}`, sort: (r) => r.v.source },
      { key: 'tgt', label: 'Target', html: (r) => `<span class="apath">${esc(short(r.v.target))}</span>`, text: (r) => r.v.target, sort: (r) => r.v.target },
      { key: 'st', label: 'Status', html: (r) => stB(r.st), text: (r) => STL[r.st], sort: (r) => r.st },
      { key: 'act', label: '', html: (r) => view('finding', r.i) + btn(`data-copyf="${r.i}"`, 'Copy fix') },
    ], {
      id: (r) => r.i, select: true, empty: 'No findings.',
      filters: [
        { key: 'kind', label: 'Kind', get: (r) => r.kind }, { key: 'sev', label: 'Severity', get: (r) => r.v.severity },
        { key: 'rule', label: 'Rule', get: (r) => r.v.rule }, { key: 'ctx', label: 'Context', get: (r) => r.ctx },
        { key: 'st', label: 'Status', get: (r) => STL[r.st] },
      ],
      tools: [
        { id: 'copysel', label: (s) => `Copy selected (${s.sel.size})` },
        { id: 'copyall', label: 'Copy all shown' },
      ],
      expand: (r) => `<div class="aexpbox"><p><b>${esc(r.v.message)}</b></p>${r.v.why ? `<p class="asub">${esc(r.v.why)}</p>` : ''}${r.v.snippet ? `<pre>${esc(r.v.snippet)}</pre>` : ''}<div>${view('finding', r.i, 'Open in atlas ↗')}${btn(`data-copyf="${r.i}"`, 'Copy agent fix prompt', 'abtn')}</div></div>`,
    })

  P.contexts = () => head('Bounded contexts', 'Click a name to list its modules.') + table('contexts', A.contexts, [
    { key: 'tier', label: 'Tier', html: (c) => esc(c.tier), text: (c) => c.tier, sort: (c) => c.tier },
    { key: 'ctx', label: 'Context', html: (c) => btn(`data-drill="${esc(c.key)}"`, esc(c.label), 'alink strong') + (c.nest ? ' ' + badge('v-major', 'nest') : ''), text: (c) => c.label, sort: (c) => c.label },
    { key: 'g', label: 'Grade', html: (c) => gradeB(c.grade), text: (c) => c.grade, sort: (c) => c.score },
    { key: 's', label: 'Score', num: true, html: (c) => c.score, text: (c) => c.score, sort: (c) => c.score },
    { key: 'p', label: 'Purity', num: true, html: (c) => pct(c.purity), text: (c) => pct(c.purity), sort: (c) => c.purity },
    { key: 't', label: 'Tangle', num: true, html: (c) => pct(c.tangle), text: (c) => pct(c.tangle), sort: (c) => c.tangle },
    { key: 'm', label: 'Modules', num: true, html: (c) => c.modules, text: (c) => c.modules, sort: (c) => c.modules },
    { key: 'l', label: 'Lines', num: true, html: (c) => c.loc.toLocaleString(), text: (c) => c.loc, sort: (c) => c.loc },
    { key: 'maj', label: 'Major', num: true, html: (c) => c.crit + c.major || '', text: (c) => c.crit + c.major, sort: (c) => c.crit + c.major },
    { key: 'min', label: 'Minor', num: true, html: (c) => c.minor || '', text: (c) => c.minor, sort: (c) => c.minor },
    { key: 'in', label: 'In', num: true, html: (c) => c.inbound, text: (c) => c.inbound, sort: (c) => c.inbound },
    { key: 'out', label: 'Out', num: true, html: (c) => c.outbound, text: (c) => c.outbound, sort: (c) => c.outbound },
    { key: 'act', label: '', html: (c) => view('ctx', c.key) },
  ], { id: (c) => c.key, filters: [{ key: 'tier', label: 'Tier', get: (c) => c.tier }, { key: 'g', label: 'Grade', get: (c) => c.grade }] })

  P.modules = () => head('Modules', 'Every file on the map (generated handles excluded).') + table('modules', A.modules.filter((m) => !m.generated), [
    { key: 'name', label: 'Module', html: (m) => `<b>${esc(m.name)}</b><div class="asub apath">${esc(short(m.path))}</div>`, text: (m) => m.path, sort: (m) => m.path },
    { key: 'ctx', label: 'Context', html: (m) => esc(label(m.ctx)), text: (m) => label(m.ctx), sort: (m) => label(m.ctx) },
    { key: 'layer', label: 'Layer', html: (m) => esc(A.layers[m.layer]?.label || m.layer), text: (m) => m.layer, sort: (m) => m.layer },
    { key: 'loc', label: 'Lines', num: true, html: (m) => m.loc, text: (m) => m.loc, sort: (m) => m.loc },
    { key: 'ty', label: 'Types', num: true, html: (m) => m.symbols.types, text: (m) => m.symbols.types, sort: (m) => m.symbols.types },
    { key: 'fi', label: 'Fan-in', num: true, html: (m) => m.fanIn + (m.well ? ' ' + badge('v-major', 'well') : ''), text: (m) => m.fanIn, sort: (m) => m.fanIn },
    { key: 'fo', label: 'Fan-out', num: true, html: (m) => m.fanOut, text: (m) => m.fanOut, sort: (m) => m.fanOut },
    { key: 'v', label: 'Findings', num: true, html: (m) => m.violations || '', text: (m) => m.violations, sort: (m) => m.violations },
    { key: 'rule', label: 'Classified by', html: (m) => `<code class="asub">${esc(m.rule || '—')}</code>`, text: (m) => m.rule || '' },
    { key: 'act', label: '', html: (m) => view('module', m.id) },
  ], {
    id: (m) => m.id,
    filters: [
      { key: 'tier', label: 'Tier', get: (m) => m.tier }, { key: 'ctx', label: 'Context', get: (m) => label(m.ctx) },
      { key: 'layer', label: 'Layer', get: (m) => A.layers[m.layer]?.label || m.layer },
      { key: 'has', label: 'Findings', get: (m) => (m.violations ? 'has findings' : 'clean') },
    ],
  })

  P.seams = () => {
    const seams = A.seams || []
    const rows = seams.flatMap((s) => [...s.unhandled.map((k) => ({ s, k, st: 'unhandled' })), ...s.dead.map((k) => ({ s, k, st: 'dead' })), ...s.matched.map((k) => ({ s, k, st: 'matched' }))])
    const fix = (r) => A.violations.findIndex((v) => v.seam && v.kind === r.k && (r.s.emitters.includes(v.source) || r.s.handlers.includes(v.source)))
    const at = (arr) => (arr || []).slice(0, 2).map((x) => `${x.file.split('/').pop()}:${x.line}`).join(', ') || '—'
    const SB = { matched: badge('s-done', 'matched'), unhandled: badge('v-major', 'emitted, not handled'), dead: badge('v-minor', 'handled, not emitted') }
    return head('Contract seams', 'Protocol boundaries: kind strings one side emits and the other matches on. Not scored.') +
      '<div class="acards">' + seams.map((s) => card(s.id, `${s.matched.length} ✓`, [s.unhandled.length && `${s.unhandled.length} unhandled`, s.dead.length && `${s.dead.length} dead`].filter(Boolean).join(' · ') || 'in sync', s.unhandled.length ? 'bad' : '')).join('') + '</div>' +
      table('seams', rows, [
        { key: 'seam', label: 'Seam', html: (r) => esc(r.s.id), text: (r) => r.s.id, sort: (r) => r.s.id },
        { key: 'k', label: 'Kind', html: (r) => `<code>${esc(r.k)}</code>`, text: (r) => r.k, sort: (r) => r.k },
        { key: 'st', label: 'Status', html: (r) => SB[r.st], text: (r) => r.st, sort: (r) => ({ unhandled: 0, dead: 1, matched: 2 })[r.st] },
        { key: 'em', label: 'Emitted at', html: (r) => `<span class="apath">${esc(at(r.s.emitted[r.k]))}</span>`, text: (r) => at(r.s.emitted[r.k]) },
        { key: 'ha', label: 'Handled at', html: (r) => `<span class="apath">${esc(at(r.s.handled[r.k]))}</span>`, text: (r) => at(r.s.handled[r.k]) },
        { key: 'act', label: '', html: (r) => view('seam', r.s.id) + (r.st !== 'matched' && fix(r) >= 0 ? btn(`data-copyf="${fix(r)}"`, 'Copy fix') : '') },
      ], { id: (r) => `${r.s.id}|${r.k}`, filters: [{ key: 'seam', label: 'Seam', get: (r) => r.s.id }, { key: 'st', label: 'Status', get: (r) => r.st }] })
  }

  P.ports = () => head(A.views?.interfaces?.label || 'Interfaces', A.views?.interfaces?.hint || 'Who calls each one, and which files implement it.') + table('ports', (A.ports || []).map((p, i) => ({ p, i })), [
    { key: 'name', label: 'Name', html: (r) => `<b>${esc(r.p.name)}</b>`, text: (r) => r.p.name, sort: (r) => r.p.name },
    { key: 'area', label: 'Area', html: (r) => esc(label(r.p.ctx)), text: (r) => label(r.p.ctx), sort: (r) => label(r.p.ctx) },
    { key: 'apps', label: 'Apps', num: true, html: (r) => r.p.apps, text: (r) => r.p.apps, sort: (r) => r.p.apps },
    { key: 'cal', label: 'Callers', num: true, html: (r) => r.p.callers.length || badge('v-minor', 'unused'), text: (r) => r.p.callers.length, sort: (r) => r.p.callers.length },
    { key: 'impl', label: 'Implementers', html: (r) => esc(r.p.implementers.slice(0, 3).map((x) => x.split('/').pop()).join(', ') || '—'), text: (r) => r.p.implementers.join(' ') },
    { key: 'ev', label: 'Evidence', html: (r) => ((r.p.verified || []).length ? badge('s-done', 'verified') : badge('s-snooze', 'name guess')), text: (r) => r.p.implEvidence },
    { key: 'act', label: '', html: (r) => view('port', r.i) },
  ], {
    id: (r) => r.i,
    filters: [
      { key: 'use', label: 'Usage', get: (r) => (r.p.callers.length ? 'used' : 'unused') },
      { key: 'ev', label: 'Evidence', get: (r) => ((r.p.verified || []).length ? 'verified' : 'name guess') },
    ],
  })

  P.flows = () => head(A.views?.use_cases?.label || 'Use cases', A.views?.use_cases?.hint || 'From each entry point inward through the layers.') + table('flows', (A.flows || []).map((f, i) => ({ f, i })), [
    { key: 'op', label: 'Name', html: (r) => `<code>${esc(r.f.id)}</code>`, text: (r) => r.f.id, sort: (r) => r.f.id },
    { key: 'kind', label: 'Type', html: (r) => esc(r.f.kind), text: (r) => r.f.kind, sort: (r) => r.f.kind },
    { key: 'ctx', label: 'Context', html: (r) => esc(label(r.f.ctx)), text: (r) => label(r.f.ctx), sort: (r) => label(r.f.ctx) },
    { key: 'entry', label: 'Entry point', html: (r) => esc(r.f.stages.entry.map((x) => x.split('/').pop()).join(', ') || '—'), text: (r) => r.f.stages.entry.join(' ') },
    { key: 'len', label: 'Modules', num: true, html: (r) => r.f.path.length, text: (r) => r.f.path.length, sort: (r) => r.f.path.length },
    { key: 'v', label: 'Findings', num: true, html: (r) => r.f.violations.length || '', text: (r) => r.f.violations.length, sort: (r) => r.f.violations.length },
    { key: 'act', label: '', html: (r) => view('flow', r.i, 'Play ↗') },
  ], { id: (r) => r.i, filters: [{ key: 'kind', label: 'Type', get: (r) => (r.f.kind === 'command' ? 'Command' : 'Query') }, { key: 'ctx', label: 'Context', get: (r) => label(r.f.ctx) }] })

  P.history = () => head('Commits', 'Blast radius = how many contexts a commit touched.') + table('history', (A.history || []).map((c, i) => ({ c, i })), [
    { key: 'sha', label: 'Commit', html: (r) => `<code>${esc(r.c.short)}</code>`, text: (r) => r.c.short },
    { key: 'sub', label: 'Subject', html: (r) => esc(r.c.subject), text: (r) => r.c.subject },
    { key: 'au', label: 'Author', html: (r) => esc(r.c.author), text: (r) => r.c.author, sort: (r) => r.c.author },
    { key: 'ts', label: 'When', html: (r) => ago(r.c.ts), text: (r) => new Date(r.c.ts * 1000).toISOString(), sort: (r) => -r.c.ts },
    { key: 'diff', label: '+ / −', num: true, html: (r) => `<span class="aadd">+${r.c.add}</span> <span class="adel">−${r.c.del}</span>`, text: (r) => `${r.c.add}/${r.c.del}`, sort: (r) => r.c.add + r.c.del },
    { key: 'files', label: 'Files', num: true, html: (r) => r.c.files, text: (r) => r.c.files, sort: (r) => r.c.files },
    { key: 'blast', label: 'Blast', num: true, html: (r) => r.c.blast + (r.c.shotgun ? ' ' + badge('v-major', 'shotgun') : ''), text: (r) => r.c.blast, sort: (r) => r.c.blast },
    { key: 'act', label: '', html: (r) => view('commit', r.i) },
  ], { id: (r) => r.i })

  function render() {
    if (!A) return
    const main = root.querySelector('.amain')
    const scroll = main ? main.scrollTop : 0
    const counts = {
      findings: A.violations.length, contexts: A.contexts.length, modules: A.modules.filter((m) => !m.generated).length,
      seams: (A.seams || []).length, ports: (A.ports || []).length, flows: (A.flows || []).length, history: (A.history || []).length,
    }
    root.innerHTML = `<aside class="anav"><div class="abrand"><img src="./logo.svg" alt="" style="width:22px;height:22px;vertical-align:-6px;margin-right:8px;border-radius:6px">SPRAWLER</div>
      ${NAV.map(([k, l]) => `<a class="${page === k ? 'on' : ''}" data-page="${k}">${esc(navLabel(k, l))}${counts[k] != null ? `<em>${counts[k]}</em>` : ''}</a>`).join('')}
      <div class="anavfoot">Press <b>G</b> to switch views</div></aside>
      <div class="abody"><header class="ahead"><div><b>${esc(A.project.title)}</b><span>${esc([A.project.branch, A.project.sha].filter(Boolean).join(' · '))}</span></div>
      <span class="asp"></span><span class="ascore">${gradeB(A.score.grade)} ${A.score.total}/100</span>
      <button class="abtn primary" data-exit>◈ Atlas view</button></header>
      <main class="amain">${P[page]()}</main></div>`
    root.querySelector('.amain').scrollTop = scroll
    if (focusQ) {
      const el = root.querySelector(`[data-q="${focusQ}"]`)
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length) }
      focusQ = null
    }
  }

  function copyRows(key, onlySel) {
    const c = cache[key]
    if (!c) return
    const s = st(key)
    const list = (onlySel ? c.rows.filter((r) => s.sel.has(String(c.opt.id(r)))) : c.rows).map((r) => r.i)
    if (list.length) api.copyMany(list)
  }

  function csv(key) {
    const c = cache[key]
    if (!c) return
    const cols = c.cols.filter((x) => x.text)
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const out = [cols.map((x) => q(x.label)).join(','), ...c.rows.map((r) => cols.map((x) => q(x.text(r))).join(','))].join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([out], { type: 'text/csv' }))
    a.download = `sprawler-${A.project.name}-${key}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 3000)
  }

  root.addEventListener('click', (e) => {
    const t = e.target
    const on = (sel) => t.closest(sel)
    let el
    if ((el = on('[data-page]'))) { page = el.dataset.page; root.querySelector('.amain')?.scrollTo(0, 0); return render() }
    if (on('[data-exit]')) return api.exit()
    if ((el = on('[data-sort]'))) { const [k, c] = el.dataset.sort.split('|'); const s = st(k); s.dir = s.sort === c ? -s.dir : 1; s.sort = c; return render() }
    if ((el = on('[data-pg]'))) { const [k, n] = el.dataset.pg.split('|'); st(k).page = +n; return render() }
    if ((el = on('[data-csv]'))) return csv(el.dataset.csv)
    if ((el = on('[data-tool]'))) { const [k, id] = el.dataset.tool.split('|'); return copyRows(k, id === 'copysel') }
    if ((el = on('[data-open]'))) return api.open(el.dataset.open, el.dataset.id)
    if ((el = on('[data-copyf]'))) return api.copyFinding(+el.dataset.copyf)
    if ((el = on('[data-copyitem]'))) return api.copyItem(el.dataset.copyitem)
    if ((el = on('[data-mark]'))) { const v = el.dataset.mark, i = v.indexOf('|'); api.mark(v.slice(i + 1), v.slice(0, i)); return render() }
    if ((el = on('[data-drill]'))) { const s = st('modules'); s.f = { ctx: label(el.dataset.drill) }; s.page = 0; s.q = ''; page = 'modules'; return render() }
    if (on('input, select, button, a')) return
    if ((el = on('[data-row]'))) { const v = el.dataset.row, i = v.indexOf('|'); const s = st(v.slice(0, i)), id = v.slice(i + 1); s.open = s.open === id ? null : id; render() }
  })
  root.addEventListener('change', (e) => {
    const t = e.target
    if (t.dataset.f) { const [k, f] = t.dataset.f.split('|'); const s = st(k); s.f[f] = t.value; s.page = 0; return render() }
    if (t.dataset.sel) { const v = t.dataset.sel, i = v.indexOf('|'); const s = st(v.slice(0, i)), id = v.slice(i + 1); t.checked ? s.sel.add(id) : s.sel.delete(id); return render() }
    if (t.dataset.selall) {
      const k = t.dataset.selall, c = cache[k], s = st(k)
      const per = c.opt.per || 100
      const ids = c.rows.slice(s.page * per, (s.page + 1) * per).map((r) => String(c.opt.id(r)))
      ids.forEach((id) => (t.checked ? s.sel.add(id) : s.sel.delete(id)))
      return render()
    }
  })
  root.addEventListener('input', (e) => {
    const t = e.target
    if (!t.dataset.q) return
    const s = st(t.dataset.q)
    s.q = t.value
    s.page = 0
    focusQ = t.dataset.q
    render()
  })

  return { setAtlas: (a) => { A = a }, render }
}
