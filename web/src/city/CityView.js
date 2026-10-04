// The metropolis. Same public API as the old AtlasView (main.js drives either), drawn as a city:
// districts = bounded contexts, buildings = modules, cars = dependencies, dirt tracks = violations,
// cranes and scaffolding = uncommitted work.
import * as THREE from 'three'
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { planCity } from './plan.js'
import { loadKit, part, kitMesh, cityMaterial } from './kit.js'
import { paintLanduse, buildGround, buildForest } from './ground.js'
import { buildRoads } from './roads.js'
import { buildTraffic } from './traffic.js'
import { Construction } from './construction.js'
import { buildRiver } from './river.js'
import { Ribbons } from './ribbons.js'
import { Police } from './police.js'
import { Weather } from './weather.js'
import { Chopper } from './chopper.js'

export const GRADE = { S: '#e0a92a', A: '#2fa86a', B: '#2f7fd6', C: '#8b62c9', D: '#e07b1f', F: '#d8383a', '?': '#7d8792' }
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const clamp01 = (x) => Math.max(0, Math.min(1, x))

// which building a module becomes
export const ARCH = {
  root: 'hall', composition: 'hall', project: 'hall',
  core: 'landmark', kernel: 'landmark', entity: 'landmark',
  model: 'civic', abstraction: 'civic', contract: 'civic',
  internal: 'substation', binding: 'house', generated: 'prefab',
  port: 'tollgate', adapter: 'warehouse', driven: 'warehouse', persistence: 'warehouse', integration: 'warehouse',
  driving: 'station', endpoint: 'station', ui: 'library', worker: 'factory',
  tool: 'shed', config: 'shed', util: 'apartment', migration: 'shed',
  command: 'factory', service: 'office', query: 'shop', view: 'library',
  proof: 'tent', test: 'tent', loose: 'shack',
}
// what each building type looks like in words, for legends and the inspector
// data lenses (SimCity-style data views): each maps a module to a number; colours use percentile rank
export const LENSES = {
  loc: { label: 'Size', icon: '📏', unit: 'lines', get: (m) => m.loc, hint: 'lines of code — the tallest buildings are the biggest files' },
  cc: { label: 'Complexity', icon: '🌀', unit: 'worst fn', get: (m) => m.metrics?.ccMax, hint: 'cyclomatic complexity of the worst function in the file' },
  fn: { label: 'Long functions', icon: '📜', unit: 'lines', get: (m) => m.metrics?.fnMax, hint: 'length of the longest function' },
  smell: { label: 'Smell', icon: '🦨', unit: '', get: (m) => m.metrics?.smell, hint: 'how far past the limits for size, function length, complexity and nesting', fmt: (v) => Math.round(v * 100) + '%' },
  churn: { label: 'Churn', icon: '🔥', unit: 'commits', get: (m) => m.metrics?.churn, hint: 'how often the file changes' },
  age: { label: 'Freshness', icon: '🕰', unit: 'days ago', get: (m) => m.metrics?.age == null ? null : -m.metrics.age, hint: 'hot = changed recently, cool = untouched for a long time', fmt: (v) => Math.round(-v) + 'd' },
  fanin: { label: 'Load-bearing', icon: '🏋', unit: 'dependents', get: (m) => m.fanIn, hint: 'how many modules depend on it — hot = changing it ripples furthest' },
  authors: { label: 'Bus factor', icon: '🚌', unit: 'authors', get: (m) => (m.metrics?.authors ? -m.metrics.authors : null), hint: 'hot = only one person has touched it', fmt: (v) => -v },
}

export const ARCH_ICON = { hall: ['🏛', 'Town hall'], landmark: ['🏙', 'Landmark tower'], civic: ['🏛', 'Civic building'], factory: ['🏭', 'Factory'], shop: ['🏪', 'Shop'], library: ['📚', 'Library'], warehouse: ['🏬', 'Warehouse'], prefab: ['📦', 'Prefab block'], apartment: ['🏢', 'Apartments'], office: ['🏢', 'Office tower'], megatower: ['🗼', 'Mega-tower'], tollgate: ['🛂', 'Toll gate'], station: ['🚏', 'Bus station'], substation: ['⚡', 'Substation'], shed: ['🛖', 'Utility shed'], tent: ['⛺', 'Inspection tent'], house: ['🏠', 'House'], shack: ['🏚', 'Shack'] }
const STACK = new Set(['landmark', 'civic', 'factory', 'shop', 'library', 'warehouse', 'prefab', 'apartment', 'office', 'megatower'])
const MAXF = { landmark: 22, civic: 6, factory: 5, shop: 8, library: 5, warehouse: 3, prefab: 6, apartment: 14, office: 26, megatower: 40 }
const NEUTRAL = new THREE.Color('#d8d4cc')
const RED_ROOF = new THREE.Color('#d65a4a')

const _M = new THREE.Matrix4(), _Q = new THREE.Quaternion(), _P = new THREE.Vector3(), _S = new THREE.Vector3(), _Y = new THREE.Vector3(0, 1, 0)

