// City planner — pure data, no three.js. Turns an atlas into districts, lots, streets, highways,
// dirt tracks and one car route per dependency.
//
// Geometry is polar on purpose: every district is a ring city (plaza → ring streets → outer street)
// with radial spokes, and the metro is rings of districts joined by ring roads between tiers and
// connectors through the gaps. Routing on that shape is analytic (arc → spoke → arc), so routing
// 50k dependencies costs milliseconds instead of 50k graph searches.

export const LOT = 4.6 // lot spacing along a row (building footprint ≤ 2.4)
export const ROW = 4.4 // radial step between back-to-back rows
const STREET_OFF = 2.7 // street centre → row centre
const GAP_DISTRICT = 20 // forest between districts on a ring
const GAP_TIER = 34 // forest belt between tiers (a ring road runs through it)
const TAU = Math.PI * 2
// town halls stand on the plaza; domain cores ring it
const PLAZA = new Set(['root', 'composition', 'core', 'kernel', 'entity', 'project'])
const CORE = new Set([])
const SIDE = { east: 0, south: Math.PI / 2, west: Math.PI, north: -Math.PI / 2 }

// road classes: width (world units) and car speed (units / s)
export const ROAD = {
  street: { w: 2.2, v: 4.2 },
  spoke: { w: 2.4, v: 5.0 },
  outer: { w: 2.6, v: 5.5 },
  arterial: { w: 3.0, v: 7.0 },
  ring: { w: 4.2, v: 11.0 },
  connector: { w: 3.6, v: 9.5 },
  drive: { w: 1.4, v: 2.4 },
  dirt: { w: 2.0, v: 1.25 },
  path: { w: 1.2, v: 1.0 },
}

const hashStr = (s) => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0) / 4294967296
}
const wrap = (a) => { a %= TAU; return a < 0 ? a + TAU : a }
// signed shortest angular difference b - a in (-π, π]
const adiff = (a, b) => { let d = wrap(b - a); if (d > Math.PI) d -= TAU; return d }

function arcPts(cx, cz, r, a0, a1, out, step = 0.12) {
  const d = adiff(a0, a1)
  const n = Math.max(1, Math.ceil(Math.abs(d) / Math.min(step, 4.5 / Math.max(r, 1))))
  for (let i = 0; i <= n; i++) {
    const a = a0 + (d * i) / n
    out.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r])
  }
  return out
}

