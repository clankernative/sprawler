// DOM HUD: score, legend/filters, contexts, threats/history/trophies, detail cards, toasts.
import { GRADE } from './atlas.js'
import { buildInbox, loadMarks, status, visible, summarize } from './inbox.js'

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const $ = (id) => document.getElementById(id)
const pct = (x) => `${Math.round(x * 100)}%`
const SEV = { critical: '#ff2e4d', major: '#ff9f1c', minor: '#ffd166' }
const GLYPH = { icosa: '⬢', box: '■', tetra: '▲', cone: '▼', octa: '◆', sphere: '●', dodeca: '✦' }
export const short = (p) => (p || '').replace(/^apps\//, '').replace(/^platform\//, '')

export function ago(ts) {
  const s = Date.now() / 1000 - ts
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

let SEAM = 'all'
export function setSeamMode(m) { SEAM = m }

export function renderTop(A) {
  const p = A.project
  $('proj').textContent = p.title
  $('head').innerHTML = p.repos
    ? p.repos.map((r) => `${esc(r.repo)} <b>${esc(r.sha || '—')}</b>${r.dirty ? `<span class="warn">*</span>` : ''}`).join(' · ')
    : `HEAD <b>${esc(p.sha || '—')}</b>${p.branch ? ` · ${esc(p.branch)}` : ''}${p.dirty ? ` · <span class="warn">${p.dirty} dirty</span>` : ''}`
}

export function setLive(state, text) {
  const el = $('live')
  el.className = 'live ' + state
  el.innerHTML = `<i></i>${esc(text)}`
}

// collapsible sections remember their open state across re-renders (they start collapsed)
const OPEN = new Set()
document.addEventListener('toggle', (e) => {
  const k = e.target?.dataset?.sec
  if (!k) return
  e.target.open ? OPEN.add(k) : OPEN.delete(k)
}, true)
export function openSec(k) { OPEN.add(k) }
const sec = (k, title, sub, body) => `<details class="lsec" data-sec="${esc(k)}" ${OPEN.has(k) ? 'open' : ''}><summary>${title}${sub ? ` <small>${sub}</small>` : ''}</summary>${body}</details>`
export const KIND = { fix: ['FIX', '#ff2e4d'], improve: ['IMPROVE', '#ffd166'], check: ['CHECK', '#4cc9ff'] }
const KIND_HEAD = {
  fix: 'FIX — breaks the architecture or fails at runtime',
  improve: 'IMPROVE — works, but the design is drifting',
  check: "CHECK — maybe a problem, or something the map can't see",
}

export function renderLeft(A, F, selKey) {
  const s = A.score
  const tierRows = A.tiers.map((t) => {
    const n = A.modules.filter((m) => m.tier === t.id).length
    return `<div class="row tog ${F.tiers.has(t.id) ? 'off' : ''}" data-tier="${t.id}"><i style="background:${t.color}"></i><span>${esc(t.label)}</span><a class="labt ${F.labelTiers?.has(t.id) ? 'off' : ''}" data-labtier="${t.id}" title="show/hide labels for this tier">Aa</a><em>${n}</em></div>`
  }).join('')
  const used = new Map()
  for (const m of A.modules) used.set(m.layer, (used.get(m.layer) || 0) + 1)
  const layerRows = Object.entries(A.layers).filter(([k]) => used.has(k)).map(([k, l]) =>
    `<div class="row tog ${F.layers.has(k) ? 'off' : ''}" data-layer="${k}"><b style="color:${l.color}">${GLYPH[l.shape] || '●'}</b><span>${esc(l.label)}</span><em>${used.get(k)}</em></div>`).join('')
  const ctxRows = A.tiers.map((t) => {
    const list = A.contexts.filter((c) => c.tier === t.id).sort((a, b) => a.score - b.score)
    if (!list.length) return ''
    return `<div class="sub" style="color:${t.color}">${esc(t.label)}</div>` + list.map((c) => {
      const v = c.crit + c.major + c.minor
      const pk = F.picked?.has(c.key)
      return `<div class="row ctx ${selKey === c.key ? 'on' : ''} ${pk ? 'picked' : ''}" data-ctx="${c.key}"><a class="pick" data-pick="${c.key}" title="pick (multi-select)">${pk ? '☑' : '☐'}</a>
        <b class="gr" style="color:${GRADE[c.grade]}">${c.grade}</b><span>${esc(c.label)}</span>
        <u><s style="width:${pct(c.purity)};background:${GRADE[c.grade]}"></s></u>
        ${c.nest ? '<em class="hot">NEST</em>' : v ? `<em class="${c.crit + c.major ? 'hot' : 'warm'}">${v}</em>` : '<em class="ok">✓</em>'}</div>`
    }).join('')
  }).join('')
  const sum = summarize(A)
  const seams = A.seams || []
  const seamBody = seams.length ? `<div class="pickbar">${[['off', 'hide seams'], ['miss', 'only mismatched kinds'], ['all', 'every matched protocol link']].map(([m, t]) => `<button data-seam="${m}" title="${t}" class="${F.seams === m ? 'on' : ''}">${m === 'miss' ? 'MISMATCHES' : m.toUpperCase()}</button>`).join('')}</div>
    ${seams.map((x) => { const bad = x.unhandled.length, dead = x.dead.length; return `<div class="row seamrow ${bad ? 'bad' : dead ? 'dead' : 'ok'}" data-seamrow="${esc(x.id)}" title="click for the full seam card"><b>⇄</b><span><u>${esc(x.id)}</u><small>${esc(x.label.split('·')[1] || x.label)}</small></span>${bad ? `<em class="hot">✕${bad}</em>` : ''}${dead ? `<em class="warm">◌${dead}</em>` : ''}<em class="ok">${x.matched.length}✓</em><em class="st">${bad ? 'BROKEN' : dead ? 'CHECK' : 'IN SYNC'}</em></div>` }).join('')}` : ''
  const inSync = seams.filter((x) => !x.unhandled.length && !x.dead.length).length
  $('left').innerHTML = `
    <div class="score">
      <div class="grade" style="color:${s.withheld ? '#5c6773' : GRADE[s.grade]};text-shadow:0 0 24px ${s.withheld ? 'transparent' : GRADE[s.grade]}" title="${s.withheld ? 'grade withheld: confidence too low to back it up' : ''}">${s.withheld ? '?' : s.grade}</div>
      <div class="sc"><div class="big"><span id="scoreNum">${s.total}</span><small>/100</small></div>
        <div class="lbl">${esc(s.label || 'ARCHITECTURE HEALTH')}${s.withheld ? ' · NOT ENOUGH EVIDENCE' : ''}</div>
        <div class="xp"><s style="width:${pct(s.xp / Math.max(1, s.xpMax))}"></s></div>
        <div class="lbl">${s.xp} / ${s.xpMax} XP</div></div>
    </div>
    <div class="fsum" data-gotab="inbox" title="open the inbox">
      <span style="--c:#ff2e4d"><b>${sum.fix}</b>to fix</span><span style="--c:#ffd166"><b>${sum.improve}</b>to improve</span><span style="--c:#4cc9ff"><b>${sum.check}</b>to check</span></div>
    ${s.worst ? `<div class="row ctx worst" data-ctx="${s.worst.key}"><b class="gr" style="color:${GRADE[s.worst.grade]}">${s.worst.grade}</b><span>worst: ${esc(s.worst.label)}</span><em>${s.worst.score}</em></div>` : ''}
    ${sec('stats', 'NUMBERS', `confidence ${pct(s.confidence ?? 1)}`, `<div class="stats">
      <div><b>${A.modules.length}</b><span>modules</span></div>
      <div><b>${s.edges}</b><span>deps</span></div>
      <div><b class="c-ok">${pct(s.purity)}</b><span>purity</span></div>
      <div><b class="${s.tangle > 0.3 ? 'c-bad' : 'c-ok'}">${pct(s.tangle)}</b><span>tangle</span></div>
      <div><b class="c-ok">${s.clean}</b><span>clean</span></div>
      <div><b style="color:#4cc9ff">${s.cross}</b><span>cross ok</span></div>
      <div><b class="${sum.fix ? 'c-bad' : 'c-ok'}">${A.violations.length}</b><span>findings</span></div>
      <div><b style="color:#b388ff">${A.wells.length}</b><span>wells</span></div>
    </div>
    ${s.policyCoverage != null ? `<div class="note" title="share of scored links that at least one team rule checks; the rest are allowed only because nothing forbids them">rules check ${pct(s.policyCoverage)} of links${s.boundary?.scored ? ` · ${s.boundary.violating}/${s.boundary.pairs} context pairs break a rule` : ''}</div>` : ''}
    ${s.evidence?.csharp ? `<div class="note" title="C# names resolved by Roslyn · files with no recognised role · projects without dotnet restore">C# ${s.evidence.csharp.failed ? 'analysis FAILED' : `names resolved ${pct(s.evidence.csharp.resolution)}`} · ${s.evidence.csharp.unclassified} unclassified files · ${s.evidence.csharp.unrestored} unrestored projects</div>` : ''}
    <div class="note" title="dropped Rust refs ${s.unknown?.dropped ?? 0} · unresolved imports ${s.unknown?.unresolved ?? 0} · phantom bindings ${s.unknown?.phantoms ?? 0}">confidence ${pct(s.confidence ?? 1)} · ${s.unknown?.dropped ?? 0} dropped · ${s.unknown?.phantoms ?? 0} phantom</div>`)}
    ${sec('display', 'DISPLAY', 'height · labels · filters', `
      <div class="sub">ISLAND HEIGHT</div>
      <div class="pickbar">${[['traffic', 'incoming links'], ['size', 'lines of code'], ['churn', 'commits touching it'], ['flat', 'no height']].map(([h, t]) => `<button data-height="${h}" title="${t}" class="${F.height === h ? 'on' : ''}">${h.toUpperCase()}</button>`).join('')}</div>
      <div class="sub">LABELS <small>L cycles · tier names always stay</small></div>
      <div class="pickbar">${[['all', 'tiers, contexts and modules'], ['ctx', 'tier + context names only'], ['tier', 'tier names only']].map(([m, t]) => `<button data-labmode="${m}" title="${t}" class="${F.labels === m ? 'on' : ''}">${{ all: 'ALL', ctx: 'SECTIONS', tier: 'TIERS' }[m]}</button>`).join('')}</div>
      <div class="row tog ${F.focusHide ? '' : 'off'}" data-toggle="focusHide"><b>◎</b><span>Selection hides unrelated</span><em>${F.focusHide ? 'ON' : 'OFF'}</em></div>
      <div class="row tog ${F.tests ? '' : 'off'}" data-toggle="tests"><b>▣</b><span>Show test suites</span><em>${F.tests ? 'ON' : 'OFF'}</em></div>
      <div class="row tog ${F.generated ? '' : 'off'}" data-toggle="generated"><b>▣</b><span>Show generated handles</span><em>${F.generated ? 'ON' : 'OFF'}</em></div>`)}
    ${sec('tiers', 'TIERS & LAYERS', 'click to hide', tierRows + '<div class="sub">LAYERS <small>shape · colour</small></div>' + layerRows)}
    ${seams.length ? sec('seams', 'CONTRACT SEAMS', `${inSync}/${seams.length} in sync`, seamBody) : ''}
    ${sec('contexts', esc(A.project.contextLabel || 'BOUNDED CONTEXTS'), `${A.contexts.length} · ☐ pick · ⇧click map`, `
      <div class="pickbar"><span>${F.picked?.size || 0} picked</span>
      <button data-iso="off" class="${F.isolate === 'off' ? 'on' : ''}" title="show everything, highlight picks">ALL</button>
      <button data-iso="only" class="${F.isolate === 'only' ? 'on' : ''}" title="show only picked contexts (I)">ONLY</button>
      <button data-iso="plus" class="${F.isolate === 'plus' ? 'on' : ''}" title="picked + everything they touch">+NEIGHBOURS</button>
      <button data-fit title="frame the picked contexts (F)">FIT</button><button data-clearpick title="clear picks">✕</button></div>${ctxRows}`)}`
}

function itemCard(A, it, st) {
  const [kl, kc] = KIND[it.kind]
  const where = it.where.slice(0, 8).map((w) => `<a class="wchip" ${w.key ? `data-ctx="${esc(w.key)}"` : `data-mod="${esc(w.mod)}"`}>${esc(w.label)}${w.n > 1 ? ` <i>×${w.n}</i>` : ''}</a>`).join('') + (it.where.length > 8 ? `<small class="dim"> +${it.where.length - 8} more</small>` : '')
  const rows = it.findings.slice(0, 30).map((i) => {
    const v = A.violations[i]
    return `<div class="threat" data-threat="${i}" style="--c:${kc}"><span>${esc(short(v.source))}${v.line ? ':' + v.line : ''}</span><i>→</i><span>${esc(short(v.target))}</span><button class="cp" data-copy="${i}" title="copy agent fix prompt">⧉</button></div>`
  }).join('')
  const n = it.findings.length
  return `<div class="item" style="--c:${kc}">
    <div class="ih"><span class="kchip">${kl}</span>${st === 'worse' ? '<span class="kchip worse">GOT WORSE</span>' : ''}<b>${esc(it.title)}</b><em>${it.count}</em></div>
    <p>${esc(it.why)}</p>
    ${where ? `<div class="where">${where}</div>` : ''}
    <div class="iact"><button class="go" data-show="${it.id}" title="load the right view for this item">▶ SHOW</button>${n ? `<button class="cp" data-copyitem="${it.id}" title="copy ${n} agent fix prompt${n > 1 ? 's' : ''}">⧉ AGENT FIX${n > 1 ? ` <i>${n}</i>` : ''}</button>` : ''}<span class="sp"></span><button class="mk" data-mark="done" data-item="${it.id}" title="hide until it gets worse">✓ DONE</button><button class="mk" data-mark="snooze" data-item="${it.id}" title="hide for 7 days">⏾ 7d</button></div>
    ${rows ? sec('f:' + it.id, `${n} finding${n > 1 ? 's' : ''}`, 'click one to inspect', rows) : ''}
  </div>`
}

function renderInbox(A, items, marks) {
  let html = ''
  if (!localStorage.getItem('sprawler:onboarded')) {
    html += `<div class="onboard"><b>START HERE</b><ol><li>Work top to bottom — <b style="color:#ff2e4d">FIX</b> first.</li><li><b>▶ SHOW</b> loads the right view for an item.</li><li><b>⧉ AGENT FIX</b> copies a fix prompt with file:line and code.</li></ol><small>Ready-made views live under <b>▦ VIEWS</b> (keys 1–9). Press <b>?</b> for every shortcut.</small><button data-onboard>GOT IT</button></div>`
  }
  const open = [], hidden = []
  for (const it of items) {
    const st = status(it, marks)
    ;(visible(st) ? open : hidden).push([it, st])
  }
  if (!open.length) html += '<div class="clear">◈ INBOX ZERO<br><small>nothing left to look at</small></div>'
  let last = null
  for (const [it, st] of open) {
    if (it.kind !== last) { last = it.kind; html += `<div class="ksec" style="--c:${KIND[it.kind][1]}">${KIND_HEAD[it.kind]}</div>` }
    html += itemCard(A, it, st)
  }
  if (hidden.length) {
    html += sec('marked', `DONE & SNOOZED · ${hidden.length}`, 'saved in this browser', hidden.map(([it, st]) => {
      const m = marks[it.id]
      return `<div class="mrow"><b style="color:${KIND[it.kind][1]}">${st === 'done' ? '✓' : '⏾'}</b><span>${esc(it.title)}<small>${st === 'snooze' ? 'snoozed until ' + new Date(m.until).toLocaleDateString() : 'done ' + ago(m.at / 1000) + ' · returns if it grows past ' + m.count}</small></span><button class="cp" data-show="${it.id}" title="show me">▶</button><button class="cp" data-mark="" data-item="${it.id}" title="put back in the inbox">↺</button></div>`
    }).join(''))
  }
  return html
}

export function detailItem(A, it) {
  const [kl, kc] = KIND[it.kind]
  const n = it.findings.length
  return `<div class="dh"><span class="chip" style="--c:${kc}">${kl}</span><span class="chip" style="--c:#8892b0">${it.count}</span><button class="x" data-close>✕</button></div>
    <h2>${esc(it.title)}</h2><p class="explain">${esc(it.why)}</p>
    ${n ? `<button class="bigcp" data-copyitem="${it.id}">⧉ COPY ${n > 1 ? n + ' FIX PROMPTS' : 'FIX PROMPT'}</button>` : ''}
    ${it.where.length ? `<div class="sec">WHERE</div><div class="deps">${it.where.map((w) => `<div class="dep" ${w.key ? `data-ctx="${esc(w.key)}"` : `data-mod="${esc(w.mod)}"`}><i>›</i><span>${esc(w.label)}</span><em>${w.n || ''}</em></div>`).join('')}</div>` : ''}
    ${n ? breaks(A, it.findings.map((i) => A.violations[i]), 20) : ''}`
}

const EXPLORE = ['flows', 'ports', 'trophies']
export function renderRight(A, tab, cur) {
  if (tab === 'threats') tab = 'inbox'
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab || (b.dataset.tab === 'explore' && EXPLORE.includes(tab))))
  const items = buildInbox(A), marks = loadMarks(A)
  const open = items.filter((it) => visible(status(it, marks)))
  $('tabInbox').innerHTML = `INBOX <em class="${open.some((i) => i.kind === 'fix') ? 'hot' : open.length ? 'warm' : 'ok'}">${open.length}</em>`
  let html = ''
  if (tab === 'inbox') html = renderInbox(A, items, marks)
  else if (EXPLORE.includes(tab)) {
    const earned = A.achievements.filter((a) => a.earned).length
    html = `<div class="subtabs">${[['flows', `${esc(ucLabel(A).toUpperCase())} ${(A.flows || []).length}`], ['ports', `${esc(ifLabel(A).toUpperCase())} ${(A.ports || []).length}`], ['trophies', `★ ${earned}/${A.achievements.length}`]].map(([k, l]) => `<button data-sub="${k}" class="${tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>`
    if (tab === 'flows') {
      html += `<div class="note">${esc(ucLabel(A))}: ${(A.views?.use_cases?.stages || []).map((x) => esc(x.label.toLowerCase())).join(' → ')}. ▶ plays it.</div>`
      let last = null
      ;(A.flows || []).forEach((f, i) => {
        if (f.ctx !== last) { last = f.ctx; html += `<div class="sub">${esc(ctxLabel(A, f.ctx))}</div>` }
        html += `<div class="flow" data-flow="${i}"><b class="k-${f.kind}" title="${esc(f.kind)}">${esc((f.kind || '?')[0].toUpperCase())}</b><span>${esc(f.op)}</span>
          ${f.violations.length ? `<em class="hot">⚠${f.violations.length}</em>` : ''}<em>${f.path.length}</em><button class="cp" data-play="${i}" title="play flow">▶</button></div>`
      })
      if (!(A.flows || []).length) html += `<div class="clear">${esc(A.views?.use_cases?.hint || 'nothing found')}</div>`
    } else if (tab === 'ports') {
      const P = A.ports || []
      const unused = P.filter((p) => !p.callers.length).length
      html += P.length ? `<div class="note">${esc(ifLabel(A))}, most-used first. ${unused ? `<b class="c-bad">${unused} unused</b> by any module. ` : ''}⚙ = implementers (✓ verified by an implements link or contract seam, otherwise a name guess).</div>` : `<div class="clear">${esc(A.views?.interfaces?.hint || 'nothing found')}</div>`
      html += P.map((p, i) => `<div class="flow" data-port="${i}"><b style="color:#4cc9ff">◆</b><span>${esc(p.name)}</span>
        ${p.callers.length ? `<em title="apps using it">${p.apps}▣</em><em title="callers">${p.callers.length}</em>` : '<em class="warm">unused</em>'}
        <em title="implementers" style="color:#ff9f1c">${p.implementers.length ? '⚙' + p.implementers.length + ((p.verified || []).length ? '✓' : '') : ''}</em></div>`).join('')
    } else {
      html += A.achievements.map((a) => `<div class="troph ${a.earned ? 'got' : ''}">
        <b>${a.earned ? '★' : '☆'}</b><div><div class="tt">${esc(a.title)}</div><small>${esc(a.desc)}</small></div><em>${a.xp} XP</em></div>`).join('')
    }
  } else {
    html = `<div class="hbar"><button id="replay">▶ REPLAY</button><small>click a commit to light up its blast radius</small></div>`
    html += A.history.map((c, i) => `<div class="commit ${cur === i ? 'on' : ''}" data-commit="${i}">
      <div class="cs">${esc(c.subject)}</div>
      <div class="cm"><b>${esc(c.short)}</b> ${esc(c.author)} · ${ago(c.ts)} <span class="add">+${c.add}</span> <span class="del">−${c.del}</span>
      <em class="${c.shotgun ? 'hot' : c.blast > 1 ? 'warm' : 'ok'}">${c.shotgun ? 'SHOTGUN ' : ''}⊙${c.blast}</em></div>
      <u><s style="width:${Math.min(100, c.blast * 14)}%;background:${c.shotgun ? '#ff2e4d' : '#39ffb0'}"></s></u></div>`).join('')
    if (!A.history.length) html += '<div class="clear">no git history</div>'
  }
  $('rightBody').innerHTML = html
}

