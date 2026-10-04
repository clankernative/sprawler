// Construction = uncommitted work. New files rise as half-built towers under tower cranes, edited files
// get scaffolding, deleted files become rubble, and an uncommitted violation has a bulldozer cutting
// its dirt track while a code inspector waits beside it.
import * as THREE from 'three'
import { kitMesh, part } from './kit.js'

const _M = new THREE.Matrix4(), _Q = new THREE.Quaternion(), _P = new THREE.Vector3(), _S = new THREE.Vector3(), _Y = new THREE.Vector3(0, 1, 0)
const MAX_CRANES = 60

export class Construction {
  constructor(view) {
    this.view = view
    this.group = new THREE.Group()
    this.cap = new Map() // module id → floors visible while under construction
    this.sites = []
    const A = view.atlas, P = view.plan
    const mat = view.mat
    const news = A.modules.filter((m) => m.wip === 'new' && view.bld.has(m.id)).sort((a, b) => (b.wipAdd || 0) - (a.wipAdd || 0))
    const mods = A.modules.filter((m) => m.wip === 'mod' && view.bld.has(m.id))
    for (const m of news) {
      const b = view.bld.get(m.id)
      const tiny = (m.wipAdd || 0) < 12 && b.floors < 2
      // a brand-new file: the tower is ~2/3 built (more lines written = taller), crane on the corner
      const prog = Math.min(0.85, 0.35 + Math.log2(1 + (m.wipAdd || 0)) / 14)
      this.cap.set(m.id, tiny ? -1 : Math.max(0, Math.floor(b.floors * prog)))
      this.sites.push({ kind: 'new', id: m.id, b, tiny, crane: this.sites.filter((s) => s.crane).length < MAX_CRANES && !tiny })
    }
    for (const m of mods) this.sites.push({ kind: 'mod', id: m.id, b: view.bld.get(m.id), big: (m.wipAdd || 0) + (m.wipDel || 0) > 60 })
    for (const [id, lot] of P.lots) if (id.startsWith('demolished:')) this.sites.push({ kind: 'demo', id, lot })
    this.tracks = P.tracks.filter((t) => t.wip > 0)

    const cranes = this.sites.filter((s) => s.crane)
    const scaff = this.sites.filter((s) => s.kind === 'mod' || (s.kind === 'new' && !s.tiny))
    const found = this.sites.filter((s) => s.kind === 'new' && s.tiny)
    const demo = this.sites.filter((s) => s.kind === 'demo')
    // crane geometry: mast segments + slewing top + hook
    const mastN = cranes.reduce((n, s) => n + this.mastH(s), 0)
    this.mast = kitMesh('crane_mast', mastN, mat)
    this.top = kitMesh('crane_top', cranes.length, mat)
    this.hook = kitMesh('crane_hook', cranes.length, mat)
    this.scaf = kitMesh('scaffold', scaff.length, mat)
    this.found = kitMesh('foundation', found.length, mat)
    this.rubble = kitMesh('rubble', demo.length, mat)
    this.cones = kitMesh('cone', (cranes.length + found.length) * 4 + this.tracks.length * 6, mat)
    this.dozers = kitMesh('bulldozer', this.tracks.length, mat)
    this.inspectors = kitMesh('inspector', this.tracks.length, mat)
    for (const m of [this.mast, this.top, this.hook, this.scaf, this.found, this.rubble, this.cones, this.dozers, this.inspectors]) this.group.add(m)
    let mi = 0, ci = 0
    cranes.forEach((s, k) => {
      const { x, z, ry } = s.b
      // the crane stands on the lot's back-left corner
      const ox = Math.cos(-ry) * 1.6 - Math.sin(-ry) * -1.6, oz = Math.sin(-ry) * 1.6 + Math.cos(-ry) * -1.6
      s.cx = x + ox; s.cz = z + oz
      const H = this.mastH(s)
      for (let h = 0; h < H; h++) { _M.compose(_P.set(s.cx, h, s.cz), _Q.identity(), _S.setScalar(1)); this.mast.setMatrixAt(mi, _M); this.mast.userData.ids ??= []; this.mast.userData.ids[mi] = s.id; mi++ }
      s.topY = H
      s.k = k
      s.phase = (k * 1.7) % (Math.PI * 2)
      for (let c = 0; c < 4; c++) this.cone(ci++, x + (c % 2 ? 1.5 : -1.5), z + (c < 2 ? 1.5 : -1.5))
    })
    this.top.userData.ids = cranes.map((s) => s.id)
    this.hook.userData.ids = cranes.map((s) => s.id)
    this.cranes = cranes
    scaff.forEach((s, k) => {
      const b = s.b
      const capF = this.cap.get(s.id)
      const hb = part(b.arch + '_base').h ?? 0.8
      const h = s.kind === 'new' ? hb + Math.max(0, capF) * 0.5 + 0.9 : b.height
      _Q.setFromAxisAngle(_Y, b.ry)
      _M.compose(_P.set(b.x, 0, b.z), _Q, _S.set(2.65, Math.max(1.2, h), 2.65))
      this.scaf.setMatrixAt(k, _M)
    })
    this.scaf.userData.ids = scaff.map((s) => s.id)
    found.forEach((s, k) => {
      _Q.setFromAxisAngle(_Y, s.b.ry)
      _M.compose(_P.set(s.b.x, 0.01, s.b.z), _Q, _S.setScalar(1))
      this.found.setMatrixAt(k, _M)
      for (let c = 0; c < 4; c++) this.cone(ci++, s.b.x + (c % 2 ? 1.4 : -1.4), s.b.z + (c < 2 ? 1.4 : -1.4))
    })
    this.found.userData.ids = found.map((s) => s.id)
    demo.forEach((s, k) => {
      _Q.setFromAxisAngle(_Y, s.lot.ry)
      _M.compose(_P.set(s.lot.x, 0, s.lot.z), _Q, _S.setScalar(1))
      this.rubble.setMatrixAt(k, _M)
    })
    // unpermitted construction: bulldozer working the track, inspector parked at its start, survey cones
    this.tracks.forEach((t, k) => {
      t.cum = [0]
      for (let i = 1; i < t.pts.length; i++) t.cum.push(t.cum[i - 1] + Math.hypot(t.pts[i][0] - t.pts[i - 1][0], t.pts[i][1] - t.pts[i - 1][1]))
      const [x, z] = this.along(t, 0.12)
      _M.compose(_P.set(x + 1.6, 0.05, z), _Q.identity(), _S.setScalar(1))
      this.inspectors.setMatrixAt(k, _M)
      for (let c = 0; c < 6; c++) { const [cx, cz] = this.along(t, 0.2 + c * 0.12); this.cone(ci++, cx + 1.4, cz + 1.4) }
    })
    for (const m of [this.mast, this.scaf, this.found, this.rubble, this.cones, this.inspectors]) { m.instanceMatrix.needsUpdate = true; m.computeBoundingSphere() }
  }