// ── district: plaza, ring streets, rows of lots, spokes ──────────────────────
function layoutDistrict(ctx, mods, layers, extra = []) {
  const items = [...mods, ...extra]
  const byRing = new Map()
  for (const m of items) {
    const ring = m.demolished ? 99 : PLAZA.has(m.layer) ? 0 : Math.max(1, layers[m.layer]?.ring ?? 3) - (CORE.has(m.layer) ? 1 : 0)
    if (!byRing.has(ring)) byRing.set(ring, [])
    byRing.get(ring).push(m)
  }
  const rings = [...byRing.keys()].sort((a, b) => a - b)
  const key = (m) => `${m.layer}|${m.slice || ''}|${m.name}`
  const lots = new Map()
  const parks = [] // unused slots → trees, flowerbeds
  // ring 0 (domain core, composition root…) sits on the central plaza
  let core = rings.length && rings[0] <= 0 ? byRing.get(rings[0]) : []
  const rest = core.length ? rings.slice(1) : rings
  core = [...core].sort((a, b) => (a.layer === 'root' ? -1 : 0) - (b.layer === 'root' ? -1 : 0) || key(a).localeCompare(key(b)))
  const c = LOT * 0.6
  core.forEach((m, i) => {
    const r = i === 0 && core.length > 1 ? 0 : c * Math.sqrt(i + 0.35)
    const a = i * 2.39996
    lots.set(m.id, { lx: Math.cos(a) * r, lz: Math.sin(a) * r, face: a + Math.PI, street: 0, ang: a, plaza: true })
  })
  const plazaR = core.length ? c * Math.sqrt(core.length) + LOT * 0.75 : 5
  const streets = [plazaR + 1.4]
  // estimate the final size to choose the spoke count before placing rows
  const est = Math.sqrt(plazaR * plazaR + (items.length - core.length) * LOT * ROW * 1.5 / Math.PI)
  const K = Math.max(3, Math.min(10, Math.round((TAU * est) / 46)))
  const spokes = Array.from({ length: K }, (_, k) => (k * TAU) / K)
  const rowsInfo = []
  let streetR = streets[0]
  let side = 0 // 0 = row faces inward (just outside a street), 1 = faces outward (back-to-back)
  let rr = streetR + STREET_OFF
  const freeSlots = (r) => {
    const n = Math.max(6, Math.floor((TAU * r) / LOT))
    const clear = (ROAD.spoke.w / 2 + 1.5) / r
    const slots = []
    for (let i = 0; i < n; i++) {
      const a = (i + 0.5) * (TAU / n)
      if (spokes.some((s) => Math.abs(adiff(a, s)) < clear + TAU / n / 2.2)) continue
      slots.push(a)
    }
    return slots
  }
  let row = null
  const openRow = () => { row = { r: rr, side, free: freeSlots(rr), all: null, used: 0 }; row.all = [...row.free]; rowsInfo.push(row) }
  const advance = () => {
    if (side === 0) { side = 1; rr += ROW }
    else { streetR = rr + STREET_OFF; streets.push(streetR); side = 0; rr = streetR + STREET_OFF }
    openRow()
  }
  openRow()
  let lastRing = null
  for (const ring of rest) {
    const list = byRing.get(ring).sort((a, b) => key(a).localeCompare(key(b)))
    // a new layer ring starts a fresh row when the current one is already half used
    if (lastRing != null && row.used > row.all.length * 0.5) advance()
    lastRing = ring
    const sided = new Map()
    const plain = []
    for (const m of list) {
      const s = layers[m.layer]?.side
      if (s && SIDE[s] != null) { if (!sided.has(s)) sided.set(s, []); sided.get(s).push(m) } else plain.push(m)
    }
    const groups = [...[...sided.entries()].map(([s, l]) => ({ s, l })), { s: null, l: plain }]
    for (const g of groups) {
      for (const m of g.l) {
        if (!row.free.length) advance()
        let k = 0
        if (g.s) {
          let bd = 1e9
          row.free.forEach((a, j) => { const d = Math.abs(adiff(SIDE[g.s], a)); if (d < bd) { bd = d; k = j } })
        }
        const a = row.free.splice(k, 1)[0]
        row.used++
        lots.set(m.id, { lx: Math.cos(a) * row.r, lz: Math.sin(a) * row.r, face: row.side === 0 ? a + Math.PI : a, row: rowsInfo.indexOf(row), ang: a, r: row.r, side: row.side })
      }
    }
  }
  if (!row.used) { rowsInfo.pop(); if (side === 1) rr -= ROW }
  // the street outside the last row is the district's outer street (if we are mid-pair, close it)
  const lastRow = rowsInfo.length ? rowsInfo[rowsInfo.length - 1] : null
  // an inward-facing last row still needs a street behind it to close the district
  let outerR = lastRow ? Math.max(streets[streets.length - 1], lastRow.r + STREET_OFF) : streets[streets.length - 1]
  if (outerR > streets[streets.length - 1] + 0.01) streets.push(outerR)
  // which street each row's lots attach to
  for (const row of rowsInfo) {
    let best = 0, bd = 1e9
    streets.forEach((s, k) => {
      const want = row.side === 0 ? s < row.r : s > row.r
      const d = Math.abs(s - row.r)
      if (want && d < bd) { bd = d; best = k }
    })
    row.street = best
    for (const a of row.free) parks.push({ lx: Math.cos(a) * row.r, lz: Math.sin(a) * row.r, ang: a })
  }
  for (const L of lots.values()) if (L.row != null) L.street = rowsInfo[L.row].street
  return { lots, parks, plazaR, streets, spokes, R: outerR + 2.2, outerR }
}

