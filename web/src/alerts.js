// The town's happenings. Five layers, loudest to quietest:
//   advisor card (critical news) · site markers + off-screen arrows · minimap blips · news ticker · the world itself
// plus the morning paper (everything since your last visit) and the news-chopper idle camera.
import * as THREE from 'three'
import { FX } from './city/fx.js'

const $ = (id) => document.getElementById(id)
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const base = (id) => String(id || '').split('/').pop().replace(/\.(roc|rs|cs|json|ts|js|py)$/, '')
const SEV_ORDER = { bad: 3, warn: 2, good: 1, info: 0 }
const WEATHER = { S: ['☀️', 'Clear skies'], A: ['🌤', 'Mostly sunny'], B: ['⛅', 'Fair, some cloud'], C: ['🌥', 'Overcast'], D: ['🌧', 'Rain'], F: ['⛈', 'Storms'], '?': ['🌫', 'Fog — not enough evidence'] }
const ADVISORS = {
  transit: { icon: '🚦', name: 'Transit Advisor', c: '#e0483b' },
  zoning: { icon: '🏛', name: 'Zoning Board', c: '#e39a2d' },
  utilities: { icon: '🔌', name: 'Utilities', c: '#8b62c9' },
  planning: { icon: '📐', name: 'City Planner', c: '#2f6bff' },
  inspector: { icon: '📋', name: 'Building Inspector', c: '#2f9e66' },
}
const TRANSIT_RULES = new Set(['context-bleed', 'port-bypass', 'runtime-leak', 'native-host-link', 'tier-breach', 'undeclared-coupling'])

export class Alerts {
  constructor(ctx) {
    this.c = ctx // { world, view, H, sfx, A (getter), focusCtx, selectModule, selectThreat, selectSeam, copyThreat, clearRoom, isStatic }
    this.events = []
    this.last = 0
    this.temp = [] // short-lived markers from fresh events
    this.markEls = new Map()
    this.queue = []
    this.advisorOpen = null
    this.poiIdx = 0
    this.fx = new FX(ctx.world)
    this.tickerX = 0
    this.frame = 0
    this.mm = { canvas: $('minimap'), static: null }
    this.mm.canvas.addEventListener('pointerdown', (e) => this.minimapClick(e))
    $('ticker').addEventListener('click', (e) => {
      const n = e.target.closest('[data-news]')
      if (n) return this.flyEvent(this.byId(+n.dataset.news) || this.standing[+n.dataset.standing])
      if (e.target.closest('.mast')) this.openPaper(true)
    })
    $('tickerRoll').addEventListener('click', (e) => {
      const n = e.target.closest('[data-standing]')
      if (n) this.flyEvent(this.standing[+n.dataset.standing])
    })
    $('advisor').addEventListener('click', (e) => this.advisorClick(e))
    $('paper').addEventListener('click', (e) => this.paperClick(e))
    $('markers').addEventListener('click', (e) => {
      const m = e.target.closest('[data-mk]')
      if (m) this.flyPoi(this.pois[+m.dataset.mk])
    })
    ctx.world.setPoi(() => this.nextPoi())
  }

  get A() { return this.c.A }
  byId(id) { return this.events.find((e) => e.id === id) }
  ctxLabel(k) { return this.A?.contexts.find((c) => c.key === k)?.label || (k || '').split(':').pop() }
  modCtx(id) { return this.c.view.mods?.get(id)?.ctx }

  // ── lifecycle ────────────────────────────────────────────────────────────
  async start() {
    await this.poll(true)
    this.rebuild()
    setInterval(() => this.poll(false), 2000)
  }

  // the city was (re)built: refresh standing stories, markers, minimap, emitters
  rebuild() {
    if (!this.A || !this.c.view.plan) return
    this.standing = this.standingStories()
    this.renderTicker()
    this.buildPois()
    this.drawMinimapStatic()
    const em = []
    for (const s of this.c.view.smokeStacks || []) em.push({ kind: 'smoke', pos: [s[0], 3.2 * s[3], s[1]] })
    for (const t of this.c.view.plan.tracks) {
      const n = Math.min(4, 1 + Math.floor(Math.log2(1 + t.n)))
      for (let k = 0; k < n; k++) { const p = t.pts[Math.floor(((k + 0.5) / n) * (t.pts.length - 1))]; em.push({ kind: 'dust', pos: [p[0], 0.3, p[1]] }) }
    }
    // stink lines over the smelliest buildings (literal code smell)
    for (const m of this.A.modules) {
      const s = m.metrics?.smell || 0
      if (s < 0.4 || !this.c.view.bld?.has(m.id)) continue
      const b = this.c.view.bld.get(m.id)
      em.push({ kind: 'stink', pos: [b.x, b.height + 0.3, b.z], amt: s })
    }
    this.fx.setEmitters(em)
    this.c.view.poiSource = () => this.pois || []
  }

  async poll(first) {
    if (this.c.isStatic()) return
    try {
      const r = await fetch(`/api/events?since=${this.last}`, { cache: 'no-store' })
      if (!r.ok) return
      const j = await r.json()
      const fresh = j.events || []
      if (j.last < this.last) { this.events = []; this.last = 0; return }
      this.last = j.last
      if (!fresh.length) return
      this.events.push(...fresh)
      if (this.events.length > 400) this.events = this.events.slice(-400)
      if (!first) this.onFresh(fresh)
      this.renderTicker()
    } catch { /* server offline */ }
  }