function depRow(d, dir) {
  const e = d.e
  const cls = e.status === 'violation' ? 'bad' : e.status === 'cross' ? 'cross' : e.status === 'test' ? 'dim' : ''
  return `<div class="dep ${cls}" data-mod="${esc(d.id)}" title="${esc(e.rule || e.relations.join(','))}"><i>${dir}</i><span>${esc(short(d.id))}</span><em>${e.weight}</em></div>`
}

// prominent, clickable rule-break list (click → threat card, ⧉ → copy fix prompt)
function breaks(A, v, max) {
  return `<div class="breaks"><div class="bh">⚠ RULE BREAKS · ${v.length}<small>click to inspect · ⧉ copies an agent fix prompt</small></div>` +
    v.slice(0, max).map((x) => {
      const i = A.violations.indexOf(x)
      return `<div class="vio click" data-threat="${i}" style="--c:${SEV[x.severity]}"><b>${esc(x.rule)}</b> <em>${esc(x.severity)}</em><button class="cp" data-copy="${i}" title="copy agent fix prompt">⧉ COPY</button><br>${esc(x.message)}<br><small>${esc(short(x.source))}${x.line ? ':' + x.line : ''} → ${esc(short(x.target))}</small></div>`
    }).join('') + (v.length > max ? `<div class="more">+${v.length - max} more in the INBOX</div>` : '') + '</div>'
}

