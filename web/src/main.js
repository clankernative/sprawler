import './style.css'
import { createWorld } from './scene.js'
import { AtlasView, GRADE } from './atlas.js'
import { initAudio, sfx, toggleMute } from './audio.js'
import * as H from './hud.js'
import { exportView } from './export.js'
import { createAdmin } from './admin.js'
import { openSetup, setupOpen } from './setup.js'
import { buildInbox, loadMarks, mark, status, summarize } from './inbox.js'

const $ = (id) => document.getElementById(id)
const world = createWorld($('stage'))
const view = new AtlasView(world)
let A = null
let version = 0
let tab = 'inbox'
let curCommit = null
let replayTimer = null
let booted = false
let isStatic = false
let adminOn = false
// render debug panel (` key): switch each rendering stage off live to find GPU-specific artifacts
const dbg = { bloom: true, sanitize: true, fx: true, msaa: true, floor: true, stars: true, particles: true, shift: true }
function applyDbg() {
  world.bloom.enabled = dbg.bloom && !document.body.classList.contains('doc')
  world.sanitize.enabled = dbg.sanitize
  world.fx.enabled = dbg.fx
  world.floor.visible = dbg.floor
  world.stars.visible = dbg.stars && !document.body.classList.contains('doc')
  if (view.pts) view.pts.visible = dbg.particles && !document.body.classList.contains('doc')
  const n = dbg.msaa ? 4 : 0
  for (const t of [world.composer.renderTarget1, world.composer.renderTarget2]) if (t.samples !== n) { t.samples = n; t.dispose() }
}
function renderDbg() {
  let el = document.getElementById('dbg')
  if (!el) {
    el = document.createElement('div'); el.id = 'dbg'; document.body.appendChild(el)
    el.addEventListener('change', (e) => { const k = e.target.dataset.k; if (k) { dbg[k] = e.target.checked; applyDbg(); e.target.blur() } })
  }
  el.innerHTML = '<b>RENDER DEBUG</b> <small>` to close</small>' + Object.keys(dbg).map((k) => `<label><input type="checkbox" data-k="${k}" ${dbg[k] ? 'checked' : ''}> ${k}</label>`).join('')
}
addEventListener('keydown', (e) => {
  if (e.key !== '`' || e.target.tagName === 'INPUT') return
  const el = document.getElementById('dbg')
  if (el && el.style.display !== 'none') el.style.display = 'none'
  else { renderDbg(); document.getElementById('dbg').style.display = 'block' }
})

// ── loop ────────────────────────────────────────────────────────────────────
let last = performance.now()
let frameN = 0
// horizontal centre of the area not covered by the left panel, right panel or detail card
function freeCenter() {
  const b = document.body.classList
  let x0 = 0, x1 = innerWidth
  if (!b.contains('hideL')) x0 = Math.max(0, $('left').getBoundingClientRect().right)
  if (!b.contains('hideR')) x1 = Math.min(x1, $('right').getBoundingClientRect().left)
  const d = $('detail')
  if (d.classList.contains('open')) x1 = Math.min(x1, d.getBoundingClientRect().left)
  return x1 - x0 < 200 ? innerWidth / 2 : (x0 + x1) / 2
}
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000)
  last = now
  const t = now / 1000
  if (!adminOn) { // the 3D view sleeps while the tables are open
    view.update(t, dt)
    if (booted && (frameN++ % 6 === 0)) world.setFrameShift(dbg.shift ? innerWidth / 2 - freeCenter() : 0)
    if (booted && frameN % 6 === 3) updateScope()
    world.tick(t, dt)
  }
  requestAnimationFrame(loop)
}
requestAnimationFrame(loop)

async function fetchAtlas() {
  try {
    const r = await fetch('/api/atlas', { cache: 'no-store' })
    if (r.ok) {
      const j = await r.json()
      if (j.modules) return j
    }
  } catch { /* fall through */ }
  isStatic = true
  const r = await fetch('./atlas.json', { cache: 'no-store' })
  return r.json()
}

function renderAll() {
  H.renderTop(A)
  H.renderLeft(A, view.filters, view.sel?.type === 'ctx' ? view.sel.key : null)
  H.renderRight(A, tab, curCommit)
}

// ── boot: a title card over the live map, which assembles itself behind it ──
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let bootReady = false

function stage(text, frac) {
  $('bootStage').textContent = text
  $('bootBar').style.width = `${Math.round(frac * 100)}%`
}

function tally(id, to, dur = 650) {
  const el = $(id)
  el.parentElement.classList.add('on')
  const t0 = performance.now()
  return new Promise((done) => {
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / dur)
      el.textContent = Math.round(to * (1 - Math.pow(1 - k, 3))).toLocaleString()
      if (k < 1) requestAnimationFrame(step)
      else done()
    }
    step()
  })
}

async function boot() {
  world.controls.autoRotate = true
  world.controls.autoRotateSpeed = 0.35
  world.scan()
  stage('connecting to the scanner', 0.08)
  // first run: no saved workspace config yet → choose what to scan, then wait for the first scan
  try {
    const v = await (await fetch('/api/version', { cache: 'no-store' })).json()
    if (v.setup) {
      stage('first run: choose what to scan', 0.05)
      await openSetup({ firstRun: true })
      stage('scanning the workspace', 0.08)
      for (let i = 0; i < 600; i++) {
        const s = await (await fetch('/api/version', { cache: 'no-store' })).json()
        if (s.error || (!s.setup && !s.scanning && s.version > 0)) break
        await sleep(500)
      }
    }
  } catch { /* static build: no server, no setup */ }
  try {
    A = await fetchAtlas()
  } catch {
    stage('scanner offline — run sprawler serve', 0)
    return
  }
  const p = A.project
  $('bootTitle').textContent = p.title
  $('bootSub').textContent = [p.branch, p.sha].filter(Boolean).join(' · ') || 'working tree'
  version = A.scan || 0
  view.onCtxClick = (k, e) => (e?.shiftKey ? togglePick(k) : (clearRoom(), focusCtx(k)))
  view.onSeamClick = (id) => { clearRoom(); selectSeam(id) }
  view.build(A)
  world.camera.position.set(0, view.L.extent * 1.7, view.L.extent * 2.3)
  world.controls.target.set(0, 0, 0)
  renderAll()
  view.startBoot() // islands rise behind the card
  world.scan()
  bootReady = true
  $('boot').classList.add('live')
  const sm = summarize(A)
  stage(`reading ${(A.stats?.files ?? A.modules.length).toLocaleString()} files`, 0.3)
  await tally('bsMods', A.modules.length)
  stage('judging every dependency', 0.55)
  await tally('bsDeps', A.score.edges)
  stage('mapping bounded contexts', 0.76)
  await tally('bsCtx', A.contexts.length, 450)
  stage('collecting findings', 0.92)
  if (sm.fix) $('bsFix').parentElement.classList.add('hot')
  await tally('bsFix', sm.fix + sm.improve + sm.check, 450)
  stage('ready', 1)
  const gc = A.score.withheld ? '#5c6773' : GRADE[A.score.grade]
  $('bootGrade').innerHTML = `<b style="color:${gc};text-shadow:0 0 40px ${gc}">${A.score.withheld ? '?' : A.score.grade}</b><span>${A.score.total}<small>/100</small><i>${H.esc((A.score.label || 'hexagon integrity').toLowerCase())}${A.score.withheld ? ' · not enough evidence' : ''}</i></span>`
  $('bootGrade').classList.add('on')
  await sleep(450)
  $('engage').classList.add('ready')
}