  // live news: effects, markers, advisor
  onFresh(list) {
    const { sfx, world } = this.c
    let shake = 0
    for (const e of list) {
      const pos = this.eventPos(e)
      if (e.kind === 'build.open' && pos) { this.fx.confetti([pos[0], pos[1] + 2, pos[2]]); sfx.chord() }
      if ((e.kind === 'grade.up' || e.kind === 'trophy.won') && (pos || true)) { const p = pos || [0, 0, 0]; for (let k = 0; k < 3; k++) setTimeout(() => this.fx.firework([p[0] + (Math.random() - 0.5) * 20, 0, p[2] + (Math.random() - 0.5) * 20], ['#f2c230', '#e0483b', '#2f6bff'][k]), k * 450); sfx.chord() }
      if (e.kind === 'track.closed' && pos) { this.fx.confetti([pos[0], 1, pos[2]], 60); sfx.chord() }
      if (e.kind === 'track.cut') { sfx.horn(); if (e.sev === 'bad') setTimeout(() => sfx.alarm(), 500); shake = Math.max(shake, e.sev === 'bad' ? 1 : 0.5) }
      if (e.kind === 'build.start' || e.kind === 'build.renovate') sfx.clank()
      if (e.kind === 'bridge.broken') { sfx.alarm(); shake = 1.2 }
      if (pos && e.kind !== 'commit' && e.kind !== 'score' && e.kind !== 'boot') this.temp.push({ e, pos, until: performance.now() + 45000 })
      if (this.isCritical(e)) this.queue.push(e)
      const h = this.headline(e)
      if (h && e.kind !== 'score') this.c.H.toast(`<b>${h.icon} ${h.short ? esc(h.short) : h.text.replace(/<small>.*?<\/small>/g, '')}</b>`, e.sev === 'bad' ? 'bad' : e.sev === 'good' ? 'gold' : '')
    }
    if (shake) world.shake(shake)
    this.pumpAdvisor()
  }

  isCritical(e) {
    if (e.kind === 'track.cut') return e.sev === 'bad'
    return ['bridge.broken', 'grade.down', 'cycle.new', 'trophy.lost'].includes(e.kind)
  }

  // one scan can emit a dozen near-identical events (a new file paves a road per import): fold them
  coalesce(list) {
    const GROUP = new Set(['road.paving', 'road.open', 'build.start', 'build.renovate', 'build.open', 'build.demolish', 'track.cut', 'track.closed'])
    const out = [], idx = new Map()
    for (const e of list) {
      const k = GROUP.has(e.kind) ? `${e.kind}|${e.kind.startsWith('road') || e.kind.startsWith('track') ? e.source : e.ctx}|${Math.round(e.t / 30)}` : null
      if (k && idx.has(k)) { const g = idx.get(k); g.merged++; g.targets.push(e.target || e.module); continue }
      const g = { ...e, merged: 1, targets: [e.target || e.module] }
      if (k) idx.set(k, g)
      out.push(g)
    }
    return out
  }

