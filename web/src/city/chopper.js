// The news chopper: always in the air, flying between whatever is happening (construction, dirt roads,
// smelly buildings, the worst district), banking into turns and circling each story. Press U (or the dock)
// for chopper cam: the camera rides along behind it with a TV lower-third.
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

function coloured(geo, hex) {
  geo = geo.index ? geo.toNonIndexed() : geo
  const c = new THREE.Color(hex), n = geo.attributes.position.count, a = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b }
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3))
  geo.deleteAttribute('uv')
  return geo
}

function build() {
  const g = new THREE.Group()
  const body = mergeGeometries([
    coloured(new THREE.CapsuleGeometry(0.42, 0.9, 4, 10).rotateX(Math.PI / 2).scale(1, 0.95, 1), '#f4f5f7'),
    coloured(new THREE.CapsuleGeometry(0.36, 0.5, 4, 10).rotateX(Math.PI / 2).translate(0, 0.08, -0.38).scale(0.98, 0.9, 1), '#2a4a8f'),
    coloured(new THREE.BoxGeometry(0.85, 0.08, 0.5).translate(0, -0.08, 0.15), '#2f6bff'), // belly stripe
    coloured(new THREE.CylinderGeometry(0.07, 0.13, 1.6, 6).rotateX(Math.PI / 2).translate(0, 0.12, 1.35), '#f4f5f7'), // tail boom
    coloured(new THREE.BoxGeometry(0.06, 0.5, 0.32).translate(0, 0.36, 2.1), '#2f6bff'), // fin
    coloured(new THREE.BoxGeometry(0.5, 0.05, 0.18).translate(0, 0.14, 1.95), '#f4f5f7'), // stabiliser
    coloured(new THREE.CylinderGeometry(0.08, 0.1, 0.22, 8).translate(0, 0.5, 0), '#4a5560'), // mast
    coloured(new THREE.BoxGeometry(0.05, 0.05, 1.3).translate(0.32, -0.48, 0), '#3a434d'), // skids
    coloured(new THREE.BoxGeometry(0.05, 0.05, 1.3).translate(-0.32, -0.48, 0), '#3a434d'),
    coloured(new THREE.BoxGeometry(0.04, 0.22, 0.04).translate(0.3, -0.38, -0.3), '#3a434d'),
    coloured(new THREE.BoxGeometry(0.04, 0.22, 0.04).translate(-0.3, -0.38, -0.3), '#3a434d'),
    coloured(new THREE.BoxGeometry(0.04, 0.22, 0.04).translate(0.3, -0.38, 0.3), '#3a434d'),
    coloured(new THREE.BoxGeometry(0.04, 0.22, 0.04).translate(-0.3, -0.38, 0.3), '#3a434d'),
    coloured(new THREE.SphereGeometry(0.11, 8, 6).translate(0, -0.3, -0.62), '#20262d'), // camera ball
  ])
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.15 })
  const hull = new THREE.Mesh(body, mat)
  hull.castShadow = true
  g.add(hull)
  // rotors spin as separate meshes
  const blade = new THREE.MeshStandardMaterial({ color: '#2b3138', roughness: 0.6 })
  const main = new THREE.Mesh(mergeGeometries([new THREE.BoxGeometry(3.4, 0.03, 0.12), new THREE.BoxGeometry(0.12, 0.03, 3.4)]), blade)
  main.position.y = 0.63
  main.castShadow = true
  g.add(main)
  const disc = new THREE.Mesh(new THREE.CircleGeometry(1.7, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#1d232a', transparent: true, opacity: 0.12, depthWrite: false }))
  disc.position.y = 0.62
  g.add(disc)
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.55, 0.06), blade)
  tail.position.set(0.08, 0.32, 2.12)
  g.add(tail)
  // nav lights: red port, green starboard, white strobe
  const lamp = (c, x, y, z) => { const m = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 4), new THREE.MeshBasicMaterial({ color: c })); m.position.set(x, y, z); g.add(m); return m }
  const nav = [lamp('#ff3030', 0.43, 0.0, 0), lamp('#30ff60', -0.43, 0.0, 0), lamp('#ffffff', 0, 0.62, 2.15)]
  // searchlight for night shots
  const spot = new THREE.SpotLight('#fff5d6', 0, 120, 0.22, 0.6, 1.2)
  spot.position.set(0, -0.3, -0.62)
  g.add(spot, spot.target)
  return { g, main, tail, nav, spot }
}

export class Chopper {
  constructor(view) {
    this.view = view
    const parts = build()
    Object.assign(this, parts)
    this.group = this.g
    this.g.scale.setScalar(1.8)
    this.pos = new THREE.Vector3(0, 40, view.plan.extent * 0.6)
    this.vel = new THREE.Vector3()
    this.heading = 0
    this.bank = 0
    this.target = null
    this.story = null
    this.orbitT = 0
    this.idx = 0
    this.g.position.copy(this.pos)
  }