function engage() {
  if (booted || !bootReady) return
  booted = true
  initAudio()
  sfx.boom()
  world.controls.autoRotate = false
  $('boot').classList.add('gone')
  document.body.classList.add('on')
  setTimeout(() => sfx.scan(), 150)
  world.scan()
  world.flyTo([0, 0, 0], view.L.extent * 1.55, 2.6)
  setTimeout(() => world.shake(0.6), 2000)
  setTimeout(() => {
    const el = $('scoreNum')
    if (el) H.countUp(el, A.score.total, 1500, sfx.tick)
  }, 1200)
  setTimeout(() => {
    const got = A.achievements.filter((a) => a.earned)
    got.slice(0, 3).forEach((a, i) => setTimeout(() => { H.toast(`<b>★ ${H.esc(a.title)}</b><span>+${a.xp} XP</span>`, 'gold'); sfx.chord() }, i * 650))
  }, 3200)
  poll()
  if (localStorage.getItem('sprawler:mode') === 'admin') setTimeout(() => setAdmin(true), 300)
}
$('boot').addEventListener('pointerdown', engage)
addEventListener('keydown', (e) => {
  if (booted || setupOpen() || e.metaKey || e.ctrlKey || e.altKey) return
  if (bootReady) { e.preventDefault(); engage() }
})

// ── live ────────────────────────────────────────────────────────────────────
async function poll() {
  if (isStatic) { H.setLive('static', 'STATIC SNAPSHOT'); return }
  try {
    const r = await fetch('/api/version', { cache: 'no-store' })
    const j = await r.json()
    if (j.scanning) H.setLive('scan', 'RESCANNING…')
    else if (j.error) H.setLive('err', 'SCAN ERROR')
    else H.setLive('ok', `LIVE · scan #${j.version}`)
    if (j.version && j.version !== version && !j.scanning) {
      version = j.version
      await applyUpdate()
    }
  } catch {
    H.setLive('err', 'OFFLINE')
  }
  setTimeout(poll, 2000)
}

async function applyUpdate() {
  const old = A
  const fresh = await fetchAtlas()
  const oldV = new Set(old.violations.map((v) => v.id))
  const newV = new Set(fresh.violations.map((v) => v.id))
  const fixed = [...oldV].filter((x) => !newV.has(x)).length
  const added = [...newV].filter((x) => !oldV.has(x)).length
  const had = new Set(old.achievements.filter((a) => a.earned).map((a) => a.id))
  A = fresh
  view.build(A, { instant: true })
  renderAll()
  refreshDetail()
  if (adminOn) { admin.setAtlas(A); admin.render() }
  world.scan()
  sfx.scan()
  const d = +(A.score.total - old.score.total).toFixed(1)
  H.toast(`<b>RESCAN</b><span>${A.score.total} [${A.score.grade}] ${d ? (d > 0 ? `▲${d}` : `▼${-d}`) : '±0'}</span>`, d < 0 ? 'bad' : '')
  if (fixed) { setTimeout(() => { H.toast(`<b>◈ ${fixed} FINDING${fixed > 1 ? 'S' : ''} RESOLVED</b><span>+${fixed * 50} XP</span>`, 'gold'); sfx.chord() }, 400) }
  if (added) { setTimeout(() => { H.toast(`<b>⚠ ${added} NEW FINDING${added > 1 ? 'S' : ''}</b><span>a new rule break appeared</span>`, 'bad'); sfx.alarm(); world.shake(1.2) }, 400) }
  for (const a of A.achievements) if (a.earned && !had.has(a.id)) setTimeout(() => { H.toast(`<b>★ UNLOCKED · ${H.esc(a.title)}</b><span>+${a.xp} XP</span>`, 'gold'); sfx.chord() }, 900)
}

// ── copy agent prompts ──────────────────────────────────────────────────────
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
}

function copyThreat(i) {
  const v = A.violations[i]
  if (!v?.prompt) return
  copyText(v.prompt)
  sfx.chord()
  H.toast(`<b>⧉ FIX PROMPT COPIED</b><span>${H.esc(v.rule)} · ${H.esc(H.short(v.source))}${v.line ? ':' + v.line : ''}</span>`, 'gold')
}

function copyRule(rule) {
  const list = A.violations.filter((v) => v.rule === rule && v.prompt)
  if (!list.length) return
  const head = `# ${list.length} \`${rule}\` findings — fix each one below\n\nWork through them one at a time; re-run the check after each.\n\n`
  copyText(head + list.map((v, k) => `<!-- finding ${k + 1}/${list.length} -->\n${v.prompt}`).join('\n\n---\n\n'))
  sfx.chord()
  H.toast(`<b>⧉ ${list.length} PROMPTS COPIED</b><span>${H.esc(rule)}</span>`, 'gold')
}

// ── flows & ports ───────────────────────────────────────────────────────────
let flowTimer = null
function stopFlow() { if (flowTimer) { clearInterval(flowTimer); flowTimer = null } }

function selectFlow(i, fly = true) {
  const f = A.flows[i]
  if (!f) return
  stopReplay(); stopFlow()
  view.select({ type: 'commit', modules: f.path.filter((id) => view.mods.has(id)) })
  if (fly) { const { pos, radius } = view.ctxCenter(f.ctx); world.flyTo(pos, Math.max(45, radius * 3.2)); sfx.whoosh() }
  sfx.click()
  H.showDetail(H.detailFlow(A, f, i))
}

