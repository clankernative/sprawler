// The river between the platform's two banks. Road bridges where highways cross it; one named bridge per
// contract seam — intact when in sync, collapsed mid-span when a kind is never handled (fails at runtime),
// a bridge to nowhere when a handler has nothing to handle.
import * as THREE from 'three'
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { kitMesh, part } from './kit.js'

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const _M = new THREE.Matrix4(), _Q = new THREE.Quaternion(), _P = new THREE.Vector3(), _S = new THREE.Vector3(), _Y = new THREE.Vector3(0, 1, 0), _X = new THREE.Vector3(1, 0, 0)

function strip(pts, w) {
  const pos = [], uv = [], idx = []
  let L = 0
  for (let i = 0; i < pts.length; i++) {
    if (i) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)]
    const tx = b[0] - a[0], tz = b[1] - a[1], tl = Math.hypot(tx, tz) || 1
    const nx = -tz / tl, nz = tx / tl
    pos.push(pts[i][0] + nx * w / 2, 0, pts[i][1] + nz * w / 2, pts[i][0] - nx * w / 2, 0, pts[i][1] - nz * w / 2)
    uv.push(-1, L, 1, L)
    if (i < pts.length - 1) { const j = i * 2; idx.push(j, j + 2, j + 1, j + 1, j + 2, j + 3) }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('aUV', new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  const nrm = new Float32Array(pos.length)
  for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
  return g
}