export class CityView {
  constructor(world) {
    this.world = world
    this.root = new THREE.Group()
    world.scene.add(this.root)
    this.filters = { tiers: new Set(), layers: new Set(), tests: false, generated: true, picked: new Set(), isolate: 'off', height: 'traffic', labels: 'all', labelTiers: new Set(), focusHide: true, seams: 'all', solo: new Set() }
    this.platforms = new Map()
    this.mode = 'structure'
    this.sel = null
    this.hoverId = null
    this.bootT = -1
    this.atlas = null
    this.pulses = new Map()
    this.ray = new THREE.Raycaster()
    this.modLabels = []
    this.L = { extent: 300 }
    this._allow = null
    this.focusCtx = null
    this.kitReady = loadKit()
    this.mat = null
  }

  // ── build ──────────────────────────────────────────────────────────────────
  async build(atlas, { instant = false } = {}) {
    await this.kitReady
    const prevCam = this.atlas ? true : false
    this.dispose()
    this.atlas = atlas
    this.mods = new Map(atlas.modules.map((m) => [m.id, m]))
    this.ctxs = new Map(atlas.contexts.map((c) => [c.key, c]))
    this.tierColor = new Map(atlas.tiers.map((t) => [t.id, new THREE.Color(t.color)]))
    this.plan = planCity(atlas)
    const P = this.plan
    this.L = { extent: P.extent, ctxPos: new Map([...P.districts].map(([k, d]) => [k, { x: d.x, z: d.z, radius: d.R }])) }
    this.world.setExtent(P.extent)
    const uni = this.world.uni
    if (!this.mat) this.mat = cityMaterial(uni)
    this.land = paintLanduse(P)
    this.ground = buildGround(P, this.land, uni)
    this.root.add(this.ground.group)
    this.roads = buildRoads(P, uni)
    this.root.add(this.roads.group)
    this.river = buildRiver(this, uni)
    if (this.river) this.root.add(this.river.group)
    this.forest = buildForest(P, this.land, this.mat)
    this.root.add(this.forest.group)
    this.buildBuildings()
    this.buildDecor()
    this.traffic = buildTraffic(P, atlas, uni)
    this.root.add(this.traffic.group)
    this.construction = new Construction(this)
    this.root.add(this.construction.group)
    this.buildSigns()
    this.ribbons = new Ribbons(this)
    this.police = new Police(this)
    this.root.add(this.police.group)
    this.weather = new Weather(this)
    this.root.add(this.weather.group)
    this.chopper = new Chopper(this)
    this.root.add(this.chopper.group)
    this.paintSmell()
    if (this.lens) this.setLens(this.lens)
    this.world.setGloom?.(this.weather.sky.dark)
    this.impactIds = null
    // adjacency for selection
    this.adj = new Map()
    this.edgeIdx = new Map()
    atlas.edges.forEach((e, i) => {
      for (const id of [e.source, e.target]) { if (!this.adj.has(id)) this.adj.set(id, []); this.adj.get(id).push(i) }
      this.edgeIdx.set(e.source + '→' + e.target, i)
    })
    this.bootT = instant ? 99 : -1
    if (this.sel && !this.selValid(this.sel)) this.sel = null
    this.applyState()
    console.info(`[city] plan ${Math.round(P.ms)}ms · ${atlas.modules.length} buildings · ${this.traffic.count} cars · ${this.forest.count} trees · ${P.tracks.length} dirt tracks`)
    return prevCam
  }

  archOf(m) {
    if (this.atlas.wells?.includes(m.id)) return 'megatower'
    return ARCH[m.layer] || 'apartment'
  }

  buildBuildings() {
    const A = this.atlas, P = this.plan
    const inst = new Map() // part name → [{ id, x, y, z, ry, s }]
    const add = (name, rec) => { if (!inst.has(name)) inst.set(name, []); inst.get(name).push({ ...rec, name }) }
    this.bld = new Map() // module id → { arch, floors, height, x, z, ry, parts: [[name, idx]] }
    for (const m of A.modules) {
      const lot = P.lots.get(m.id)
      if (!lot) continue
      const arch = this.archOf(m)
      const loc = Math.max(1, m.loc || 1)
      let floors = 0, height
      const rec = { id: m.id, x: lot.x, z: lot.z, ry: lot.ry }
      if (STACK.has(arch)) {
        floors = Math.max(0, Math.min(MAXF[arch], Math.round(Math.log2(1 + loc / 18) * (arch === 'office' || arch === 'landmark' || arch === 'megatower' ? 2.4 : 1.5))))
        if (m.generated) floors = Math.min(floors, 2)
        const hb = part(arch + '_base').h ?? 0.8
        add(arch + '_base', { ...rec, y: 0, s: 1 })
        for (let f = 0; f < floors; f++) add(arch + '_floor', { ...rec, y: hb + f * 0.5, s: 1, f })
        add(arch + '_roof', { ...rec, y: hb + floors * 0.5, s: 1 })
        height = hb + floors * 0.5 + 0.6
      } else {
        const s = arch === 'hall' ? 1 + Math.min(0.5, Math.log2(1 + loc / 200) * 0.2) : 0.9 + Math.min(0.3, Math.log2(1 + loc / 100) * 0.12)
        add(arch, { ...rec, y: 0, s })
        height = (part(arch).box.max.y || 1.5) * s
      }
      this.bld.set(m.id, { arch, floors, height, x: lot.x, z: lot.z, ry: lot.ry, parts: [] })
    }
    this.bmeshes = []
    for (const [name, list] of inst) {
      const mesh = kitMesh(name, list.length, this.mat)
      mesh.userData.ids = list.map((r) => r.id)
      mesh.userData.recs = list
      list.forEach((r, i) => {
        this.bld.get(r.id).parts.push([mesh, i])
        _Q.setFromAxisAngle(_Y, r.ry)
        _M.compose(_P.set(r.x, r.y, r.z), _Q, _S.setScalar(r.s))
        mesh.setMatrixAt(i, _M)
      })
      mesh.instanceMatrix.needsUpdate = true
      mesh.computeBoundingSphere()
      this.root.add(mesh)
      this.bmeshes.push(mesh)
    }
  }