function playFlow(i) {
  selectFlow(i)
  const f = A.flows[i]
  const order = Object.values(f.stages).map((ids) => ids.filter((id) => view.mods.has(id))).filter((s) => s.length)
  const visited = []
  let k = 0
  flowTimer = setInterval(() => {
    if (k >= order.length) {
      stopFlow()
      H.toast(`<b>▶ ${H.esc(f.id)}</b><span>${f.path.length} modules · ${f.violations.length ? f.violations.length + ' findings on path' : 'clean path'}</span>`, f.violations.length ? 'bad' : '')
      return
    }
    for (const id of order[k]) {
      view.pulse(id, 1.3)
      for (const v of visited) view.pulseEdge(v, id, 1.2)
    }
    visited.push(...order[k])
    sfx.tick(); sfx.hover()
    k++
  }, 450)
}

function selectPort(i) {
  const p = A.ports[i]
  if (!p) return
  stopReplay(); stopFlow()
  const ids = [p.id, ...p.callers, ...p.implementers].filter((id) => view.mods.has(id))
  view.select({ type: 'commit', modules: ids })
  world.flyTo(view.posOf(p.id), view.L.extent * 1.1)
  sfx.whoosh(); sfx.click()
  view.pulse(p.id, 1.6)
  p.callers.forEach((c, n) => setTimeout(() => { view.pulse(c, 1); view.pulseEdge(c, p.id, 1) }, 200 + n * 12))
  H.showDetail(H.detailPort(A, p))
}

// ── selection ───────────────────────────────────────────────────────────────
function stopReplay() {
  if (replayTimer) { clearInterval(replayTimer); replayTimer = null; const b = $('replay'); if (b) b.textContent = '▶ REPLAY' }
}

function selectModule(id, fly = true) {
  const m = view.mods.get(id)
  if (!m) return
  stopReplay()
  curCommit = null
  view.select({ type: 'module', id })
  if (fly) { world.flyTo(view.posOf(id), 34); sfx.whoosh() }
  sfx.click()
  H.showDetail(H.detailModule(A, m, view.neighbors(id)))
  H.renderLeft(A, view.filters, null)
}

function focusCtx(key) {
  const c = view.ctxs.get(key)
  if (!c) return
  stopReplay()
  curCommit = null
  view.select({ type: 'ctx', key })
  const { pos, radius } = view.ctxCenter(key)
  world.flyTo(pos, Math.max(30, radius * 2.6))
  sfx.whoosh(); sfx.click()
  H.showDetail(H.detailCtx(A, c, view.filters.solo))
  H.renderLeft(A, view.filters, key)
}

// ── contract seams ──────────────────────────────────────────────────────────
function selectSeam(id, kind) {
  const s = (A.seams || []).find((x) => x.id === id)
  if (!s) return
  stopReplay(); stopFlow()
  const mods = [...s.emitters, ...s.handlers].filter((m) => view.mods.has(m))
  view.select({ type: 'commit', modules: mods })
  const ctxs = [...new Set(mods.map((m) => view.mods.get(m).ctx))]
  view.flashCtx(ctxs)
  let x = 0, z = 0
  for (const k of ctxs) { const { pos } = view.ctxCenter(k); x += pos[0]; z += pos[2] }
  world.flyTo([x / ctxs.length, 0, z / ctxs.length], Math.max(80, view.L.extent * 0.75))
  sfx.whoosh(); sfx.click()
  if (s.unhandled.length) { sfx.alarm(); world.shake(0.5) }
  H.showDetail(H.detailSeam(A, s, kind))
}

function copySeamReport(id) {
  const s = (A.seams || []).find((x) => x.id === id)
  if (!s) return
  copyText(H.seamReport(A, s))
  sfx.chord()
  H.toast(`<b>⧉ SEAM REPORT COPIED</b><span>${H.esc(s.id)} · ${s.matched.length} matched · ${s.unhandled.length + s.dead.length} to fix</span>`, 'gold')
}

// from a detail card: jump to the INBOX, expand the item that holds this finding, and open it
function openThreat(i) {
  tab = 'inbox'
  const it = buildInbox(A).find((x) => x.findings.includes(i))
  if (it) H.openSec('f:' + it.id)
  H.renderRight(A, tab, curCommit)
  selectThreat(i)
  const row = document.querySelector(`#rightBody [data-threat="${i}"]`)
  if (row) { row.classList.add('flash'); row.scrollIntoView({ block: 'center', behavior: 'smooth' }) }
}

function selectThreat(i) {
  const v = A.violations[i]
  if (!v) return
  stopReplay()
  const idx = view.edgeIndex(v.source, v.target)
  if (idx == null) {
    H.toast('<b>HIDDEN</b><span>turn CONTRACT SEAMS to MISMATCHES to see this one</span>')
    return
  }
  view.select({ type: 'edge', idx })
  const a = view.posOf(v.source), b = view.posOf(v.target)
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + 4, (a[2] + b[2]) / 2]
  world.flyTo(mid, Math.max(30, Math.hypot(a[0] - b[0], a[2] - b[2]) * 1.3))
  world.shake(v.severity === 'critical' ? 1.4 : 0.7)
  sfx.alarm()
  H.showDetail(H.detailThreat(A, v, i))
}

function selectCommit(i, fromReplay = false) {
  const c = A.history[i]
  if (!c) return
  if (!fromReplay) stopReplay()
  curCommit = i
  view.select({ type: 'commit', modules: c.modules.filter((m) => view.mods.has(m)) })
  view.flashCtx(c.contexts)
  if (c.shotgun) { world.shake(0.9); sfx.alarm() } else sfx.click()
  H.showDetail(H.detailCommit(A, c))
  H.renderRight(A, tab, curCommit)
}

// selecting on the map: slide the right panel away so the centred thing is visible; clearing brings it back
let autoHidR = false
function clearRoom() {
  if (!document.body.classList.contains('hideR')) { toggleDrawer('R', true); autoHidR = true }
}

function clearSel() {
  if (autoHidR && document.body.classList.contains('hideR')) toggleDrawer('R', true)
  autoHidR = false
  view.filters.solo.clear()
  stopReplay()
  stopFlow()
  curCommit = null
  view.select(null)
  H.showDetail(null)
  H.renderLeft(A, view.filters, null)
  H.renderRight(A, tab, curCommit)
}

function overview() {
  clearSel()
  world.flyTo([0, 0, 0], view.L.extent * 1.55, 1.4)
  sfx.whoosh()
}

// select nothing, isolate nothing, show the whole map (0 / ⌂ RESET / Esc until it's all back)
function resetView(fly = true) {
  const F = view.filters
  if (tangled) toggleTangle()
  F.picked.clear()
  F.isolate = 'off'
  clearSel()
  refreshFilters()
  if (fly) { world.flyTo([0, 0, 0], view.L.extent * 1.55, 1.2); sfx.whoosh() }
  H.toast('<b>⌂ SHOWING EVERYTHING</b><span>selection and isolation cleared</span>')
}

