// Traffic police: every rule break gets pulled over. A red car stopped on the shoulder of its dirt road
// (or the trampled path across a lawn), a cruiser behind it with its lights going. Click the cruiser for
// the ticket: the rule, file:line, the code, and a fix prompt.
import * as THREE from 'three'
import { kitMesh, has } from './kit.js'

const _M = new THREE.Matrix4(), _Q = new THREE.Quaternion(), _P = new THREE.Vector3(), _S = new THREE.Vector3(), _Y = new THREE.Vector3(0, 1, 0)
const MAX = 90 // stops on screen at once, worst first
const SEV = { critical: 3, major: 2, minor: 1 }

export class Police {
  constructor(view) {
    this.view = view
    this.group = new THREE.Group()
    const A = view.atlas, P = view.plan
    const byPair = new Map()
    for (const t of P.tracks) byPair.set(t.a + '|' + t.b, t), byPair.set(t.b + '|' + t.a, t)
    // worst first, at most a few stops per dirt road so one hairy pair doesn't eat the budget
    const order = A.violations.map((v, i) => [v, i]).filter(([v]) => !v.seam).sort((a, b) => (SEV[b[0].severity] || 0) - (SEV[a[0].severity] || 0))
    const perTrack = new Map()
    this.stops = []
    for (const [v, i] of order) {
      if (this.stops.length >= MAX) break
      const sa = view.bld.get(v.source), sb = view.bld.get(v.target)
      if (!sa || !sb) continue
      const t = byPair.get(v.fromCtx + '|' + v.toCtx)
      let x, z, ang
      if (t && v.fromCtx !== v.toCtx) {
        const n = perTrack.get(t) || 0
        if (n >= 3) continue
        perTrack.set(t, n + 1)
        ;[x, z, ang] = along(t.pts, 0.28 + n * 0.22)
      } else {
        // a shortcut across the lawn inside a district: pulled over halfway
        x = (sa.x + sb.x) / 2; z = (sa.z + sb.z) / 2; ang = Math.atan2(sb.x - sa.x, sb.z - sa.z)
      }
      // both cars sit on the right shoulder; the cruiser parks behind the offender
      const rx = Math.cos(ang), rz = -Math.sin(ang), fx = Math.sin(ang), fz = Math.cos(ang)
      const side = 1.25
      this.stops.push({ vi: i, sev: v.severity, car: [x + rx * side, z + rz * side], cop: [x + rx * side - fx * 1.7, z + rz * side - fz * 1.7], ang })
    }
    const n = this.stops.length
    this.cars = kitMesh('car', n, view.mat)
    this.cops = kitMesh(has('police') ? 'police' : 'inspector', n, view.mat)
    this.cops.userData.vis = this.stops.map((s) => s.vi)
    this.cars.userData.vis = this.stops.map((s) => s.vi)
    this.stops.forEach((s, k) => {
      // pulled over: nose angled toward the verge
      _Q.setFromAxisAngle(_Y, s.ang + Math.PI + 0.18)
      _M.compose(_P.set(s.car[0], 0.07, s.car[1]), _Q, _S.setScalar(1))
      this.cars.setMatrixAt(k, _M)
      this.cars.geometry.attributes.iTint.setXYZ(k, 0.91, 0.28, 0.23)
      _Q.setFromAxisAngle(_Y, s.ang + Math.PI + 0.1)
      _M.compose(_P.set(s.cop[0], 0.07, s.cop[1]), _Q, _S.setScalar(1.05))
      this.cops.setMatrixAt(k, _M)
      // iFx.w drives the light bar: siren phase per cruiser so they don't all flash in sync
      this.cops.geometry.attributes.iFx.setW(k, 1 + (k % 7) / 7)
    })
    for (const m of [this.cars, this.cops]) {
      m.instanceMatrix.needsUpdate = true
      m.geometry.attributes.iTint.needsUpdate = true
      m.geometry.attributes.iFx.needsUpdate = true
      m.computeBoundingSphere()
      this.group.add(m)
    }
  }

  // keep the pulled-over pairs in step with selection ghosting (iFx.y) without touching the siren (iFx.w)
  apply(dim) {
    for (const m of [this.cars, this.cops]) {
      const fx = m.geometry.attributes.iFx
      m.userData.vis.forEach((vi, k) => fx.setY(k, dim(vi) ? 0.85 : 0))
      fx.needsUpdate = true
    }
  }

  pickables() { return [this.cops, this.cars] }
}

function along(pts, f) {
  const cum = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
  const L = cum[cum.length - 1] * f
  let i = 1
  while (i < cum.length - 1 && cum[i] < L) i++
  const a = pts[i - 1], b = pts[i]
  const k = (L - cum[i - 1]) / Math.max(1e-4, cum[i] - cum[i - 1])
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, Math.atan2(b[0] - a[0], b[1] - a[1])]
}