  // ── headlines ────────────────────────────────────────────────────────────
  headline(e) {
    if (e.merged > 1) {
      const D = this.ctxLabel(e.ctx), src = esc(base(e.source)), m = e.merged
      const G = {
        'road.paving': { icon: '🚧', text: `Road crews pave <b>${m}</b> new roads from <b>${src}</b>`, short: `${m} new roads from ${base(e.source)}` },
        'build.start': { icon: '🏗', text: `Ground broken on <b>${m}</b> new buildings in <b>${esc(D)}</b>`, short: `${m} new buildings in ${D}` },
        'build.renovate': { icon: '🧰', text: `Scaffolding goes up on <b>${m}</b> buildings in <b>${esc(D)}</b>`, short: `Renovating ${m} buildings` },
        'build.open': { icon: '🎉', text: `<b>${m}</b> buildings open in <b>${esc(D)}</b>${e.subject ? ` — “${esc(e.subject)}”` : ''}`, short: `${m} grand openings in ${D}` },
        'build.demolish': { icon: '🧱', text: `Wrecking ball hits <b>${m}</b> buildings in <b>${esc(D)}</b>`, short: `${m} demolished in ${D}` },
        'track.cut': { icon: e.wip ? '🚜' : '⚠', text: `<b>${m}</b> ${e.wip ? 'unpermitted ' : ''}dirt roads cut from <b>${src}</b>`, short: `${m} dirt roads from ${base(e.source)}` },
        'track.closed': { icon: '🌲', text: `<b>${m}</b> dirt roads from <b>${src}</b> closed — the forest grows back`, short: `${m} dirt roads closed` },
        'road.open': { icon: '🛣', text: `<b>${m}</b> new routes open`, short: `${m} new routes` },
      }[e.kind]
      if (G) return G
    }
    const D = (k) => esc(this.ctxLabel(k))
    const n = e.aggregated ? `${e.count} ` : ''
    const name = e.module ? esc(base(e.module)) : ''
    const where = e.ctx ? ` in ${D(e.ctx)}` : ''
    const pair = e.ctxs?.length > 1 ? `${D(e.ctxs[0])} → ${D(e.ctxs[1])}` : e.ctx ? D(e.ctx) : ''
    switch (e.kind) {
      case 'boot': return e.count ? { icon: '🌅', text: `Morning in the city: ${e.count} site${e.count > 1 ? 's' : ''} under construction` } : null
      case 'build.start': return { icon: '🏗', text: e.aggregated ? `Ground broken on ${n}new buildings` : `Ground broken on <b>${name}</b>${where}`, short: `Ground broken: ${base(e.module)}` }
      case 'build.renovate': return { icon: '🧰', text: e.aggregated ? `Scaffolding goes up on ${n}buildings` : `Scaffolding goes up on <b>${name}</b>${where}`, short: `Renovating ${base(e.module)}` }
      case 'build.open': return { icon: '🎉', text: e.aggregated ? `${n}buildings open their doors` : `<b>${name}</b> opens${where}${e.subject ? ` — “${esc(e.subject)}”` : ''}`, short: `Grand opening: ${base(e.module)}` }
      case 'build.demolish': return { icon: '🧱', text: e.aggregated ? `Wrecking ball hits ${n}buildings` : `Wrecking ball hits <b>${name}</b>${where}`, short: `Demolished: ${base(e.module)}` }
      case 'build.cleared': return { icon: '🧹', text: `Rubble cleared at <b>${name}</b>${where}` }
      case 'module.added': return { icon: '🏢', text: e.aggregated ? `${n}new buildings appear` : `New building <b>${name}</b>${where}` }
      case 'module.removed': return { icon: '🏚', text: e.aggregated ? `${n}buildings removed` : `<b>${name}</b> torn down${where}` }
      case 'road.paving': return { icon: '🚧', text: e.aggregated ? `Crews pave ${n}new roads` : `Road crews pave <b>${esc(base(e.source))}</b> → <b>${esc(base(e.target))}</b>` }
      case 'road.open': return { icon: '🛣', text: `${e.count > 1 ? e.count + ' new routes' : 'New route'} open: ${pair}` }
      case 'track.cut': return {
        icon: e.wip ? '🚜' : '⚠', short: e.wip ? `Unpermitted dirt road: ${e.rule}` : `New dirt road: ${e.rule}`,
        text: e.aggregated ? `${n}dirt roads bulldozed through the woods` : e.wip
          ? `Unpermitted dirt road: <b>${esc(base(e.source))}</b> bulldozes toward <b>${esc(base(e.target))}</b> <small>${esc(e.rule)}</small>`
          : `${e.from === 'wip' ? 'Committed: ' : ''}dirt road cut from <b>${esc(base(e.source))}</b> to <b>${esc(base(e.target))}</b> <small>${esc(e.rule)}</small>`,
      }
      case 'track.closed': return { icon: '🌲', text: e.aggregated ? `${n}dirt roads closed — the forest grows back` : `Dirt road closed, forest grows back: <b>${esc(base(e.source))}</b> → <b>${esc(base(e.target))}</b>`, short: 'Dirt road closed — forest grows back' }
      case 'bridge.broken': return { icon: '⛔', text: `<b>${esc(e.seam)}</b> bridge collapses — ${esc((e.kinds || []).slice(0, 3).join(', '))} no longer handled`, short: `${e.seam} bridge collapsed` }
      case 'bridge.fixed': return { icon: '🌉', text: `<b>${esc(e.seam)}</b> bridge repaired` }
      case 'bridge.dead': return { icon: '🌁', text: `Bridge to nowhere on <b>${esc(e.seam)}</b>: ${esc((e.kinds || []).slice(0, 3).join(', '))}` }
      case 'grade.up': return { icon: '📈', text: `<b>${D(e.ctx)}</b> cleans up: ${esc(e.from)} → ${esc(e.to)}`, short: `${this.ctxLabel(e.ctx)} ${e.from} → ${e.to}` }
      case 'grade.down': return { icon: '📉', text: `<b>${D(e.ctx)}</b> slides: ${esc(e.from)} → ${esc(e.to)}`, short: `${this.ctxLabel(e.ctx)} ${e.from} → ${e.to}` }
      case 'score': return { icon: e.to >= e.from ? '⬆' : '⬇', text: `City rating ${e.from} → <b>${e.to}</b>` }
      case 'trophy.won': return { icon: '🏆', text: `Trophy won: <b>${esc(e.subject)}</b>` }
      case 'trophy.lost': return { icon: '💔', text: `Trophy lost: <b>${esc(e.subject)}</b>` }
      case 'cycle.new': return { icon: '🔁', text: `Gridlock: traffic circling between ${(e.ctxs || []).map(D).join(', ')}` }
      case 'cycle.gone': return { icon: '✅', text: `Gridlock cleared between ${(e.ctxs || []).map(D).join(', ')}` }
      case 'well.new': return { icon: '🏙', text: `Mega-tower rises: <b>${name}</b> — everyone depends on it` }
      case 'well.gone': return { icon: '🏗', text: `Mega-tower <b>${name}</b> split up` }
      case 'nest.new': return { icon: '🍝', text: `Spaghetti junction forms in <b>${D(e.ctx)}</b>` }
      case 'nest.gone': return { icon: '🛣', text: `Spaghetti junction untangled in <b>${D(e.ctx)}</b>` }
      case 'commit': return { icon: '📰', text: `${esc(e.author || 'someone')} commits “<b>${esc(e.subject)}</b>” — ${e.count || 0} building${e.count === 1 ? '' : 's'}${e.shotgun ? ' · <small>shotgun</small>' : ''}`, short: `Commit: ${e.subject}` }
      case 'branch': return { icon: '🔀', text: `City rezoned: ${esc(e.from)} → <b>${esc(e.to)}</b>` }
      default: return null
    }
  }