// selecting something hidden by isolation drops the isolation, so you never land in empty space
const _select = view.select.bind(view)
view.select = (sel) => {
  const allow = sel ? view.allowCtx() : null
  if (allow) {
    const ids = sel.type === 'module' ? [sel.id] : sel.type === 'commit' ? sel.modules
      : sel.type === 'edge' ? [view.atlas.edges[sel.idx]?.source, view.atlas.edges[sel.idx]?.target] : []
    const ctxs = sel.type === 'ctx' ? [sel.key] : ids.map((id) => view.mods.get(id)?.ctx).filter(Boolean)
    if (ctxs.some((k) => !allow.has(k))) {
      view.filters.picked.clear()
      view.filters.isolate = 'off'
      H.toast('<b>SHOWING ALL CONTEXTS</b><span>what you picked was outside the isolated ones</span>')
      setTimeout(() => H.renderLeft(A, view.filters, view.sel?.type === 'ctx' ? view.sel.key : null), 0)
    }
  }
  _select(sel)
}

function updateScope() {
  const el = $('scopeBar')
  let total = 0, shown = 0
  for (const p of view.platforms.values()) { total++; if (p.g.visible) shown++ }
  const solo = [...view.filters.solo].map((l) => A.layers[l]?.label || l)
  const why = solo.length ? `Showing only ${solo.join(' + ')}` : view._allow ? 'Isolated' : view.focusCtx ? 'Focused on your selection' : null
  const on = !!why && !tangled && (solo.length > 0 || shown < total)
  el.classList.toggle('show', on)
  const txt = `${why} · ${shown} of ${total} contexts shown`
  if (on && el.dataset.t !== txt) {
    el.dataset.t = txt
    el.innerHTML = `<span>${txt}</span><button data-resetall>✕ Show everything <b>Esc</b></button>`
  }
}

function refreshDetail() {
  const s = view.sel
  if (!s) return H.showDetail(null)
  if (s.type === 'module') H.showDetail(H.detailModule(A, view.mods.get(s.id), view.neighbors(s.id)))
  else if (s.type === 'ctx') H.showDetail(H.detailCtx(A, view.ctxs.get(s.key), view.filters.solo))
}

function replay() {
  if (replayTimer) return stopReplay()
  if (!A.history.length) return
  let i = A.history.length - 1
  $('replay').textContent = '■ STOP'
  tab = 'history'
  const step = () => {
    selectCommit(i, true)
    const el = document.querySelector(`[data-commit="${i}"]`)
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    const b = $('replay'); if (b) b.textContent = '■ STOP'
    i--
    if (i < 0) stopReplay()
  }
  step()
  replayTimer = setInterval(step, 1800)
}

// ── multi-select, isolate, document mode ───────────────────────────────────
function refreshFilters() {
  view.applyState()
  H.renderLeft(A, view.filters, view.sel?.type === 'ctx' ? view.sel.key : null)
}

function togglePick(key) {
  const P = view.filters.picked
  P.has(key) ? P.delete(key) : P.add(key)
  if (!P.size) view.filters.isolate = 'off'
  sfx.toggle(P.has(key))
  view.flashCtx([key])
  refreshFilters()
}

function setIsolate(m) {
  if (m !== 'off' && !view.filters.picked.size) {
    H.toast('<b>PICK SOMETHING FIRST</b><span>tick contexts in the list, or shift-click islands</span>')
    return
  }
  view.filters.isolate = m
  sfx.toggle(m !== 'off')
  refreshFilters()
  if (m !== 'off') fitPicked()
}

function fitPicked(dir = null) {
  const keys = [...(view._allow || view.filters.picked)]
  if (!keys.length) { world.flyTo([0, 0, 0], view.L.extent * 1.55, 1.2, dir); return }
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9
  for (const k of keys) {
    const { pos, radius } = view.ctxCenter(k)
    x0 = Math.min(x0, pos[0] - radius); x1 = Math.max(x1, pos[0] + radius)
    z0 = Math.min(z0, pos[2] - radius); z1 = Math.max(z1, pos[2] + radius)
  }
  const r = Math.max(x1 - x0, z1 - z0) / 2
  world.flyTo([(x0 + x1) / 2, 0, (z0 + z1) / 2], Math.max(40, r * 2.6), 1.2, dir)
  sfx.whoosh()
}

function toggleDrawer(side, auto = false) {
  const on = document.body.classList.toggle('hide' + side)
  $(side === 'L' ? 'lDrawer' : 'rDrawer').textContent = side === 'L' ? (on ? '›' : '‹') : (on ? '‹' : '›')
  if (!auto) { sfx.whoosh(); if (side === 'R') autoHidR = false }
}
$('lDrawer').addEventListener('click', () => toggleDrawer('L'))
$('rDrawer').addEventListener('click', () => toggleDrawer('R'))

// ── export ──────────────────────────────────────────────────────────────────
const exOpts = { format: 'png', bg: 'scene', info: true, labels: true, scale: 2 }
function openExport(on = true) { $('exportModal').classList.toggle('open', on); if (on) sfx.click() }
$('exportBtn').addEventListener('click', () => openExport(true))
$('exCancel').addEventListener('click', () => openExport(false))
$('exportModal').addEventListener('click', (e) => {
  if (e.target.id === 'exportModal') return openExport(false)
  const b = e.target.closest('button')
  if (!b) return
  const k = Object.keys(b.dataset).find((x) => x.startsWith('ex'))
  if (!k) return
  const key = k.slice(2).toLowerCase(), v = b.dataset[k]
  exOpts[key] = key === 'scale' ? +v : key === 'info' || key === 'labels' ? v === '1' : v
  b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b))
  sfx.toggle(true)
})
$('exGo').addEventListener('click', async () => {
  openExport(false)
  H.toast('<b>⤓ RENDERING…</b><span>high-resolution export</span>')
  try {
    const r = await exportView(exOpts, { world, A })
    window.__lastExport = r
    sfx.chord()
    H.toast(`<b>⤓ EXPORTED</b><span>${H.esc(r.name)} · ${r.w}×${r.h}${r.pages > 1 ? ` · ${r.pages} pages` : ''}</span>`, 'gold')
  } catch (err) {
    console.error(err)
    H.toast(`<b>EXPORT FAILED</b><span>${H.esc(err.message)}</span>`, 'bad')
  }
})

let docMode = false
function setDocMode(on) {
  if (on === docMode) return
  docMode = on
  world.setDoc(on)
  view.setDoc(on)
  document.body.classList.toggle('doc', on)
  $('docBtn').classList.toggle('on', on)
  sfx.toggle(on)
}
function toggleDoc() {
  setDocMode(!docMode)
  if (docMode) world.topView()
}

