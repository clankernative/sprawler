import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'

const FLOOR_VS = /* glsl */ `
varying vec3 vW;
void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`

const FLOOR_FS = /* glsl */ `
uniform float uTime; uniform float uScan; uniform float uExtent; uniform float uDoc;
#define MAXT 8
#define MAXG 64
// tier zones, tier ring lines and island glows are drawn HERE, not as coplanar meshes (those z-fought the floor)
uniform vec2 uTierR[MAXT]; uniform vec3 uTierC[MAXT]; uniform float uTierN;
uniform vec4 uGlow[MAXG]; uniform vec3 uGlowC[MAXG]; uniform float uGlowN;
uniform float uZoneOp; uniform float uLineOp;
varying vec3 vW;
float hexDist(vec2 p){ p = abs(p); return max(dot(p, normalize(vec2(1.0,1.732))), p.x); }
vec4 hexCoords(vec2 uv){
  vec2 r = vec2(1.0,1.732); vec2 h = r*0.5;
  vec2 a = mod(uv, r) - h; vec2 b = mod(uv - h, r) - h;
  vec2 gv = dot(a,a) < dot(b,b) ? a : b;
  return vec4(gv, uv - gv);
}
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
void main(){
  vec2 uv = vW.xz / 7.0;
  vec4 hc = hexCoords(uv);
  float d = hexDist(hc.xy);
  float fw = fwidth(d);
  float far = 1.0 - smoothstep(0.03, 0.14, fw); // fade grid where cells shrink below a few pixels (kills moire)
  float line = smoothstep(0.5 - fw * 1.8 - 0.004, 0.5, d) * far;
  float dist = length(vW.xz);
  float fade = 1.0 - smoothstep(uExtent*0.6, uExtent*2.2, dist);
  float tw = step(0.985, hash(hc.zw)) * (0.5 + 0.5*sin(uTime*0.8 + hash(hc.zw)*40.0)) * far;
  vec3 base = vec3(0.0012,0.0025,0.005);
  vec3 col = base + vec3(0.02,0.16,0.24) * line * 0.14 * fade + vec3(0.1,0.8,1.0) * tw * 0.12 * fade;
  // concentric pulse + scan wave
  float pulse = smoothstep(2.0, 0.0, abs(mod(dist - uTime*6.0, 140.0) - 70.0)) * 0.05 * fade;
  float scan = smoothstep(6.0, 0.0, abs(dist - uScan)) * step(0.0, uScan);
  col += vec3(0.1,0.9,1.0) * (pulse + scan * (0.35 + line*0.9));
  // document mode: warm paper with a faint dot grid at hex centres
  vec3 paper = vec3(0.84, 0.79, 0.69);
  float dotg = 1.0 - smoothstep(0.045, 0.075 + fw, length(hc.xy));
  vec3 doc = paper - vec3(0.2, 0.19, 0.17) * dotg * far * 0.5 - vec3(0.06) * line * 0.6;
  float fd = fwidth(dist);
  for (int i = 0; i < MAXT; i++) {
    if (float(i) >= uTierN) break;
    vec2 r = uTierR[i];
    float inside = step(r.x, dist) * step(dist, r.y);
    float ln = 1.0 - smoothstep(0.0, fd * 1.5 + 0.02, abs(dist - r.y));
    col += uTierC[i] * (inside * uZoneOp + ln * uLineOp);
    doc = mix(doc, uTierC[i], inside * uZoneOp);
    doc = mix(doc, vec3(0.12, 0.15, 0.19), ln * uLineOp);
  }
  for (int i = 0; i < MAXG; i++) {
    if (float(i) >= uGlowN) break;
    vec4 g = uGlow[i];
    float gd = length(vW.xz - g.xy) / (g.z * 1.8);
    col += uGlowC[i] * pow(max(0.0, 1.0 - gd), 2.4) * g.w * 0.4;
  }
  gl_FragColor = vec4(mix(col, doc, uDoc), 1.0);
}`