// ── metro: tiers → centre cluster + rings ───────────────────────────────────
function placeDistricts(atlas, D) {
  const tierOrder = atlas.tiers.map((t) => t.id)
  if (atlas.contexts.some((c) => c.tier === 'unmapped')) tierOrder.push('unmapped')
  const tiers = []
  let prevOuter = 0
  tierOrder.forEach((tid) => {
    const list = atlas.contexts.filter((c) => c.tier === tid).map((c) => D.get(c.key)).filter(Boolean)
    if (!list.length) return
    list.sort((a, b) => b.R - a.R)
    if (!tiers.length) {
      const placed = []
      for (const p of list) {
        if (!placed.length) { p.x = 0; p.z = 0; placed.push(p); continue }
        let t = 0
        for (let k = 0; k < 60000; k++) {
          t += 0.05
          const rr = 3 * t, a = t * 2.39996
          const x = Math.cos(a) * rr, z = Math.sin(a) * rr
          if (placed.every((q) => Math.hypot(q.x - x, q.z - z) > q.R + p.R + GAP_DISTRICT)) { p.x = x; p.z = z; break }
        }
        placed.push(p)
      }
      const outer = Math.max(...placed.map((p) => Math.hypot(p.x, p.z) + p.R))
      tiers.push({ id: tid, R: 0, inner: 0, outer, list })
      prevOuter = outer
      return
    }
    const maxR = Math.max(...list.map((p) => p.R))
    const need = list.reduce((s, p) => s + 2 * p.R + GAP_DISTRICT, 0)
    const R = Math.max(prevOuter + GAP_TIER + maxR, need / TAU)
    const scale = (TAU * R) / need
    let a = -Math.PI / 2 + tiers.length * 0.9
    const order = []
    for (let i = 0, j = list.length - 1; i <= j; i++, j--) { order.push(list[i]); if (i !== j) order.push(list[j]) }
    for (const p of order) {
      const span = ((2 * p.R + GAP_DISTRICT) * scale) / R
      a += span / 2
      p.x = Math.cos(a) * R; p.z = Math.sin(a) * R; p.polar = wrap(a)
      a += span / 2
    }
    tiers.push({ id: tid, R, inner: R - maxR, outer: R + maxR, list: order })
    prevOuter = R + maxR
  })
  return tiers
}