// ── modes ───────────────────────────────────────────────────────────────────
function setMode(m) {
  view.setMode(m)
  document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === m))
  sfx.toggle(true)
}

let tangled = false
function toggleTangle() {
  tangled = !tangled
  if (tangled) { view.select(null); H.showDetail(null) }
  view.setTangle(tangled)
  $('tangleBtn').classList.toggle('on', tangled)
  sfx.toggle(tangled); sfx.whoosh()
  world.shake(0.6)
  if (tangled) {
    H.toast('<b>TANGLE MODE</b><span>what a generic force-directed graph shows you</span>', 'bad')
    world.flyTo([0, view.L.extent * 0.6, 0], view.L.extent * 1.9, 1.6)
  } else {
    H.toast('<b>HEX MODE</b><span>the same graph, placed by its architecture</span>')
    world.flyTo([0, 0, 0], view.L.extent * 1.55, 1.6)
  }
}

// ── preset views, saved views, inbox actions ───────────────────────────────
const EXPLORE = ['flows', 'ports', 'trophies']
let lastSub = 'flows'

// every preset starts from a clean slate, so it looks the same no matter what you did before
function applyView(v = {}) {
  stopReplay(); stopFlow()
  const F = view.filters
  const wantTangle = !!v.tangle
  if (wantTangle !== tangled) toggleTangle()
  setDocMode(!!v.doc)
  const height = v.height || 'traffic', seams = v.seams || 'all'
  let rebuild = false
  if (height !== F.height) { F.height = height; rebuild = true }
  if (seams !== F.seams) { F.seams = seams; H.setSeamMode(seams); rebuild = true }
  F.picked = new Set((v.pick || []).filter((k) => view.ctxs.has(k)))
  F.isolate = F.picked.size ? (v.isolate || 'off') : 'off'
  F.labels = v.labels || 'all'
  F.focusHide = v.focusHide !== false
  curCommit = null
  view.sel = null
  if (rebuild) view.build(A, { instant: true })
  view.mode = v.mode || 'structure'
  view.select(v.select || null)
  H.showDetail(null)
  if (v.tab) { tab = v.tab; if (EXPLORE.includes(tab)) lastSub = tab }
  refreshFilters()
  H.renderRight(A, tab, curCommit)
  if (wantTangle) return
  const cam = v.camera
  if (v.cam) {
    const t = v.cam.t, p = v.cam.p
    world.flyTo(t, Math.hypot(p[0] - t[0], p[1] - t[1], p[2] - t[2]), 1.2, [p[0] - t[0], p[1] - t[1], p[2] - t[2]])
  } else if (cam === 'top') world.topView()
  else if (cam === 'fit') fitPicked()
  else if (cam === 'fittop') fitPicked([0, 1, 0.0001])
  else if (cam === 'module' && v.select?.id) world.flyTo(view.posOf(v.select.id), 34)
  else if (cam === 'overview') world.flyTo([0, 0, 0], view.L.extent * 1.55, 1.3)
  sfx.whoosh()
}

const ctxOfTier = (...t) => A.contexts.filter((c) => t.includes(c.tier)).map((c) => c.key)
const PRESETS = [
  { label: 'Overview', desc: 'everything, angled camera', v: () => ({ camera: 'overview' }) },
  { label: 'Fix first', desc: 'contexts with FIX items, plus what they touch', v: () => ({ pick: buildInbox(A).filter((i) => i.kind === 'fix').flatMap((i) => i.view?.pick || []), isolate: 'plus', mode: 'threats', focusHide: false, camera: 'fit', tab: 'inbox' }) },
  { label: 'Architecture diagram', desc: 'paper, top-down, section labels — best for export', v: () => ({ doc: true, labels: 'ctx', camera: 'top' }) },
  { label: 'Data flow', desc: 'particles run along every dependency, in its direction', v: () => ({ mode: 'flow', labels: 'ctx', camera: 'overview' }) },
  { label: 'Boundaries', desc: 'SDK ports + Rust host and every contract seam', v: () => ({ pick: ctxOfTier('sdk', 'host'), isolate: 'only', seams: 'all', camera: 'fittop' }) },
  { label: 'Ports', desc: 'the SDK ring and everything that calls it', v: () => ({ pick: ctxOfTier('sdk'), isolate: 'off', focusHide: false, camera: 'overview', tab: 'ports' }) },
  { label: 'Worst context', desc: 'the lowest-scoring context and its neighbours', v: () => ({ pick: [A.score.worst?.key].filter(Boolean), isolate: 'plus', camera: 'fit' }) },
  { label: 'Change hotspots', desc: 'height = commits touching it, git history open', v: () => ({ height: 'churn', camera: 'overview', tab: 'history' }) },
  { label: 'Hairball comparison', desc: 'the same graph as a generic force layout', v: () => ({ tangle: true }) },
]
function runPreset(i) {
  const p = PRESETS[i]
  if (!p) return
  applyView(p.v())
  H.toast(`<b>▦ ${H.esc(p.label)}</b><span>${H.esc(p.desc)}</span>`)
  toggleViews(false)
}