  standingStories() {
    const A = this.A, out = []
    const w = A.wip || {}
    const sites = (w.new || 0) + (w.mod || 0) + (w.demolished?.length || 0)
    if (sites) out.push({ icon: '🏗', text: `<b>${sites}</b> construction site${sites > 1 ? 's' : ''} open across ${w.contexts?.length || 1} district${(w.contexts?.length || 1) > 1 ? 's' : ''}`, kind: 'standing.wip', sev: 'info' })
    if (w.violations) out.push({ icon: '🚜', text: `<b>${w.violations}</b> unpermitted dirt road${w.violations > 1 ? 's' : ''} — fix before you commit`, kind: 'standing.unpermitted', sev: 'bad' })
    const broken = (A.seams || []).filter((s) => s.unhandled.length)
    for (const s of broken) out.push({ icon: '⛔', text: `<b>${esc(s.id)}</b> bridge is out: ${s.unhandled.length} kind${s.unhandled.length > 1 ? 's' : ''} never handled`, kind: 'standing.bridge', seam: s.id, sev: 'bad' })
    if (A.score.worst) out.push({ icon: '🏚', text: `Worst district: <b>${esc(A.score.worst.label)}</b> (${A.score.worst.grade}, ${A.score.worst.score})`, kind: 'standing.worst', ctx: A.score.worst.key, sev: 'warn' })
    const cars = A.edges.filter((e) => !e.seam && !e.test).length
    out.push({ icon: '🚗', text: `<b>${cars.toLocaleString()}</b> cars on the road today`, kind: 'standing.traffic', sev: 'info' })
    const [wi, wl] = WEATHER[A.score.withheld ? '?' : A.score.grade] || WEATHER['?']
    out.push({ icon: wi, text: `Weather: ${wl} — city rating <b>${A.score.total}</b>`, kind: 'standing.weather', sev: 'info' })
    const got = A.achievements.filter((a) => a.earned).length
    out.push({ icon: '🏆', text: `${got} of ${A.achievements.length} trophies in the cabinet`, kind: 'standing.trophies', sev: 'info' })
    return out
  }

  renderTicker() {
    if (!this.A) return
    const recent = this.coalesce(this.events.filter((e) => e.kind !== 'score').slice(-80)).slice(-24).reverse()
    const items = []
    for (const e of recent) {
      const h = this.headline(e)
      if (!h) continue
      items.push(`<span class="news ${e.sev}" data-news="${e.id}"><i>${h.icon}</i><b>${h.text}</b><small>${ago(e.t)}</small></span>`)
    }
    ;(this.standing || []).forEach((s, i) => items.push(`<span class="news ${s.sev}" data-standing="${i}"><i>${s.icon}</i><b>${s.text}</b></span>`))
    const html = items.join('')
    const roll = $('tickerRoll')
    if (roll.dataset.h === html) return
    roll.dataset.h = html
    roll.innerHTML = html + html // twice, for a seamless loop
    this.tickerW = 0
  }

  // ── points of interest (markers, J, chopper) ─────────────────────────────
  buildPois() {
    const v = this.c.view
    const P = []
    for (const p of v.construction?.poi() || []) {
      if (p.kind === 'new') P.push({ ...p, icon: '🏗', c: '#f2c230', label: 'new: ' + base(p.id), pri: 3 })
      else if (p.kind === 'mod') P.push({ ...p, icon: '🧰', c: '#e39a2d', label: 'editing ' + base(p.id), pri: 1 })
      else if (p.kind === 'demo') P.push({ ...p, icon: '🧱', c: '#8e959e', label: 'deleted ' + base(p.id.replace('demolished:', '')), pri: 2 })
      else if (p.kind === 'track') P.push({ ...p, icon: '🚜', c: '#e0483b', label: `unpermitted: ${this.ctxLabel(p.track.a)} → ${this.ctxLabel(p.track.b)}`, pri: 5, hot: true })
    }
    for (const s of (this.A.seams || []).filter((x) => x.unhandled.length)) {
      const b = v.plan.river?.bridges.find((x) => x.id === s.id)
      const h = s.handlers.find((f) => v.bld?.has(f))
      const pos = b ? [b.x, 3, b.z] : h ? v.posOf(h).map((x, i) => (i === 1 ? x + 4 : x)) : null
      if (pos) P.push({ kind: 'seam', seam: s.id, pos, icon: '⛔', c: '#8b62c9', label: `${s.id} bridge out`, pri: 4, hot: true })
    }
    this.basePois = P
    this.mergePois()
  }

  mergePois() {
    const now = performance.now()
    this.temp = this.temp.filter((t) => t.until > now)
    const ev = this.temp.map((t) => {
      const h = this.headline(t.e) || { icon: '•' }
      return { kind: 'event', e: t.e, pos: t.pos, icon: h.icon, c: t.e.sev === 'bad' ? '#e0483b' : t.e.sev === 'good' ? '#2f9e66' : t.e.sev === 'warn' ? '#e39a2d' : '#2f6bff', label: (h.short || '').slice(0, 60), pri: t.e.sev === 'bad' ? 5 : 2, hot: t.e.sev === 'bad' }
    })
    this.pois = [...(this.basePois || []), ...ev].sort((a, b) => b.pri - a.pri).slice(0, 40)
  }

  nextPoi() {
    if (!this.pois?.length) return null
    const p = this.pois[this.poiIdx++ % this.pois.length]
    return { pos: p.pos, dist: 60 }
  }

  next() {
    const p = this.pois?.[this.poiIdx++ % Math.max(1, this.pois?.length || 0)]
    if (!p) { this.c.H.toast('<b>ALL QUIET</b><span>nothing happening in the city right now</span>'); return }
    this.flyPoi(p)
  }

  flyPoi(p) {
    if (!p) return
    const { world, sfx } = this.c
    if (p.kind === 'seam') return this.c.selectSeam(p.seam)
    if (p.kind === 'event') return this.flyEvent(p.e)
    if (p.id && this.c.view.mods?.has(p.id)) { this.c.clearRoom(); return this.c.selectModule(p.id) }
    if (p.kind === 'track') {
      const i = this.A.violations.findIndex((v) => v.wip && this.modCtx(v.source) && [p.track.a, p.track.b].includes(this.modCtx(v.source)))
      if (i >= 0) return this.c.selectThreat(i)
    }
    world.flyTo(p.pos, 50)
    sfx.whoosh()
  }

