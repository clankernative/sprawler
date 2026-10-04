// Planner invariants on synthetic cities of several sizes: every number finite, no two buildings on one lot,
// districts never overlap, every non-seam dependency gets a route.  `npm run check`
import { planCity } from '../src/city/plan.js'

const LAYERS = { core: { ring: 0 }, root: { ring: 3, side: 'north' }, model: { ring: 1 }, command: { ring: 2 }, query: { ring: 2 },
  view: { ring: 2 }, port: { ring: 1 }, adapter: { ring: 1 }, driving: { ring: 3, side: 'west' }, driven: { ring: 3, side: 'east' }, test: { ring: 4, side: 'south' } }
let seed = 1
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)

function synth(nCtx, perCtx, nEdges) {
  const tiers = [{ id: 'app' }, { id: 'sdk' }, { id: 'host' }, { id: 'instance' }]
  const contexts = [], modules = []
  for (let c = 0; c < nCtx; c++) {
    const tier = tiers[c < nCtx / 2 ? 0 : 1 + (c % 3)].id
    const key = `${tier}:ctx${c}`
    contexts.push({ key, tier, label: `ctx${c}` })
    const n = 1 + Math.floor(rnd() * perCtx * 2)
    for (let i = 0; i < n; i++) {
      const layer = Object.keys(LAYERS)[Math.floor(rnd() * 11)]
      modules.push({ id: `${key}/m${i}`, name: `M${i}`, ctx: key, tier, layer, loc: Math.floor(rnd() * 400) })
    }
  }
  const edges = []
  for (let i = 0; i < nEdges; i++) {
    const a = modules[Math.floor(rnd() * modules.length)], b = modules[Math.floor(rnd() * modules.length)]
    if (a === b) continue
    edges.push({ source: a.id, target: b.id, status: rnd() < 0.08 ? 'violation' : a.ctx === b.ctx ? 'clean' : 'cross' })
  }
  return { tiers, layers: LAYERS, contexts, modules, edges, seams: [], project: { name: 'synth' } }
}

let fail = 0
const check = (ok, msg) => { if (!ok) { fail++; console.error('  ✕ ' + msg) } }
for (const [nCtx, per, nEdges] of [[3, 3, 20], [12, 8, 400], [35, 20, 2600], [70, 90, 20000]]) {
  const A = synth(nCtx, per, nEdges)
  const P = planCity(A)
  const fin = (v) => Number.isFinite(v)
  check([...P.lots.values()].every((l) => fin(l.x) && fin(l.z) && fin(l.ry)), 'non-finite lot')
  for (const d of P.districts.values()) {
    const ls = [...P.lots.values()].filter((l) => l.ctx === d.key)
    for (let i = 0; i < ls.length; i++) for (let j = i + 1; j < ls.length; j++) {
      if (Math.hypot(ls[i].x - ls[j].x, ls[i].z - ls[j].z) < 2.5) { check(false, `two buildings share a lot in ${d.key}`); i = ls.length; break }
    }
  }
  const ds = [...P.districts.values()]
  for (let i = 0; i < ds.length; i++) for (let j = i + 1; j < ds.length; j++) {
    check(Math.hypot(ds[i].x - ds[j].x, ds[i].z - ds[j].z) >= ds[i].R + ds[j].R, `districts overlap: ${ds[i].key} / ${ds[j].key}`)
  }
  const routed = P.routes.filter(Boolean)
  check(routed.length === A.edges.length, `routed ${routed.length} of ${A.edges.length} dependencies`)
  check(routed.every((r) => r.pieces.every((p) => p.pts.length >= 2 && p.pts.every(([x, z]) => fin(x) && fin(z)))), 'non-finite route point')
  console.log(`${fail ? '✕' : '✓'} ${nCtx} districts · ${A.modules.length} buildings · ${A.edges.length} cars · ${P.tracks.length} dirt roads · ${Math.round(P.ms)} ms`)
}
process.exit(fail ? 1 : 0)
