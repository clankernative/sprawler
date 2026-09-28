// Hex layout: tiers → concentric rings, contexts → hex platforms, layers → rings inside a platform.
const SIDE = { east: 0, south: Math.PI / 2, west: Math.PI, north: -Math.PI / 2 }
const S = 2.6 // node spacing (world units)
const GOLDEN = Math.PI * (3 - Math.sqrt(5))

export function nodeSize(m) {
  if (m.generated) return 0.45
  return Math.min(1.5, 0.5 + 0.28 * Math.log2(1 + m.loc / 25))
}

function sortKey(m) {
  return `${m.layer}|${m.slice || ''}|${m.name}`
}

// place `items` on arcs centred at `center`, filling rows outward from `r`
function arc(items, center, r, maxSpan, out) {
  let i = 0
  while (i < items.length) {
    const cap = Math.max(1, Math.floor((r * maxSpan) / S) + 1)
    const row = items.slice(i, i + cap)
    const span = row.length > 1 ? Math.min(maxSpan, ((row.length - 1) * S) / r) : 0
    row.forEach((m, k) => {
      const a = center - span / 2 + (row.length > 1 ? (span * k) / (row.length - 1) : 0)
      out.push([m, r, a])
    })
    i += cap
    if (i < items.length) r += S
  }
  return r
}

export function localLayout(mods, layers) {
  const byRing = new Map()
  for (const m of mods) {
    const ring = layers[m.layer]?.ring ?? 3
    if (!byRing.has(ring)) byRing.set(ring, [])
    byRing.get(ring).push(m)
  }
  const rings = [...byRing.keys()].sort((a, b) => a - b)
  const pos = new Map()
  const bands = []
  let outer = 0
  let core = 0
  rings.forEach((ring, ri) => {
    const items = byRing.get(ring).sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
    if (ri === 0) {
      items.forEach((m, i) => {
        const r = S * 0.85 * Math.sqrt(i + 0.5)
        const a = i * GOLDEN
        pos.set(m.id, [Math.cos(a) * r, 1.9, Math.sin(a) * r])
      })
      core = S * 0.85 * Math.sqrt(items.length) + S * 0.55
      outer = core
      bands.push(core)
      return
    }
    let r = outer + S * 0.9
    const placed = []
    const unsided = items.filter((m) => !layers[m.layer]?.side)
    const sided = new Map()
    for (const m of items) {
      const s = layers[m.layer]?.side
      if (!s) continue
      if (!sided.has(s)) sided.set(s, [])
      sided.get(s).push(m)
    }
    // unsided: evenly around full rings
    let i = 0
    while (i < unsided.length) {
      const cap = Math.max(3, Math.floor((2 * Math.PI * r) / S))
      const row = unsided.slice(i, i + cap)
      const off = ri * 0.7 + (i / cap) * 0.5
      row.forEach((m, k) => placed.push([m, r, off + (2 * Math.PI * k) / row.length]))
      i += cap
      r += S
    }
    if (!unsided.length) r = outer + S * 0.9
    let maxR = unsided.length ? r - S : r
    for (const [side, list] of sided) {
      const end = arc(list, SIDE[side] ?? 0, r, 1.5, placed)
      maxR = Math.max(maxR, end)
    }
    for (const [m, rr, a] of placed) pos.set(m.id, [Math.cos(a) * rr, 1.0, Math.sin(a) * rr])
    outer = maxR + S * 0.2
    bands.push(outer)
  })
  const radius = Math.max(outer + S * 0.8, S * 2)
  return { pos, radius, bands, core }
}