export function detailModule(A, m, nb) {
  const l = A.layers[m.layer] || {}
  const c = A.contexts.find((x) => x.key === m.ctx)
  const v = A.violations.filter((x) => x.source === m.id || x.target === m.id)
  const syms = m.sample.slice(0, 24).map(([k, n, ln]) => `<div class="sym"><i>${k === 'type' ? 'T' : k === 'method' ? 'm' : 'ƒ'}</i><span>${esc(n)}</span><em>L${ln}</em></div>`).join('')
  return `<div class="dh"><span class="chip" style="--c:${l.color}">${esc(l.label || m.layer)}</span><span class="chip" style="--c:#8892b0">${esc(c?.label)}</span>${m.well ? '<span class="chip" style="--c:#b388ff">GRAVITY WELL</span>' : ''}<button class="x" data-close>✕</button></div>
    <h2>${esc(m.name)}</h2><div class="path">${esc(m.path || 'platform-generated handle (virtual)')}</div>
    <div class="path">classified by <b>${esc(m.rule || 'no rule — unmapped')}</b></div>
    ${m.role ? `<div class="path">role <b>${esc(m.role)}</b>${m.project ? ` · project <b>${esc(m.project)}</b>` : ''}${m.evidence?.length ? ` — because ${esc(m.evidence.join('; '))}` : ''}</div>` : ''}
    ${m.resolution && m.resolution[1] ? `<div class="path">${m.resolution[1]} name(s) in this file could not be resolved — some dependencies may be missing</div>` : ''}
    <div class="stats s4"><div><b>${m.loc}</b><span>lines</span></div><div><b>${m.symbols.types}</b><span>types</span></div>
    <div><b>${m.fanIn}</b><span>fan-in</span></div><div><b>${m.fanOut}</b><span>fan-out</span></div></div>
    ${v.length ? breaks(A, v, 8) : '<div class="okline">◈ this module keeps every rule</div>'}
    <div class="sec">DEPENDS ON · ${nb.out.length}</div><div class="deps">${nb.out.slice(0, 30).map((d) => depRow(d, '→')).join('') || '<small class="dim">nothing — a leaf</small>'}</div>
    <div class="sec">USED BY · ${nb.in.length}</div><div class="deps">${nb.in.slice(0, 30).map((d) => depRow(d, '←')).join('') || '<small class="dim">nobody</small>'}</div>
    ${syms ? `<div class="sec">SYMBOLS</div><div class="syms">${syms}</div>` : ''}`
}

