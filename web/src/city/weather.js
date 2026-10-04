// Weather that means something. The sky follows the city rating (S/A clear, B fair, C overcast, D rain,
// F thunderstorms) and every struggling district gets its own cloud parked over it — rain over D, a storm
// with lightning over F — so trouble is visible from orbit.
import * as THREE from 'three'
import { kitMesh } from './kit.js'

const _M = new THREE.Matrix4(), _Q = new THREE.Quaternion(), _P = new THREE.Vector3(), _S = new THREE.Vector3(), _Y = new THREE.Vector3(0, 1, 0)
export const SKIES = {
  S: { clouds: 4, dark: 0, rain: 0, label: 'Clear skies', icon: '☀️' },
  A: { clouds: 8, dark: 0, rain: 0, label: 'Mostly sunny', icon: '🌤' },
  B: { clouds: 16, dark: 0.08, rain: 0, label: 'Fair, some cloud', icon: '⛅' },
  C: { clouds: 26, dark: 0.22, rain: 0, label: 'Overcast', icon: '🌥' },
  D: { clouds: 32, dark: 0.35, rain: 0.5, label: 'Rain', icon: '🌧' },
  F: { clouds: 38, dark: 0.5, rain: 1, label: 'Thunderstorms', icon: '⛈' },
}

const RAIN_VS = /* glsl */ `
uniform float uTime; attribute vec4 aDrop; varying float vA;
void main(){
  // aDrop: x,z offset inside the column, phase, column height
  float y = aDrop.w * (1.0 - fract(uTime * 0.9 + aDrop.z));
  vec3 p = position + vec3(aDrop.x, y, aDrop.y);
  vA = smoothstep(0.0, 3.0, y) * smoothstep(aDrop.w, aDrop.w - 4.0, y);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
}`
const RAIN_FS = /* glsl */ `varying float vA; void main(){ if (vA < 0.02) discard; gl_FragColor = vec4(0.72, 0.8, 0.9, vA * 0.55); }`

export class Weather {
  constructor(view) {
    this.view = view
    this.group = new THREE.Group()
    const A = view.atlas, P = view.plan
    const grade = A.score.withheld ? 'C' : A.score.grade
    this.sky = SKIES[grade] || SKIES.C
    let seed = 11
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    // drifting fair-weather clouds across the whole map (their shadows already roll over the ground)
    const E = P.extent
    this.drift = []
    for (let i = 0; i < this.sky.clouds; i++) this.drift.push({ x: (rnd() - 0.5) * 2 * E, z: (rnd() - 0.5) * 2 * E, y: 46 + rnd() * 20, s: 2.2 + rnd() * 2.8, r: rnd() * 6, v: 1.5 + rnd() * 2 })
    // storm cells over every district graded D or F; a lighter grey cloud over C
    this.cells = []
    for (const d of P.districts.values()) {
      const c = view.ctxs.get(d.key)
      if (!c || !'CDF'.includes(c.grade)) continue
      this.cells.push({ d, g: c.grade, x: d.x, z: d.z, y: 17 + d.R * 0.08, s: Math.max(2.4, d.R / 6), r: rnd() * 6, flash: 0, next: 3 + rnd() * 8 })
    }
    this.light = kitMesh('cloud', this.drift.length + this.cells.filter((c) => c.g === 'C').length, view.mat)
    this.dark = kitMesh('rain_cloud', this.cells.filter((c) => c.g !== 'C').length, view.mat)
    for (const m of [this.light, this.dark]) { m.castShadow = true; m.receiveShadow = false; this.group.add(m) }
    // rain columns under D/F cells
    const wet = this.cells.filter((c) => c.g !== 'C')
    const per = 260
    const geo = new THREE.InstancedBufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0.12, -1.4, 0.05], 3))
    const drops = new Float32Array(wet.length * per * 4)
    this.rainCols = wet
    wet.forEach((c, k) => {
      for (let i = 0; i < per; i++) {
        const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * c.s * 2.6
        drops.set([c.x + Math.cos(a) * r, c.z + Math.sin(a) * r, rnd(), c.y], (k * per + i) * 4)
      }
    })
    geo.setAttribute('aDrop', new THREE.InstancedBufferAttribute(drops, 4))
    geo.instanceCount = wet.length * per
    this.rain = new THREE.LineSegments(geo, new THREE.ShaderMaterial({ uniforms: { uTime: view.world.uni.uTime }, vertexShader: RAIN_VS, fragmentShader: RAIN_FS, transparent: true, depthWrite: false }))
    this.rain.frustumCulled = false
    this.group.add(this.rain)
    this.lightning = new THREE.PointLight('#cfe0ff', 0, 160, 1.2)
    this.group.add(this.lightning)
    this.update(0, 0)
  }

  update(t, dt) {
    const E = this.view.plan.extent
    let li = 0, di = 0
    for (const c of this.drift) {
      c.x += c.v * dt
      if (c.x > E * 1.1) c.x = -E * 1.1
      _Q.setFromAxisAngle(_Y, c.r)
      _M.compose(_P.set(c.x, c.y, c.z), _Q, _S.setScalar(c.s))
      this.light.setMatrixAt(li++, _M)
    }
    let flashMax = 0, fx = 0, fz = 0
    for (const c of this.cells) {
      // cells hover and turn slowly over their district
      const bob = Math.sin(t * 0.4 + c.r) * 0.6
      _Q.setFromAxisAngle(_Y, c.r + t * 0.02)
      _M.compose(_P.set(c.x, c.y + bob, c.z), _Q, _S.set(c.s * 1.25, c.s * 0.9, c.s * 1.25))
      if (c.g === 'C') this.light.setMatrixAt(li++, _M)
      else this.dark.setMatrixAt(di++, _M)
      if (c.g === 'F') {
        c.next -= dt
        if (c.next < 0) { c.flash = 1; c.next = 2.5 + Math.random() * 7; this.view.onThunder?.() }
        c.flash *= Math.pow(0.0005, dt)
        if (c.flash > flashMax) { flashMax = c.flash; fx = c.x; fz = c.z }
      }
    }
    // lightning: a double flicker lights the district from inside the cloud
    const flick = flashMax * (0.6 + 0.4 * Math.sin(t * 60))
    this.lightning.intensity = flick * 9000
    this.lightning.position.set(fx, 22, fz)
    this.light.instanceMatrix.needsUpdate = true
    this.dark.instanceMatrix.needsUpdate = true
  }
}
