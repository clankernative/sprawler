// The 3D map: hex platforms per bounded context, glowing module nodes, shader edges + particles.
import * as THREE from 'three'
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { computeLayout, nodeSize, tangleLayout } from './layout.js'

export const GRADE = { S: '#ffd166', A: '#39ffb0', B: '#4cc9ff', C: '#c792ea', D: '#ff9f1c', F: '#ff2e4d', '?': '#5c6773' }
const RED = new THREE.Color('#ff2e4d')
const AMBER = new THREE.Color('#ffb020')
const PURPLE = new THREE.Color('#b388ff')
const WHITE = new THREE.Color('#ffffff')
const GREY = new THREE.Color('#34445a')
const INK = new THREE.Color('#1f2630')
const MAGENTA = new THREE.Color('#ff4fd8')
const SEAM_COL = { wire: '#ff4fd8', effects: '#b388ff', response: '#4cc9ff', predicate: '#ffd166' }
const PIN = { ok: new THREE.Color('#39ffb0'), bad: new THREE.Color('#ff2e4d'), dead: new THREE.Color('#ffb020') }
const BLACK = new THREE.Color(0, 0, 0)
const SEG = 10
const clamp01 = (x) => Math.max(0, Math.min(1, x))
const ease = (k) => 1 - Math.pow(1 - clamp01(k), 3)
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

const GEOS = {
  icosa: () => new THREE.IcosahedronGeometry(1, 0),
  box: () => new THREE.BoxGeometry(1.35, 1.35, 1.35),
  tetra: () => new THREE.TetrahedronGeometry(1.15),
  cone: () => new THREE.ConeGeometry(0.9, 1.8, 6),
  octa: () => new THREE.OctahedronGeometry(1.15),
  sphere: () => new THREE.SphereGeometry(0.9, 16, 12),
  dodeca: () => new THREE.DodecahedronGeometry(1.05),
}

const CURVE = /* glsl */ `
vec3 bez(vec3 a, vec3 c1, vec3 c2, vec3 b, float t){
  float u = 1.0 - t;
  return u*u*u*a + 3.0*u*u*t*c1 + 3.0*u*t*t*c2 + t*t*t*b;
}
// hex mode: control points sit on context hubs, so every edge between two contexts shares one bundled arc
vec3 route(vec3 a, vec3 b, vec3 h1, vec3 h2, float t, float lift, float bl){
  vec3 up = vec3(0.0, lift * 0.3, 0.0);
  return bez(a, mix(h1, mix(a, b, 0.33) + up, bl), mix(h2, mix(a, b, 0.66) + up, bl), b, t);
}`

const EDGE_VS = /* glsl */ `
uniform float uTime; uniform float uBlend;
attribute vec3 aA; attribute vec3 aB; attribute vec3 aTA; attribute vec3 aTB; attribute vec3 aH1; attribute vec3 aH2; attribute vec3 aC;
attribute float aT; attribute float aL; attribute float aS; attribute float aK; attribute float aSeed;
varying vec3 vC; varying float vS; varying float vT; varying float vK; varying float vSeed;
${CURVE}
void main(){
  vec3 a = mix(aA, aTA, uBlend); vec3 b = mix(aB, aTB, uBlend);
  vec3 p = route(a, b, aH1, aH2, aT, aL, uBlend);
  if (aK > 1.5 && aK < 2.5) {
    float j = sin(aT * 23.0 + uTime * 5.0 + aSeed * 11.0) * 0.22 * sin(aT * 3.14159);
    p.y += j; p.x += j * 0.6;
  }
  vC = aC; vS = aS; vT = aT; vK = aK; vSeed = aSeed;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`

const EDGE_FS = /* glsl */ `
uniform float uTime; uniform float uReveal; uniform float uFlow; uniform float uDetail; uniform float uDoc;
varying vec3 vC; varying float vS; varying float vT; varying float vK; varying float vSeed;
void main(){
  bool viol = vK > 1.5 && vK < 2.5;
  float speed = viol ? 1.1 : 0.35;
  float pulse = pow(fract(vT * 1.5 - uTime * speed + vSeed), 12.0) * (1.0 - uDoc);
  float lod = viol ? max(uDetail, 0.6) : uDetail;
  float a = vS * uReveal * lod * (0.5 + pulse * (0.5 + uFlow * 1.0));
  if (viol) a *= 0.8 + 0.2 * sin(uTime * 3.0 + vSeed * 20.0) * (1.0 - uDoc);
  a *= 1.0 + uDoc * 0.8;
  if (a < 0.003) discard;
  vec3 ink = viol ? vec3(0.8, 0.1, 0.16) : mix(vC * 0.35, vec3(0.16, 0.2, 0.27), 0.6);
  gl_FragColor = vec4(mix(vC * (0.85 + pulse * 0.9), ink, uDoc), min(a, 0.9));
}`

const PART_VS = /* glsl */ `
uniform float uTime; uniform float uBlend; uniform float uReveal; uniform float uFlow; uniform float uDetail;
attribute vec3 aA; attribute vec3 aB; attribute vec3 aTA; attribute vec3 aTB; attribute vec3 aH1; attribute vec3 aH2; attribute vec3 aC;
attribute float aL; attribute float aS; attribute float aK; attribute float aPh; attribute float aSp; attribute float aSz;
varying vec3 vC; varying float vA;
${CURVE}
void main(){
  float t = fract(uTime * aSp + aPh);
  vec3 a = mix(aA, aTA, uBlend); vec3 b = mix(aB, aTB, uBlend);
  vec3 p = route(a, b, aH1, aH2, t, aL, uBlend);
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSz * (1.0 + uFlow * 0.8) * (320.0 / max(1.0, -mv.z));
  float kindVis = aK < 0.5 ? uFlow : 1.0;
  vA = aS * uReveal * kindVis * uDetail * sin(t * 3.14159);
  vC = aC;
}`

const PART_FS = /* glsl */ `
varying vec3 vC; varying float vA;
void main(){
  vec2 d = gl_PointCoord - 0.5; float r = length(d);
  float a = smoothstep(0.5, 0.0, r) * vA;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vC * (0.9 + (0.5 - r) * 1.2), a * 0.8);
}`