export function detailThreat(A, v, i) {
  const where = v.line ? `${v.source}:${v.line}` : v.source
  return `<div class="dh"><span class="chip" style="--c:${SEV[v.severity]}">${esc(v.severity.toUpperCase())}</span><span class="chip" style="--c:${SEV[v.severity]}">${esc(v.rule)}</span><button class="x" data-close>✕</button></div>
    <h2>${esc(v.message)}</h2>
    <div class="path"><b>${esc(where)}</b></div>
    <div class="path">→ ${esc(v.target)}</div>
    ${v.snippet ? `<pre class="snip">${esc(v.snippet)}</pre>` : ''}
    <button class="bigcp" data-copy="${i}">⧉ COPY AGENT FIX PROMPT</button>
    <div class="note">Includes the rule, why it exists, file:line, the code, allowed layers, a fix direction and a "done when" check.</div>
    <div class="sec">JUMP TO</div><div class="deps">
      <div class="dep bad" data-mod="${esc(v.source)}"><i>●</i><span>${esc(short(v.source))}</span><em>source</em></div>
      <div class="dep" data-mod="${esc(v.target)}"><i>●</i><span>${esc(short(v.target))}</span><em>target</em></div></div>`
}

const ctxLabel = (A, k) => A.contexts.find((c) => c.key === k)?.label || k
export const ucLabel = (A) => A.views?.use_cases?.label || 'Use cases'
export const ifLabel = (A) => A.views?.interfaces?.label || 'Interfaces'
const stageLabel = (A, k) => (A.views?.use_cases?.stages || []).find((x) => x.key === k)?.label || k.toUpperCase()