const FX = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uShake: { value: 0 }, uDoc: { value: 0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: /* glsl */ `
  uniform sampler2D tDiffuse; uniform float uTime; uniform float uShake; uniform float uDoc; varying vec2 vUv;
  float h(vec2 p){ return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453); }
  void main(){
    vec2 c = vUv - 0.5; float d = length(c);
    float ab = (0.0005 + d*0.0012) * (1.0 - uDoc) + uShake*0.01;
    vec3 col;
    col.r = texture2D(tDiffuse, vUv + c*ab).r;
    col.g = texture2D(tDiffuse, vUv).g;
    col.b = texture2D(tDiffuse, vUv - c*ab).b;
    col *= 1.0 - smoothstep(0.35, 0.9, d) * 0.75 * (1.0 - uDoc * 0.85);

    gl_FragColor = vec4(col, 1.0);
  }`,
}

export function createWorld(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.setSize(innerWidth, innerHeight)
  renderer.toneMapping = THREE.NoToneMapping
  container.appendChild(renderer.domElement)

  const labels = new CSS2DRenderer()
  labels.setSize(innerWidth, innerHeight)
  labels.domElement.className = 'labels'
  container.appendChild(labels.domElement)
  // clickable labels sit above the canvas; never let them swallow zoom
  labels.domElement.addEventListener('wheel', (e) => {
    e.preventDefault()
    renderer.domElement.dispatchEvent(new WheelEvent('wheel', e))
  }, { passive: false })

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x02050a)
  scene.fog = new THREE.FogExp2(0x02050a, 0.0022)

  const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.2, 12000)
  camera.position.set(0, 260, 320)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.07
  controls.minPolarAngle = 0 // straight down is allowed
  controls.maxPolarAngle = Math.PI * 0.49
  controls.minDistance = 1.5
  controls.maxDistance = 4000
  controls.zoomSpeed = 1.4
  controls.zoomToCursor = true
  controls.screenSpacePanning = false
  // left orbit · middle-drag pan · right-drag pan · wheel zoom
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN }
  renderer.domElement.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault() }) // no autoscroll

  // softer three-point rig: warm key, cool rim, sky/ground fill
  const amb = new THREE.AmbientLight(0x6688aa, 0.7)
  scene.add(amb)
  const sun = new THREE.DirectionalLight(0xfff1dc, 1.25)
  sun.position.set(80, 200, 120)
  scene.add(sun)
  const rimL = new THREE.DirectionalLight(0x4cc9ff, 0.55)
  rimL.position.set(-140, 70, -180)
  scene.add(rimL)
  const hemi = new THREE.HemisphereLight(0x4cc9ff, 0x100818, 0.6)
  scene.add(hemi)

  const floorU = {
    uTime: { value: 0 }, uScan: { value: -1 }, uExtent: { value: 300 }, uDoc: { value: 0 },
    uTierR: { value: Array.from({ length: 8 }, () => new THREE.Vector2()) }, uTierC: { value: Array.from({ length: 8 }, () => new THREE.Color()) }, uTierN: { value: 0 },
    uGlow: { value: Array.from({ length: 64 }, () => new THREE.Vector4()) }, uGlowC: { value: Array.from({ length: 64 }, () => new THREE.Color()) }, uGlowN: { value: 0 },
    uZoneOp: { value: 0 }, uLineOp: { value: 0 },
  }
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(40000, 40000),
    new THREE.ShaderMaterial({ uniforms: floorU, vertexShader: FLOOR_VS, fragmentShader: FLOOR_FS, fog: false }),
  )
  floor.rotation.x = -Math.PI / 2
  floor.position.y = -0.62 // below every slab bottom and well clear of the ground zones (no z-fighting)
  scene.add(floor)

  const starG = new THREE.BufferGeometry()
  const sp = new Float32Array(3000 * 3)
  for (let i = 0; i < 3000; i++) {
    const u = Math.random() * 2 - 1, t = Math.random() * Math.PI * 2, r = 1800 + Math.random() * 1500
    const s = Math.sqrt(1 - u * u)
    sp[i * 3] = s * Math.cos(t) * r
    sp[i * 3 + 1] = Math.abs(u) * r * 0.8 + 50
    sp[i * 3 + 2] = s * Math.sin(t) * r
  }
  starG.setAttribute('position', new THREE.BufferAttribute(sp, 3))
  const stars = new THREE.Points(starG, new THREE.PointsMaterial({ color: 0x9fd8ff, size: 2.2, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.7 }))
  scene.add(stars)

  // MSAA target: without it the composer renders aliased, and thin lines crawl when anything moves
  const rt = new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType, samples: 4 })
  const composer = new EffectComposer(renderer, rt)
  composer.setPixelRatio(renderer.getPixelRatio())
  composer.addPass(new RenderPass(scene, camera))
  // guard: one NaN/Inf or huge additive pixel makes bloom smear black blocks on some GPUs — clean before bloom
  const sanitize = new ShaderPass({
    uniforms: { tDiffuse: { value: null } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
    void main(){ vec3 c = texture2D(tDiffuse, vUv).rgb;
      if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
      gl_FragColor = vec4(clamp(c, 0.0, 16.0), 1.0); }`,
  })
  composer.addPass(sanitize)
  const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.7, 0.4, 0.62)
  composer.addPass(bloom)
  composer.addPass(new OutputPass())
  const fx = new ShaderPass(FX)
  composer.addPass(fx)

  // camera tween
  let tween = null
  function flyTo(target, dist = 60, dur = 1.3, forceDir = null) {
    const t = new THREE.Vector3(...target)
    const dir = forceDir ? new THREE.Vector3(...forceDir) : camera.position.clone().sub(controls.target)
    if (dir.lengthSq() < 1e-6) dir.set(0, 1, 1)
    dir.normalize()
    if (!forceDir && dir.y < 0.45) { dir.y = 0.45; dir.normalize() }
    tween = { t0: performance.now(), dur: dur * 1000, fromT: controls.target.clone(), toT: t, fromP: camera.position.clone(), toP: t.clone().add(dir.multiplyScalar(dist)) }
  }
  // frame shift: slide the projection so "centre" means the gap between open panels, not the window middle
  let shift = 0, shiftTarget = 0
  const setFrameShift = (px) => { shiftTarget = px }
  const PAPER = new THREE.Color('#ece6d8'), NIGHT = new THREE.Color(0x02050a)
  let docOn = false
  let extent = 300
  function setExtent(e) {
    extent = e
    controls.maxDistance = Math.max(1500, e * 9)
  }
  // whole network, straight down; fits the map's diameter into the vertical FOV
  function topView(dur = 1.4) {
    const fit = (extent * 1.15) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / Math.min(1, camera.aspect)
    flyTo([0, 0, 0], fit, dur, [0, 1, 0.0001])
  }
  let shakeAmt = 0
  const shake = (a = 1) => { shakeAmt = Math.min(2, shakeAmt + a) }
  let scanT = -1
  const scan = () => { scanT = 0 }
  let lastInput = performance.now()
  // any click, scroll or key anywhere pauses the slow auto-rotation; it resumes after IDLE_MS of no input
  const IDLE_MS = 60000
  const pause = () => { lastInput = performance.now(); controls.autoRotate = false }
  renderer.domElement.addEventListener('pointerdown', () => { tween = null })
  renderer.domElement.addEventListener('wheel', () => { tween = null }, { passive: true })
  for (const ev of ['pointerdown', 'wheel', 'keydown']) addEventListener(ev, pause, { capture: true, passive: true })
  controls.autoRotateSpeed = 0.25
  // WASD fly (shift = fast), Q/E orbit
  const keys = new Set()
  let fast = false
  addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.metaKey || e.ctrlKey || e.altKey || !document.body.classList.contains('on') || document.body.classList.contains('admin') || document.body.classList.contains('setup')) return
    const k = e.key.toLowerCase()
    fast = e.shiftKey
    if (k.length === 1 && 'wasdqe'.includes(k)) keys.add(k)
  })
  addEventListener('keyup', (e) => { keys.delete(e.key.toLowerCase()); fast = e.shiftKey })
  addEventListener('blur', () => keys.clear())
  const _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _mv = new THREE.Vector3(), _off = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0)

  function tick(time, dt) {
    if (tween) {
      const k = Math.min(1, (performance.now() - tween.t0) / tween.dur)
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2
      controls.target.lerpVectors(tween.fromT, tween.toT, e)
      camera.position.lerpVectors(tween.fromP, tween.toP, e)
      if (k >= 1) tween = null
    }
    if (keys.size) {
      tween = null
      controls.autoRotate = false
      lastInput = performance.now()
      const dist = camera.position.distanceTo(controls.target)
      // screen-up projected on the ground = forward, works tilted and straight down
      _fwd.set(0, 1, 0).applyQuaternion(camera.quaternion).setY(0)
      if (_fwd.lengthSq() < 1e-6) _fwd.subVectors(controls.target, camera.position).setY(0)
      _fwd.normalize()
      _right.set(1, 0, 0).applyQuaternion(camera.quaternion).setY(0).normalize()
      const f = (keys.has('w') ? 1 : 0) - (keys.has('s') ? 1 : 0), r = (keys.has('d') ? 1 : 0) - (keys.has('a') ? 1 : 0)
      if (f || r) {
        _mv.copy(_fwd).multiplyScalar(f).addScaledVector(_right, r).normalize().multiplyScalar(Math.max(8, dist) * 0.9 * dt * (fast ? 3 : 1))
        camera.position.add(_mv)
        controls.target.add(_mv)
      }
      const q = (keys.has('q') ? 1 : 0) - (keys.has('e') ? 1 : 0)
      if (q) {
        _off.subVectors(camera.position, controls.target).applyAxisAngle(Y, q * dt * 1.6)
        camera.position.copy(controls.target).add(_off)
      }
    }
    if (performance.now() - lastInput > IDLE_MS && !tween) controls.autoRotate = true
    controls.update()
    if (Math.abs(shiftTarget - shift) > 0.3 || (shift !== 0 && !camera.view)) {
      shift += (shiftTarget - shift) * Math.min(1, dt * 6)
      if (Math.abs(shift) < 0.5 && Math.abs(shiftTarget) < 0.5) { shift = 0; camera.clearViewOffset() }
      else camera.setViewOffset(innerWidth, innerHeight, shift, 0, innerWidth, innerHeight)
    }
    // distance-aware depth range + fog, so far zoom stays crisp and visible
    const dist = camera.position.distanceTo(controls.target)
    const near = THREE.MathUtils.clamp(dist * 0.004, 0.05, 20)
    const far = dist * 6 + 4000
    if (Math.abs(near - camera.near) / camera.near > 0.1 || Math.abs(far - camera.far) / camera.far > 0.1) {
      camera.near = near
      camera.far = far
      camera.updateProjectionMatrix()
    }
    scene.fog.density = (docOn ? 0.08 : 0.3) / Math.max(60, dist)
    stars.position.copy(camera.position)
    const off = new THREE.Vector3()
    if (shakeAmt > 0.001) {
      off.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(shakeAmt * 1.6)
      camera.position.add(off)
      shakeAmt *= Math.pow(0.02, dt)
    }
    if (scanT >= 0) {
      scanT += dt
      floorU.uScan.value = scanT * 420
      if (scanT > 4) { scanT = -1; floorU.uScan.value = -1 }
    }
    floorU.uTime.value = time
    fx.uniforms.uTime.value = time
    fx.uniforms.uShake.value = shakeAmt
    stars.rotation.y = time * 0.004
    composer.render()
    labels.render(scene, camera)
    camera.position.sub(off)
  }

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight
    if (shift) camera.setViewOffset(innerWidth, innerHeight, shift, 0, innerWidth, innerHeight)
    camera.updateProjectionMatrix()
    renderer.setSize(innerWidth, innerHeight)
    composer.setSize(innerWidth, innerHeight)
    labels.setSize(innerWidth, innerHeight)
  })

  function setDoc(on) {
    docOn = on
    scene.background.copy(on ? PAPER : NIGHT)
    scene.fog.color.copy(on ? PAPER : NIGHT)
    floorU.uDoc.value = on ? 1 : 0
    fx.uniforms.uDoc.value = on ? 1 : 0
    bloom.enabled = !on
    stars.visible = !on
    amb.intensity = on ? 1.5 : 0.7
    hemi.intensity = on ? 0.9 : 0.6
    rimL.intensity = on ? 0.2 : 0.55
  }

  return { renderer, scene, camera, controls, flyTo, topView, setExtent, setDoc, shake, scan, tick, floorU, bloom, composer, floor, stars, setFrameShift, fx, sanitize, rt }
}