export function planCity(atlas) {
  const t0 = performance.now()
  const layers = atlas.layers || {}
  const byCtx = new Map()
  for (const m of atlas.modules) { if (!byCtx.has(m.ctx)) byCtx.set(m.ctx, []); byCtx.get(m.ctx).push(m) }
  const demo = new Map()
  for (const d of atlas.wip?.demolished || []) {
    if (!d.ctx) continue
    if (!demo.has(d.ctx)) demo.set(d.ctx, [])
    demo.get(d.ctx).push({ id: 'demolished:' + d.path, name: d.path.split('/').pop(), layer: 'loose', demolished: true, path: d.path })
  }
  const D = new Map()
  for (const c of atlas.contexts) {
    const loc = layoutDistrict(c, byCtx.get(c.key) || [], layers, demo.get(c.key) || [])
    D.set(c.key, { key: c.key, tier: c.tier, ...loc, x: 0, z: 0, rot: 0, seed: hashStr(c.key) })
  }
  const tiers = placeDistricts(atlas, D)
  const tierIdx = new Map(tiers.map((t, i) => [t.id, i]))
  const OB = rasterize([...D.values()])
  // ring roads in the forest belts between tiers (+ one county road outside the last tier)
  const rings = []
  for (let i = 0; i < tiers.length; i++) {
    const out = tiers[i].outer
    const nextIn = i + 1 < tiers.length ? tiers[i + 1].inner : out + GAP_TIER
    rings.push({ i, r: (out + nextIn) / 2 })
  }
  // orient every district so spoke 0 faces its inner ring (centre tier: faces out to the beltway)
  for (const d of D.values()) {
    const ti = tierIdx.get(d.tier) ?? 0
    const toward = Math.atan2(-d.z, -d.x) // toward the city centre
    d.ti = ti
    d.rot = ti === 0 ? (Math.hypot(d.x, d.z) < 1 ? 0 : wrap(toward + Math.PI)) : wrap(toward)
  }
  const W = (d, lx, lz) => {
    const c = Math.cos(d.rot), s = Math.sin(d.rot)
    return [d.x + lx * c - lz * s, d.z + lx * s + lz * c]
  }
  // world-space lots
  const lots = new Map()
  for (const d of D.values()) {
    for (const [id, L] of d.lots) {
      const [x, z] = W(d, L.lx, L.lz)
      lots.set(id, { id, ctx: d.key, x, z, ry: Math.PI / 2 - (L.face + d.rot), street: L.street, ang: L.ang, plaza: !!L.plaza, r: L.r ?? Math.hypot(L.lx, L.lz) })
    }
    d.parksW = d.parks.map((p) => { const [x, z] = W(d, p.lx, p.lz); return { x, z } })
  }
  // gates: spoke 0 = inner gate (ring below), spoke nearest π = outer gate (ring above)
  for (const d of D.values()) {
    const outerSpoke = d.spokes.reduce((b, s) => (Math.abs(adiff(Math.PI, s)) < Math.abs(adiff(Math.PI, b)) ? s : b), d.spokes[0])
    const g = (ang) => { const [x, z] = W(d, Math.cos(ang) * d.outerR, Math.sin(ang) * d.outerR); return { x, z, ang } }
    d.gates = d.ti === 0 ? { out: { ...g(0), ring: 0 } } : { in: { ...g(0), ring: d.ti - 1 }, out: { ...g(outerSpoke), ring: d.ti } }
  }
  // connectors between consecutive rings, through the gaps between the districts of the tier between them
  const connectors = new Map() // ring i → angles connecting ring i to ring i+1
  for (let i = 0; i + 1 < rings.length; i++) {
    const tier = tiers[i + 1]
    const angs = tier.list.map((p) => p.polar).sort((a, b) => a - b)
    const gaps = angs.map((a, k) => { const b = angs[(k + 1) % angs.length]; return wrap(a + wrap(b - a) / 2) })
    const step = gaps.length > 10 ? Math.ceil(gaps.length / 8) : 1
    connectors.set(i, gaps.filter((_, k) => k % step === 0))
  }
  // arterials: gate → ring road. Ring tiers go straight (radial, through forest). The centre
  // cluster is packed, so its arterials search a coarse grid around the other districts.
  const arterials = []
  const grid = { ob: OB, districts: [...D.values()] }
  for (const d of D.values()) {
    for (const [kind, g] of Object.entries(d.gates)) {
      const ring = rings[g.ring]
      if (!ring) continue
      const ang = Math.atan2(g.z, g.x)
      const end = [Math.cos(ang) * ring.r, Math.sin(ang) * ring.r]
      let pts
      if (d.ti === 0 && Math.hypot(d.x, d.z) > 1) pts = gridPath(grid, [g.x, g.z], end, d.key)
      if (d.ti === 0 && Math.hypot(d.x, d.z) <= 1) pts = gridPath(grid, [g.x, g.z], end, d.key)
      if (!pts) pts = [[g.x, g.z], end]
      const last = pts[pts.length - 1]
      g.ringAng = wrap(Math.atan2(last[1], last[0]))
      g.art = pts
      arterials.push({ ctx: d.key, kind, ring: g.ring, pts })
    }
  }

  // ── routing ──
  const ctxOf = (id) => lots.get(id)?.ctx
  // local leg: lot → street → (arc) → spoke → (radial) → street → (arc) → target point
  const localPath = (d, from, to) => {
    // from/to: { r (street radius), ang (local), pt: [x,z] world start/end, offStreet: bool }
    const out = []
    const P = (lx, lz) => W(d, lx, lz)
    out.push(from.pt)
    const a0 = from.ang, a1 = to.ang
    const r0 = from.r, r1 = to.r
    const loc = []
    if (Math.abs(r0 - r1) < 0.01) arcPts(0, 0, r0, a0, a1, loc)
    else {
      let best = d.spokes[0], bc = 1e9
      for (const s of d.spokes) {
        const cost = Math.abs(adiff(a0, s)) * r0 + Math.abs(adiff(s, a1)) * r1
        if (cost < bc) { bc = cost; best = s }
      }
      arcPts(0, 0, r0, a0, best, loc)
      loc.push([Math.cos(best) * r1, Math.sin(best) * r1])
      arcPts(0, 0, r1, best, a1, loc)
    }
    for (const [lx, lz] of loc) out.push(P(lx, lz))
    out.push(to.pt)
    return out
  }
  const lotStop = (id) => {
    const L = lots.get(id), d = D.get(L.ctx), dl = d.lots.get(id)
    const sr = d.streets[L.street] ?? d.streets[0]
    return { r: sr, ang: dl.ang, pt: [L.x, L.z] }
  }
  const gateStop = (d, g) => ({ r: d.outerR, ang: g.ang, pt: [g.x, g.z] })
  const angStop = (d, ang) => { const [x, z] = W(d, Math.cos(ang) * d.outerR, Math.sin(ang) * d.outerR); return { r: d.outerR, ang, pt: [x, z] } }
  // global leg between two gates along ring roads and connectors
  const globalCache = new Map()
  const globalPath = (ga, gb) => {
    const k = `${ga.x.toFixed(2)},${ga.z.toFixed(2)}>${gb.x.toFixed(2)},${gb.z.toFixed(2)}`
    if (globalCache.has(k)) return globalCache.get(k)
    const out = [...ga.art]
    let ring = ga.ring, ang = ga.ringAng
    const target = gb.ring
    while (ring !== target) {
      const up = target > ring
      const ci = up ? ring : ring - 1
      const cands = connectors.get(ci) || [ang]
      let best = cands[0], bc = 1e9
      for (const c of cands) {
        const cost = Math.abs(adiff(ang, c)) + Math.abs(adiff(c, gb.ringAng)) * 0.6
        if (cost < bc) { bc = cost; best = c }
      }
      arcPts(0, 0, rings[ring].r, ang, best, out, 0.05)
      ring = up ? ring + 1 : ring - 1
      ang = best
      out.push([Math.cos(ang) * rings[ring].r, Math.sin(ang) * rings[ring].r])
    }
    arcPts(0, 0, rings[ring].r, ang, gb.ringAng, out, 0.05)
    for (let i = gb.art.length - 1; i >= 0; i--) out.push(gb.art[i])
    globalCache.set(k, out)
    return out
  }
  const pickGates = (da, db) => {
    if (da.ti < db.ti) return [da.gates.out, db.gates.in || db.gates.out]
    if (da.ti > db.ti) return [da.gates.in || da.gates.out, db.gates.out]
    return da.ti === 0 ? [da.gates.out, db.gates.out] : [da.gates.in, db.gates.in]
  }
  // dirt tracks: one per violating district pair, searched around third districts
  const tracks = new Map()
  const trackFor = (da, db) => {
    const k = da.key < db.key ? da.key + '|' + db.key : db.key + '|' + da.key
    if (tracks.has(k)) return tracks.get(k)
    const aim = (d, o) => wrap(Math.atan2(o.z - d.z, o.x - d.x) - d.rot)
    const aa = aim(da, db), ab = aim(db, da)
    const sa = angStop(da, aa), sb = angStop(db, ab)
    // start just outside each district so the track leaves the town edge
    const pa = [da.x + Math.cos(aa + da.rot) * (da.R + 1), da.z + Math.sin(aa + da.rot) * (da.R + 1)]
    const pb = [db.x + Math.cos(ab + db.rot) * (db.R + 1), db.z + Math.sin(ab + db.rot) * (db.R + 1)]
    let mid = trackSearch(OB, pa, pb, da.idx, db.idx)
    mid = wobble(mid, hashStr(k))
    const pts = [sa.pt, ...mid, sb.pt]
    const t = { key: k, a: da.key, b: db.key, aAng: aa, bAng: ab, pts, n: 0, wip: 0, rules: new Map(), sev: 'minor' }
    tracks.set(k, t)
    return t
  }

  const routes = []
  const SEVR = { minor: 0, major: 1, critical: 2 }
  atlas.edges.forEach((e, i) => {
    if (e.seam) { routes.push(null); return }
    const la = lots.get(e.source), lb = lots.get(e.target)
    if (!la || !lb) { routes.push(null); return }
    const da = D.get(la.ctx), db = D.get(lb.ctx)
    const viol = e.status === 'violation'
    const pieces = []
    if (da === db) {
      if (viol) {
        // a shortcut trampled straight across the lawns
        pieces.push({ pts: [[la.x, la.z], [lb.x, lb.z]], cls: 'path' })
      } else pieces.push({ pts: localPath(da, lotStop(e.source), lotStop(e.target)), cls: 'street' })
    } else if (viol) {
      const t = trackFor(da, db)
      t.n++
      if (e.wip) t.wip++
      if (e.rule) t.rules.set(e.rule, (t.rules.get(e.rule) || 0) + 1)
      if (SEVR[e.severity] > SEVR[t.sev]) t.sev = e.severity
      const fwd = t.a === da.key
      const pts = fwd ? t.pts : [...t.pts].reverse()
      pieces.push({ pts: localPath(da, lotStop(e.source), angStop(da, fwd ? t.aAng : t.bAng)), cls: 'street' })
      pieces.push({ pts, cls: 'dirt', shared: 'track:' + t.key + (fwd ? '>' : '<') })
      pieces.push({ pts: localPath(db, angStop(db, fwd ? t.bAng : t.aAng), lotStop(e.target)), cls: 'street' })
    } else {
      const [ga, gb] = pickGates(da, db)
      pieces.push({ pts: localPath(da, lotStop(e.source), gateStop(da, ga)), cls: 'street', shared: `L:${e.source}>${ga.x},${ga.z}` })
      pieces.push({ pts: globalPath(ga, gb), cls: 'ring', shared: `G:${ga.x},${ga.z}>${gb.x},${gb.z}` })
      pieces.push({ pts: localPath(db, gateStop(db, gb), lotStop(e.target)), cls: 'street', shared: `L:${gb.x},${gb.z}>${e.target}` })
    }
    routes.push({ i, pieces, viol, cross: da !== db })
  })

  // roads to draw
  const roads = []
  for (const d of D.values()) {
    d.streets.forEach((r, k) => {
      const pts = []
      const n = Math.max(24, Math.ceil((TAU * r) / 3))
      for (let j = 0; j <= n; j++) { const a = (j / n) * TAU; pts.push(W(d, Math.cos(a) * r, Math.sin(a) * r)) }
      roads.push({ cls: k === d.streets.length - 1 ? 'outer' : 'street', pts, ctx: d.key, closed: true })
    })
    for (const s of d.spokes) {
      roads.push({ cls: 'spoke', pts: [W(d, Math.cos(s) * d.streets[0], Math.sin(s) * d.streets[0]), W(d, Math.cos(s) * d.outerR, Math.sin(s) * d.outerR)], ctx: d.key })
    }
  }
  for (const r of rings) {
    const pts = []
    const n = Math.max(64, Math.ceil((TAU * r.r) / 5))
    for (let j = 0; j <= n; j++) { const a = (j / n) * TAU; pts.push([Math.cos(a) * r.r, Math.sin(a) * r.r]) }
    roads.push({ cls: 'ring', pts, closed: true, ring: r.i })
  }
  for (const [i, angs] of connectors) {
    for (const a of angs) roads.push({ cls: 'connector', pts: [[Math.cos(a) * rings[i].r, Math.sin(a) * rings[i].r], [Math.cos(a) * rings[i + 1].r, Math.sin(a) * rings[i + 1].r]] })
  }
  for (const a of arterials) roads.push({ cls: 'arterial', pts: a.pts, ctx: a.ctx })

  const river = planRiver(atlas, D, tiers, tierIdx, rings, roads, lots)
  const extent = (rings.length ? rings[rings.length - 1].r : 100) + 12
  return {
    districts: D, lots, tiers, rings, connectors, arterials, roads, tracks: [...tracks.values()], routes, extent, river,
    ms: performance.now() - t0,
  }
}