  flyToConstruction() {
    const p = (this.pois || []).find((x) => x.kind === 'new' || x.kind === 'track' || x.kind === 'mod' || x.kind === 'demo')
    if (!p) { this.c.H.toast('<b>NO CONSTRUCTION</b><span>every change is committed</span>'); return }
    this.flyPoi(p)
    this.c.H.toast(`<b>🏗 ${this.basePois.filter((x) => x.kind !== 'seam').length} SITES</b><span>press J to visit the next one</span>`)
  }

  eventPos(e) {
    const v = this.c.view
    if (e.module && v.bld?.has(e.module)) { const p = v.posOf(e.module); return [p[0], p[1] * 2 + 3, p[2]] }
    if (e.source && v.bld?.has(e.source) && e.target && v.bld?.has(e.target)) {
      const a = v.posOf(e.source), b = v.posOf(e.target)
      const sa = this.modCtx(e.source), sb = this.modCtx(e.target)
      const t = v.plan?.tracks.find((t) => (t.a === sa && t.b === sb) || (t.a === sb && t.b === sa))
      if (t) { const p = t.pts[Math.floor(t.pts.length / 2)]; return [p[0], 3, p[1]] }
      return [(a[0] + b[0]) / 2, 4, (a[2] + b[2]) / 2]
    }
    if (e.source && v.bld?.has(e.source)) { const p = v.posOf(e.source); return [p[0], p[1] * 2 + 3, p[2]] }
    if (e.ctx && v.plan?.districts.has(e.ctx)) { const c = v.ctxCenter(e.ctx); return [c.pos[0], 6, c.pos[2]] }
    if (e.seam) { const s = this.A.seams?.find((x) => x.id === e.seam); const h = s?.handlers.find((f) => v.bld?.has(f)); if (h) return v.posOf(h) }
    return null
  }

  flyEvent(e) {
    if (!e) return
    const { world, sfx } = this.c
    if (e.seam) return this.c.selectSeam(e.seam)
    if (e.kind === 'track.cut' || e.kind === 'track.closed') {
      const i = this.A.violations.findIndex((v) => v.source === e.source && v.target === e.target)
      if (i >= 0) return this.c.selectThreat(i)
    }
    if (e.module && this.c.view.mods?.has(e.module)) { this.c.clearRoom(); return this.c.selectModule(e.module) }
    if (e.ctx && this.c.view.ctxs?.has(e.ctx)) return this.c.focusCtx(e.ctx)
    const pos = this.eventPos(e)
    if (pos) { world.flyTo(pos, 60); sfx.whoosh() }
  }

  // ── advisor ──────────────────────────────────────────────────────────────
  pumpAdvisor() {
    if (this.advisorOpen || !this.queue.length) return
    const e = this.queue.shift()
    this.showAdvisor(e)
  }

  showAdvisor(e) {
    const kind = e.kind === 'bridge.broken' ? 'utilities' : e.kind === 'track.cut' ? (TRANSIT_RULES.has(e.rule) ? 'transit' : 'zoning') : 'planning'
    const ad = ADVISORS[kind]
    const D = (k) => esc(this.ctxLabel(k))
    let title, body
    if (e.kind === 'track.cut') {
      title = e.wip ? 'Unpermitted road under construction' : 'A new dirt road just opened'
      const msg = this.A.violations.find((v) => v.source === e.source && v.target === e.target)?.message || e.rule
      body = `<b>${esc(base(e.source))}</b>${e.ctx ? ` (${D(e.ctx)})` : ''} now reaches <b>${esc(base(e.target))}</b> without a road: ${esc(msg)}. ${e.wip ? "It isn't committed yet — this is the cheapest moment to fix it." : 'Traffic is already using it.'}`
    } else if (e.kind === 'bridge.broken') {
      title = `The ${esc(e.seam)} bridge is out`
      body = `The platform emits <b>${esc((e.kinds || []).join(', '))}</b> but nothing on the other bank handles it. That fails at runtime.`
    } else if (e.kind === 'grade.down') {
      title = `${D(e.ctx)} is going downhill`
      body = `The district slid from <b>${esc(e.from)}</b> to <b>${esc(e.to)}</b>. Smoke is rising over it — check its quests.`
    } else if (e.kind === 'cycle.new') {
      title = 'Gridlock'
      body = `Traffic now circles between ${(e.ctxs || []).map(D).join(', ')} and never leaves. Break the cycle.`
    } else {
      title = esc(this.headline(e)?.short || e.kind)
      body = this.headline(e)?.text || ''
    }
    const vi = this.A.violations.findIndex((v) => v.source === e.source && v.target === e.target && v.prompt)
    this.advisorOpen = e
    $('advisor').style.setProperty('--c', ad.c)
    $('advisor').innerHTML = `<div class="ad"><div class="av">${ad.icon}</div><div style="flex:1"><div class="who"><b>${ad.name}</b> · just now</div><h4>${title}</h4><p>${body}</p>
      <div class="aa"><button class="go" data-adv="fly">Fly there</button>${vi >= 0 ? `<button data-adv="fix" data-vi="${vi}">⧉ Agent fix</button>` : ''}<button class="later" data-adv="later">Later</button></div></div></div>`
    $('advisor').classList.add('open')
    this.c.sfx.whoosh()
    clearTimeout(this.advTimer)
    this.advTimer = setTimeout(() => this.closeAdvisor(), 16000)
  }

  advisorClick(e) {
    const b = e.target.closest('[data-adv]')
    if (!b) return
    const ev = this.advisorOpen
    if (b.dataset.adv === 'fly') this.flyEvent(ev)
    if (b.dataset.adv === 'fix') this.c.copyThreat(+b.dataset.vi)
    this.closeAdvisor()
  }

  closeAdvisor() {
    $('advisor').classList.remove('open')
    this.advisorOpen = null
    setTimeout(() => this.pumpAdvisor(), 600)
  }

