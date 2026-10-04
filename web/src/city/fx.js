// Particles: confetti for grand openings, fireworks for trophies / grade-ups, smoke over run-down
// districts, dust where trucks crawl along dirt tracks. One Points mesh, GPU-animated, bursts recycled.
import * as THREE from 'three'

const N = 6000
const VS = /* glsl */ `
uniform float uTime; uniform float uPx;
attribute vec3 aP; attribute vec3 aV; attribute vec4 aInfo; attribute vec3 aCol;
varying vec3 vCol; varying float vA; varying float vKind;
void main(){
  float t0 = aInfo.x, life = aInfo.y, kind = aInfo.z, size = aInfo.w;
  float age = uTime - t0;
  if (kind > 1.5 && kind < 2.5) age = mod(uTime - t0, life); // looping emitters (smoke, dust)
  float k = age / life;
  vec3 p = aP;
  if (kind < 0.5) { // confetti: burst up, flutter down
    p += aV * age + vec3(sin(age * 7.0 + aP.x) * 0.3, -2.2 * age * age, cos(age * 6.0 + aP.z) * 0.3);
  } else if (kind < 1.5) { // firework spark: fast burst, gravity, fade
    p += aV * age * (1.0 - k * 0.4) + vec3(0.0, -3.5 * age * age, 0.0);
  } else { // smoke / dust: rise and spread
    p += aV * age + vec3(sin(age * 0.8 + aP.x) * 0.4 * k, 0.0, cos(age * 0.7 + aP.z) * 0.4 * k);
  }
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float grow = kind > 1.5 ? (0.4 + k * 1.8) : 1.0;
  gl_PointSize = size * grow * uPx / max(1.0, -mv.z);
  vA = (age < 0.0 || k > 1.0) ? 0.0 : (kind > 1.5 ? sin(k * 3.14159) * 0.55 : 1.0 - k * k);
  vCol = aCol; vKind = kind;
}`
const FS = /* glsl */ `
varying vec3 vCol; varying float vA; varying float vKind;
void main(){
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d);
  float a = vKind < 0.5 ? step(max(abs(d.x), abs(d.y) * 1.8), 0.45) : smoothstep(0.5, 0.1, r);
  a *= vA;
  if (a < 0.02) discard;
  gl_FragColor = vec4(vCol, a);
}`

const CONFETTI = ['#e0483b', '#2f6bff', '#f2c230', '#2f9e66', '#ffffff', '#8b62c9'].map((h) => new THREE.Color(h))

export class FX {
  constructor(world) {
    this.world = world
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3))
    this.aP = new THREE.BufferAttribute(new Float32Array(N * 3), 3)
    this.aV = new THREE.BufferAttribute(new Float32Array(N * 3), 3)
    this.aInfo = new THREE.BufferAttribute(new Float32Array(N * 4).fill(-1000), 4)
    this.aCol = new THREE.BufferAttribute(new Float32Array(N * 3), 3)
    for (const [k, a] of Object.entries({ aP: this.aP, aV: this.aV, aInfo: this.aInfo, aCol: this.aCol })) { a.setUsage(THREE.DynamicDrawUsage); g.setAttribute(k, a) }
    this.uni = { uTime: world.uni.uTime, uPx: { value: innerHeight * 0.9 } }
    this.points = new THREE.Points(g, new THREE.ShaderMaterial({ uniforms: this.uni, vertexShader: VS, fragmentShader: FS, transparent: true, depthWrite: false }))
    this.points.frustumCulled = false
    this.points.renderOrder = 5
    world.scene.add(this.points)
    this.cursor = 0
    this.loopEnd = 0 // [0, loopEnd) reserved for looping emitters
    addEventListener('resize', () => { this.uni.uPx.value = innerHeight * 0.9 })
  }

  now() { return this.world.uni.uTime.value }

  slot() {
    const i = this.loopEnd + (this.cursor++ % (N - this.loopEnd))
    return i
  }

  put(i, p, v, t0, life, kind, size, col) {
    this.aP.setXYZ(i, p[0], p[1], p[2]); this.aV.setXYZ(i, v[0], v[1], v[2])
    this.aInfo.setXYZW(i, t0, life, kind, size); this.aCol.setXYZ(i, col.r, col.g, col.b)
  }

  flush() { for (const a of [this.aP, this.aV, this.aInfo, this.aCol]) a.needsUpdate = true }

  confetti(pos, n = 160) {
    const t = this.now()
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2, s = 1.5 + Math.random() * 3
      this.put(this.slot(), [pos[0], pos[1], pos[2]], [Math.cos(a) * s, 5 + Math.random() * 5, Math.sin(a) * s], t + Math.random() * 0.15, 3 + Math.random(), 0, 0.5 + Math.random() * 0.4, CONFETTI[k % CONFETTI.length])
    }
    this.flush()
  }

  firework(pos, color = '#f2c230', n = 220) {
    const t = this.now() + Math.random() * 0.3
    const c = new THREE.Color(color), w = new THREE.Color('#ffffff')
    const p = [pos[0], pos[1] + 18 + Math.random() * 8, pos[2]]
    for (let k = 0; k < n; k++) {
      const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u), s = 7 + Math.random() * 2
      this.put(this.slot(), p, [r * Math.cos(th) * s, u * s, r * Math.sin(th) * s], t, 1.6 + Math.random() * 0.6, 1, 0.9, k % 5 ? c : w)
    }
    this.flush()
  }

  // looping emitters are rebuilt with the city: smoke over bad districts, dust on dirt tracks
  setEmitters(list) {
    let i = 0
    const t = this.now()
    const smoke = new THREE.Color('#8f8a84'), dust = new THREE.Color('#c9a77c'), stink = new THREE.Color('#9fc23d')
    for (const e of list) {
      const n = e.kind === 'smoke' ? 26 : e.kind === 'stink' ? Math.round(5 + 9 * (e.amt || 0.5)) : 10
      for (let k = 0; k < n && i < 2600; k++, i++) {
        const life = e.kind === 'smoke' ? 7 : e.kind === 'stink' ? 3.2 : 2.4
        const jitter = e.kind !== 'smoke' ? [(Math.random() - 0.5) * 1.6, 0, (Math.random() - 0.5) * 1.6] : [0, 0, 0]
        const vel = e.kind === 'smoke' ? [0.3, 1.6 + Math.random() * 0.5, 0.2] : e.kind === 'stink' ? [(Math.random() - 0.5) * 0.3, 0.9 + Math.random() * 0.4, (Math.random() - 0.5) * 0.3] : [(Math.random() - 0.5) * 0.6, 0.5, (Math.random() - 0.5) * 0.6]
        this.put(i, [e.pos[0] + jitter[0], e.pos[1], e.pos[2] + jitter[2]], vel,
          t - (k / n) * life, life, 2, e.kind === 'smoke' ? 3.2 : e.kind === 'stink' ? 1.1 : 1.6, e.kind === 'smoke' ? smoke : e.kind === 'stink' ? stink : dust)
      }
    }
    for (let k = i; k < this.loopEnd; k++) this.aInfo.setXYZW(k, -1000, 1, 0, 0)
    this.loopEnd = Math.max(i, 1)
    this.flush()
  }
}