// ── coarse grid search (centre-cluster arterials, dirt tracks) ──────────────
// every district is burnt into one obstacle raster, so a search step is a single array lookup
const OB_CELL = 3
function rasterize(districts) {
  let E = 0
  districts.forEach((d, i) => { d.idx = i; E = Math.max(E, Math.hypot(d.x, d.z) + d.R) })
  E += 60
  const n = Math.ceil((2 * E) / OB_CELL)
  const ids = new Int32Array(n * n).fill(-1)
  for (const d of districts) {
    const r = d.R + 0.5
    const x0 = Math.max(0, Math.floor((d.x - r + E) / OB_CELL)), x1 = Math.min(n - 1, Math.ceil((d.x + r + E) / OB_CELL))
    const z0 = Math.max(0, Math.floor((d.z - r + E) / OB_CELL)), z1 = Math.min(n - 1, Math.ceil((d.z + r + E) / OB_CELL))
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      const wx = x * OB_CELL - E, wz = z * OB_CELL - E
      if ((wx - d.x) ** 2 + (wz - d.z) ** 2 < r * r) ids[z * n + x] = d.idx
    }
  }
  return { E, n, ids, cell: OB_CELL }
}

// A* on an n×n grid; `blocked` is a Uint8Array mask. Typed-array heap, no per-node allocation.
function astar(n, blocked, sx, sz, ex, ez) {
  const N = n * n
  const s = sz * n + sx, e = ez * n + ex
  if (blocked[s] || blocked[e]) return null
  const g = new Float32Array(N).fill(Infinity)
  const from = new Int32Array(N).fill(-1)
  const closed = new Uint8Array(N)
  let hk = new Float32Array(1024), hi = new Int32Array(1024), hn = 0
  const push = (f, i) => {
    if (hn === hk.length) { const k2 = new Float32Array(hn * 2), i2 = new Int32Array(hn * 2); k2.set(hk); i2.set(hi); hk = k2; hi = i2 }
    let k = hn++
    while (k > 0) { const p = (k - 1) >> 1; if (hk[p] <= f) break; hk[k] = hk[p]; hi[k] = hi[p]; k = p }
    hk[k] = f; hi[k] = i
  }
  const pop = () => {
    const top = hi[0]
    const lf = hk[--hn], li = hi[hn]
    let k = 0
    for (;;) {
      const l = 2 * k + 1
      if (l >= hn) break
      const r = l + 1
      const m = r < hn && hk[r] < hk[l] ? r : l
      if (hk[m] >= lf) break
      hk[k] = hk[m]; hi[k] = hi[m]; k = m
    }
    hk[k] = lf; hi[k] = li
    return top
  }
  g[s] = 0
  push(0, s)
  while (hn) {
    const cur = pop()
    if (cur === e) break
    if (closed[cur]) continue
    closed[cur] = 1
    const cx = cur % n, cz = (cur / n) | 0, gc = g[cur]
    for (let dz = -1; dz <= 1; dz++) {
      const z = cz + dz
      if (z < 0 || z >= n) continue
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue
        const x = cx + dx
        if (x < 0 || x >= n) continue
        const j = z * n + x
        if (blocked[j] || closed[j]) continue
        const ng = gc + (dx && dz ? 1.414 : 1)
        if (ng < g[j]) { g[j] = ng; from[j] = cur; push(ng + Math.hypot(ex - x, ez - z), j) }
      }
    }
  }
  if (from[e] < 0 && s !== e) return null
  const path = []
  for (let k = e; k >= 0; k = from[k]) { path.push(k); if (k === s) break }
  return path.reverse()
}