export function detailFlow(A, f, i) {
  const stages = Object.entries(f.stages).map(([k, ids]) => {
    if (!ids.length && k !== 'entry') return ''
    const rows = ids.length ? ids.map((id) => `<div class="dep" data-mod="${esc(id)}"><i>›</i><span>${esc(short(id))}</span></div>`).join('')
      : '<small class="dim">no entry point found on the map — invoked from outside it</small>'
    return `<div class="sec">${esc(stageLabel(A, k))} · ${ids.length}</div><div class="deps">${rows}</div>`
  }).join('')
  const v = f.violations.map((j) => [A.violations[j], j]).filter(([x]) => x)
  return `<div class="dh"><span class="chip" style="--c:${f.kind === 'command' ? '#ff6b6b' : '#4cc9ff'}">${esc((f.kind || '').toUpperCase())}</span><span class="chip" style="--c:#8892b0">${esc(ctxLabel(A, f.ctx))}</span><button class="x" data-close>✕</button></div>
    <h2>${esc(f.id)}</h2>${f.registeredIn ? `<div class="path">registered in ${esc(f.registeredIn)}</div>` : `<div class="path">${esc(f.module)}</div>`}
    <button class="bigcp" data-play="${i}">▶ PLAY FLOW</button>
    ${v.length ? `<div class="sec bad">FINDINGS ON THIS PATH · ${v.length}</div>` + v.map(([x, j]) => `<div class="vio" style="--c:${SEV[x.severity]}"><b>${esc(x.rule)}</b> ${esc(short(x.source))}${x.line ? ':' + x.line : ''}<button class="cp" data-copy="${j}">⧉</button></div>`).join('') : '<div class="okline">◈ clean path</div>'}
    ${stages}`
}