export function computeLayout(atlas) {
  const byCtx = new Map()
  for (const m of atlas.modules) {
    if (!byCtx.has(m.ctx)) byCtx.set(m.ctx, [])
    byCtx.get(m.ctx).push(m)
  }
  const tierOrder = atlas.tiers.map((t) => t.id)
  if (atlas.contexts.some((c) => c.tier === 'unmapped')) tierOrder.push('unmapped')
  const ctxPos = new Map()
  const maxIn = Math.max(1, ...atlas.contexts.map((c) => c.inbound || 0))
  for (const c of atlas.contexts) {
    const local = localLayout(byCtx.get(c.key) || [], atlas.layers)
    // busier contexts get a bigger footprint, like a city with more traffic
    const grow = 1 + (0.35 * Math.log2(1 + (c.inbound || 0))) / Math.log2(1 + maxIn)
    ctxPos.set(c.key, { x: 0, z: 0, radius: local.radius * grow, local, tier: c.tier })
  }
  const tiers = []
  let prevOuter = 0
  const GAP = 7
  tierOrder.forEach((tid, ti) => {
    const list = atlas.contexts.filter((c) => c.tier === tid).map((c) => ctxPos.get(c.key))
    if (!list.length) return
    list.sort((a, b) => b.radius - a.radius)
    if (tiers.length === 0) {
      const placed = []
      for (const p of list) {
        if (!placed.length) {
          p.x = 0; p.z = 0; placed.push(p); continue
        }
        let t = 0
        for (let k = 0; k < 40000; k++) {
          t += 0.08
          const rr = 2.2 * t, a = t * 2.39996
          const x = Math.cos(a) * rr, z = Math.sin(a) * rr
          if (placed.every((q) => Math.hypot(q.x - x, q.z - z) > q.radius + p.radius + GAP * 0.55)) {
            p.x = x; p.z = z; break
          }
        }
        placed.push(p)
      }
      const outer = Math.max(...placed.map((p) => Math.hypot(p.x, p.z) + p.radius))
      tiers.push({ id: tid, R: outer * 0.5, inner: 0, outer })
      prevOuter = outer
      return
    }
    const maxR = Math.max(...list.map((p) => p.radius))
    const need = list.reduce((s, p) => s + 2 * p.radius + GAP, 0)
    const R = Math.max(prevOuter + maxR + GAP * 1.6, need / (2 * Math.PI))
    const circ = 2 * Math.PI * R
    const scale = circ / need
    let a = -Math.PI / 2 + ti * 0.9
    // interleave big/small so rings look balanced
    const order = []
    for (let i = 0, j = list.length - 1; i <= j; i++, j--) {
      order.push(list[i])
      if (i !== j) order.push(list[j])
    }
    for (const p of order) {
      const span = ((2 * p.radius + GAP) * scale) / R
      a += span / 2
      p.x = Math.cos(a) * R
      p.z = Math.sin(a) * R
      a += span / 2
    }
    tiers.push({ id: tid, R, inner: R - maxR, outer: R + maxR })
    prevOuter = R + maxR
  })
  return { ctxPos, tiers, extent: prevOuter }
}

// Classic force-directed hairball — the "what a DI-soup graph viewer shows you" mode.
export function tangleLayout(modules, edges, extent) {
  const n = modules.length
  const idx = new Map(modules.map((m, i) => [m.id, i]))
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5
  const R = Math.max(40, extent * 0.55)
  const P = new Float32Array(n * 3)
  for (let i = 0; i < n * 3; i++) P[i] = rnd() * R
  const D = new Float32Array(n * 3)
  const E = []
  for (const e of edges) {
    const a = idx.get(e.source), b = idx.get(e.target)
    if (a != null && b != null && a !== b) E.push(a, b)
  }
  const k = R / Math.cbrt(n) * 1.2
  let temp = R * 0.1
  for (let it = 0; it < 90; it++) {
    D.fill(0)
    for (let i = 0; i < n; i++) {
      const ix = P[i * 3], iy = P[i * 3 + 1], iz = P[i * 3 + 2]
      for (let j = i + 1; j < n; j++) {
        const dx = ix - P[j * 3], dy = iy - P[j * 3 + 1], dz = iz - P[j * 3 + 2]
        const d2 = dx * dx + dy * dy + dz * dz + 0.01
        const f = (k * k) / d2
        D[i * 3] += dx * f; D[i * 3 + 1] += dy * f; D[i * 3 + 2] += dz * f
        D[j * 3] -= dx * f; D[j * 3 + 1] -= dy * f; D[j * 3 + 2] -= dz * f
      }
    }
    for (let e = 0; e < E.length; e += 2) {
      const a = E[e], b = E[e + 1]
      const dx = P[a * 3] - P[b * 3], dy = P[a * 3 + 1] - P[b * 3 + 1], dz = P[a * 3 + 2] - P[b * 3 + 2]
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.01
      const f = d / k
      D[a * 3] -= dx * f; D[a * 3 + 1] -= dy * f; D[a * 3 + 2] -= dz * f
      D[b * 3] += dx * f; D[b * 3 + 1] += dy * f; D[b * 3 + 2] += dz * f
    }
    for (let i = 0; i < n; i++) {
      const dx = D[i * 3], dy = D[i * 3 + 1], dz = D[i * 3 + 2]
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.01
      const s = Math.min(d, temp) / d
      P[i * 3] += dx * s - P[i * 3] * 0.01
      P[i * 3 + 1] += dy * s - P[i * 3 + 1] * 0.01
      P[i * 3 + 2] += dz * s - P[i * 3 + 2] * 0.01
    }
    temp *= 0.96
  }
  let max = 1
  for (let i = 0; i < n * 3; i++) max = Math.max(max, Math.abs(P[i]))
  const sc = R / max
  const out = new Map()
  modules.forEach((m, i) => out.set(m.id, [P[i * 3] * sc, P[i * 3 + 1] * sc * 0.6 + R * 0.6 + 8, P[i * 3 + 2] * sc]))
  return out
}
