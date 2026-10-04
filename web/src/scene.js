// The world: renderer, sky, sun + soft shadows, ambient occlusion, tilt-shift, strategy-game camera.
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js'
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'

// day and night palettes; `t` (0 day → 1 night) blends between them
export const SKY = {
  day: { zenith: '#7fb6e6', horizon: '#e4eef2', ground: '#c9dcc0', sun: '#fff0d8', hemiSky: '#d7ecff', hemiGround: '#7a9a5a', fog: '#dfeaee' },
  night: { zenith: '#0a1530', horizon: '#2a3a5e', ground: '#16203a', sun: '#9fb4ff', hemiSky: '#5a6ea8', hemiGround: '#1d2636', fog: '#1a2440' },
}

// depth pinned just inside the far plane: exactly 1.0 gets clipped by rounding and punches holes in the sky
const SKY_VS = /* glsl */ `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = vec4(p.xy, p.w * 0.9999, p.w); }`
const SKY_FS = /* glsl */ `
uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uGround; uniform float uNight; uniform float uTime; varying vec3 vDir;
float h(vec3 p){ return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
void main(){
  float y = vDir.y;
  vec3 c = y > 0.0 ? mix(uHorizon, uZenith, pow(clamp(y, 0.0, 1.0), 0.55)) : mix(uHorizon, uGround, clamp(-y * 4.0, 0.0, 1.0));
  // stars at night
  vec3 q = floor(vDir * 420.0);
  float s = step(0.9975, h(q)) * smoothstep(0.05, 0.4, y) * uNight;
  c += vec3(0.9, 0.95, 1.0) * s * (0.6 + 0.4 * sin(uTime * 2.0 + h(q) * 30.0));
  gl_FragColor = vec4(c, 1.0);
}`