export function detailPort(A, p) {
  const byCtx = Object.entries(p.callerCtx).map(([k, n]) => `<div class="lb"><span>${esc(ctxLabel(A, k))}</span><u><s style="width:${Math.min(100, n * 8)}%;background:#4cc9ff"></s></u><em>${n}</em></div>`).join('')
  return `<div class="dh"><span class="chip" style="--c:#4cc9ff">${esc(ifLabel(A).toUpperCase())}</span>${p.callers.length ? '' : '<span class="chip" style="--c:#ffd166">UNUSED</span>'}<button class="x" data-close>✕</button></div>
    <h2>${esc(p.name)}</h2><div class="path">${esc(p.id)}</div>
    <div class="stats s4"><div><b>${p.apps}</b><span>apps</span></div><div><b>${p.callers.length}</b><span>callers</span></div><div><b>${Object.keys(p.callerCtx).length}</b><span>contexts</span></div><div><b>${p.implementers.length}</b><span>impl?</span></div></div>
    <div class="sec">DRIVING SIDE · who calls it</div>${byCtx || '<small class="dim">nobody — candidate for removal, or a capability no app uses yet</small>'}
    <div class="sec">IMPLEMENTERS <small>${esc(p.implEvidence)}</small></div>
    <div class="deps">${p.implementers.map((id) => `<div class="dep" data-mod="${esc(id)}"><i>⚙</i><span>${esc(short(id))}</span></div>`).join('') || '<small class="dim">no implementer found</small>'}</div>
    <div class="sec">CALLERS · ${p.callers.length}</div><div class="deps">${p.callers.slice(0, 60).map((id) => `<div class="dep" data-mod="${esc(id)}"><i>→</i><span>${esc(short(id))}</span></div>`).join('')}</div>`
}