function smooth(pts, it = 2) {
  for (let k = 0; k < it; k++) {
    const out = [pts[0]]
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1]
      out.push([ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25], [ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75])
    }
    out.push(pts[pts.length - 1])
    pts = out
  }
  return pts
}

function simplify(pts, eps) {
  if (pts.length < 3) return pts
  const [ax, az] = pts[0], [bx, bz] = pts[pts.length - 1]
  const L = Math.hypot(bx - ax, bz - az) || 1
  let best = 0, bi = 0
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((bx - ax) * (az - pts[i][1]) - (ax - pts[i][0]) * (bz - az)) / L
    if (d > best) { best = d; bi = i }
  }
  if (best < eps) return [pts[0], pts[pts.length - 1]]
  return [...simplify(pts.slice(0, bi + 1), eps).slice(0, -1), ...simplify(pts.slice(bi), eps)]
}

// search a window of the obstacle raster; `allow` district ids may be crossed (start / end districts)
function rasterPath(OB, a, b, allow, pad = 40) {
  const { E, n: N, ids, cell } = OB
  // long searches sample the raster coarsely (~140 cells across), short ones at full resolution
  const span = Math.hypot(b[0] - a[0], b[1] - a[1]) + 2 * pad
  const st = Math.max(1, Math.round(span / 140 / cell))
  const toC = (v) => Math.max(0, Math.min(N - 1, Math.round((v + E) / cell)))
  const ax = toC(a[0]), az = toC(a[1]), bx = toC(b[0]), bz = toC(b[1])
  const p = Math.ceil(pad / cell)
  const x0 = Math.max(0, Math.min(ax, bx) - p), z0 = Math.max(0, Math.min(az, bz) - p)
  const x1 = Math.min(N - 1, Math.max(ax, bx) + p), z1 = Math.min(N - 1, Math.max(az, bz) + p)
  const n = Math.ceil((Math.max(x1 - x0, z1 - z0) + 1) / st)
  const blocked = new Uint8Array(n * n)
  for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
    const gx = x0 + x * st, gz = z0 + z * st
    if (gx > x1 || gz > z1) { blocked[z * n + x] = 1; continue }
    const id = ids[gz * N + gx]
    if (id >= 0 && id !== allow[0] && id !== allow[1]) blocked[z * n + x] = 1
  }
  const path = astar(n, blocked, Math.round((ax - x0) / st), Math.round((az - z0) / st), Math.round((bx - x0) / st), Math.round((bz - z0) / st))
  if (!path) return null
  return path.map((k) => [(x0 + (k % n) * st) * cell - E, (z0 + ((k / n) | 0) * st) * cell - E])
}