export function buildRiver(view, uni) {
  const R = view.plan.river
  if (!R) return null
  const group = new THREE.Group()
  // sandy banks, then the water
  const bankMat = new THREE.MeshStandardMaterial({ color: '#cdb98d', roughness: 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })
  const bank = new THREE.Mesh(strip(R.pts, R.w + 3.2), bankMat)
  bank.position.y = 0.03
  bank.receiveShadow = true
  group.add(bank)
  const waterMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.25, metalness: 0.0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
  waterMat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uni.uTime
    sh.uniforms.uNight = uni.uNight
    sh.uniforms.uDoc = uni.uDoc
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec2 aUV; varying vec2 vUV2; varying vec3 vWw;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvUV2 = aUV;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWw = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
uniform float uTime; uniform float uNight; uniform float uDoc; varying vec2 vUV2; varying vec3 vWw;
float wh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float wn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(wh(i), wh(i+vec2(1,0)), f.x), mix(wh(i+vec2(0,1)), wh(i+vec2(1,1)), f.x), f.y); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
    float u = abs(vUV2.x);
    float flow = vUV2.y * 0.35 - uTime * 0.6;
    float rip = wn(vec2(flow, vUV2.x * 3.0)) * 0.6 + wn(vec2(flow * 2.3, vUV2.x * 7.0 + 3.0)) * 0.4;
    vec3 deep = vec3(0.22, 0.52, 0.72), shallow = vec3(0.45, 0.74, 0.86);
    vec3 c = mix(deep, shallow, smoothstep(0.2, 1.0, u) * 0.8 + rip * 0.25);
    c = mix(c, vec3(0.92, 0.96, 0.97), smoothstep(0.82, 0.97, u) * (0.55 + 0.45 * sin(vUV2.y * 0.8 + uTime * 1.5)));
    c += vec3(1.0) * step(0.985, wh(floor(vWw.xz * 3.0) + floor(uTime * 2.0))) * (1.0 - u) * 0.35 * (1.0 - uNight);
    c = mix(c, vec3(0.78, 0.86, 0.9), uDoc * 0.8);
    diffuseColor.rgb = pow(c, vec3(2.2));`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
    totalEmissiveRadiance += vec3(0.25, 0.4, 0.7) * uNight * 0.05 * (0.5 + rip);`)
  }
  waterMat.customProgramCacheKey = () => 'water-v1'
  const water = new THREE.Mesh(strip(R.pts, R.w), waterMat)
  water.position.y = 0.045
  water.receiveShadow = true
  group.add(water)

  // road bridges over every crossing: deck flush with the road, railings either side
  const span = part('bridge_span')
  const deckY = 0.07 - Math.min(0.35, (span.box.max.y - span.box.min.y) * 0.35)
  const len = R.w + 5
  const roadB = kitMesh('bridge_span', R.crossings.length, view.mat)
  R.crossings.forEach((c, i) => {
    _Q.setFromAxisAngle(_Y, c.ang - Math.PI / 2)
    const wide = c.cls === 'connector' ? 1.25 : 1.05
    _M.compose(_P.set(c.x, deckY, c.z), _Q, _S.set(len / 8, 1, wide))
    roadB.setMatrixAt(i, _M)
  })
  roadB.instanceMatrix.needsUpdate = true
  roadB.computeBoundingSphere()
  group.add(roadB)

  // seam bridges: whole, collapsed (two tilted halves with the gap in the middle of the river), or half
  const halves = []
  const whole = []
  for (const b of R.bridges) {
    if (b.status === 'ok') whole.push(b)
    else if (b.status === 'bad') { halves.push({ b, side: -1, drop: true }); halves.push({ b, side: 1, drop: true }) }
    else halves.push({ b, side: -1, drop: false })
  }
  const seamWhole = kitMesh('bridge_span', whole.length, view.mat)
  const seamHalf = kitMesh('bridge_span', halves.length, view.mat)
  const pierM = kitMesh('bridge_pier', R.bridges.length * 2, view.mat)
  seamWhole.userData.seams = whole.map((b) => b.id)
  seamHalf.userData.seams = halves.map((h) => h.b.id)
  const L2 = R.w + 6
  whole.forEach((b, i) => {
    _Q.setFromAxisAngle(_Y, b.ang - Math.PI / 2)
    _M.compose(_P.set(b.x, 0.45, b.z), _Q, _S.set(L2 / 8, 1.2, 0.7))
    seamWhole.setMatrixAt(i, _M)
    seamWhole.geometry.attributes.iTint.setXYZ(i, 0.62, 0.86, 0.7)
  })
  halves.forEach((h, i) => {
    const b = h.b
    const dir = [Math.sin(b.ang), Math.cos(b.ang)]
    const off = (L2 / 4) * h.side
    const tilt = h.drop ? 0.32 * -h.side : 0
    const q2 = new THREE.Quaternion().setFromAxisAngle(_Y, b.ang - Math.PI / 2)
    _Q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), tilt)
    q2.multiply(_Q)
    _M.compose(_P.set(b.x + dir[0] * off, h.drop ? 0.1 : 0.45, b.z + dir[1] * off), q2, _S.set(L2 / 16 * 0.92, 1.2, 0.7))
    seamHalf.setMatrixAt(i, _M)
    seamHalf.geometry.attributes.iTint.setXYZ(i, h.drop ? 0.95 : 1.0, h.drop ? 0.55 : 0.8, h.drop ? 0.5 : 0.45)
  })
  R.bridges.forEach((b, i) => {
    const dir = [Math.sin(b.ang), Math.cos(b.ang)]
    for (const s of [-1, 1]) {
      _Q.setFromAxisAngle(_Y, b.ang)
      _M.compose(_P.set(b.x + dir[0] * s * (R.w / 2 + 1.6), 0.6, b.z + dir[1] * s * (R.w / 2 + 1.6)), _Q, _S.set(0.6, 0.3, 0.6))
      pierM.setMatrixAt(i * 2 + (s > 0 ? 1 : 0), _M)
    }
  })
  for (const m of [seamWhole, seamHalf, pierM]) {
    m.instanceMatrix.needsUpdate = true
    m.geometry.attributes.iTint.needsUpdate = true
    m.computeBoundingSphere()
    group.add(m)
  }
  // labels
  const labels = []
  for (const b of R.bridges) {
    const el = document.createElement('div')
    el.className = 'slabel ' + b.status
    el.innerHTML = `<b>⇄ ${esc(b.id)}</b><span class="ok">${b.ok}✓</span>${b.bad ? `<span class="bad">${b.bad}✕ out</span>` : ''}${b.dead ? `<span class="dead">${b.dead}◌</span>` : ''}`
    el.addEventListener('click', (e) => { e.stopPropagation(); view.onSeamClick?.(b.id) })
    const lab = new CSS2DObject(el)
    lab.position.set(b.x, 3.2, b.z)
    group.add(lab)
    labels.push({ el, lab, b })
  }
  return { group, pick: [seamWhole, seamHalf], labels }
}