const savedKey = () => `sprawler:${A.project.name}:views`
const loadSaved = () => { try { return JSON.parse(localStorage.getItem(savedKey()) || '[]') } catch { return [] } }
function currentSpec() {
  const F = view.filters
  return { pick: [...F.picked], isolate: F.isolate, labels: F.labels, focusHide: F.focusHide, seams: F.seams, height: F.height,
    mode: view.mode, doc: docMode, tangle: tangled, tab, cam: { p: world.camera.position.toArray(), t: world.controls.target.toArray() } }
}
function renderViews() {
  const saved = loadSaved()
  $('viewsMenu').innerHTML = '<div class="vh">PRESETS</div>' +
    PRESETS.map((p, i) => `<div class="vrow" data-preset="${i}"><b>${i + 1}</b><span>${H.esc(p.label)}<small>${H.esc(p.desc)}</small></span></div>`).join('') +
    '<div class="vh">SAVED IN THIS BROWSER</div>' +
    (saved.map((s, i) => `<div class="vrow" data-saved="${i}"><b>★</b><span>${H.esc(s.name)}</span><a data-delsaved="${i}" title="delete">✕</a></div>`).join('') || '<div class="vnone">none yet</div>') +
    '<div class="vrow save" data-savecur><b>+</b><span>Save current view…</span></div>'
}
function toggleViews(on) {
  const m = $('viewsMenu')
  on = on ?? !m.classList.contains('open')
  if (on) renderViews()
  m.classList.toggle('open', on)
}
$('viewsBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleViews(); sfx.click() })
$('viewsMenu').addEventListener('click', (e) => {
  e.stopPropagation()
  const del = e.target.closest('[data-delsaved]')
  if (del) { const s = loadSaved(); s.splice(+del.dataset.delsaved, 1); localStorage.setItem(savedKey(), JSON.stringify(s)); return renderViews() }
  const p = e.target.closest('[data-preset]')
  if (p) return runPreset(+p.dataset.preset)
  const sv = e.target.closest('[data-saved]')
  if (sv) { const s = loadSaved()[+sv.dataset.saved]; toggleViews(false); applyView(s.spec); return H.toast(`<b>★ ${H.esc(s.name)}</b><span>saved view</span>`) }
  if (e.target.closest('[data-savecur]')) {
    const name = prompt('Name this view', `view ${loadSaved().length + 1}`)
    if (!name) return
    const s = loadSaved(); s.push({ name, spec: currentSpec() }); localStorage.setItem(savedKey(), JSON.stringify(s))
    sfx.chord(); renderViews(); H.toast(`<b>★ SAVED</b><span>${H.esc(name)}</span>`, 'gold')
  }
})
addEventListener('click', () => toggleViews(false))

function toggleHelp(on) {
  const m = $('helpModal')
  m.classList.toggle('open', on ?? !m.classList.contains('open'))
}
$('helpBtn').addEventListener('click', () => toggleHelp())
$('helpModal').addEventListener('click', (e) => { if (e.target.id === 'helpModal' || e.target.closest('[data-closehelp]')) toggleHelp(false) })

const itemById = (id) => buildInbox(A).find((x) => x.id === id)
function showItem(id) {
  const it = itemById(id)
  if (!it) return
  if (it.view) applyView({ labels: 'all', ...it.view, tab: it.view.tab || 'inbox' })
  if (it.view?.seam) selectSeam(it.view.seam)
  else H.showDetail(H.detailItem(A, it))
  sfx.click()
}
function copyItem(id) {
  const it = itemById(id)
  if (!it?.findings.length) return
  const list = it.findings.map((i) => A.violations[i]).filter((v) => v?.prompt)
  const head = list.length > 1 ? `# ${list.length} findings: ${it.title}\n\n${it.why}\n\nWork through them one at a time; re-run the check after each.\n\n` : ''
  copyText(head + list.map((v, k) => (list.length > 1 ? `<!-- finding ${k + 1}/${list.length} -->\n` : '') + v.prompt).join('\n\n---\n\n'))
  sfx.chord()
  H.toast(`<b>⧉ ${list.length} PROMPT${list.length > 1 ? 'S' : ''} COPIED</b><span>${H.esc(it.title)}</span>`, 'gold')
}
function markItem(id, state) {
  const it = itemById(id)
  if (!it) return
  mark(A, id, state, it.count)
  sfx.toggle(!!state)
  H.toast(state === 'done' ? `<b>✓ DONE</b><span>hidden until it gets worse — see DONE & SNOOZED</span>` : state === 'snooze' ? `<b>⏾ SNOOZED 7 DAYS</b><span>see DONE & SNOOZED at the bottom</span>` : `<b>↺ BACK IN THE INBOX</b><span>${H.esc(it.title)}</span>`)
  H.renderRight(A, tab, curCommit)
  H.renderLeft(A, view.filters, view.sel?.type === 'ctx' ? view.sel.key : null)
}
$('tangleBtn').addEventListener('click', toggleTangle)
$('topBtn').addEventListener('click', () => { world.topView(); sfx.whoosh() })
$('docBtn').addEventListener('click', toggleDoc)

// ── tables view: hot-swap between the atlas and a plain admin screen (G) ────
const admin = createAdmin($('admin'), {
  exit: () => setAdmin(false),
  open: (type, id) => {
    setAdmin(false)
    setTimeout(() => {
      if (type === 'finding') openThreat(+id)
      else if (type === 'item') showItem(id)
      else if (type === 'ctx') focusCtx(id)
      else if (type === 'module') selectModule(id)
      else if (type === 'seam') selectSeam(id)
      else if (type === 'flow') { tab = lastSub = 'flows'; H.renderRight(A, tab, curCommit); playFlow(+id) }
      else if (type === 'port') { tab = lastSub = 'ports'; H.renderRight(A, tab, curCommit); selectPort(+id) }
      else if (type === 'commit') { tab = 'history'; H.renderRight(A, tab, curCommit); selectCommit(+id) }
    }, 60)
  },
  copyFinding: (i) => copyThreat(i),
  copyItem: (id) => copyItem(id),
  copyMany: (list) => {
    const vs = list.map((i) => A.violations[i]).filter((v) => v?.prompt)
    if (!vs.length) return
    const many = vs.length > 1
    copyText((many ? `# ${vs.length} findings — fix each one below\n\nWork through them one at a time; re-run the check after each.\n\n` : '') +
      vs.map((v, k) => (many ? `<!-- finding ${k + 1}/${vs.length} -->\n` : '') + v.prompt).join('\n\n---\n\n'))
    sfx.chord()
    H.toast(`<b>⧉ ${vs.length} PROMPT${many ? 'S' : ''} COPIED</b><span>ready to paste into an agent</span>`, 'gold')
  },
  mark: (id, state) => markItem(id, state || null),
})
function setAdmin(on) {
  if (on === adminOn || !A) return
  adminOn = on
  document.body.classList.toggle('admin', on)
  localStorage.setItem('sprawler:mode', on ? 'admin' : 'atlas')
  if (on) { toggleViews(false); H.tip(null); admin.setAtlas(A); admin.render() }
  else last = performance.now()
  sfx.toggle(on)
}
$('adminBtn').addEventListener('click', () => setAdmin(true))
$('resetBtn').addEventListener('click', () => resetView())
$('settingsBtn').addEventListener('click', async () => {
  if (isStatic) return
  sfx.click()
  const r = await openSetup()
  if (r) H.toast('<b>⚙ SETTINGS SAVED</b><span>rescanning the workspace</span>')
})
$('scopeBar').addEventListener('click', (e) => { if (e.target.closest('[data-resetall]')) resetView() })
$('muteBtn').addEventListener('click', () => { const m = toggleMute(); $('muteBtn').textContent = m ? '♪̸' : '♪' })

// ── panels ──────────────────────────────────────────────────────────────────
$('left').addEventListener('click', (e) => {
  const F = view.filters
  const gt = e.target.closest('[data-gotab]')
  if (gt) { tab = gt.dataset.gotab; if (document.body.classList.contains('hideR')) toggleDrawer('R'); sfx.click(); return H.renderRight(A, tab, curCommit) }
  const pk = e.target.closest('[data-pick]')
  if (pk) { e.stopPropagation(); return togglePick(pk.dataset.pick) }
  const iso = e.target.closest('[data-iso]')
  if (iso) return setIsolate(iso.dataset.iso)
  if (e.target.closest('[data-fit]')) return fitPicked()
  if (e.target.closest('[data-clearpick]')) { F.picked.clear(); F.isolate = 'off'; sfx.toggle(false); return refreshFilters() }
  const hb = e.target.closest('[data-height]')
  if (hb) { F.height = hb.dataset.height; sfx.whoosh(); world.shake(0.3); view.build(A, { instant: true }); return refreshFilters() }
  const lt = e.target.closest('[data-labtier]')
  if (lt) { e.stopPropagation(); const t = lt.dataset.labtier; F.labelTiers.has(t) ? F.labelTiers.delete(t) : F.labelTiers.add(t); sfx.toggle(!F.labelTiers.has(t)); return refreshFilters() }
  const sr = e.target.closest('[data-seamrow]')
  if (sr) return selectSeam(sr.dataset.seamrow)
  const lm = e.target.closest('[data-labmode]')
  if (lm) { F.labels = lm.dataset.labmode; sfx.toggle(F.labels === 'all'); return refreshFilters() }
  const sm = e.target.closest('[data-seam]')
  if (sm) {
    F.seams = sm.dataset.seam
    H.setSeamMode(F.seams)
    sfx.toggle(F.seams !== 'off')
    view.build(A, { instant: true })
    H.renderRight(A, tab, curCommit)
    return refreshFilters()
  }
  const r = e.target.closest('[data-tier],[data-layer],[data-toggle],[data-ctx]')
  if (!r) return
  if (r.dataset.ctx) { clearRoom(); return focusCtx(r.dataset.ctx) }
  if (r.dataset.tier) { const t = r.dataset.tier; F.tiers.has(t) ? F.tiers.delete(t) : F.tiers.add(t) }
  if (r.dataset.layer) { const l = r.dataset.layer; F.layers.has(l) ? F.layers.delete(l) : F.layers.add(l) }
  if (r.dataset.toggle) F[r.dataset.toggle] = !F[r.dataset.toggle]
  sfx.toggle(true)
  view.applyState()
  H.renderLeft(A, F, view.sel?.type === 'ctx' ? view.sel.key : null)
})

document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab === 'explore' ? lastSub : b.dataset.tab; sfx.toggle(true); H.renderRight(A, tab, curCommit) }))