function gridPath(G, a, b, own) {
  const d = G.districts.find((x) => x.key === own)
  const dir = Math.atan2(a[1] - (d?.z ?? 0), a[0] - (d?.x ?? 0))
  // start just outside the own district's edge
  const s = [a[0] + Math.cos(dir) * 4, a[1] + Math.sin(dir) * 4]
  let pts = rasterPath(G.ob, s, b, [], 60)
  if (!pts) return null
  pts = simplify(pts, 1.2)
  return smooth([a, ...pts.slice(1, -1), b], 2)
}

function trackSearch(OB, a, b, ia, ib) {
  let pts = rasterPath(OB, a, b, [ia, ib], 60)
  if (!pts) return [a, b]
  pts = simplify(pts, OB.cell * 0.6)
  return smooth([a, ...pts.slice(1, -1), b], 2)
}

// dirt tracks meander a little: nobody surveyed them
function wobble(pts, seed) {
  if (pts.length < 2) return pts
  const out = []
  let acc = 0
  for (let i = 0; i < pts.length; i++) {
    const [x, z] = pts[i]
    if (i === 0 || i === pts.length - 1) { out.push([x, z]); continue }
    const [px, pz] = pts[i - 1], [nx, nz] = pts[i + 1]
    acc += Math.hypot(x - px, z - pz)
    const tx = nx - px, tz = nz - pz, L = Math.hypot(tx, tz) || 1
    const w = Math.sin(acc * 0.09 + seed * 40) * 1.6 + Math.sin(acc * 0.23 + seed * 13) * 0.7
    out.push([x - (tz / L) * w, z + (tx / L) * w])
  }
  return out
}