  mastH(s) { return Math.max(6, Math.ceil(s.b.height + 3)) }

  cone(i, x, z) {
    _M.compose(_P.set(x, 0.06, z), _Q.identity(), _S.setScalar(1.4))
    this.cones.setMatrixAt(i, _M)
  }

  along(t, f) {
    const L = t.cum[t.cum.length - 1] * f
    let i = 1
    while (i < t.cum.length - 1 && t.cum[i] < L) i++
    const a = t.pts[i - 1], b = t.pts[i]
    const k = (L - t.cum[i - 1]) / Math.max(1e-4, t.cum[i] - t.cum[i - 1])
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, Math.atan2(b[0] - a[0], b[1] - a[1])]
  }

  // keep construction gear in step with selection ghosting / filters
  apply() {
    const v = this.view
    for (const mesh of [this.mast, this.top, this.hook, this.scaf, this.found]) {
      const ids = mesh.userData.ids || []
      const fx = mesh.geometry.attributes.iFx
      for (let i = 0; i < mesh.count; i++) {
        const id = ids[i]
        const b = id && v.bld.get(id)
        const parts = b?.parts?.[0]
        const ghost = parts ? parts[0].geometry.attributes.iFx.getY(parts[1]) : 0
        fx.setXYZW(i, 0, ghost, 0, 0)
      }
      fx.needsUpdate = true
    }
  }

  update(t, dt) {
    for (const s of this.cranes) {
      // the jib swings slowly back and forth, the hook bobs
      const a = s.phase + Math.sin(t * 0.18 + s.phase) * 1.4
      _Q.setFromAxisAngle(_Y, a)
      _M.compose(_P.set(s.cx, s.topY, s.cz), _Q, _S.setScalar(1))
      this.top.setMatrixAt(s.k, _M)
      const reach = 2.6 + Math.sin(t * 0.31 + s.phase) * 1.2
      const hx = s.cx + Math.sin(a) * -reach * -1, hz = s.cz + Math.cos(a) * -reach * -1
      _M.compose(_P.set(s.cx - Math.sin(a) * reach, s.topY + 0.4, s.cz - Math.cos(a) * reach), _Q, _S.set(1, 1 + Math.sin(t * 0.5 + s.phase) * 0.6 + 1.2, 1))
      this.hook.setMatrixAt(s.k, _M)
      void hx; void hz
    }
    this.top.instanceMatrix.needsUpdate = true
    this.hook.instanceMatrix.needsUpdate = true
    this.tracks.forEach((tr, k) => {
      const f = 0.3 + 0.25 * (0.5 + 0.5 * Math.sin(t * 0.08 + k))
      const [x, z, ang] = this.along(tr, f)
      const back = Math.cos(t * 0.08 + k) < 0
      _Q.setFromAxisAngle(_Y, ang + (back ? Math.PI : 0))
      _M.compose(_P.set(x, 0.05 + Math.abs(Math.sin(t * 9)) * 0.03, z), _Q, _S.setScalar(1.2))
      this.dozers.setMatrixAt(k, _M)
    })
    this.dozers.instanceMatrix.needsUpdate = true
  }

  pickables() { return [this.scaf, this.mast, this.top, this.found] }

  // points of interest for markers / the news chopper
  poi() {
    const out = []
    for (const s of this.sites) {
      if (s.kind === 'demo') out.push({ kind: 'demo', id: s.id, pos: [s.lot.x, 2, s.lot.z] })
      else out.push({ kind: s.kind, id: s.id, pos: [s.b.x, s.b.height + 2, s.b.z] })
    }
    for (const t of this.tracks) { const [x, z] = this.along(t, 0.5); out.push({ kind: 'track', track: t, pos: [x, 2, z] }) }
    return out
  }

  dispose() {}
}