$('rightBody').addEventListener('click', (e) => {
  if (e.target.closest('#replay')) return replay()
  if (e.target.closest('[data-onboard]')) { localStorage.setItem('sprawler:onboarded', '1'); return H.renderRight(A, tab, curCommit) }
  const sb = e.target.closest('[data-sub]')
  if (sb) { tab = lastSub = sb.dataset.sub; sfx.toggle(true); return H.renderRight(A, tab, curCommit) }
  const mk = e.target.closest('[data-mark]')
  if (mk) { e.stopPropagation(); return markItem(mk.dataset.item, mk.dataset.mark) }
  const sh = e.target.closest('[data-show]')
  if (sh) { e.stopPropagation(); return showItem(sh.dataset.show) }
  const ci = e.target.closest('[data-copyitem]')
  if (ci) { e.stopPropagation(); return copyItem(ci.dataset.copyitem) }
  const wc = e.target.closest('.wchip[data-ctx]')
  if (wc) return focusCtx(wc.dataset.ctx)
  const srr = e.target.closest('[data-seamrow]')
  if (srr) return selectSeam(srr.dataset.seamrow)
  const cp = e.target.closest('[data-copy]')
  if (cp) { e.stopPropagation(); return copyThreat(+cp.dataset.copy) }
  const cr = e.target.closest('[data-copy-rule]')
  if (cr) { e.stopPropagation(); return copyRule(cr.dataset.copyRule) }
  const pl = e.target.closest('[data-play]')
  if (pl) { e.stopPropagation(); return playFlow(+pl.dataset.play) }
  const fl = e.target.closest('[data-flow]')
  if (fl) return selectFlow(+fl.dataset.flow)
  const po = e.target.closest('[data-port]')
  if (po) return selectPort(+po.dataset.port)
  const t = e.target.closest('[data-threat]')
  if (t) return selectThreat(+t.dataset.threat)
  const c = e.target.closest('[data-commit]')
  if (c) return selectCommit(+c.dataset.commit)
  const m = e.target.closest('[data-mod]')
  if (m) return selectModule(m.dataset.mod)
})

$('detail').addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) return clearSel()
  const cp = e.target.closest('[data-copy]')
  if (cp) return copyThreat(+cp.dataset.copy)
  const sl = e.target.closest('[data-sololayer]')
  if (sl) {
    // solo layers: first click shows only that layer, more clicks add/remove, removing the last shows all
    const S = view.filters.solo, k = sl.dataset.sololayer
    S.has(k) ? S.delete(k) : S.add(k)
    sfx.toggle(S.has(k))
    view.applyState()
    return refreshDetail()
  }
  const rep = e.target.closest('[data-seamreport]')
  if (rep) return copySeamReport(rep.dataset.seamreport)
  const ci = e.target.closest('[data-copyitem]')
  if (ci) return copyItem(ci.dataset.copyitem)
  const dc = e.target.closest('[data-ctx]')
  if (dc && view.ctxs.has(dc.dataset.ctx)) return focusCtx(dc.dataset.ctx)
  const th = e.target.closest('[data-threat]')
  if (th) return openThreat(+th.dataset.threat)
  const pl = e.target.closest('[data-play]')
  if (pl) return playFlow(+pl.dataset.play)
  const m = e.target.closest('[data-mod]')
  if (m && view.mods.has(m.dataset.mod)) selectModule(m.dataset.mod)
})