export function seamThreat(A, s, k) {
  return A.violations.findIndex((v) => v.seam && v.kind === k && (s.emitters.includes(v.source) || s.handlers.includes(v.source)))
}

export function detailSeam(A, s, focusKind) {
  const bad = s.unhandled.length, dead = s.dead.length
  const rows = [...s.unhandled.map((k) => [k, 'bad']), ...s.dead.map((k) => [k, 'dead']), ...s.matched.map((k) => [k, 'ok'])]
  const site = (arr) => (arr || []).slice(0, 3).map((x) => `<a class="site" data-mod="${esc(x.file)}">${esc(x.file.split('/').pop())}:${x.line}</a>`).join(' ') || '<span class="miss">— none —</span>'
  const ST = { ok: ['✓', 'matched', '#39ffb0'], bad: ['✕', 'emitted, never handled', '#ff2e4d'], dead: ['◌', 'handled, never emitted', '#ffb020'] }
  const table = rows.map(([k, st]) => {
    const vi = st === 'ok' ? -1 : seamThreat(A, s, k)
    return `<tr class="${st} ${k === focusKind ? 'focus' : ''}"><td><b style="color:${ST[st][2]}">${ST[st][0]}</b> <code>${esc(k)}</code></td><td>${site(s.emitted[k])}</td><td>${site(s.handled[k])}</td><td>${vi >= 0 ? `<button class="cp" data-copy="${vi}" title="copy agent fix prompt">⧉</button>` : ''}</td></tr>`
  }).join('')
  const files = (list) => list.map((f) => `<div class="dep" data-mod="${esc(f)}"><i>›</i><span>${esc(short(f))}</span></div>`).join('')
  return `<div class="dh"><span class="chip" style="--c:#ff4fd8">CONTRACT SEAM</span><span class="chip" style="--c:${bad ? '#ff2e4d' : dead ? '#ffb020' : '#39ffb0'}">${bad ? `${bad} BROKEN` : dead ? `${dead} TO CHECK` : 'IN SYNC'}</span><button class="x" data-close>✕</button></div>
    <h2>${esc(s.id)} seam</h2><div class="path">${esc(s.label)}</div>
    <p class="explain">A protocol boundary, not an import. One side <b>emits</b> kind strings as data, the other side <b>matches</b> on them. A kind that is emitted but never handled fails at runtime (<b style="color:#ff2e4d">✕</b>). A handler that nothing emits is dead code — or the kind is built dynamically (<b style="color:#ffb020">◌</b>).${s.note ? ` <i>Note: ${esc(s.note)}.</i>` : ''}</p>
    <div class="stats s4"><div><b class="c-ok">${s.matched.length}</b><span>matched</span></div><div><b class="${bad ? 'c-bad' : ''}">${bad}</b><span>unhandled</span></div><div><b style="color:${dead ? '#ffb020' : ''}">${dead}</b><span>dead</span></div><div><b>${rows.length}</b><span>kinds</span></div></div>
    <button class="bigcp" data-seamreport="${esc(s.id)}">⧉ COPY SEAM REPORT</button>
    <div class="sec">EVERY KIND <small>click a file:line to jump</small></div>
    <table class="seamtab"><thead><tr><th>kind</th><th>emitted at</th><th>handled at</th><th></th></tr></thead><tbody>${table}</tbody></table>
    <div class="sec">EMITTING SIDE · ${s.emitters.length}</div><div class="deps">${files(s.emitters)}</div>
    <div class="sec">HANDLING SIDE · ${s.handlers.length}</div><div class="deps">${files(s.handlers)}</div>`
}

export function seamReport(A, s) {
  const line = (arr) => (arr || []).map((x) => `${x.file}:${x.line}`).join(', ') || '—'
  const out = [`# Contract seam: \`${s.id}\``, '', s.label, '', `Repository root: \`${A.project.root}\``, '',
    'A protocol boundary, not an import: one side emits `kind` strings, the other matches on them.', '',
    `Matched ${s.matched.length} · unhandled ${s.unhandled.length} · dead ${s.dead.length}`, '',
    '| kind | status | emitted at | handled at |', '|---|---|---|---|']
  for (const k of s.unhandled) out.push(`| \`${k}\` | ✕ emitted, never handled | ${line(s.emitted[k])} | — |`)
  for (const k of s.dead) out.push(`| \`${k}\` | ◌ handled, never emitted | — | ${line(s.handled[k])} |`)
  for (const k of s.matched) out.push(`| \`${k}\` | ✓ matched | ${line(s.emitted[k])} | ${line(s.handled[k])} |`)
  if (s.unhandled.length || s.dead.length) {
    out.push('', '## Task', 'Bring the two sides back in sync. For each ✕ add the host handler arm (with validation) or stop emitting the kind.',
      'For each ◌ confirm nothing builds the kind dynamically; if nothing does, remove the arm, otherwise add a typed SDK constructor.',
      'Preserve behaviour and keep changes minimal. Done when `sprawler report` shows this seam as in sync.')
  }
  return out.join('\n')
}