  // ── the morning paper ────────────────────────────────────────────────────
  seenKey() { return `sprawler:${this.A.project.name}:seen` }

  maybePaper(after) {
    let seen = 0
    try { seen = +localStorage.getItem(this.seenKey()) || 0 } catch { /* private window */ }
    const since = this.events.filter((e) => e.t > seen && e.kind !== 'boot' && e.kind !== 'score')
    this.afterPaper = after
    if (!seen || since.length) this.openPaper(false, since, !seen)
    else after?.()
  }

  openPaper(force, since, first) {
    const A = this.A
    let seen = 0
    try { seen = +localStorage.getItem(this.seenKey()) || 0 } catch { /* */ }
    since = since || this.events.filter((e) => (force ? true : e.t > seen) && e.kind !== 'boot' && e.kind !== 'score').slice(-60)
    const rank = (e) => (e.kind === 'track.cut' ? 50 : e.kind === 'bridge.broken' ? 48 : e.kind === 'grade.down' ? 40 : e.kind === 'build.open' ? 30 : e.kind === 'trophy.won' ? 28 : e.kind === 'commit' ? 20 : 10) + SEV_ORDER[e.sev] * 3
    const ordered = this.coalesce(since).sort((a, b) => rank(b) - rank(a) || b.t - a.t)
    const lead = ordered[0]
    const g = A.score.withheld ? '?' : A.score.grade
    const [wi, wl] = WEATHER[g] || WEATHER['?']
    const w = A.wip || {}
    const sites = (w.new || 0) + (w.mod || 0) + (w.demolished?.length || 0)
    const commits = since.filter((e) => e.kind === 'commit')
    const opened = since.filter((e) => e.kind === 'build.open').length
    const cut = since.filter((e) => e.kind === 'track.cut').length, closed = since.filter((e) => e.kind === 'track.closed').length
    let leadH, leadDeck, leadP
    if (first || !lead) {
      leadH = `Welcome to ${esc(A.project.title.split('·')[0].trim() || A.project.name)}`
      leadDeck = `A city of ${A.modules.length.toLocaleString()} buildings in ${A.contexts.length} districts, with ${A.edges.length.toLocaleString()} cars on the road.`
      leadP = `Roads only exist where the architecture allows a dependency; everything else has bulldozed a dirt road through the woods. Today the city counts <b>${A.violations.length}</b> of those. ${sites ? `There ${sites === 1 ? 'is' : 'are'} <b>${sites}</b> construction site${sites > 1 ? 's' : ''} open — work not yet committed.` : 'All work is committed; not a crane in sight.'}`
    } else {
      const h = this.headline(lead)
      leadH = h?.short ? esc(h.short) : h?.text || 'News'
      leadDeck = h?.text || ''
      leadP = `Since your last visit: <b>${commits.length}</b> commit${commits.length === 1 ? '' : 's'}, <b>${opened}</b> grand opening${opened === 1 ? '' : 's'}, <b>${cut}</b> new dirt road${cut === 1 ? '' : 's'} and <b>${closed}</b> closed. The city rating stands at <b>${A.score.total}</b>.`
    }
    const stories = ordered.slice(first ? 0 : 1, 10).map((e) => {
      const h = this.headline(e)
      if (!h) return ''
      return `<div class="story"><h3>${h.icon} ${h.short ? esc(h.short) : h.text}</h3><p>${h.text} <small>· ${ago(e.t)}</small></p><button class="fly" data-pfly="${e.id}">Fly there →</button></div>`
    }).join('') || `<div class="story"><h3>Quiet streets</h3><p>No news since your last visit.</p></div>`
    const worst = [...A.contexts].sort((a, b) => a.score - b.score).slice(0, 3)
    $('paper').innerHTML = `<div class="np">
      <div class="nmast"><h1>The Daily Commit</h1></div>
      <div class="nline"><span>${new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</span><span>${esc(A.project.title)}</span><span>${esc(A.project.branch || '')} · ${esc(A.project.sha || '')}</span></div>
      <div class="lead"><div><h2>${leadH}</h2><div class="deck">${leadDeck}</div><p>${leadP}</p>${lead && !first ? `<button class="fly" data-pfly="${lead.id}">Fly there →</button>` : ''}</div>
        <div><div class="box"><h4>Weather</h4><div class="weather"><b>${wi}</b><div>${wl}<br><small>City rating ${A.score.total} · grade ${g}</small></div></div></div>
        <div class="box" style="margin-top:10px"><h4>Under construction</h4>${sites ? `<p>${w.new || 0} new · ${w.mod || 0} renovating · ${w.demolished?.length || 0} demolished<br><small>+${w.added || 0} / −${w.deleted || 0} lines${w.violations ? ` · <b style="color:#b3261e">${w.violations} unpermitted</b>` : ''}</small></p><button class="fly" data-pwip>Visit the sites →</button>` : '<p>No cranes today.</p>'}</div>
        <div class="box" style="margin-top:10px"><h4>Districts to watch</h4>${worst.map((c) => `<p>${esc(c.label)} — <b>${c.grade}</b> ${c.score} <button class="fly" data-pctx="${esc(c.key)}">→</button></p>`).join('')}</div></div></div>
      <div class="cols">${stories}</div>
      <div class="nfoot"><button data-pclose>Enter the city</button></div></div>`
    $('paper').classList.add('open')
    this.c.sfx.whoosh()
  }

  paperClick(e) {
    const f = e.target.closest('[data-pfly]')
    const close = () => {
      $('paper').classList.remove('open')
      try { localStorage.setItem(this.seenKey(), String(Math.floor(Date.now() / 1000))) } catch { /* */ }
      const f = this.afterPaper; this.afterPaper = null; f?.()
    }
    if (f) { close(); return setTimeout(() => this.flyEvent(this.byId(+f.dataset.pfly)), 200) }
    if (e.target.closest('[data-pwip]')) { close(); return setTimeout(() => this.flyToConstruction(), 200) }
    const c = e.target.closest('[data-pctx]')
    if (c) { close(); return setTimeout(() => this.c.focusCtx(c.dataset.pctx), 200) }
    if (e.target.closest('[data-pclose]') || e.target.id === 'paper') close()
  }