// tilt-shift + gentle grade + vignette: the "miniature model" look at metro zoom
const LOOK = {
  uniforms: { tDiffuse: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uTilt: { value: 0 }, uFocus: { value: 0.55 }, uShake: { value: 0 }, uNight: { value: 0 }, uDoc: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: /* glsl */ `
  uniform sampler2D tDiffuse; uniform vec2 uRes; uniform float uTilt; uniform float uFocus; uniform float uShake; uniform float uNight; uniform float uDoc; varying vec2 vUv;
  void main(){
    float band = abs(vUv.y - uFocus);
    float blur = smoothstep(0.16, 0.55, band) * uTilt * (1.0 - uDoc);
    vec3 col = texture2D(tDiffuse, vUv).rgb;
    if (blur > 0.01) {
      vec3 acc = col; float wsum = 1.0;
      for (int i = 0; i < 12; i++) {
        float a = float(i) * 2.39996;
        float r = sqrt(float(i) + 0.5) / 3.5;
        vec2 o = vec2(cos(a), sin(a)) * r * blur * 7.0 / uRes;
        acc += texture2D(tDiffuse, vUv + o).rgb; wsum += 1.0;
      }
      col = acc / wsum;
    }
    vec2 c = vUv - 0.5;
    col *= 1.0 - dot(c, c) * mix(0.42, 0.7, uNight) * (1.0 - uDoc);
    gl_FragColor = vec4(col, 1.0);
  }`,
}

export function createWorld(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: false })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.setSize(innerWidth, innerHeight)
  renderer.toneMapping = THREE.NeutralToneMapping
  renderer.toneMappingExposure = 1.0
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  container.appendChild(renderer.domElement)

  const labels = new CSS2DRenderer()
  labels.setSize(innerWidth, innerHeight)
  labels.domElement.className = 'labels'
  container.appendChild(labels.domElement)
  labels.domElement.addEventListener('wheel', (e) => { e.preventDefault(); renderer.domElement.dispatchEvent(new WheelEvent('wheel', e)) }, { passive: false })

  const scene = new THREE.Scene()
  renderer.setClearColor(SKY.day.horizon)
  scene.fog = new THREE.Fog(new THREE.Color(SKY.day.fog), 400, 2400)

  const camera = new THREE.PerspectiveCamera(34, innerWidth / innerHeight, 0.5, 9000)
  camera.position.set(0, 420, 520)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.minPolarAngle = 0
  controls.maxPolarAngle = Math.PI * 0.43
  controls.minDistance = 7
  controls.maxDistance = 3000
  controls.zoomSpeed = 1.3
  controls.zoomToCursor = true
  controls.screenSpacePanning = false
  // strategy-game mouse: left-drag pans the map, right-drag orbits, wheel zooms
  controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.ROTATE }
  controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE }
  renderer.domElement.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault() })
  renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault())

  // sky dome
  const skyU = { uZenith: { value: new THREE.Color(SKY.day.zenith) }, uHorizon: { value: new THREE.Color(SKY.day.horizon) }, uGround: { value: new THREE.Color(SKY.day.ground) }, uNight: { value: 0 }, uTime: { value: 0 } }
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), new THREE.ShaderMaterial({ uniforms: skyU, vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false, fog: false }))
  sky.frustumCulled = false
  sky.renderOrder = -10
  scene.add(sky)

  const hemi = new THREE.HemisphereLight(SKY.day.hemiSky, SKY.day.hemiGround, 1.35)
  scene.add(hemi)
  const sun = new THREE.DirectionalLight(SKY.day.sun, 3.1)
  sun.castShadow = true
  sun.shadow.mapSize.set(4096, 4096)
  sun.shadow.bias = -0.00025
  sun.shadow.normalBias = 0.35
  sun.shadow.radius = 3
  const SUN_DIR = new THREE.Vector3(-0.55, 0.78, 0.42).normalize() // warm sun from the upper left
  scene.add(sun, sun.target)

  // post: AO → look (tilt-shift, vignette) → tone map → SMAA
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType, samples: 0 }))
  composer.setPixelRatio(renderer.getPixelRatio())
  const renderPass = new RenderPass(scene, camera)
  composer.addPass(renderPass)
  const ao = new GTAOPass(scene, camera, innerWidth, innerHeight)
  ao.output = GTAOPass.OUTPUT.Default
  ao.blendIntensity = 0.85
  ao.updateGtaoMaterial({ radius: 2.2, distanceExponent: 1.6, thickness: 1.5, scale: 1.0, samples: 12 })
  ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 })
  composer.addPass(ao)
  // bloom only at night: lit windows, street lamps and headlights glow (GTA-at-night streaks)
  const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.0, 0.55, 0.82)
  bloom.enabled = false
  composer.addPass(bloom)
  const look = new ShaderPass(LOOK)
  composer.addPass(look)
  composer.addPass(new OutputPass())
  const smaa = new SMAAPass(innerWidth * renderer.getPixelRatio(), innerHeight * renderer.getPixelRatio())
  composer.addPass(smaa)

  // ── camera tween ──
  let tween = null
  function flyTo(target, dist = 60, dur = 1.3, forceDir = null) {
    const t = new THREE.Vector3(...target)
    const dir = forceDir ? new THREE.Vector3(...forceDir) : camera.position.clone().sub(controls.target)
    if (dir.lengthSq() < 1e-6) dir.set(0, 1, 1)
    dir.normalize()
    if (!forceDir && dir.y < 0.55) { dir.y = 0.55; dir.normalize() }
    tween = { t0: performance.now(), dur: dur * 1000, fromT: controls.target.clone(), toT: t, fromP: camera.position.clone(), toP: t.clone().add(dir.multiplyScalar(dist)) }
  }
  let shift = 0, shiftTarget = 0
  const setFrameShift = (px) => { shiftTarget = px }
  let extent = 300
  function setExtent(e) { extent = e; controls.maxDistance = Math.max(800, e * 4.2) }
  function topView(dur = 1.4) {
    const fit = (extent * 1.08) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / Math.min(1, camera.aspect)
    flyTo([0, 0, 0], fit, dur, [0, 1, 0.0001])
  }
  let shakeAmt = 0
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches
  const shake = (a = 1) => { if (!calm) shakeAmt = Math.min(2, shakeAmt + a) }
  const scan = () => {}
  let lastInput = performance.now()
  const touch = () => { lastInput = performance.now(); tween = null; idleCam = null; if (follow) { follow = null; onFollowEnd?.() } }
  let onFollowEnd = null
  renderer.domElement.addEventListener('pointerdown', touch)
  renderer.domElement.addEventListener('wheel', touch, { passive: true })
  // WASD pan (shift = fast), Q/E orbit
  const keys = new Set()
  let fast = false
  addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.metaKey || e.ctrlKey || e.altKey || !document.body.classList.contains('on') || document.body.classList.contains('admin') || document.body.classList.contains('setup')) return
    const k = e.key.toLowerCase()
    fast = e.shiftKey
    if (k === 'd' && window.__hex?.view?.sel?.type === 'module') return // D = demolition preview on a selected building
    if (k.length === 1 && 'wasdqe'.includes(k)) keys.add(k)
  })
  addEventListener('keyup', (e) => { keys.delete(e.key.toLowerCase()); fast = e.shiftKey })
  addEventListener('blur', () => keys.clear())
  const _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _mv = new THREE.Vector3(), _off = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0)

  // follow mode (chopper cam): fn() → { pos, look } every frame; any input hands control back
  let follow = null
  const setFollow = (fn) => { follow = fn; tween = null }
  // news-chopper idle camera: hands are off for a while → drift between points of interest
  let idleCam = null
  let poiFn = null
  const setPoi = (fn) => { poiFn = fn }

  let night = 0, nightTarget = 0
  const setNight = (on) => { nightTarget = on ? 1 : 0 }
  let docOn = false
  const C1 = new THREE.Color(), C2 = new THREE.Color()
  const mixc = (key, t) => C1.set(SKY.day[key]).lerp(C2.set(SKY.night[key]), t)
  // bad weather greys the sky and dims the sun (0 = clear … 0.5 = storm)
  let gloom = 0
  const setGloom = (g) => { gloom = docOn ? 0 : g }
  const GREY = new THREE.Color('#7f8c99'), GREY2 = new THREE.Color('#b9c2c9')
  const uni = { uTime: { value: 0 }, uNight: { value: 0 }, uDoc: { value: 0 }, uLens: { value: 0 } } // shared with city materials

  const maxPR = Math.min(devicePixelRatio, 2)
  let pr = maxPR, frames = 0, acc = 0, work = 0, slow = 0
  // adapt resolution to how long our own frames take (not to rAF rate, which throttles in background tabs)
  function adapt(dt, ms) {
    if (document.hidden) return
    frames++; acc += dt; work += ms
    if (acc < 1.5) return
    const avg = work / frames
    frames = 0; acc = 0; work = 0
    slow = avg > 22 ? slow + 1 : avg < 9 ? slow - 1 : 0
    let next = pr
    if (slow >= 2) { next = Math.max(1, pr - 0.25); slow = 0 }
    else if (slow <= -3) { next = Math.min(maxPR, pr + 0.25); slow = 0 }
    if (next !== pr) {
      pr = next
      renderer.setPixelRatio(pr); composer.setPixelRatio(pr)
      renderer.setSize(innerWidth, innerHeight); composer.setSize(innerWidth, innerHeight)
    }
  }

  function tick(time, dt) {
    const t0 = performance.now()
    if (tween) {
      const k = Math.min(1, (performance.now() - tween.t0) / tween.dur)
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2
      controls.target.lerpVectors(tween.fromT, tween.toT, e)
      camera.position.lerpVectors(tween.fromP, tween.toP, e)
      if (k >= 1) tween = null
    }
    if (keys.size) {
      tween = null; idleCam = null
      if (follow) { follow = null; onFollowEnd?.() }
      lastInput = performance.now()
      const dist = camera.position.distanceTo(controls.target)
      _fwd.set(0, 1, 0).applyQuaternion(camera.quaternion).setY(0)
      if (_fwd.lengthSq() < 1e-6) _fwd.subVectors(controls.target, camera.position).setY(0)
      _fwd.normalize()
      _right.set(1, 0, 0).applyQuaternion(camera.quaternion).setY(0).normalize()
      const f = (keys.has('w') ? 1 : 0) - (keys.has('s') ? 1 : 0), r = (keys.has('d') ? 1 : 0) - (keys.has('a') ? 1 : 0)
      if (f || r) {
        _mv.copy(_fwd).multiplyScalar(f).addScaledVector(_right, r).normalize().multiplyScalar(Math.max(8, dist) * 0.8 * dt * (fast ? 3 : 1))
        camera.position.add(_mv); controls.target.add(_mv)
      }
      const q = (keys.has('q') ? 1 : 0) - (keys.has('e') ? 1 : 0)
      if (q) { _off.subVectors(camera.position, controls.target).applyAxisAngle(Y, q * dt * 1.4); camera.position.copy(controls.target).add(_off) }
    }
    // idle → chopper drifts to the next point of interest and slowly circles it
    if (follow) {
      const f = follow()
      if (f) {
        const k = Math.min(1, dt * 7)
        camera.position.lerp(f.pos, k)
        controls.target.lerp(f.look, k)
      }
    } else if (!calm && !tween && performance.now() - lastInput > 30000 && document.body.classList.contains('on') && poiFn) {
      if (!idleCam || time > idleCam.until) {
        const p = poiFn()
        if (p) { flyTo(p.pos, p.dist || 70, 4); idleCam = { until: time + 16 } }
        else idleCam = { until: time + 10 }
      }
      _off.subVectors(camera.position, controls.target).applyAxisAngle(Y, dt * 0.06)
      camera.position.copy(controls.target).add(_off)
    }
    controls.update()
    // keep the camera above the ground
    if (camera.position.y < 3) camera.position.y = 3
    if (Math.abs(shiftTarget - shift) > 0.3 || (shift !== 0 && !camera.view)) {
      shift += (shiftTarget - shift) * Math.min(1, dt * 6)
      if (Math.abs(shift) < 0.5 && Math.abs(shiftTarget) < 0.5) { shift = 0; camera.clearViewOffset() }
      else camera.setViewOffset(innerWidth, innerHeight, shift, 0, innerWidth, innerHeight)
    }
    const dist = camera.position.distanceTo(controls.target)
    const near = THREE.MathUtils.clamp(dist * 0.01, 0.3, 30)
    const far = dist * 5 + 3000
    if (Math.abs(near - camera.near) / camera.near > 0.1 || Math.abs(far - camera.far) / camera.far > 0.1) {
      camera.near = near; camera.far = far; camera.updateProjectionMatrix()
    }
    sky.position.copy(camera.position)
    sky.scale.setScalar(camera.far * 0.9)
    // day / night
    night += (nightTarget - night) * Math.min(1, dt * 1.2)
    const n = docOn ? 0 : night
    uni.uNight.value = n
    uni.uTime.value = time
    skyU.uZenith.value.copy(mixc('zenith', n)).lerp(GREY, gloom * (1 - n)); skyU.uHorizon.value.copy(mixc('horizon', n)).lerp(GREY2, gloom * 0.7 * (1 - n)); skyU.uGround.value.copy(mixc('ground', n))
    skyU.uNight.value = n; skyU.uTime.value = time
    hemi.color.copy(mixc('hemiSky', n)); hemi.groundColor.copy(mixc('hemiGround', n))
    hemi.intensity = THREE.MathUtils.lerp(docOn ? 2.2 : 1.35, 0.95, n)
    sun.color.copy(mixc('sun', n))
    sun.intensity = THREE.MathUtils.lerp(docOn ? 1.2 : 3.1 * (1 - gloom * 0.55), 0.55, n)
    bloom.enabled = n > 0.03
    bloom.strength = n * 0.85
    scene.fog.color.copy(mixc('fog', n))
    renderer.setClearColor(scene.fog.color)
    scene.fog.near = dist * 2.2 + 250
    scene.fog.far = dist * 7 + 1500
    // the sun's shadow box follows the camera target, sized to what's on screen, snapped to texels
    const S = THREE.MathUtils.clamp(dist * 0.85, 30, 900)
    const cam = sun.shadow.camera
    if (Math.abs(cam.right - S) / S > 0.08) {
      cam.left = -S; cam.right = S; cam.top = S; cam.bottom = -S
      cam.near = 1; cam.far = S * 4 + 200
      cam.updateProjectionMatrix()
    }
    const texel = (2 * S) / sun.shadow.mapSize.x
    const tx = Math.round(controls.target.x / texel) * texel, tz = Math.round(controls.target.z / texel) * texel
    sun.target.position.set(tx, 0, tz)
    sun.position.set(tx, 0, tz).addScaledVector(SUN_DIR, S * 2 + 100)
    // tilt-shift only when looking at the city from above at some distance
    const pol = controls.getPolarAngle()
    look.uniforms.uTilt.value = THREE.MathUtils.clamp((dist - 60) / 260, 0, 1) * THREE.MathUtils.clamp((pol - 0.25) / 0.5, 0, 1) * 0.9
    look.uniforms.uNight.value = n
    look.uniforms.uDoc.value = docOn ? 1 : 0
    ao.enabled = dist < 520 && !docOn
    const off = new THREE.Vector3()
    if (shakeAmt > 0.001) {
      off.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(shakeAmt * Math.min(2.5, dist * 0.012))
      camera.position.add(off)
      shakeAmt *= Math.pow(0.02, dt)
    }
    composer.render()
    labels.render(scene, camera)
    camera.position.sub(off)
    adapt(dt, performance.now() - t0)
  }

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight
    if (shift) camera.setViewOffset(innerWidth, innerHeight, shift, 0, innerWidth, innerHeight)
    camera.updateProjectionMatrix()
    renderer.setSize(innerWidth, innerHeight)
    composer.setSize(innerWidth, innerHeight)
    ao.setSize(innerWidth, innerHeight)
    bloom.setSize(innerWidth, innerHeight)
    look.uniforms.uRes.value.set(innerWidth, innerHeight)
    labels.setSize(innerWidth, innerHeight)
  })
  look.uniforms.uRes.value.set(innerWidth, innerHeight)

  function setDoc(on) { docOn = on; uni.uDoc.value = on ? 1 : 0 }

  return { setFollow, set onFollowEnd(f) { onFollowEnd = f }, get following() { return !!follow }, setGloom, sky, pixelRatio: () => pr, bloom, lastInput: () => lastInput, renderer, scene, camera, controls, flyTo, topView, setExtent, setDoc, setNight, shake, scan, tick, composer, setFrameShift, sun, hemi, ao, look, uni, setPoi, get night() { return night } }
}