  // points of interest: the alerts' list if there is news, else the city's standing stories
  pickStory() {
    const v = this.view
    const list = []
    for (const p of v.poiSource?.() || []) list.push({ pos: p.pos, label: p.label, icon: p.icon })
    if (list.length < 4) {
      const smelly = v.atlas.modules.filter((m) => (m.metrics?.smell || 0) >= 0.6 && v.bld.has(m.id)).sort((a, b) => b.metrics.smell - a.metrics.smell).slice(0, 4)
      for (const m of smelly) { const p = v.posOf(m.id); list.push({ pos: [p[0], 0, p[2]], label: `${m.name}: ${m.loc} lines, the smelliest building in town`, icon: '🦨' }) }
      for (const t of v.plan.tracks.slice(0, 3)) { const p = t.pts[Math.floor(t.pts.length / 2)]; list.push({ pos: [p[0], 0, p[1]], label: `Dirt road: ${v.ctxs.get(t.a)?.label} → ${v.ctxs.get(t.b)?.label}`, icon: '🟫' }) }
      const worst = v.atlas.score.worst
      if (worst) { const c = v.ctxCenter(worst.key); list.push({ pos: c.pos, label: `Worst district: ${worst.label} (${worst.grade})`, icon: '🏚' }) }
      for (const d of [...v.plan.districts.values()].sort((a, b) => b.R - a.R).slice(0, 3)) list.push({ pos: [d.x, 0, d.z], label: `Over ${v.ctxs.get(d.key)?.label}`, icon: '🏙' })
    }
    if (!list.length) return null
    return list[this.idx++ % list.length]
  }

  update(t, dt) {
    if (!dt) return
    if (!this.story || (this.orbitT > 14 && this.arrived)) {
      this.story = this.pickStory()
      this.arrived = false
      this.orbitT = 0
      this.onStory?.(this.story)
    }
    const s = this.story
    if (!s) return
    const tgt = new THREE.Vector3(s.pos[0], 0, s.pos[2])
    const R = 34
    // fly to an orbit point around the story, then circle it
    let goal
    const flat = new THREE.Vector3(this.pos.x - tgt.x, 0, this.pos.z - tgt.z)
    const d = flat.length()
    if (d > R * 1.3 && !this.arrived) goal = tgt.clone().addScaledVector(flat.normalize(), R).setY(30)
    else {
      this.arrived = true
      this.orbitT += dt
      const a = Math.atan2(this.pos.z - tgt.z, this.pos.x - tgt.x) + dt * 0.28
      goal = new THREE.Vector3(tgt.x + Math.cos(a + 0.35) * R, 26 + Math.sin(t * 0.3) * 2, tgt.z + Math.sin(a + 0.35) * R)
    }
    const want = goal.sub(this.pos)
    const dist = want.length()
    const speed = this.arrived ? 9 : Math.min(42, 12 + dist * 0.35)
    want.setLength(Math.min(speed, dist * 2))
    this.vel.lerp(want, Math.min(1, dt * 1.4))
    this.pos.addScaledVector(this.vel, dt)
    // heading follows velocity, bank into the turn
    const h = Math.atan2(-this.vel.x, -this.vel.z)
    let dh = h - this.heading
    while (dh > Math.PI) dh -= Math.PI * 2
    while (dh < -Math.PI) dh += Math.PI * 2
    this.heading += dh * Math.min(1, dt * 2.2)
    this.bank += (THREE.MathUtils.clamp(dh * 1.6, -0.5, 0.5) - this.bank) * Math.min(1, dt * 3)
    const pitch = THREE.MathUtils.clamp(this.vel.length() / 60, 0, 0.25)
    this.g.position.copy(this.pos)
    this.g.rotation.set(-pitch, this.heading, 0, 'YXZ')
    this.g.rotateZ(this.bank)
    this.main.rotation.y = t * 38
    this.tail.rotation.x = t * 55
    this.nav[2].visible = (t * 1.3) % 1 < 0.12
    // searchlight on the story at night
    const n = this.view.world.uni.uNight.value
    this.spot.intensity = n * 2200
    this.spot.target.position.copy(this.g.worldToLocal(tgt.clone()))
  }

  // chase camera: behind and slightly above, aimed just past the chopper toward the story below,
  // so the chopper sits in the lower third of the frame with the city opening up ahead of it
  cam() {
    const back = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading))
    // camera 12 behind and 7 above; aim 10 ahead and 4 below → chopper sits just under frame centre
    const look = this.pos.clone().addScaledVector(back, -10).add(new THREE.Vector3(0, -4, 0))
    return { pos: this.pos.clone().addScaledVector(back, 12).add(new THREE.Vector3(0, 7, 0)), look }
  }
}