// ── the river: contract seams cross it on named bridges ─────────────────────
// It runs through the forest belt between the tier that emits protocol kinds and the tier that
// handles them. Every road that crosses it gets a road bridge; each seam gets its own bridge.
function planRiver(atlas, D, tiers, tierIdx, rings, roads, lots) {
  const seams = atlas.seams || []
  if (!seams.length || rings.length < 2) return null
  const ctxOf = (f) => lots.get(f)?.ctx
  const votes = new Map()
  for (const s of seams) {
    const e = s.emitters.map(ctxOf).find(Boolean), h = s.handlers.map(ctxOf).find(Boolean)
    if (!e || !h || e === h) continue
    const a = tierIdx.get(D.get(e).tier), b = tierIdx.get(D.get(h).tier)
    if (a == null || b == null || a === b) continue
    const k = Math.min(a, b)
    votes.set(k, (votes.get(k) || 0) + 1)
  }
  if (!votes.size) return null
  const k = [...votes.entries()].sort((x, y) => y[1] - x[1])[0][0]
  if (!rings[k]) return null
  const R = rings[k].r + 9
  const seed = hashStr(atlas.project?.name || 'river')
  const rad = (a) => R + 2.6 * Math.sin(5 * a + seed * 30) + 1.3 * Math.sin(11 * a + seed * 70)
  const pts = []
  const n = Math.max(160, Math.ceil((TAU * R) / 4))
  for (let j = 0; j <= n; j++) { const a = (j / n) * TAU; pts.push([Math.cos(a) * rad(a), Math.sin(a) * rad(a)]) }
  // road crossings → road bridges
  const crossings = []
  const segX = (p1, p2, p3, p4) => {
    const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0])
    if (Math.abs(d) < 1e-9) return null
    const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d
    const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d
    return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])] : null
  }
  for (const r of roads) {
    if (r.ctx && r.cls !== 'arterial') continue
    if (r.cls === 'ring') continue
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const a = r.pts[i], b = r.pts[i + 1]
      const ra = Math.hypot(a[0], a[1]), rb = Math.hypot(b[0], b[1])
      if (Math.max(ra, rb) < R - 6 || Math.min(ra, rb) > R + 6) continue
      for (let j = 0; j + 1 < pts.length; j++) {
        const x = segX(a, b, pts[j], pts[j + 1])
        if (x) { crossings.push({ x: x[0], z: x[1], ang: Math.atan2(b[0] - a[0], b[1] - a[1]), cls: r.cls }); break }
      }
    }
  }
  // seam bridges: one per seam, between its emitting and handling districts
  const used = crossings.map((c) => Math.atan2(c.z, c.x))
  const bridges = []
  for (const s of seams) {
    const e = s.emitters.map(ctxOf).find(Boolean), h = s.handlers.map(ctxOf).find(Boolean)
    if (!e || !h) continue
    const de = D.get(e), dh = D.get(h)
    let a = Math.atan2((de.z + dh.z) / 2, (de.x + dh.x) / 2)
    // keep clear of road bridges and of each other
    for (let tries = 0; tries < 40; tries++) {
      const busy = [...used, ...bridges.map((b) => b.polar)].some((u) => Math.abs(adiff(u, a)) * R < 14)
      if (!busy) break
      a += (tries % 2 ? 1 : -1) * (tries + 1) * (7 / R)
    }
    const r = rad(a)
    const status = s.unhandled.length ? 'bad' : s.dead.length ? 'dead' : 'ok'
    bridges.push({ id: s.id, polar: a, x: Math.cos(a) * r, z: Math.sin(a) * r, ang: Math.atan2(Math.cos(a), Math.sin(a)), status, ok: s.matched.length, bad: s.unhandled.length, dead: s.dead.length, ec: e, hc: h })
  }
  return { pts, R, w: 7, ring: k, crossings, bridges }
}