const UV_VS = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`

// soft coloured light pool under each island
const GLOW_FS = /* glsl */ `
uniform vec3 uCol; uniform float uOp; varying vec2 vUv;
void main(){
  float d = length(vUv - 0.5) * 2.0;
  float a = pow(max(0.0, 1.0 - d), 2.4) * uOp;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uCol, a * 0.4);
}`

// red warning beam above contexts with major/critical threats
const BEAM_FS = /* glsl */ `
uniform float uTime; uniform float uOp; varying vec2 vUv;
void main(){
  float h = vUv.y;
  float a = (1.0 - h) * (1.0 - h) * (0.55 + 0.3 * sin(uTime * 2.0 - h * 14.0)) * uOp;
  if (a < 0.004) discard;
  gl_FragColor = vec4(1.0, 0.16, 0.28, a * 0.55);
}`

function hexLoop(r, y, mat) {
  const pts = []
  for (let k = 0; k <= 6; k++) {
    const a = (k * Math.PI) / 3
    pts.push(new THREE.Vector3(Math.sin(a) * r, y, Math.cos(a) * r))
  }
  return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat)
}

const _M = new THREE.Matrix4(), _Q = new THREE.Quaternion(), _P = new THREE.Vector3(), _S = new THREE.Vector3(), _E = new THREE.Euler()

export class AtlasView {
  constructor(world) {
    this.world = world
    this.root = new THREE.Group()
    world.scene.add(this.root)
    this.uni = { uTime: { value: 0 }, uBlend: { value: 0 }, uReveal: { value: 0 }, uFlow: { value: 0 }, uDetail: { value: 1 }, uDoc: { value: 0 } }
    this.filters = { tiers: new Set(), layers: new Set(), tests: false, generated: true, picked: new Set(), isolate: 'off', height: 'traffic', labels: 'all', labelTiers: new Set(), focusHide: true, seams: 'all', solo: new Set() }
    this.seamObjs = []
    this.seamPick = []
    this.focusCtx = null
    this.nodeEmis = { value: 0.4 }
    this.highways = []
    this.platforms = new Map()
    this.doc = false
    this.nearCtx = null
    this.far = 0
    this._allow = null
    this.mode = 'structure'
    this.sel = null
    this.hoverId = null
    this.blend = 0
    this.blendTarget = 0
    this.bootT = -1
    this.onCtxClick = null
    this.ray = new THREE.Raycaster()
    this.modLabels = []
    this.atlas = null
    this.pulses = new Map()
    this.edgePulses = new Map()
    this.baseCol = new Map()
  }

  // brief glow on a module / edge — used by flow playback and live traces
  pulse(id, amt = 1) {
    if (this.nodeRef?.has(id)) this.pulses.set(id, Math.max(this.pulses.get(id) || 0, amt))
  }

  pulseEdge(a, b, amt = 1) {
    const i = this.edgeIndex(a, b)
    if (i != null) this.edgePulses.set(i, Math.max(this.edgePulses.get(i) || 0, amt))
    return i
  }

  build(atlas, { instant = false } = {}) {
    this.dispose()
    atlas = this.seamView(atlas)
    this.atlas = atlas
    this.mods = new Map(atlas.modules.map((m) => [m.id, m]))
    this.ctxs = new Map(atlas.contexts.map((c) => [c.key, c]))
    this.tierColor = new Map(atlas.tiers.map((t) => [t.id, new THREE.Color(t.color)]))
    this.tierColor.set('unmapped', new THREE.Color('#9aa5b1'))
    this.tierIdx = new Map(atlas.tiers.map((t, i) => [t.id, i]))
    this.tierIdx.set('unmapped', atlas.tiers.length)
    this.L = computeLayout(atlas)
    this.world.floorU.uExtent.value = this.L.extent
    this.world.setExtent(this.L.extent)
    this.computeElevation()
    this.hex = new Map()
    for (const m of atlas.modules) {
      const c = this.L.ctxPos.get(m.ctx)
      const p = c.local.pos.get(m.id) || [0, 1, 0]
      this.hex.set(m.id, new THREE.Vector3(c.x + p[0], p[1] + 0.6 + (this.elev.get(m.ctx) || 0), c.z + p[2]))
    }
    this.size = new Map(atlas.modules.map((m) => [m.id, nodeSize(m)]))
    this.tang = null
    this.pulses = new Map()
    this.edgePulses = new Map()
    this.baseCol = new Map()
    this.buildTiers()
    this.buildPlatforms()
    this.buildNodes()
    this.buildEdges()
    this.buildWells()
    this.buildSeams()
    this.bootT = instant ? 99 : -1
    if (this.blendTarget > 0) this.ensureTangle()
    if (this.sel && !this.selValid(this.sel)) this.sel = null
    if (this.doc) this.setDoc(true)
    this.applyState()
  }

  // contract seams: off = hide, miss = only mismatches, all = every matched protocol link too
  seamView(A) {
    const mode = this.filters.seams || 'miss'
    if (mode === 'all') return A
    return { ...A, edges: A.edges.filter((e) => !e.seam || (mode === 'miss' && e.status === 'violation')) }
  }

  // island height: how tall each context stands (traffic = incoming links, like a city's size)
  computeElevation() {
    const A = this.atlas, metric = this.filters.height || 'traffic'
    const churn = new Map()
    for (const c of A.history || []) for (const k of c.contexts) churn.set(k, (churn.get(k) || 0) + 1)
    this.metricVal = new Map()
    for (const c of A.contexts) {
      const v = metric === 'size' ? c.loc : metric === 'churn' ? (churn.get(c.key) || 0) : metric === 'flat' ? 0 : (c.inbound || 0)
      this.metricVal.set(c.key, v)
    }
    const max = Math.max(1, ...this.metricVal.values())
    this.elev = new Map()
    for (const [k, v] of this.metricVal) this.elev.set(k, metric === 'flat' ? 0 : (9 * Math.log2(1 + v)) / Math.log2(1 + max))
  }

  // paper / ink look for the top-down diagram
  setDoc(on) {
    this.doc = on
    this.uni.uDoc.value = on ? 1 : 0
    this.nodeEmis.value = on ? 0.06 : 0.4
    if (this.pts) this.pts.visible = !on
    for (const p of this.platforms.values()) {
      for (const [m] of p.fadeMats) {
        const u = m.userData
        if (!u?.c) continue
        m.color.copy(on ? u.docC : u.c)
        if (m.emissive) { m.emissive.copy(on ? BLACK : u.e); m.roughness = on ? 0.95 : 0.55; m.metalness = on ? 0 : 0.35 }
      }
    }
    if (this.nodeRef) this.applyState()
  }

  allowCtx() {
    const F = this.filters
    if (F.isolate === 'off' || !F.picked.size) return null
    const s = new Set(F.picked)
    if (F.isolate === 'plus') {
      for (const e of this.atlas.edges) {
        if (e.test) continue
        const a = this.mods.get(e.source).ctx, b = this.mods.get(e.target).ctx
        if (F.picked.has(a)) s.add(b)
        if (F.picked.has(b)) s.add(a)
      }
    }
    return s
  }

  selValid(s) {
    if (s.type === 'module') return this.mods.has(s.id)
    if (s.type === 'ctx') return this.ctxs.has(s.key)
    if (s.type === 'commit') return true
    return false
  }

  layerColor(l) {
    return new THREE.Color(this.atlas.layers[l]?.color || '#9aa5b1')
  }

  startBoot() {
    this.bootT = 0
  }

  // ── build ────────────────────────────────────────────────────────────────
  buildTiers() {
    this.tierObjs = []
    const tiers = this.L.tiers
    tiers.forEach((t, i) => {
      const col = this.tierColor.get(t.id)
      const r = i < tiers.length - 1 ? (t.outer + tiers[i + 1].inner) / 2 : t.outer + 8
      const r0 = i === 0 ? 0.01 : (tiers[i - 1].outer + t.inner) / 2
      // zone + ring line are drawn by the floor shader (no coplanar meshes to z-fight the floor)
      if (i < 8) { this.world.floorU.uTierR.value[i].set(r0, r); this.world.floorU.uTierC.value[i].copy(col) }
      const tier = this.atlas.tiers.find((x) => x.id === t.id) || { label: 'UNMAPPED', blurb: 'fog of war' }
      const el = document.createElement('div')
      el.className = 'tlabel'
      el.style.color = '#' + col.getHexString()
      el.innerHTML = `<b>${esc(tier.label)}</b><span>${esc(tier.blurb || '')}</span>`
      const lab = new CSS2DObject(el)
      lab.position.set(0, 1, -r)
      this.root.add(lab)
      this.tierObjs.push({ el, lab, col, id: t.id })
    })
    this.world.floorU.uTierN.value = Math.min(8, tiers.length)
  }

  buildPlatforms() {
    this.platforms = new Map()
    this.tops = []
    const perTier = new Map()
    const sorted = [...this.atlas.contexts].sort((a, b) => {
      const pa = this.L.ctxPos.get(a.key), pb = this.L.ctxPos.get(b.key)
      return (this.tierIdx.get(a.tier) - this.tierIdx.get(b.tier)) || Math.atan2(pa.z, pa.x) - Math.atan2(pb.z, pb.x)
    })
    const PAPER = new THREE.Color('#ece6d8'), PAPER_SIDE = new THREE.Color('#d6cdb9'), WHITE_C = new THREE.Color('#ffffff')
    for (const c of sorted) {
      const P = this.L.ctxPos.get(c.key)
      const ti = this.tierIdx.get(c.tier) ?? 0
      const k = perTier.get(c.tier) || 0
      perTier.set(c.tier, k + 1)
      const col = this.tierColor.get(c.tier)
      const R = P.radius
      const EL = this.elev.get(c.key) || 0
      const g = new THREE.Group()
      g.position.set(P.x, 0, P.z)
      this.root.add(g)
      const fadeMats = []
      // polygonOffset pushes solids back so outline lines on the same faces never z-fight
      const solid = (color, emissive, op, docC) => {
        const m = new THREE.MeshStandardMaterial({ color, emissive, metalness: 0.35, roughness: 0.55, transparent: true, opacity: op, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })
        m.userData = { c: new THREE.Color(color), e: new THREE.Color(emissive), docC: new THREE.Color(docC) }
        fadeMats.push([m, op])
        return m
      }
      const lineMat = (color, op, docC = '#3a4452') => {
        const m = new THREE.LineBasicMaterial({ color, transparent: true, opacity: op })
        m.userData = { c: new THREE.Color(color), docC: new THREE.Color(docC) }
        fadeMats.push([m, op])
        return m
      }
      // island slab: taller = more traffic (or size / churn); bevelled skirt, darker sides
      // top at EL+0.6, bottom 0.25 above the floor (y=-0.62): the island never crosses the floor plane
      const H = 0.97 + EL
      const slabGeo = new THREE.CylinderGeometry(R, R * 1.06, H, 6, 1)
      const sideM = solid(0x03070d, col.clone().multiplyScalar(0.025), 0.97, PAPER_SIDE)
      const topM = solid(0x070f1b, col.clone().multiplyScalar(0.05), 0.97, PAPER)
      const top = new THREE.Mesh(slabGeo, [sideM, topM, sideM])
      top.position.y = 0.6 + EL - H / 2
      top.userData.ctx = c.key
      g.add(top)
      this.tops.push(top)
      const rim = new THREE.LineSegments(new THREE.EdgesGeometry(slabGeo), new THREE.LineBasicMaterial({ color: col.clone(), transparent: true, opacity: 0.9 }))
      rim.position.y = top.position.y
      g.add(rim)
      const deck = new THREE.Group()
      deck.position.y = EL
      g.add(deck)
      // onion rings: each band becomes a low terrace coloured by its dominant layer
      const bands = P.local.bands
      const members = bands.map(() => new Map())
      for (const m of this.atlas.modules) {
        if (m.ctx !== c.key) continue
        const h = this.hex.get(m.id)
        const d = Math.hypot(h.x - P.x, h.z - P.z)
        let bi = bands.findIndex((b) => d <= b + 0.01)
        if (bi < 0) bi = bands.length - 1
        members[bi].set(m.layer, (members[bi].get(m.layer) || 0) + (m.generated ? 0.25 : 1))
      }
      const dominant = (mp) => {
        let best = null, n = -1
        for (const [l, v] of mp) if (v > n) { n = v; best = l }
        return best
      }
      const nb = bands.length
      for (let bi = nb - 1; bi >= 1; bi--) {
        const l = dominant(members[bi])
        if (!l) continue
        const lc = this.layerColor(l)
        const rr = Math.min(R * 0.97, bands[bi] * 1.12)
        const h = 0.32 + (nb - bi) * 0.09
        const tg = new THREE.CylinderGeometry(rr, rr * 1.01, h, 6)
        const tm = new THREE.Mesh(tg, solid(lc.clone().multiplyScalar(0.17), lc.clone().multiplyScalar(0.11), 0.95, lc.clone().lerp(WHITE_C, 0.72)))
        tm.position.y = 0.3 + h / 2
        tm.userData.ctx = c.key
        deck.add(tm)
        this.tops.push(tm)
        const te = new THREE.LineSegments(new THREE.EdgesGeometry(tg), lineMat(lc.clone().multiplyScalar(0.85), 0.5, lc.clone().multiplyScalar(0.55)))
        te.position.y = tm.position.y
        deck.add(te)
      }
      let dais = null
      if (P.local.core > 0) {
        const cl = dominant(members[0])
        const hasCore = c.layers.core || c.layers.kernel
        const dcol = hasCore ? new THREE.Color('#ffd166') : cl ? this.layerColor(cl) : col
        // spans 0.3 → 1.4 so its bottom edge sits inside the slab, not on its top face
        const dg = new THREE.CylinderGeometry(P.local.core, P.local.core * 1.05, 1.1, 6)
        dais = new THREE.Mesh(dg, solid(dcol.clone().multiplyScalar(0.14), dcol.clone().multiplyScalar(hasCore ? 0.2 : 0.1), 0.95, dcol.clone().lerp(WHITE_C, 0.6)))
        dais.position.y = 0.85
        dais.userData.ctx = c.key
        deck.add(dais)
        this.tops.push(dais)
        const de = new THREE.LineSegments(new THREE.EdgesGeometry(dg), lineMat(dcol, 0.75, dcol.clone().multiplyScalar(0.5)))
        de.position.y = 0.85
        deck.add(de)
      }
      let nest = null
      if (c.nest) {
        nest = hexLoop(R * 1.14, 0.9, new THREE.LineBasicMaterial({ color: RED, transparent: true, opacity: 0.8 }))
        deck.add(nest)
      }
      const glowU = { uOp: { value: 0 } } // glow is drawn by the floor shader
      let beam = null
      if (c.crit + c.major) {
        const bh = 60 + 25 * Math.log2(1 + c.crit + c.major)
        beam = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.16, R * 0.3, bh, 16, 1, true), new THREE.ShaderMaterial({
          uniforms: { uTime: this.uni.uTime, uOp: { value: 0 } }, vertexShader: UV_VS, fragmentShader: BEAM_FS,
          transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        }))
        beam.position.y = EL + 0.6 + bh / 2
        g.add(beam)
      }
      const el = document.createElement('div')
      el.className = 'plabel'
      const v = c.crit + c.major + c.minor
      el.title = `${this.filters.height}: ${this.metricVal.get(c.key)}`
      el.innerHTML = `<span class="g" style="color:${GRADE[c.grade]}">${c.grade}</span><span class="n">${esc(c.label)}</span><span class="m">${c.modules}</span>${v ? `<span class="v ${c.crit + c.major ? 'hot' : ''}">⚠${v}</span>` : ''}${c.nest ? '<span class="v hot">NEST</span>' : ''}`
      el.addEventListener('click', (e) => { e.stopPropagation(); this.onCtxClick?.(c.key, e) })
      const lab = new CSS2DObject(el)
      lab.position.set(0, EL + 3, R * 0.95)
      g.add(lab)
      this.platforms.set(c.key, {
        g, top, rim, dais, nest, el, lab, tier: c.tier, col, R, fadeMats, glowU, beam, EL, flash: 0, seed: Math.random() * 6,
        delay: ti * 0.5 + k * 0.05, viol: c.crit + c.major, minor: c.minor,
      })
    }
  }

  buildNodes() {
    const byShape = new Map()
    for (const m of this.atlas.modules) {
      const s = this.atlas.layers[m.layer]?.shape || 'sphere'
      if (!byShape.has(s)) byShape.set(s, [])
      byShape.get(s).push(m)
    }
    this.meshes = []
    this.nodeRef = new Map()
    for (const [shape, list] of byShape) {
      const mat = new THREE.MeshLambertMaterial({ flatShading: true })
      mat.onBeforeCompile = (sh) => {
        sh.uniforms.uEmis = this.nodeEmis
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uEmis;')
        sh.fragmentShader = sh.fragmentShader.replace(
          '#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\n#if defined(USE_INSTANCING_COLOR) || defined(USE_COLOR)\ntotalEmissiveRadiance += vColor * uEmis;\n#endif',
        )
      }
      const mesh = new THREE.InstancedMesh((GEOS[shape] || GEOS.sphere)(), mat, list.length)
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      mesh.frustumCulled = false
      mesh.userData.ids = list.map((m) => m.id)
      list.forEach((m, i) => {
        mesh.setColorAt(i, this.layerColor(m.layer))
        mesh.setMatrixAt(i, new THREE.Matrix4().makeScale(0, 0, 0))
        this.nodeRef.set(m.id, [mesh, i])
      })
      mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)
      this.root.add(mesh)
      this.meshes.push(mesh)
    }
    this.nodeVis = new Map()
  }

  buildEdges() {
    const E = this.atlas.edges
    const n = E.length
    this.adj = new Map()
    this.edgeKind = new Uint8Array(n)
    this.edgeBase = new Float32Array(n)
    this.edgeIdx = new Map()
    this.pCount = new Int32Array(n)
    this.pStart = new Int32Array(n)
    let pc = 0
    E.forEach((e, i) => {
      for (const id of [e.source, e.target]) {
        if (!this.adj.has(id)) this.adj.set(id, [])
        this.adj.get(id).push(i)
      }
      this.edgeIdx.set(e.source + '→' + e.target, i)
      const k = e.status === 'violation' ? 2 : e.status === 'test' || e.status === 'fog' ? 3 : e.status === 'cross' ? 1 : 0
      this.edgeKind[i] = k
      this.pCount[i] = e.seam ? 0 : k === 2 ? 5 : k === 3 ? 0 : 1
      pc += this.pCount[i]
    })
    const V = n * SEG * 2
    const f3 = (c) => new Float32Array(c * 3), f1 = (c) => new Float32Array(c)
    const aA = f3(V), aB = f3(V), aTA = f3(V), aTB = f3(V), aH1 = f3(V), aH2 = f3(V), aC = f3(V), aT = f1(V), aL = f1(V), aS = f1(V), aK = f1(V), aSeed = f1(V)
    const pA = f3(pc), pB = f3(pc), pTA = f3(pc), pTB = f3(pc), pH1 = f3(pc), pH2 = f3(pc), pC = f3(pc), pL = f1(pc), pS = f1(pc), pK = f1(pc), pPh = f1(pc), pSp = f1(pc), pSz = f1(pc)
    const hub = (key) => { const p = this.L.ctxPos.get(key); return new THREE.Vector3(p.x, (this.elev.get(key) || 0) + 1, p.z) }
    const hubY = (ha, hb) => Math.max(ha.y, hb.y) + 4 + Math.hypot(ha.x - hb.x, ha.z - hb.z) * 0.16
    const pairs = new Map()
    const h1 = new THREE.Vector3(), h2 = new THREE.Vector3(), up = new THREE.Vector3()
    let pi = 0
    E.forEach((e, i) => {
      const a = this.hex.get(e.source), b = this.hex.get(e.target)
      const sm = this.mods.get(e.source), tm = this.mods.get(e.target)
      const k = this.edgeKind[i]
      const col = k === 2 ? RED.clone()
        : e.seam ? MAGENTA.clone()
        : k === 3 ? GREY.clone()
          : k === 1 ? this.tierColor.get(tm.tier).clone().lerp(this.tierColor.get(sm.tier), 0.35)
            : this.layerColor(sm.layer).lerp(this.tierColor.get(sm.tier), 0.3)
      const d = a.distanceTo(b)
      let lift
      if (sm.ctx !== tm.ctx) {
        // bundle: all edges between the same two contexts share hub control points
        const ha = hub(sm.ctx), hb = hub(tm.ctx)
        const y = hubY(ha, hb) + (k === 2 ? 5 : 0)
        h1.lerpVectors(ha, hb, 0.14).setY(y)
        h2.lerpVectors(ha, hb, 0.86).setY(y)
        lift = 4 + d * 0.2
        if (!e.test && !e.seam) {
          const pk = sm.ctx < tm.ctx ? sm.ctx + '|' + tm.ctx : tm.ctx + '|' + sm.ctx
          if (!pairs.has(pk)) pairs.set(pk, { a: sm.ctx, b: tm.ctx, ta: sm.tier, tb: tm.tier, n: 0, viol: 0 })
          const pr = pairs.get(pk)
          pr.n += e.weight || 1
          if (k === 2) pr.viol++
        }
      } else {
        lift = k === 2 ? 8 + d * 0.32 : k === 3 ? 1 + d * 0.08 : 1.2 + d * 0.12
        up.set(0, lift * 1.33, 0) // cubic with both controls lifted peaks at 0.75 of their height
        h1.lerpVectors(a, b, 1 / 3).add(up)
        h2.lerpVectors(a, b, 2 / 3).add(up)
      }
      const seed = Math.random()
      for (let s = 0; s < SEG; s++) {
        for (let hh = 0; hh < 2; hh++) {
          const v = (i * SEG + s) * 2 + hh
          a.toArray(aA, v * 3); b.toArray(aB, v * 3); a.toArray(aTA, v * 3); b.toArray(aTB, v * 3); col.toArray(aC, v * 3)
          h1.toArray(aH1, v * 3); h2.toArray(aH2, v * 3)
          aT[v] = (s + hh) / SEG; aL[v] = lift; aK[v] = k; aSeed[v] = seed
        }
      }
      this.pStart[i] = pi
      for (let q = 0; q < this.pCount[i]; q++, pi++) {
        a.toArray(pA, pi * 3); b.toArray(pB, pi * 3); a.toArray(pTA, pi * 3); b.toArray(pTB, pi * 3); col.toArray(pC, pi * 3)
        h1.toArray(pH1, pi * 3); h2.toArray(pH2, pi * 3)
        pL[pi] = lift; pK[pi] = k
        pPh[pi] = q / Math.max(1, this.pCount[i]) + Math.random() * 0.15
        pSp[pi] = k === 2 ? 0.55 : k === 1 ? 0.2 : 0.3
        pSz[pi] = k === 2 ? 2.6 : k === 1 ? 1.6 : 1.1
      }
    })
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(V * 3), 3))
    const set = (geo, name, arr, sz) => geo.setAttribute(name, new THREE.BufferAttribute(arr, sz))
    set(g, 'aA', aA, 3); set(g, 'aB', aB, 3); set(g, 'aTA', aTA, 3); set(g, 'aTB', aTB, 3); set(g, 'aH1', aH1, 3); set(g, 'aH2', aH2, 3); set(g, 'aC', aC, 3)
    set(g, 'aT', aT, 1); set(g, 'aL', aL, 1); set(g, 'aS', aS, 1); set(g, 'aK', aK, 1); set(g, 'aSeed', aSeed, 1)
    const lines = new THREE.LineSegments(g, new THREE.ShaderMaterial({
      uniforms: this.uni, vertexShader: EDGE_VS, fragmentShader: EDGE_FS,
      transparent: true, depthWrite: false, blending: THREE.NormalBlending, // additive stacked crossings to white
    }))
    lines.frustumCulled = false
    this.root.add(lines)
    this.edgeGeo = g
    const pg = new THREE.BufferGeometry()
    pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(Math.max(1, pc) * 3), 3))
    set(pg, 'aA', pA, 3); set(pg, 'aB', pB, 3); set(pg, 'aTA', pTA, 3); set(pg, 'aTB', pTB, 3); set(pg, 'aH1', pH1, 3); set(pg, 'aH2', pH2, 3); set(pg, 'aC', pC, 3)
    set(pg, 'aL', pL, 1); set(pg, 'aS', pS, 1); set(pg, 'aK', pK, 1); set(pg, 'aPh', pPh, 1); set(pg, 'aSp', pSp, 1); set(pg, 'aSz', pSz, 1)
    pg.setDrawRange(0, pc)
    const pts = new THREE.Points(pg, new THREE.ShaderMaterial({
      uniforms: this.uni, vertexShader: PART_VS, fragmentShader: PART_FS,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }))
    pts.frustumCulled = false
    this.root.add(pts)
    this.pts = pts
    this.partGeo = pg
    this.buildHighways(pairs, hub, hubY)
  }

  // one thick tube per connected context pair — the zoomed-out "diagram" layer
  buildHighways(pairs, hub, hubY) {
    this.highways = []
    for (const p of pairs.values()) {
      const ha = hub(p.a), hb = hub(p.b)
      const y = hubY(ha, hb)
      const curve = new THREE.CubicBezierCurve3(ha, ha.clone().lerp(hb, 0.14).setY(y), ha.clone().lerp(hb, 0.86).setY(y), hb)
      const r = 0.35 + 0.42 * Math.log2(1 + p.n)
      const col = p.viol ? RED.clone() : this.tierColor.get(p.ta).clone().lerp(this.tierColor.get(p.tb), 0.5)
      const mat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0, depthWrite: false })
      const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 28, r, 6, false), mat)
      this.root.add(mesh)
      this.highways.push({ mesh, mat, a: p.a, b: p.b, col, viol: p.viol, n: p.n })
    }
  }

  // contract seams as hardware: a plug on the emitting island, a socket on the handling island, one cable
  // per (seam, emitter island, handler island). Each pin on the plug face is one protocol kind.
  buildSeams() {
    this.seamObjs = []
    this.seamPick = []
    const mode = this.filters.seams || 'all'
    const A = this.atlas
    if (mode === 'off' || !(A.seams || []).length) return
    const bundles = new Map()
    for (const s of A.seams) {
      const kinds = [...s.unhandled.map((k) => [k, 'bad']), ...s.dead.map((k) => [k, 'dead']), ...s.matched.map((k) => [k, 'ok'])]
      for (const [k, st] of kinds) {
        const ef = s.emitted[k]?.[0]?.file || s.emitters[0]
        const hf = s.handled[k]?.[0]?.file || s.handlers[0]
        const ec = this.mods.get(ef)?.ctx, hc = this.mods.get(hf)?.ctx
        if (!ec || !hc || ec === hc || !this.platforms.has(ec) || !this.platforms.has(hc)) continue
        const key = `${s.id}|${ec}|${hc}`
        if (!bundles.has(key)) bundles.set(key, { s, ec, hc, pins: [] })
        bundles.get(key).pins.push({ k, st })
      }
    }
    const slots = new Map()
    const slot = (ctx) => { const n = slots.get(ctx) || 0; slots.set(ctx, n + 1); return n }
    const pinGeo = new THREE.SphereGeometry(0.2, 10, 8)
    const holeGeo = new THREE.TorusGeometry(0.2, 0.06, 6, 12)
    for (const b of bundles.values()) {
      const bad = b.pins.filter((p) => p.st === 'bad').length, dead = b.pins.filter((p) => p.st === 'dead').length
      const okN = b.pins.length - bad - dead
      if (mode === 'miss' && !bad && !dead) continue
      const status = bad ? 'bad' : dead ? 'dead' : 'ok'
      const sc = new THREE.Color(SEAM_COL[b.s.id] || '#ff4fd8')
      const pa = this.L.ctxPos.get(b.ec), pb = this.L.ctxPos.get(b.hc)
      const d = new THREE.Vector3(pb.x - pa.x, 0, pb.z - pa.z).normalize()
      const obj = { seam: b.s.id, ec: b.ec, hc: b.hc, world: [], mats: [], caps: [], label: null }
      const track = (m, base = 1) => { obj.mats.push([m, base]); return m }
      const connector = (ctx, dirv, socket) => {
        const P = this.platforms.get(ctx), n = slot(ctx)
        const tan = new THREE.Vector3(-dirv.z, 0, dirv.x)
        const off = (n % 2 ? 1 : -1) * Math.ceil(n / 2) * 3.4
        const g = new THREE.Group()
        g.position.copy(dirv).multiplyScalar(P.R * 0.86).addScaledVector(tan, off).setY(P.EL + 1.5)
        g.rotation.y = Math.atan2(dirv.x, dirv.z)
        P.g.add(g)
        const cols = Math.min(8, b.pins.length)
        const w = Math.max(2.2, cols * 0.55 + 0.6), h = b.pins.length > 8 ? 1.9 : 1.3
        const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, 1.4), track(new THREE.MeshStandardMaterial({
          color: 0x0b1320, emissive: sc.clone().multiplyScalar(0.14), metalness: 0.6, roughness: 0.35, transparent: true, opacity: 0,
        })))
        box.userData = { seam: b.s.id }
        g.add(box)
        this.seamPick.push(box)
        g.add(new THREE.LineSegments(new THREE.EdgesGeometry(box.geometry), track(new THREE.LineBasicMaterial({ color: sc, transparent: true, opacity: 0 }))))
        b.pins.forEach((p, i) => {
          // plug shows what it emits, socket shows what it handles — a missing kind is an empty hole
          const missing = socket ? p.st === 'bad' : p.st === 'dead'
          const pm = new THREE.Mesh(missing ? holeGeo : pinGeo, track(new THREE.MeshBasicMaterial({ color: PIN[p.st], transparent: true, opacity: 0 })))
          pm.position.set(((i % 8) - (cols - 1) / 2) * 0.55, h > 1.5 ? (i >= 8 ? -0.4 : 0.4) : 0, 0.72)
          pm.userData = { seam: b.s.id, kind: p.k, st: p.st }
          g.add(pm)
          this.seamPick.push(pm)
        })
        return new THREE.Vector3(P.g.position.x + g.position.x, g.position.y, P.g.position.z + g.position.z).addScaledVector(dirv, 0.8)
      }
      const a = connector(b.ec, d, false)
      const z = connector(b.hc, d.clone().negate(), true)
      const cableMat = () => track(new THREE.MeshStandardMaterial({
        color: 0x151c28, emissive: PIN[status].clone().multiplyScalar(0.45), metalness: 0.5, roughness: 0.4, transparent: true, opacity: 0,
      }))
      const radius = 0.3 + 0.05 * Math.min(12, b.pins.length)
      const addWorld = (o) => { this.root.add(o); obj.world.push(o); return o }
      let labelAt
      if (okN > 0) {
        const dist = a.distanceTo(z)
        const mid = a.clone().lerp(z, 0.5).setY(Math.max(a.y, z.y) + 5 + dist * 0.1)
        const curve = new THREE.CatmullRomCurve3([a, a.clone().addScaledVector(d, 5).setY(a.y + 2), mid, z.clone().addScaledVector(d, -5).setY(z.y + 2), z])
        const cable = addWorld(new THREE.Mesh(new THREE.TubeGeometry(curve, 64, radius, 8, false), cableMat()))
        cable.userData = { seam: b.s.id }
        this.seamPick.push(cable)
        labelAt = mid.clone().setY(mid.y + 1.5)
      } else {
        // nothing matches: the cable dangles from the side that has the kind, and a ghost line shows where it should go
        const src = bad ? a : z, dir = bad ? d : d.clone().negate(), dst = bad ? z : a
        const tip = src.clone().addScaledVector(dir, 15).setY(0.2)
        const curve = new THREE.CatmullRomCurve3([src, src.clone().addScaledVector(dir, 6).setY(src.y + 1.5), src.clone().addScaledVector(dir, 12).setY(2), tip])
        const cable = addWorld(new THREE.Mesh(new THREE.TubeGeometry(curve, 40, radius, 8, false), cableMat()))
        cable.userData = { seam: b.s.id }
        this.seamPick.push(cable)
        const cap = addWorld(new THREE.Mesh(new THREE.SphereGeometry(radius * 2.2, 14, 10), track(new THREE.MeshBasicMaterial({ color: PIN[status], transparent: true, opacity: 0 }))))
        cap.position.copy(tip)
        cap.userData = { seam: b.s.id }
        this.seamPick.push(cap)
        obj.caps.push(cap)
        const ghost = addWorld(new THREE.Line(new THREE.BufferGeometry().setFromPoints([tip, dst]),
          track(new THREE.LineDashedMaterial({ color: PIN[status], dashSize: 1.2, gapSize: 0.9, transparent: true, opacity: 0 }), 0.45)))
        ghost.computeLineDistances()
        labelAt = tip.clone().setY(3)
      }
      const el = document.createElement('div')
      el.className = 'slabel ' + status
      el.innerHTML = `⇄ <b>${esc(b.s.id)}</b> <span class="ok">${okN}✓</span>${bad ? ` <span class="bad">${bad}✕</span>` : ''}${dead ? ` <span class="dead">${dead}◌</span>` : ''}`
      el.addEventListener('click', (e) => { e.stopPropagation(); this.onSeamClick?.(b.s.id) })
      const lab = new CSS2DObject(el)
      lab.position.copy(labelAt)
      this.root.add(lab)
      obj.label = lab
      this.seamObjs.push(obj)
    }
  }

  buildWells() {
    this.wells = (this.atlas.wells || []).filter((id) => this.hex.has(id)).map((id) => {
      const mk = (r, c) => new THREE.Mesh(new THREE.TorusGeometry(r, 0.12, 8, 64), new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.9 }))
      const a = mk(2.8, 0xb388ff), b = mk(3.8, 0x7c4dff)
      this.root.add(a, b)
      return { id, a, b }
    })
  }

  ensureTangle() {
    if (this.tang) return
    this.tang = tangleLayout(this.atlas.modules, this.atlas.edges.filter((e) => !e.test), this.L.extent)
    const G = this.edgeGeo.attributes, P = this.partGeo.attributes
    this.atlas.edges.forEach((e, i) => {
      const a = this.tang.get(e.source), b = this.tang.get(e.target)
      for (let v = i * SEG * 2; v < (i + 1) * SEG * 2; v++) {
        G.aTA.array.set(a, v * 3); G.aTB.array.set(b, v * 3)
      }
      for (let q = this.pStart[i]; q < this.pStart[i] + this.pCount[i]; q++) {
        P.aTA.array.set(a, q * 3); P.aTB.array.set(b, q * 3)
      }
    })
    G.aTA.needsUpdate = G.aTB.needsUpdate = P.aTA.needsUpdate = P.aTB.needsUpdate = true
  }

  setTangle(on) {
    if (on) this.ensureTangle()
    this.blendTarget = on ? 1 : 0
    this.updateModuleLabels()
  }

  // ── state ────────────────────────────────────────────────────────────────
  select(sel) {
    this.sel = sel
    this.applyState()
  }

  setMode(m) {
    this.mode = m
    this.applyState()
  }

  flashCtx(keys) {
    for (const k of keys) {
      const p = this.platforms.get(k)
      if (p) p.flash = 1
    }
  }

  applyState() {
    const A = this.atlas, F = this.filters, s = this.sel
    if (!A) return
    const allow = this._allow = this.allowCtx()
    const visible = (m) => (!allow || allow.has(m.ctx)) && (!F.solo.size || F.solo.has(m.layer)) && !F.tiers.has(m.tier) && !F.layers.has(m.layer) && (F.tests || !m.test) && (F.generated || !m.generated)
    for (const m of A.modules) this.nodeVis.set(m.id, visible(m))
    let hlN = null, hlE = null
    if (s?.type === 'module') {
      hlN = new Set([s.id]); hlE = new Set()
      for (const i of this.adj.get(s.id) || []) { hlE.add(i); hlN.add(A.edges[i].source); hlN.add(A.edges[i].target) }
    } else if (s?.type === 'ctx') {
      hlN = new Set(A.modules.filter((m) => m.ctx === s.key).map((m) => m.id)); hlE = new Set()
      const inside = new Set(hlN)
      A.edges.forEach((e, i) => {
        if (inside.has(e.source) || inside.has(e.target)) { hlE.add(i); hlN.add(e.source); hlN.add(e.target) }
      })
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
    this.hlN = hlN
    this.hlCtx = hlN ? new Set([...hlN].map((id) => this.mods.get(id)?.ctx)) : null
    if (s?.type === 'ctx') this.hlCtx = new Set([s.key, ...this.hlCtx])
    // focus: a selection hides everything it isn't connected to (nodes, edges, islands, labels)
    this.focusCtx = null
    if (F.focusHide && hlN && (s || F.picked.size)) {
      for (const m of A.modules) if (!hlN.has(m.id)) this.nodeVis.set(m.id, false)
      this.focusCtx = this.hlCtx
    }
    for (const m of A.modules) {
      const [mesh, i] = this.nodeRef.get(m.id)
      const c = this.layerColor(m.layer)
      if (m.violations > 0) c.lerp(RED, 0.45)
      if (m.well) c.lerp(PURPLE, 0.5)
      let f = 1
      if (hlN) f = hlN.has(m.id) ? 1.1 : 0.09
      if (s?.type === 'module' && s.id === m.id) f = 1.45
      if (m.generated && !hlN) f *= 0.45
      if (this.doc) f *= 0.7 // neon node colours read as glare on paper
      c.multiplyScalar(f)
      this.baseCol.set(m.id, c.clone())
      mesh.setColorAt(i, c)
    }
    for (const mesh of this.meshes) mesh.instanceColor.needsUpdate = true
    const S = this.edgeGeo.attributes.aS.array, PS = this.partGeo.attributes.aS.array
    A.edges.forEach((e, i) => {
      const k = this.edgeKind[i]
      let a = [0.16, 0.28, 0.85, 0.07][k]
      if (e.seam) a = 0 // drawn as plug + socket + cable hardware instead
      if (!this.nodeVis.get(e.source) || !this.nodeVis.get(e.target)) a = 0
      else if (hlE) a = hlE.has(i) ? (k === 2 ? 0.95 : 0.6) : 0.012
      else if (this.mode === 'flow') a *= 2.0
      this.edgeBase[i] = a
      S.fill(a, i * SEG * 2, (i + 1) * SEG * 2)
      PS.fill(a, this.pStart[i], this.pStart[i] + this.pCount[i])
    })
    this.edgeGeo.attributes.aS.needsUpdate = true
    this.partGeo.attributes.aS.needsUpdate = true
    this.uni.uFlow.value = this.mode === 'flow' ? 1 : 0
    this.updateModuleLabels()
  }

  updateModuleLabels() {
    for (const o of this.modLabels) { o.element.remove(); o.removeFromParent() }
    this.modLabels = []
    if (!this.atlas || this.blendTarget > 0) return
    const s = this.sel
    let ids = []
    if (!s && this.nearCtx) ids = this.atlas.modules.filter((m) => m.ctx === this.nearCtx && !m.generated).map((m) => m.id).slice(0, 90)
    else if (s?.type === 'ctx') ids = this.atlas.modules.filter((m) => m.ctx === s.key && !m.generated).map((m) => m.id).slice(0, 90)
    else if (s?.type === 'module') {
      const m = this.mods.get(s.id)
      ids = [s.id, ...[...(this.hlN || [])].filter((x) => x !== s.id).slice(0, 40),
        ...this.atlas.modules.filter((x) => x.ctx === m.ctx && !x.generated).map((x) => x.id).slice(0, 50)]
    } else if (s?.type === 'edge') ids = [...this.hlN]
    for (const id of new Set(ids)) {
      const m = this.mods.get(id)
      if (!m || !this.nodeVis.get(id) || this.filters.labels !== 'all' || this.filters.labelTiers.has(m.tier)) continue
      const el = document.createElement('div')
      el.className = 'mlabel' + (s?.id === id ? ' sel' : '') + (m.violations ? ' bad' : '')
      el.textContent = m.name.replace(/\.(roc|rs|json)$/, '')
      const o = new CSS2DObject(el)
      o.position.copy(this.hex.get(id)).add(new THREE.Vector3(0, this.size.get(id) + 1.1, 0))
      this.root.add(o)
      this.modLabels.push(o)
    }
  }

  // ── per frame ─────────────────────────────────────────────────────────────
  update(t, dt) {
    if (!this.atlas) return
    this.uni.uTime.value = t
    if (this.bootT >= 0) this.bootT += dt
    this.blend += (this.blendTarget - this.blend) * Math.min(1, dt * 2.2)
    if (Math.abs(this.blend - this.blendTarget) < 0.001) this.blend = this.blendTarget
    const eb = this.blend * this.blend * (3 - 2 * this.blend)
    this.uni.uBlend.value = eb
    this.uni.uReveal.value = clamp01((this.bootT - 2.0) / 1.4)
    const fade = 1 - eb
    // semantic zoom: far = clean diagram (islands + highways), near = module names
    const tgt = this.world.controls.target
    const dist = this.world.camera.position.distanceTo(tgt)
    const far = clamp01((dist / Math.max(60, this.L.extent) - 0.9) / 1.1)
    this.far = far
    this.uni.uDetail.value = 1 - far * 0.9
    document.body.classList.toggle('far', far > 0.5)
    let near = null
    if (!this.sel && dist < 140 && eb < 0.5) {
      let best = 1e9
      for (const [k, p] of this.L.ctxPos) {
        const d = Math.hypot(p.x - tgt.x, p.z - tgt.z)
        if (d < best && d < p.radius * 1.3 && (!this._allow || this._allow.has(k))) { best = d; near = k }
      }
    }
    if (near !== this.nearCtx) { this.nearCtx = near; this.updateModuleLabels() }
    const rise = new Map()
    for (const [key, p] of this.platforms) {
      const e = this.bootT < 0 ? 0 : ease((this.bootT - p.delay) / 0.9)
      const y = (1 - e) * -40
      rise.set(key, y)
      p.g.position.y = y
      p.g.visible = e > 0.001 && eb < 0.999 && (!this._allow || this._allow.has(key)) && (!this.focusCtx || this.focusCtx.has(key))
      const dim = this.hlCtx && !this.hlCtx.has(key) ? 0.3 : 1
      p.flash *= Math.pow(0.08, dt)
      // opaque when fully shown: transparent objects re-sort every frame and flicker as the camera turns
      const see = fade < 0.999
      for (const [m, op] of p.fadeMats) {
        m.opacity = see ? op * fade : 1
        if (m.transparent !== see) { m.transparent = see; m.needsUpdate = true }
      }
      const rc = p.col.clone()
      if (p.viol) rc.lerp(RED, 0.3 + 0.25 * Math.sin(t * 2.2 + p.seed))
      else if (p.minor) rc.lerp(AMBER, 0.2 + 0.18 * Math.sin(t * 2 + p.seed))
      if (this.doc) rc.lerp(INK, 0.7)
      rc.lerp(WHITE, clamp01(p.flash)).multiplyScalar(dim * (1 + p.flash * 1.5))
      p.rim.material.color.copy(rc)
      p.rim.material.opacity = see ? 0.9 * fade : 1
      if (p.rim.material.transparent !== see) { p.rim.material.transparent = see; p.rim.material.needsUpdate = true }
      if (p.nest) {
        p.nest.rotation.y = t * 0.5
        p.nest.material.opacity = (0.45 + 0.4 * Math.sin(t * 4)) * fade
      }
      p.el.style.opacity = String(fade * (dim < 1 ? 0.35 : 1) * e)
      p.lab.visible = eb <= 0.6 && this.filters.labels !== 'tier' && !this.filters.labelTiers.has(p.tier)
      p.glowU.uOp.value = this.doc ? 0 : fade * e * dim
      if (p.beam) {
        p.beam.visible = !this.doc && e > 0.99
        p.beam.material.uniforms.uOp.value = fade * (0.35 + 0.65 * far)
      }
    }
    {
      const fu = this.world.floorU
      let gi = 0
      for (const p of this.platforms.values()) {
        if (gi >= 64) break
        fu.uGlow.value[gi].set(p.g.position.x, p.g.position.z, p.R, p.g.visible ? p.glowU.uOp.value : 0)
        fu.uGlowC.value[gi].copy(p.col)
        gi++
      }
      fu.uGlowN.value = gi
    }
    for (const o of this.tierObjs) {
      const e = this.bootT < 0 ? 0 : ease(this.bootT - 1.2)
      this.world.floorU.uLineOp.value = (this.doc ? 0.55 : 0.35) * fade * e
      this.world.floorU.uZoneOp.value = (this.doc ? 0.12 : 0.05 + 0.05 * far) * fade * e
      o.el.style.opacity = String(fade * e)
      o.lab.visible = true // section (tier) names always stay
    }
    for (const h of this.highways) {
      const ok = (!this._allow || (this._allow.has(h.a) && this._allow.has(h.b))) && (!this.focusCtx || (this.focusCtx.has(h.a) && this.focusCtx.has(h.b)))
      const hot = !this.hlCtx || this.hlCtx.has(h.a) || this.hlCtx.has(h.b)
      h.mesh.visible = ok
      h.mat.opacity = Math.min(0.85, fade * this.uni.uReveal.value * (0.08 + 0.62 * far) * (hot ? 1 : 0.15) * (h.viol ? 1.3 : 1))
      h.mat.color.copy(this.doc ? (h.viol ? RED : INK) : h.col)
    }
    for (const m of this.atlas.modules) {
      const [mesh, i] = this.nodeRef.get(m.id)
      const h = this.hex.get(m.id)
      _P.copy(h)
      if (eb > 0 && this.tang) {
        const tp = this.tang.get(m.id)
        _P.set(h.x + (tp[0] - h.x) * eb, h.y + (tp[1] - h.y) * eb, h.z + (tp[2] - h.z) * eb)
      }
      const ry = rise.get(m.ctx) || 0
      _P.y += ry * (1 - eb)
      const on = this.nodeVis.get(m.id) && ry > -39.5 ? 1 : 0
      const hov = (this.hoverId === m.id ? 1.45 : 1) * (1 + (this.pulses.get(m.id) || 0) * 0.5)
      _E.set(t * 0.3 + i, t * 0.45 + i * 0.7, 0)
      _Q.setFromEuler(_E)
      _S.setScalar(this.size.get(m.id) * on * hov)
      _M.compose(_P, _Q, _S)
      mesh.setMatrixAt(i, _M)
    }
    for (const mesh of this.meshes) mesh.instanceMatrix.needsUpdate = true
    if (this.pulses.size) {
      const touched = new Set()
      for (const [id, p] of this.pulses) {
        const [mesh, i] = this.nodeRef.get(id)
        const np = p * Math.pow(0.25, dt)
        const base = this.baseCol.get(id) || WHITE
        if (np < 0.02) { this.pulses.delete(id); mesh.setColorAt(i, base) }
        else { this.pulses.set(id, np); mesh.setColorAt(i, base.clone().lerp(WHITE, Math.min(0.55, np * 0.55)).multiplyScalar(1 + np * 0.5)) }
        touched.add(mesh)
      }
      for (const mesh of touched) mesh.instanceColor.needsUpdate = true
    }
    if (this.edgePulses.size) {
      const S = this.edgeGeo.attributes.aS.array, PS = this.partGeo.attributes.aS.array
      for (const [i, p] of this.edgePulses) {
        const np = p * Math.pow(0.3, dt)
        const a = np < 0.02 ? this.edgeBase[i] : Math.max(this.edgeBase[i], 1.6 * np)
        S.fill(a, i * SEG * 2, (i + 1) * SEG * 2)
        PS.fill(a, this.pStart[i], this.pStart[i] + this.pCount[i])
        if (np < 0.02) this.edgePulses.delete(i)
        else this.edgePulses.set(i, np)
      }
      this.edgeGeo.attributes.aS.needsUpdate = true
      this.partGeo.attributes.aS.needsUpdate = true
    }
    for (const o of this.seamObjs) {
      const vis = this.platforms.get(o.ec)?.g.visible && this.platforms.get(o.hc)?.g.visible
      const op = this.uni.uReveal.value * fade
      for (const [m, base] of o.mats) {
        // fully shown solid parts are opaque: transparent ones re-sort (and flicker) as the camera turns
        const see = base < 1 || op < 0.999
        m.opacity = see ? base * op : 1
        if (m.transparent !== see) { m.transparent = see; m.needsUpdate = true }
      }
      for (const w of o.world) w.visible = !!vis && op > 0.01
      o.label.visible = !!vis && op > 0.3 && eb < 0.5 && this.filters.labels !== 'tier'
      for (const c of o.caps) c.scale.setScalar(1 + 0.35 * Math.sin(t * 4))
    }
    for (const w of this.wells) {
      const p = this.posOf(w.id)
      const vis = this.nodeVis.get(w.id) && this.uni.uReveal.value > 0
      for (const [ring, sp] of [[w.a, 1], [w.b, -0.6]]) {
        ring.visible = !!vis
        ring.position.set(...p)
        ring.rotation.set(Math.PI / 2 + Math.sin(t * sp) * 0.5, t * sp, 0)
        ring.scale.setScalar(1 + 0.15 * Math.sin(t * 3 * sp))
      }
    }
    for (const o of this.modLabels) o.element.style.opacity = String(fade)
  }

  // ── queries ──────────────────────────────────────────────────────────────
  posOf(id) {
    const h = this.hex.get(id)
    if (!h) return [0, 0, 0]
    const eb = this.uni.uBlend.value
    if (eb > 0 && this.tang) {
      const tp = this.tang.get(id)
      return [h.x + (tp[0] - h.x) * eb, h.y + (tp[1] - h.y) * eb, h.z + (tp[2] - h.z) * eb]
    }
    return [h.x, h.y, h.z]
  }

  ctxCenter(key) {
    const p = this.L.ctxPos.get(key)
    return { pos: [p.x, 1 + (this.elev?.get(key) || 0), p.z], radius: p.radius }
  }

  edgeIndex(a, b) {
    return this.edgeIdx.get(a + '→' + b)
  }

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
    this.ray.setFromCamera(new THREE.Vector2(x, y), this.world.camera)
    const shown = (o) => { for (let x = o; x; x = x.parent) if (!x.visible) return false; return true }
    const hits = this.ray.intersectObjects(this.meshes, false)
    const mh = hits.find((h) => this.nodeVis.get(h.object.userData.ids[h.instanceId]))
    const sh = this.seamPick.length ? this.ray.intersectObjects(this.seamPick, false).find((h) => shown(h.object)) : null
    if (sh && (!mh || sh.distance < mh.distance)) {
      const u = sh.object.userData
      return { type: 'seam', seam: u.seam, kind: u.kind, st: u.st }
    }
    if (mh) return { type: 'module', id: mh.object.userData.ids[mh.instanceId] }
    if (this.blend < 0.5) {
      const ph = this.ray.intersectObjects(this.tops, false).filter((h) => this.platforms.get(h.object.userData.ctx)?.g.visible)
      if (ph.length) return { type: 'ctx', key: ph[0].object.userData.ctx }
    }
    return null
  }

  dispose() {
    this.root.traverse((o) => {
      if (o.isCSS2DObject) o.element.remove()
      if (o.geometry) o.geometry.dispose()
      if (o.material) [].concat(o.material).forEach((m) => m.dispose())
    })
    this.world.scene.remove(this.root)
    this.root = new THREE.Group()
    this.world.scene.add(this.root)
    this.modLabels = []
  }
}