// ── pointer ─────────────────────────────────────────────────────────────────
const canvas = world.renderer.domElement
let down = null
let hoverPending = null
canvas.addEventListener('pointerdown', (e) => { down = e.button === 0 ? [e.clientX, e.clientY] : null })
canvas.addEventListener('pointermove', (e) => {
  if (!booted) return
  if (hoverPending) return
  hoverPending = requestAnimationFrame(() => {
    hoverPending = null
    const hit = view.pick((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1)
    const id = hit?.type === 'module' ? hit.id : null
    if (id !== view.hoverId) { view.hoverId = id; if (id) sfx.hover() }
    canvas.style.cursor = hit ? 'pointer' : ''
    if (hit?.type === 'module') {
      const m = view.mods.get(hit.id), l = A.layers[m.layer] || {}
      H.tip(`<b style="color:${l.color}">${H.esc(l.label || m.layer)}</b> · ${H.esc(view.ctxs.get(m.ctx)?.label)}<br><span class="tn">${H.esc(m.name)}</span><br><small>${m.loc} lines · in ${m.fanIn} · out ${m.fanOut}${m.violations ? ` · <span class="c-bad">⚠ ${m.violations}</span>` : ''}${m.well ? ' · <span style="color:#b388ff">◎ well</span>' : ''}</small>`, e.clientX, e.clientY)
    } else if (hit?.type === 'seam') {
      const s = A.seams.find((x) => x.id === hit.seam)
      const ST = { ok: '<span class="c-ok">✓ matched</span>', bad: '<span class="c-bad">✕ emitted, never handled</span>', dead: '<span style="color:#ffb020">◌ handled, never emitted</span>' }
      H.tip(`<b style="color:#ff4fd8">⇄ contract seam · ${H.esc(s.id)}</b>${hit.kind ? `<br><span class="tn">${H.esc(hit.kind)}</span> ${ST[hit.st]}` : ''}<br><small>${s.matched.length} matched · ${s.unhandled.length} unhandled · ${s.dead.length} dead — click for the seam card</small>`, e.clientX, e.clientY)
    } else if (hit?.type === 'ctx') {
      const c = view.ctxs.get(hit.key)
      H.tip(`<b>${H.esc(c.label)}</b> <span style="color:${'#ffd166'}">${c.grade}</span><br><small>${c.modules} modules · purity ${Math.round(c.purity * 100)}% · tangle ${Math.round(c.tangle * 100)}%</small>`, e.clientX, e.clientY)
    } else H.tip(null)
  })
})
canvas.addEventListener('pointerleave', () => { view.hoverId = null; H.tip(null) })
canvas.addEventListener('pointerup', (e) => {
  if (!down || !booted) return
  const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1])
  down = null
  if (moved > 5) return
  const hit = view.pick((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1)
  if (hit && !e.shiftKey) clearRoom()
  if (hit?.type === 'seam') selectSeam(hit.seam, hit.kind)
  else if (e.shiftKey && hit) togglePick(hit.type === 'module' ? view.mods.get(hit.id).ctx : hit.key)
  else if (hit?.type === 'module') selectModule(hit.id)
  else if (hit?.type === 'ctx') focusCtx(hit.key)
  else if (view.sel) clearSel()
})

// ── search ──────────────────────────────────────────────────────────────────
const search = $('search'), results = $('results')
let found = []
search.addEventListener('input', () => {
  const q = search.value.trim().toLowerCase()
  if (!q || !A) { results.style.display = 'none'; return }
  const ctx = A.contexts.filter((c) => c.label.toLowerCase().includes(q) || c.key.includes(q)).slice(0, 5).map((c) => ({ t: 'ctx', key: c.key, label: c.label, sub: c.key }))
  const mods = A.modules.filter((m) => !m.generated && (m.name.toLowerCase().includes(q) || (m.path || '').toLowerCase().includes(q))).slice(0, 12).map((m) => ({ t: 'mod', id: m.id, label: m.name, sub: H.short(m.path) }))
  found = [...ctx, ...mods]
  results.innerHTML = found.map((f, i) => `<div data-i="${i}" class="${i === 0 ? 'on' : ''}"><b>${f.t === 'ctx' ? '⬡' : '·'}</b>${H.esc(f.label)}<small>${H.esc(f.sub)}</small></div>`).join('') || '<div class="dim">no match</div>'
  results.style.display = 'block'
})
function pickFound(i) {
  const f = found[i]
  if (!f) return
  results.style.display = 'none'
  search.value = ''
  search.blur()
  clearRoom()
  f.t === 'ctx' ? focusCtx(f.key) : selectModule(f.id)
}
search.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') pickFound(0)
  if (e.key === 'Escape') { search.value = ''; results.style.display = 'none'; search.blur() }
  e.stopPropagation()
})
results.addEventListener('mousedown', (e) => { const d = e.target.closest('[data-i]'); if (d) pickFound(+d.dataset.i) })
search.addEventListener('blur', () => setTimeout(() => { results.style.display = 'none' }, 150))

// ── keys ────────────────────────────────────────────────────────────────────
addEventListener('keydown', (e) => {
  if (!booted || setupOpen() || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return
  const k = e.key.toLowerCase()
  if (adminOn) { if (k === 'g' || k === 'escape') setAdmin(false); return }
  if (k === 'g') return setAdmin(true)
  if (k === '/') { e.preventDefault(); search.focus() }
  else if (k === 'escape') {
    if ($('helpModal').classList.contains('open')) toggleHelp(false)
    else if ($('viewsMenu').classList.contains('open')) toggleViews(false)
    else if ($('exportModal').classList.contains('open')) openExport(false)
    else if (view.sel) clearSel()
    else if (view.filters.picked.size || view.filters.isolate !== 'off' || tangled) resetView(false)
    else overview()
  }
  else if (k === '0') resetView()
  else if (/^[1-9]$/.test(k)) runPreset(+k - 1)
  else if (k === '?' || k === 'h') toggleHelp()
  else if (k === 't') toggleTangle()
  else if (k === 'o') overview()
  else if (k === 'v') { world.topView(); sfx.whoosh() }
  else if (k === 'b') toggleDoc()
  else if (k === 'x') openExport(!$('exportModal').classList.contains('open'))
  else if (k === 'l') { view.filters.labels = { all: 'ctx', ctx: 'tier', tier: 'all' }[view.filters.labels]; sfx.toggle(view.filters.labels === 'all'); refreshFilters() }
  else if (k === '[') toggleDrawer('L')
  else if (k === ']') toggleDrawer('R')
  else if (k === 'f') fitPicked()
  else if (k === 'i') setIsolate({ off: 'only', only: 'plus', plus: 'off' }[view.filters.isolate])
  else if (k === 'p') { tab = 'history'; H.renderRight(A, tab, curCommit); replay() }
  else if (k === 'm') $('muteBtn').click()
  else if (k === 'c' && view.sel?.type === 'edge') {
    const i = A.violations.findIndex((v) => view.edgeIndex(v.source, v.target) === view.sel.idx)
    if (i >= 0) copyThreat(i)
  }
  else if (k === 'r' && !isStatic) { fetch('/api/rescan', { method: 'POST' }); H.toast('<b>RESCAN REQUESTED</b><span>re-running graphify + judge</span>') }
  else if (k === 'n') {
    if (!A.violations.length) return
    const cur = view.sel?.type === 'edge' ? A.violations.findIndex((v) => view.edgeIndex(v.source, v.target) === view.sel.idx) : -1
    selectThreat((cur + 1) % A.violations.length)
  }
})

window.__hex = { world, view }
boot()