  // plaza fountains, park trees in unused lots, street lights along highways, smoke in run-down districts
  buildDecor() {
    const P = this.plan
    const lists = new Map()
    const add = (name, x, z, ry = 0, s = 1) => { if (!lists.has(name)) lists.set(name, []); lists.get(name).push([x, z, ry, s]) }
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    for (const d of P.districts.values()) {
      const c = this.ctxs.get(d.key)
      const hasPlazaBuildings = [...d.lots.values()].some((l) => l.plaza)
      if (!hasPlazaBuildings) add('fountain', d.x, d.z)
      const good = c && (c.grade === 'S' || c.grade === 'A')
      for (const p of d.parksW) {
        const r = rnd()
        if (r < 0.55) add(rnd() < 0.5 ? 'tree_round' : 'tree_round_small', p.x + (rnd() - 0.5) * 1.5, p.z + (rnd() - 0.5) * 1.5, rnd() * 6, 0.9 + rnd() * 0.4)
        else if (r < 0.75 && good) add('flowerbed', p.x, p.z, rnd() * 6)
        else if (r < 0.9) add('bush', p.x, p.z, rnd() * 6, 1.2)
      }
      // run-down districts smoke
      if (c && (c.grade === 'D' || c.grade === 'F' || c.grade === 'C')) {
        const n = c.grade === 'C' ? 1 : c.grade === 'D' ? 2 : 3
        for (let k = 0; k < n; k++) {
          const a = d.seed * 20 + k * 2.1
          add('smoke_stack', d.x + Math.cos(a) * (d.R + 2.5), d.z + Math.sin(a) * (d.R + 2.5), 0, 1 + k * 0.2)
        }
      }
    }
    // street lights along the ring roads
    for (const r of P.rings) {
      const n = Math.floor((Math.PI * 2 * r.r) / 22)
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2
        const rr = r.r + (k % 2 ? 3.2 : -3.2)
        add('streetlight', Math.cos(a) * rr, Math.sin(a) * rr, -a + (k % 2 ? Math.PI : 0))
      }
    }
    this.smokeStacks = lists.get('smoke_stack') || []
    for (const [name, list] of lists) {
      const mesh = kitMesh(name, list.length, this.mat)
      list.forEach(([x, z, ry, s], i) => {
        _Q.setFromAxisAngle(_Y, ry)
        _M.compose(_P.set(x, 0, z), _Q, _S.setScalar(s))
        mesh.setMatrixAt(i, _M)
      })
      mesh.instanceMatrix.needsUpdate = true
      mesh.computeBoundingSphere()
      this.root.add(mesh)
    }
  }

  buildSigns() {
    this.platforms = new Map()
    for (const d of this.plan.districts.values()) {
      const c = this.ctxs.get(d.key)
      if (!c) continue
      const tier = this.atlas.tiers.find((t) => t.id === c.tier)
      const v = c.crit + c.major + c.minor
      const wip = this.atlas.modules.filter((m) => m.ctx === c.key && m.wip).length
      const el = document.createElement('div')
      el.className = 'dsign'
      el.innerHTML = `<span class="g" style="--g:${GRADE[c.grade] || GRADE['?']}">${c.grade}</span><span class="n">${esc(c.label)}<small>${esc(tier?.label || c.tier)} · ${c.modules}</small></span>${v ? `<span class="w ${c.crit + c.major ? 'hot' : ''}">⚠ ${v}</span>` : ''}${wip ? `<span class="c">🏗 ${wip}</span>` : ''}`
      el.addEventListener('click', (e) => { e.stopPropagation(); this.onCtxClick?.(c.key, e) })
      const lab = new CSS2DObject(el)
      // sign stands at the district's front edge (toward the camera's default view: +z)
      lab.position.set(d.x, 2, d.z + d.R * 0.92)
      this.root.add(lab)
      this.platforms.set(c.key, { g: { visible: true }, el, lab, d, flash: 0 })
    }
  }

  // ── state ─────────────────────────────────────────────────────────────────
  selValid(s) {
    if (s.type === 'module') return this.mods.has(s.id)
    if (s.type === 'ctx') return this.ctxs.has(s.key)
    return s.type === 'commit' || s.type === 'edge'
  }

  allowCtx() {
    const F = this.filters
    if (F.isolate === 'off' || !F.picked.size) return null
    const s = new Set(F.picked)
    if (F.isolate === 'plus') {
      for (const e of this.atlas.edges) {
        if (e.test) continue
        const a = this.mods.get(e.source)?.ctx, b = this.mods.get(e.target)?.ctx
        if (F.picked.has(a)) s.add(b)
        if (F.picked.has(b)) s.add(a)
      }
    }
    return s
  }

  select(sel) { this.sel = sel; this.applyState() }
  setMode(m) { this.mode = m; this.applyState() }
  setTangle() {}
  startBoot() { this.bootT = 0 }
  flashCtx(keys) { for (const k of keys) { const p = this.platforms.get(k); if (p) p.flash = 1 } }
  pulse(id, amt = 1) { if (this.bld?.has(id)) this.pulses.set(id, Math.max(this.pulses.get(id) || 0, amt)) }
  pulseEdge(a, b, amt = 1) {
    const i = this.edgeIndex(a, b)
    if (i != null) { this.pulse(a, amt * 0.6); this.pulse(b, amt * 0.6) }
    return i
  }

  setDoc(on) { this.doc = on; if (this.atlas) this.applyState() }

  applyState() {
    const A = this.atlas, F = this.filters, s = this.sel
    if (!A || !this.bld) return
    const allow = this._allow = this.allowCtx()
    const shown = (m) => !F.tiers.has(m.tier) && !F.layers.has(m.layer) && (F.tests || !m.test) && (F.generated || !m.generated) && (!F.solo.size || F.solo.has(m.layer))
    let hlN = null, hlE = null
    if (s?.type === 'module') {
      hlN = new Set([s.id]); hlE = new Set()
      for (const i of this.adj.get(s.id) || []) { hlE.add(i); hlN.add(A.edges[i].source); hlN.add(A.edges[i].target) }
    } else if (s?.type === 'ctx') {
      const inside = new Set(A.modules.filter((m) => m.ctx === s.key).map((m) => m.id))
      hlN = new Set(inside); hlE = new Set()
      A.edges.forEach((e, i) => { if (inside.has(e.source) || inside.has(e.target)) { hlE.add(i); hlN.add(e.source); hlN.add(e.target) } })
    } else if (s?.type === 'edge') {
      const e = A.edges[s.idx]
      hlN = new Set([e.source, e.target]); hlE = new Set([s.idx])
    } else if (s?.type === 'commit') {
      hlN = new Set(s.modules); hlE = new Set()
      A.edges.forEach((e, i) => { if (hlN.has(e.source) && hlN.has(e.target)) hlE.add(i) })
    } else if (F.picked.size && F.isolate === 'off') {
      const inside = new Set(A.modules.filter((m) => F.picked.has(m.ctx)).map((m) => m.id))
      hlN = new Set(inside); hlE = new Set()
      A.edges.forEach((e, i) => { if (inside.has(e.source) || inside.has(e.target)) { hlE.add(i); hlN.add(e.source); hlN.add(e.target) } })
    } else if (this.mode === 'threats') {
      hlN = new Set(); hlE = new Set()
      A.edges.forEach((e, i) => { if (e.status === 'violation') { hlE.add(i); hlN.add(e.source); hlN.add(e.target) } })
    }
    this.hlN = hlN; this.hlE = hlE
    this.hlCtx = hlN ? new Set([...hlN].map((id) => this.mods.get(id)?.ctx)) : null
    if (s?.type === 'ctx') this.hlCtx.add(s.key)
    this.focusCtx = F.focusHide && hlN && (s || F.picked.size) ? this.hlCtx : null
    this.vis = new Map()
    for (const m of A.modules) {
      const b = this.bld.get(m.id)
      if (!b) continue
      const vis = shown(m)
      this.vis.set(m.id, vis)
      const ghost = (allow && !allow.has(m.ctx)) || (hlN && !hlN.has(m.id) && (F.focusHide || s)) ? 1 : 0
      const hi = s?.type === 'module' && s.id === m.id ? 1 : hlN && hlN.has(m.id) && s?.type !== 'ctx' ? 0.35 : 0
      const tint = this.tintOf(m)
      b.hi = hi
      for (const [mesh, i] of b.parts) {
        const fx = mesh.geometry.attributes.iFx, tn = mesh.geometry.attributes.iTint
        fx.setXYZW(i, hi, ghost * (this.doc ? 0.4 : 0.85), 0, 0)
        tn.setXYZ(i, tint.r, tint.g, tint.b)
        fx.needsUpdate = tn.needsUpdate = true
      }
      b.vis = vis
    }
    this.placeAll()
    // cars: highlight the selection's dependencies, wash out the rest, hide what's filtered
    if (this.traffic) {
      this.traffic.setState((i, c) => {
        const e = A.edges[i]
        if (!this.vis.get(e.source) || !this.vis.get(e.target)) return 2
        if (c.test && !F.tests) return 2
        if (allow && (!allow.has(this.mods.get(e.source).ctx) || !allow.has(this.mods.get(e.target).ctx))) return 2
        if (hlE) return hlE.has(i) ? 1 : (F.focusHide ? 2 : 3)
        return 0
      })
    }
    for (const [k, p] of this.platforms) {
      p.g.visible = !allow || allow.has(k)
      const dim = (this.hlCtx && !this.hlCtx.has(k)) || (allow && !allow.has(k))
      p.el.classList.toggle('dim', !!dim)
      p.el.classList.toggle('sel', s?.type === 'ctx' && s.key === k)
    }
    this.construction?.apply()
    this.police?.apply((vi) => { const v = A.violations[vi]; return !!(this.hlN && !(this.hlN.has(v.source) && this.hlN.has(v.target))) || !!(allow && !allow.has(this.mods.get(v.source)?.ctx)) })
    this.updateModuleLabels()
    this.showRibbons()
  }

  showRibbons() {
    const A = this.atlas, s = this.sel
    if (!this.ribbons) return
    let list = []
    if (s?.type === 'module') list = (this.adj.get(s.id) || []).map((i) => [i, A.edges[i].source === s.id ? 'out' : 'in'])
    else if (s?.type === 'edge') list = [[s.idx, 'out']]
    else if (s?.type === 'commit' && this.hlE) list = [...this.hlE].map((i) => [i, 'out'])
    else if (s?.type === 'ctx') {
      // a district: only what crosses its border, the internal streets would just be noise
      list = (this.hlE ? [...this.hlE] : []).filter((i) => { const e = A.edges[i]; return this.mods.get(e.source)?.ctx !== this.mods.get(e.target)?.ctx })
        .map((i) => [i, this.mods.get(A.edges[i].source)?.ctx === s.key ? 'out' : 'in'])
    }
    list = list.filter(([i]) => !A.edges[i].test || this.filters.tests)
    // rule breaks first so they always make the cut
    list.sort((a, b) => (A.edges[b[0]].status === 'violation') - (A.edges[a[0]].status === 'violation'))
    this.ribbons.show(list)
  }

  // smelly files look weathered (iImp.y): stained facades, scaled by the 0..1 smell score
  paintSmell() {
    for (const m of this.atlas.modules) {
      const s = m.metrics?.smell || 0
      for (const [mesh, i] of this.bld.get(m.id)?.parts || []) mesh.geometry.attributes.iImp.setY(i, s)
    }
    for (const mesh of this.bmeshes) mesh.geometry.attributes.iImp.needsUpdate = true
  }

  // data lens: colour every building by a metric (percentile rank → cool…hot); null clears it
  setLens(key) {
    const L = LENSES[key]
    this.lens = L ? key : null
    this.world.uni.uLens.value = L ? 1 : 0
    const vals = []
    if (L) for (const m of this.atlas.modules) { const v = L.get(m); if (v != null && !m.generated) vals.push(v) }
    vals.sort((a, b) => a - b)
    const rank = (v) => {
      let lo = 0, hi = vals.length
      while (lo < hi) { const mid = (lo + hi) >> 1; if (vals[mid] < v) lo = mid + 1; else hi = mid }
      return vals.length > 1 ? lo / (vals.length - 1) : 0.5
    }
    for (const m of this.atlas.modules) {
      const v = L ? L.get(m) : null
      const ok = v != null && !m.generated
      for (const [mesh, i] of this.bld.get(m.id)?.parts || []) { const a = mesh.geometry.attributes.iImp; a.setZ(i, ok ? rank(v) : 0); a.setW(i, ok ? 1 : 0) }
    }
    for (const mesh of this.bmeshes) mesh.geometry.attributes.iImp.needsUpdate = true
    return L ? { ...L, min: vals[0], max: vals[vals.length - 1], n: vals.length } : null
  }

  // demolition preview: everything that depends on `id`, ring by ring (1 direct, 2, 3+)
  impact(id) {
    this.clearImpact()
    const A = this.atlas
    const users = new Map() // target → sources
    A.edges.forEach((e) => { if (e.test || e.seam) return; if (!users.has(e.target)) users.set(e.target, []); users.get(e.target).push(e.source) })
    const ring = new Map([[id, 0]])
    let front = [id]
    for (let d = 1; d <= 3 && front.length; d++) {
      const next = []
      for (const t of front) for (const s of users.get(t) || []) if (!ring.has(s)) { ring.set(s, d); next.push(s) }
      front = next
    }
    ring.delete(id)
    for (const [mid, d] of ring) for (const [mesh, i] of this.bld.get(mid)?.parts || []) { mesh.geometry.attributes.iImp.setX(i, d); mesh.geometry.attributes.iImp.needsUpdate = true }
    this.impactIds = ring
    // direct dependents' roads glow red
    this.ribbons.show((this.adj.get(id) || []).filter((i) => A.edges[i].target === id).map((i) => [i, 'in']))
    for (const [mid, d] of ring) if (d === 1) this.pulse(mid, 1.2)
    return ring
  }

  clearImpact() {
    if (!this.impactIds) return
    for (const mid of this.impactIds.keys()) for (const [mesh, i] of this.bld.get(mid)?.parts || []) { mesh.geometry.attributes.iImp.setX(i, 0); mesh.geometry.attributes.iImp.needsUpdate = true }
    this.impactIds = null
  }

  // hover: the building under the cursor glows faintly
  setHover(id) {
    if (id === this._hover) return
    const paint = (bid, on) => {
      const b = this.bld?.get(bid)
      if (!b) return
      for (const [mesh, i] of b.parts) {
        const fx = mesh.geometry.attributes.iFx
        fx.setX(i, on ? Math.max(b.hi || 0, 0.3) : (b.hi || 0))
        fx.needsUpdate = true
      }
    }
    if (this._hover) paint(this._hover, false)
    this._hover = id
    if (id) paint(id, true)
  }

  tintOf(m) {
    if (m.violations > 0) return RED_ROOF
    // zoning: roofs carry a quiet tint of the tier colour
    const tc = this.tierColor.get(m.tier)
    return tc ? NEUTRAL.clone().lerp(tc, 0.32) : NEUTRAL
  }

  // write every building part's matrix (boot growth, visibility, pulses)
  placeAll(t = 0) {
    for (const [id, b] of this.bld) {
      const grow = this.growOf(id)
      const pulse = this.pulses.get(id) || 0
      const cap = this.construction?.cap.get(id)
      for (const [mesh, i] of b.parts) {
        const r = mesh.userData.recs[i]
        let on = b.vis !== false ? 1 : 0
        // under construction: only the floors built so far, no roof yet (tiny sites are just a pit)
        if (cap != null && (cap < 0 || (r.f != null && r.f >= cap) || r.name.endsWith('_roof'))) on = 0
        _Q.setFromAxisAngle(_Y, r.ry)
        // grow: floors appear bottom-up during boot
        let sy = 1, y = r.y
        if (grow < 1) {
          const k = r.f != null ? clamp01(grow * (b.floors + 2) - r.f - 1) : clamp01(grow * 3)
          sy = k; y = r.y * Math.min(1, grow * 1.2)
        }
        const s = r.s * on * (1 + pulse * 0.06)
        _M.compose(_P.set(r.x, y, r.z), _Q, _S.set(s, s * sy, s))
        mesh.setMatrixAt(i, _M)
        if (pulse) mesh.geometry.attributes.iFx.setZ(i, Math.min(1, pulse * 0.8))
      }
    }
    for (const m of this.bmeshes) { m.instanceMatrix.needsUpdate = true; m.geometry.attributes.iFx.needsUpdate = true }
  }

  growOf(id) {
    if (this.bootT >= 50 || this.bootT < 0) return this.bootT < 0 ? 0.0001 : 1
    const b = this.bld.get(id)
    const d = this.plan.lots.get(id)
    // districts build from the centre outward
    const delay = Math.hypot(d.x, d.z) / Math.max(1, this.plan.extent) * 2.2 + (b.x * 7.13 % 1 + 1) % 1 * 0.5
    return clamp01((this.bootT - delay) / 1.4)
  }

  updateModuleLabels() {
    for (const o of this.modLabels) { o.element.remove(); o.removeFromParent() }
    this.modLabels = []
    const s = this.sel
    let ids = []
    if (s?.type === 'module') ids = [s.id, ...[...(this.hlN || [])].filter((x) => x !== s.id).slice(0, 24)]
    else if (s?.type === 'edge') ids = [...this.hlN]
    else if (s?.type === 'ctx') ids = this.atlas.modules.filter((m) => m.ctx === s.key && !m.generated).sort((a, b) => b.loc - a.loc).slice(0, 24).map((m) => m.id)
    for (const id of new Set(ids)) {
      const m = this.mods.get(id), b = this.bld.get(id)
      if (!m || !b || !b.vis || this.filters.labels !== 'all') continue
      const el = document.createElement('div')
      el.className = 'mlabel' + (s?.id === id ? ' sel' : '') + (m.violations ? ' bad' : '') + (m.wip ? ' wip' : '')
      el.textContent = m.name.replace(/\.(roc|rs|json|cs)$/, '')
      const o = new CSS2DObject(el)
      o.position.set(b.x, b.height + 0.8, b.z)
      this.root.add(o)
      this.modLabels.push(o)
    }
  }

  // ── flows as deliveries: one highlighted truck drives the use case's real route ──
  drive(ids, kind = 'command') {
    this.stopDrive()
    const P = this.plan, pts = []
    for (let k = 0; k + 1 < ids.length; k++) {
      const a = ids[k], b = ids[k + 1]
      let i = this.edgeIndex(a, b), rev = false
      if (i == null) { i = this.edgeIndex(b, a); rev = true }
      let seg = i != null && P.routes[i] ? P.routes[i].pieces.flatMap((p) => p.pts) : null
      if (seg && rev) seg = [...seg].reverse()
      if (!seg) { const A = this.bld.get(a), B = this.bld.get(b); if (A && B) seg = [[A.x, A.z], [B.x, B.z]] }
      if (seg) pts.push(...seg)
    }
    if (pts.length < 2) return
    const cum = [0]
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
    const mesh = kitMesh(kind === 'command' ? 'truck' : 'van', 1, this.mat)
    mesh.geometry.attributes.iTint.setXYZ(0, 0.25, 0.45, 1)
    mesh.geometry.attributes.iFx.setXYZW(0, 1, 0, 0, 0)
    this.root.add(mesh)
    const L = cum[cum.length - 1]
    // pace the drive to the stage ticker in main.js (~0.9 s per stage), but never slower than a highway
    this.driving = { pts, cum, L, t0: this.world.uni.uTime.value, speed: Math.max(9, L / Math.max(3, ids.length * 0.9)), mesh, end: 0 }
  }

  stopDrive() {
    if (!this.driving) return
    this.driving.mesh.removeFromParent()
    this.driving.mesh.geometry.dispose()
    this.driving = null
  }

  stepDrive(t, dt) {
    const D = this.driving
    const d = Math.min(D.L, (t - D.t0) * D.speed)
    let i = 1
    while (i < D.cum.length - 1 && D.cum[i] < d) i++
    const a = D.pts[i - 1], b = D.pts[i]
    const k = (d - D.cum[i - 1]) / Math.max(1e-4, D.cum[i] - D.cum[i - 1])
    const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz) || 1
    const x = a[0] + dx * k + (-dz / len) * 0.6, z = a[1] + dz * k + (dx / len) * 0.6
    _Q.setFromAxisAngle(_Y, Math.atan2(dx, dz))
    _M.compose(_P.set(x, 0.08, z), _Q, _S.setScalar(1.7))
    D.mesh.setMatrixAt(0, _M)
    D.mesh.instanceMatrix.needsUpdate = true
    // the camera rides along unless you grab it
    const w = this.world
    if (performance.now() - w.lastInput() > 600 && d < D.L) {
      const tg = w.controls.target
      const fx = (x - tg.x) * Math.min(1, dt * 2.5), fz = (z - tg.z) * Math.min(1, dt * 2.5)
      tg.x += fx; tg.z += fz; w.camera.position.x += fx; w.camera.position.z += fz
    }
    if (d >= D.L) { D.end += dt; if (D.end > 4) this.stopDrive() }
  }

  // ── per frame ─────────────────────────────────────────────────────────────
  update(t, dt) {
    if (!this.atlas || !this.bld) return
    if (this.driving) this.stepDrive(t, dt)
    if (this.bootT >= 0 && this.bootT < 50) {
      this.bootT += dt
      this.placeAll(t)
      if (this.bootT > 5) { this.bootT = 99; this.placeAll(t) }
    } else if (this.pulses.size) {
      for (const [id, p] of this.pulses) {
        const np = p * Math.pow(0.2, dt)
        if (np < 0.02) {
          this.pulses.delete(id)
          for (const [mesh, i] of this.bld.get(id).parts) mesh.geometry.attributes.iFx.setZ(i, 0)
        } else this.pulses.set(id, np)
      }
      this.placeAll(t)
    }
    const cam = this.world.camera, tgt = this.world.controls.target
    const dist = cam.position.distanceTo(tgt)
    this.traffic?.setLod(dist > 330)
    const far = clamp01((dist - 120) / 500)
    document.body.classList.toggle('far', far > 0.6)
    this._frame = (this._frame || 0) + 1
    if (this._frame % 8 === 0) this.declutter()
    for (const [k, p] of this.platforms) {
      p.flash *= Math.pow(0.1, dt)
      // signs: big at metro zoom, gone when you are down in the streets of that district
      const dd = Math.hypot(p.d.x - cam.position.x, p.d.z - cam.position.z)
      const close = dist < 90 && dd < p.d.R * 1.6
      const lab = this.filters.labels !== 'tier' && !this.filters.labelTiers.has(this.ctxs.get(k)?.tier)
      p.lab.visible = p.g.visible && lab && !close && !p.hidden
      p.el.style.setProperty('--flash', p.flash.toFixed(2))
    }
    this.construction?.update(t, dt)
    this.weather?.update(t, dt)
    this.chopper?.update(t, dt)
    if (this.river) for (const l of this.river.labels) l.lab.visible = this.filters.seams !== 'off' && (this.filters.seams === 'all' || l.b.status !== 'ok') && this.filters.labels !== 'tier'
  }

  // signs never pile up: higher-priority signs (selected, troubled, big) claim screen space first,
  // the rest step aside until you zoom in
  declutter() {
    const cam = this.world.camera, W = innerWidth, H = innerHeight
    const v = new THREE.Vector3()
    const s = this.sel
    const list = []
    for (const [k, p] of this.platforms) {
      const c = this.ctxs.get(k)
      v.copy(p.lab.position).project(cam)
      if (v.z > 1) { p.hidden = true; continue }
      if (!p.w) { p.w = p.el.offsetWidth || 120; p.h = p.el.offsetHeight || 30 }
      const pri = (s?.type === 'ctx' && s.key === k ? 1e6 : 0) + (this.hlCtx?.has(k) ? 1e5 : 0) + (c.crit + c.major) * 1000 + c.minor * 50 + c.modules
      list.push({ p, x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H, pri })
    }
    list.sort((a, b) => b.pri - a.pri)
    // panels count as occupied space: a sign half-hidden behind a card is worse than none
    const placed = []
    if (!document.body.classList.contains('nohud')) {
      for (const el of document.querySelectorAll('#top, #kpi .kc, #left, #mapbox, #ticker, #dock, #right, #detail.open, #advisor.open, #timeline.open')) {
        const cs = getComputedStyle(el)
        if (cs.opacity === '0' || cs.display === 'none') continue
        const r = el.getBoundingClientRect()
        if (r.width && r.height) placed.push({ x0: r.left, x1: r.right, y0: r.top, y1: r.bottom })
      }
    }
    for (const o of list) {
      const r = { x0: o.x - o.p.w / 2 - 4, x1: o.x + o.p.w / 2 + 4, y0: o.y - o.p.h / 2 - 3, y1: o.y + o.p.h / 2 + 3 }
      const hit = placed.some((q) => r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0)
      o.p.hidden = hit
      if (!hit) placed.push(r)
    }
  }

  // ── queries ───────────────────────────────────────────────────────────────
  posOf(id) {
    const b = this.bld?.get(id)
    return b ? [b.x, b.height * 0.5, b.z] : [0, 0, 0]
  }
  // camera framing for a module selection: it and everything it talks to
  frameOf(id) {
    const b = this.bld?.get(id)
    if (!b) return null
    // the building stays centred; zoom out until its nearer connections fit (far outliers don't drag the view)
    const ds = []
    for (const i of this.adj.get(id) || []) {
      const e = this.atlas.edges[i]
      if (e.test && !this.filters.tests) continue
      const o = this.bld.get(e.source === id ? e.target : e.source)
      if (o) ds.push(Math.hypot(o.x - b.x, o.z - b.z))
    }
    ds.sort((x, y) => x - y)
    const r = ds.length ? ds[Math.floor((ds.length - 1) * 0.8)] : 20
    return { pos: [b.x, 0, b.z], dist: Math.max(50, Math.min(300, r * 2.2)) }
  }

  ctxCenter(key) {
    const d = this.plan?.districts.get(key)
    return d ? { pos: [d.x, 0, d.z], radius: d.R } : { pos: [0, 0, 0], radius: 40 }
  }
  edgeIndex(a, b) { return this.edgeIdx?.get(a + '→' + b) }
  neighbors(id) {
    const out = [], inn = []
    for (const i of this.adj.get(id) || []) {
      const e = this.atlas.edges[i]
      if (e.source === id) out.push({ id: e.target, e })
      else inn.push({ id: e.source, e })
    }
    return { out, in: inn }
  }

  pick(x, y) {
    if (!this.bmeshes) return null
    this.ray.setFromCamera(new THREE.Vector2(x, y), this.world.camera)
    const extra = this.construction?.pickables() || []
    const hits = this.ray.intersectObjects([...this.bmeshes, ...extra, ...(this.police?.pickables() || []), ...(this.filters.seams !== 'off' ? this.river?.pick || [] : [])], false)
    for (const h of hits) {
      if (h.object.userData.vis) return { type: 'police', vi: h.object.userData.vis[h.instanceId] }
      if (h.object.userData.seams) return { type: 'seam', seam: h.object.userData.seams[h.instanceId] }
      const ids = h.object.userData.ids
      if (!ids) continue
      const id = ids[h.instanceId]
      if (this.vis.get(id) !== false) return { type: 'module', id }
    }
    // a dirt road through the woods?
    const dh = this.roads?.dirt && this.ray.intersectObject(this.roads.dirt, false)[0]
    if (dh) {
      let best = null, bd = 1e9
      for (const t of this.plan.tracks) {
        for (let i = 1; i < t.pts.length; i++) {
          const [ax, az] = t.pts[i - 1], [bx, bz] = t.pts[i]
          const vx = bx - ax, vz = bz - az, L2 = vx * vx + vz * vz || 1
          const k = Math.max(0, Math.min(1, ((dh.point.x - ax) * vx + (dh.point.z - az) * vz) / L2))
          const d = Math.hypot(dh.point.x - ax - vx * k, dh.point.z - az - vz * k)
          if (d < bd) { bd = d; best = t }
        }
      }
      if (best && bd < 6) return { type: 'track', key: best.key, a: best.a, b: best.b, n: best.n }
    }
    // ground → which district?
    const g = this.ray.intersectObject(this.ground.surf, false)[0]
    if (g) {
      for (const d of this.plan.districts.values()) {
        if (Math.hypot(g.point.x - d.x, g.point.z - d.z) < d.R && (!this._allow || this._allow.has(d.key))) return { type: 'ctx', key: d.key }
      }
    }
    return null
  }

  // ground point under a screen position (for the minimap, markers)
  groundAt(x, y) {
    this.ray.setFromCamera(new THREE.Vector2(x, y), this.world.camera)
    const p = new THREE.Vector3()
    return this.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p) ? p : null
  }

  dispose() {
    this.root.traverse((o) => {
      if (o.isCSS2DObject) o.element.remove()
      if (o.geometry) o.geometry.dispose()
      if (o.material && o.material !== this.mat) [].concat(o.material).forEach((m) => m.dispose?.())
    })
    this.land?.tex.dispose()
    this.traffic?.uniforms.uRoutes.value.dispose()
    this.world.scene.remove(this.root)
    this.root = new THREE.Group()
    this.world.scene.add(this.root)
    this.modLabels = []
    this.construction?.dispose()
    this.ribbons?.clear()
  }
}