export function detailCtx(A, c, solo = new Set()) {
  const tier = A.tiers.find((t) => t.id === c.tier) || {}
  const total = Object.values(c.layers).reduce((a, b) => a + b, 0) || 1
  const bars = Object.entries(c.layers).sort((a, b) => b[1] - a[1]).map(([k, n]) => {
    const l = A.layers[k] || {}
    return `<div class="lb solo ${solo.size ? (solo.has(k) ? 'on' : 'off') : ''}" data-sololayer="${esc(k)}" title="click to show only this layer · click again to bring the rest back"><span>${esc(l.label || k)}</span><u><s style="width:${pct(n / total)};background:${l.color}"></s></u><em>${n}</em></div>`
  }).join('')
  const v = A.violations.filter((x) => x.fromCtx === c.key)
  const mods = A.modules.filter((m) => m.ctx === c.key && !m.generated).sort((a, b) => b.loc - a.loc)
  return `<div class="dh"><span class="chip" style="--c:${tier.color}">${esc(tier.label)}</span>${c.nest ? '<span class="chip" style="--c:#ff2e4d">RAT\'S NEST</span>' : ''}<button class="x" data-close>✕</button></div>
    <div class="ctxhead"><div class="grade sm" style="color:${GRADE[c.grade]};text-shadow:0 0 18px ${GRADE[c.grade]}">${c.grade}</div>
    <div><h2>${esc(c.label)}</h2><div class="path">${esc(c.key)} · ${c.loc} lines</div></div></div>
    <div class="stats s4"><div><b>${c.score}</b><span>score</span></div><div><b>${pct(c.purity)}</b><span>purity</span></div>
    <div><b class="${c.tangle > 0.4 ? 'c-bad' : ''}">${pct(c.tangle)}</b><span>tangle</span></div><div><b>${c.outbound}</b><span>out-links</span></div></div>
    <div class="sec">LAYERS <small>${solo.size ? 'click a layer to add / remove it · 0 resets' : 'click one to show only it'}</small></div>${bars}
    ${v.length ? breaks(A, v, 12) : '<div class="okline">◈ clean hexagon — no rule breaks</div>'}
    <div class="sec">MODULES · ${mods.length}</div><div class="deps">${mods.slice(0, 60).map((m) => `<div class="dep ${m.violations ? 'bad' : ''}" data-mod="${esc(m.id)}"><i style="color:${A.layers[m.layer]?.color}">${GLYPH[A.layers[m.layer]?.shape] || '●'}</i><span>${esc(m.name)}</span><em>${m.loc}</em></div>`).join('')}</div>`
}

export function detailCommit(A, c) {
  const ctx = c.contexts.map((k) => A.contexts.find((x) => x.key === k)?.label || k)
  return `<div class="dh"><span class="chip" style="--c:${c.shotgun ? '#ff2e4d' : '#39ffb0'}">${c.shotgun ? 'SHOTGUN SURGERY' : 'BLAST RADIUS ' + c.blast}</span><button class="x" data-close>✕</button></div>
    <h2>${esc(c.subject)}</h2><div class="path">${esc(c.short)} · ${esc(c.author)} · ${ago(c.ts)}</div>
    <div class="stats s4"><div><b>${c.files}</b><span>files</span></div><div><b class="c-ok">+${c.add}</b><span>added</span></div>
    <div><b class="c-bad">−${c.del}</b><span>removed</span></div><div><b>${c.tiers.length}</b><span>tiers</span></div></div>
    <div class="sec">CONTEXTS TOUCHED</div><div class="chips">${ctx.map((x) => `<span class="chip" style="--c:#4cc9ff">${esc(x)}</span>`).join('') || '<small class="dim">none mapped</small>'}</div>
    <div class="sec">MODULES · ${c.modules.length}</div><div class="deps">${c.modules.slice(0, 50).map((m) => `<div class="dep" data-mod="${esc(m)}"><i>✎</i><span>${esc(short(m))}</span></div>`).join('')}</div>`
}

export function showDetail(html) {
  const d = $('detail')
  if (!html) { d.classList.remove('open'); return }
  d.innerHTML = html
  d.classList.add('open')
}

export function toast(html, kind = '') {
  const t = document.createElement('div')
  t.className = 'toast ' + kind
  t.innerHTML = html
  $('toasts').appendChild(t)
  setTimeout(() => t.classList.add('out'), 3200)
  setTimeout(() => t.remove(), 3800)
}

export function tip(html, x, y) {
  const t = $('tip')
  if (!html) { t.style.display = 'none'; return }
  t.innerHTML = html
  t.style.display = 'block'
  t.style.left = x + 16 + 'px'
  t.style.top = y + 14 + 'px'
}

export function countUp(el, to, dur = 1600, onTick) {
  const t0 = performance.now()
  let last = -1
  const step = () => {
    const k = Math.min(1, (performance.now() - t0) / dur)
    const v = to * (1 - Math.pow(1 - k, 3))
    el.textContent = v.toFixed(1)
    const whole = Math.floor(v)
    if (whole !== last) { last = whole; onTick?.() }
    if (k < 1) requestAnimationFrame(step)
  }
  step()
}