  // ── minimap ──────────────────────────────────────────────────────────────
  drawMinimapStatic() {
    const P = this.c.view.plan
    const cv = this.mm.canvas
    const box = cv.parentElement.getBoundingClientRect()
    const dpr = Math.min(2, devicePixelRatio)
    cv.width = Math.max(10, box.width * dpr); cv.height = Math.max(10, box.height * dpr)
    const off = document.createElement('canvas')
    off.width = cv.width; off.height = cv.height
    const g = off.getContext('2d')
    const E = P.extent + 30
    const s = Math.min(cv.width, cv.height) / (2 * E) * 0.98
    const ox = cv.width / 2, oz = cv.height / 2
    this.mm.map = { s, ox, oz }
    const X = (x) => ox + x * s, Z = (z) => oz + z * s
    g.fillStyle = '#c9dcc0'; g.fillRect(0, 0, cv.width, cv.height)
    g.beginPath()
    for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2 + Math.PI / 6; const x = X(Math.cos(a) * E), z = Z(Math.sin(a) * E); k ? g.lineTo(x, z) : g.moveTo(x, z) }
    g.closePath(); g.fillStyle = '#5f9a4c'; g.fill()
    g.lineCap = 'round'; g.lineJoin = 'round'
    for (const r of P.roads) {
      if (r.ctx && r.cls !== 'arterial') continue
      g.strokeStyle = r.cls === 'ring' ? '#e8e4da' : '#d4cfc3'; g.lineWidth = Math.max(1, (r.cls === 'ring' ? 4.2 : 3) * s * 1.4) * (r.cls === 'ring' ? 1.4 : 1)
      g.beginPath(); r.pts.forEach(([x, z], i) => (i ? g.lineTo(X(x), Z(z)) : g.moveTo(X(x), Z(z)))); g.stroke()
    }
    for (const d of P.districts.values()) {
      const c = this.A.contexts.find((x) => x.key === d.key)
      g.beginPath(); g.arc(X(d.x), Z(d.z), Math.max(2, d.R * s), 0, Math.PI * 2)
      g.fillStyle = '#eae5d8'; g.fill()
      g.lineWidth = Math.max(1, 1.5 * (devicePixelRatio || 1)); g.strokeStyle = ({ S: '#e0a92a', A: '#2fa86a', B: '#2f7fd6', C: '#8b62c9', D: '#e07b1f', F: '#d8383a' })[c?.grade] || '#7d8792'; g.stroke()
    }
    for (const t of P.tracks) {
      g.strokeStyle = t.wip ? '#e0483b' : '#b0703c'; g.lineWidth = Math.max(1.2, Math.log2(1 + t.n) * 1.2 * (devicePixelRatio || 1))
      g.beginPath(); t.pts.forEach(([x, z], i) => (i ? g.lineTo(X(x), Z(z)) : g.moveTo(X(x), Z(z)))); g.stroke()
    }
    this.mm.static = off
  }

  drawMinimap(t) {
    const cv = this.mm.canvas, M = this.mm.map
    if (!this.mm.static || !M) return
    const g = cv.getContext('2d')
    g.drawImage(this.mm.static, 0, 0)
    const dpr = Math.min(2, devicePixelRatio)
    for (const p of this.pois || []) {
      const pulse = p.hot ? 1 + 0.4 * Math.sin(t * 6) : 1
      g.beginPath(); g.arc(M.ox + p.pos[0] * M.s, M.oz + p.pos[2] * M.s, 3.2 * dpr * pulse, 0, Math.PI * 2)
      g.fillStyle = p.c; g.fill(); g.lineWidth = dpr; g.strokeStyle = '#fff'; g.stroke()
    }
    // camera footprint
    const v = this.c.view
    const pts = [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(([x, y]) => v.groundAt(x, y))
    if (pts.every(Boolean)) {
      g.beginPath()
      pts.forEach((p, i) => { const x = M.ox + p.x * M.s, z = M.oz + p.z * M.s; i ? g.lineTo(x, z) : g.moveTo(x, z) })
      g.closePath(); g.fillStyle = 'rgba(47,107,255,.12)'; g.fill(); g.strokeStyle = '#2f6bff'; g.lineWidth = 1.5 * dpr; g.stroke()
    } else {
      const tg = this.c.world.controls.target
      g.beginPath(); g.arc(M.ox + tg.x * M.s, M.oz + tg.z * M.s, 4 * dpr, 0, Math.PI * 2); g.fillStyle = '#2f6bff'; g.fill()
    }
  }

  minimapClick(e) {
    const M = this.mm.map
    if (!M) return
    const r = this.mm.canvas.getBoundingClientRect()
    const dpr = this.mm.canvas.width / r.width
    const x = ((e.clientX - r.left) * dpr - M.ox) / M.s, z = ((e.clientY - r.top) * dpr - M.oz) / M.s
    const { world, sfx } = this.c
    const dist = world.camera.position.distanceTo(world.controls.target)
    world.flyTo([x, 0, z], Math.min(dist, 260), 0.9)
    sfx.whoosh()
  }

  // ── per frame: markers, arrows, ticker scroll, minimap ───────────────────
  update(t, dt) {
    if (!this.A || !this.c.view.plan) return
    this.frame++
    // ticker
    const roll = $('tickerRoll')
    if (!this.tickerW) this.tickerW = roll.scrollWidth / 2
    if (this.tickerW > 0 && !roll.matches(':hover')) {
      this.tickerX = (this.tickerX + dt * 55) % this.tickerW
      roll.style.transform = `translateX(${-this.tickerX}px)`
    }
    if (this.frame % 30 === 0) this.mergePois()
    if (this.frame % 4 === 0) this.drawMinimap(t)
    this.placeMarkers()
  }

  placeMarkers() {
    const { world } = this.c
    const cam = world.camera
    const W = innerWidth, H = innerHeight
    const lft = document.body.classList.contains('hideL') ? 12 : 356, rgt = document.body.classList.contains('hideR') ? W - 12 : W - 366
    const top = 140, bot = H - 70
    const host = $('markers')
    const used = new Set()
    const v3 = new THREE.Vector3()
    let arrows = 0
    const dist = cam.position.distanceTo(world.controls.target)
    ;(this.pois || []).forEach((p, i) => {
      v3.set(p.pos[0], p.pos[1] + 1.5, p.pos[2]).project(cam)
      const behind = v3.z > 1
      let x = (v3.x * 0.5 + 0.5) * W, y = (-v3.y * 0.5 + 0.5) * H
      const on = !behind && x > lft && x < rgt && y > top && y < bot
      const key = `${p.kind}:${p.id || p.seam || p.e?.id || i}`
      // bubbles hide at metro zoom except the hot ones, so the overview stays clean
      if (on && (dist < 420 || p.hot || p.kind === 'new')) {
        used.add(key)
        let el = this.markEls.get(key)
        if (!el || !el.classList.contains('mkr')) { el?.remove(); el = document.createElement('div'); el.className = 'mkr' + (p.hot ? ' hot' : ''); this.markEls.set(key, el); host.appendChild(el) }
        el.dataset.mk = i
        el.style.setProperty('--c', p.c)
        const html = `<span class="lab">${esc(p.label)}</span><span class="bub">${p.icon}</span><span class="tail"></span>`
        if (el.dataset.h !== html) { el.innerHTML = html; el.dataset.h = html }
        el.style.left = x + 'px'; el.style.top = y + 'px'
      } else if (!on && (p.hot || p.kind === 'new') && arrows < 6) {
        arrows++
        used.add(key)
        if (behind) { x = W - x; y = H - y }
        const cx = (lft + rgt) / 2, cy = (top + bot) / 2
        const ang = Math.atan2(y - cy, x - cx)
        const sx = Math.cos(ang), sy = Math.sin(ang)
        const k = Math.min(Math.abs(((sx > 0 ? rgt - 40 : lft + 40) - cx) / (sx || 1e-6)), Math.abs(((sy > 0 ? bot - 20 : top + 20) - cy) / (sy || 1e-6)))
        const ax = cx + sx * k, ay = cy + sy * k
        let el = this.markEls.get(key)
        if (!el || !el.classList.contains('arrow')) { el?.remove(); el = document.createElement('div'); el.className = 'arrow'; this.markEls.set(key, el); host.appendChild(el) }
        el.dataset.mk = i
        el.style.setProperty('--c', p.c)
        const meters = Math.round(Math.hypot(p.pos[0] - world.controls.target.x, p.pos[2] - world.controls.target.z) * 10)
        const html = `<i>${p.icon}</i>${esc(p.label.slice(0, 26))} <small>${meters > 999 ? (meters / 1000).toFixed(1) + 'km' : meters + 'm'}</small><span class="chev" style="transform:rotate(${ang}rad)">➜</span>`
        if (el.dataset.h !== html) { el.innerHTML = html; el.dataset.h = html }
        el.style.left = ax + 'px'; el.style.top = ay + 'px'
      }
    })
    for (const [k, el] of this.markEls) if (!used.has(k)) { el.remove(); this.markEls.delete(k) }
  }

  // ── flows as deliveries: the shipment timeline ──────────────────────────
  flowStart(f, stages) {
    this.flow = { f, stages }
    // stage names come from the profile's use-case view (e.g. Clankernative: entry → operation → … → host adapter)
    const LBL = Object.fromEntries((this.A.views?.use_cases?.stages || []).map((x) => [x.key, x.label.replace(/\s*\(.*\)$/, '')]))
    $('timeline').innerHTML = `<div class="th"><span class="chip" style="--c:${f.kind === 'command' ? '#e0483b' : '#2f6bff'}">${f.kind === 'command' ? '🚚' : '🚐'} ${esc((f.kind || 'route').toUpperCase())}</span><b>${esc(f.id)}</b><span class="dim">${esc(this.ctxLabel(f.ctx))}</span>${f.violations.length ? `<span class="chip" style="--c:#e0483b">⚠ ${f.violations.length} on route</span>` : ''}<button class="x" data-tlclose>✕</button></div>
      <div class="steps">${stages.map((s, i) => `<div class="st" data-st="${i}"><i>${i + 1}</i><b>${LBL[s.key] || s.key}</b><small>${s.ids.length} stop${s.ids.length > 1 ? 's' : ''}</small></div>`).join('')}</div>`
    $('timeline').classList.add('open')
    $('timeline').onclick = (e) => { if (e.target.closest('[data-tlclose]')) this.flowEnd() }
  }

  flowStep(k, bad) {
    document.querySelectorAll('#timeline .st').forEach((el, i) => {
      el.classList.toggle('done', i < k)
      el.classList.toggle('now', i === k)
      if (i === k && bad) el.classList.add('bad')
    })
  }

  flowEnd(delay = 0) {
    clearTimeout(this.flowT)
    this.flowT = setTimeout(() => $('timeline').classList.remove('open'), delay)
  }
}

function ago(ts) {
  const s = Date.now() / 1000 - ts
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
