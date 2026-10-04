// Traffic: one vehicle per dependency, animated entirely on the GPU.
// Routes live in a float texture (x, z, cumulative travel time, road flag). Each car has up to three
// pieces (local streets → highway/dirt track → local streets); shared pieces are stored once.
// A car drives source → target → back again; it keeps right, so the two directions use two lanes.
import * as THREE from 'three'
import { ROAD } from './plan.js'
import { part } from './kit.js'

const W = 2048
const FLAG = { street: 0, spoke: 0, outer: 0, drive: 0, ring: 1, connector: 1, arterial: 1, dirt: 2, path: 3 }
// muted real-world paint: mostly whites, silvers and greys — colour is for meaning
const PAINT = ['#f4f4f2', '#eceae6', '#d9dde2', '#c4cad1', '#a9b2bc', '#8a96a3', '#6c7681', '#4d5661', '#d9cfbd', '#b9c7d2', '#9fb0a2'].map((h) => new THREE.Color(h))
const RED = new THREE.Color('#e8483b')

export function buildTraffic(plan, atlas, uni) {
  // pack route pieces
  const data = []
  const shared = new Map()
  const pushPiece = (p) => {
    if (p.shared && shared.has(p.shared)) return shared.get(p.shared)
    const pts = p.pts
    const speed = (ROAD[p.cls] || ROAD.street).v
    const flag = FLAG[p.cls] ?? 0
    const start = data.length / 4
    let t = 0
    for (let i = 0; i < pts.length; i++) {
      if (i) t += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]) / speed
      data.push(pts[i][0], pts[i][1], t, flag)
    }
    const r = { start, count: pts.length, T: Math.max(0.01, t) }
    if (p.shared) shared.set(p.shared, r)
    return r
  }
  const cars = []
  plan.routes.forEach((r, i) => {
    if (!r) return
    const ps = r.pieces.map(pushPiece)
    while (ps.length < 3) ps.push({ start: 0, count: 0, T: 0 })
    cars.push({ i, ps, viol: r.viol, test: !!atlas.edges[i].test })
  })
  const rows = Math.max(1, Math.ceil(data.length / 4 / W))
  const tex = new Float32Array(W * rows * 4)
  tex.set(data)
  const routeTex = new THREE.DataTexture(tex, W, rows, THREE.RGBAFormat, THREE.FloatType)
  routeTex.minFilter = routeTex.magFilter = THREE.NearestFilter
  routeTex.needsUpdate = true

  // vehicle type by what the dependency does: commands haul trucks, queries run vans, the rest cars
  const modById = new Map(atlas.modules.map((m) => [m.id, m]))
  const kindOf = (e) => {
    const l = modById.get(e.source)?.layer
    return l === 'command' || l === 'service' || l === 'adapter' ? 'truck' : l === 'query' || l === 'view' || l === 'persistence' ? 'van' : 'car'
  }
  const groups = { car: [], van: [], truck: [] }
  for (const c of cars) { c.kind = kindOf(atlas.edges[c.i]); groups[c.kind].push(c) }

  const tU = { uRoutes: { value: routeTex }, uW: { value: W }, uSpeed: { value: 1 } }
  const meshes = []
  const byEdge = new Map() // edge index → [mesh, instance]
  let seed = 99
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  for (const [kind, list] of Object.entries(groups)) {
    if (!list.length) continue
    const n = list.length
    // per-car data is generated once and shared by the detailed and the far-away (box) fleet
    const aA = new Float32Array(n * 4), aB = new Float32Array(n * 4), aC = new Float32Array(n * 4), aCol = new Float32Array(n * 3)
    list.forEach((c, k) => {
      const [p0, p1, p2] = c.ps
      aA.set([p0.start, p0.count, p1.start, p1.count], k * 4)
      aB.set([p2.start, p2.count, p0.T, p1.T], k * 4)
      aC.set([p2.T, rnd(), (c.viol ? 1 : 0) + (c.test ? 2 : 0), rnd()], k * 4)
      const col = c.viol ? RED : PAINT[Math.floor(rnd() * PAINT.length)]
      col.toArray(aCol, k * 3)
      byEdge.set(c.i, [kind, k])
    })
    const aS = new Float32Array(n)
    list.forEach((c, k) => { aS[k] = c.test ? 2 : 0 })
    const sAttr = new THREE.InstancedBufferAttribute(aS, 1); sAttr.setUsage(THREE.DynamicDrawUsage)
    const shared = { aA: new THREE.InstancedBufferAttribute(aA, 4), aB: new THREE.InstancedBufferAttribute(aB, 4), aC: new THREE.InstancedBufferAttribute(aC, 4), aS: sAttr, aCol: new THREE.InstancedBufferAttribute(aCol, 3) }
    for (const lod of [false, true]) {
      const geo = lod ? lodGeo(part(kind)) : part(kind).geo.clone()
      const ig = new THREE.InstancedBufferGeometry()
      for (const k of Object.keys(geo.attributes)) ig.setAttribute(k, geo.attributes[k])
      if (geo.index) ig.setIndex(geo.index)
      for (const [k, v] of Object.entries(shared)) ig.setAttribute(k, v)
      ig.instanceCount = n
      const mesh = new THREE.Mesh(ig, carMaterial(uni, tU))
      mesh.frustumCulled = false
      mesh.castShadow = false
      mesh.receiveShadow = true
      mesh.userData = { kind, list, lod }
      mesh.visible = !lod
      meshes.push(mesh)
    }
  }
  const group = new THREE.Group()
  for (const m of meshes) group.add(m)
  const meshOf = Object.fromEntries(meshes.filter((m) => !m.userData.lod).map((m) => [m.userData.kind, m]))
  // far away a car is a few pixels: swap the detailed fleet for boxes
  let far = false
  function setLod(f) {
    if (f === far) return
    far = f
    for (const m of meshes) m.visible = m.userData.lod === far
  }
  // per-car state: 0 normal · 1 highlighted · 2 hidden · 3 dimmed
  function setState(fn) {
    for (const m of meshes) {
      if (m.userData.lod) continue // shares aS with its detailed twin
      const a = m.geometry.attributes.aS
      m.userData.list.forEach((c, k) => { a.array[k] = fn(c.i, c) })
      a.needsUpdate = true
    }
  }
  return { group, meshes, byEdge, meshOf, setState, setLod, count: cars.length, texels: data.length / 4, uniforms: tU }
}

function lodGeo(p) {
  const b = p.box
  const g = new THREE.BoxGeometry(b.max.x - b.min.x, (b.max.y - b.min.y) * 0.8, b.max.z - b.min.z).translate((b.max.x + b.min.x) / 2, (b.max.y - b.min.y) * 0.4 + b.min.y, (b.max.z + b.min.z) / 2).toNonIndexed()
  const n = g.attributes.position.count
  g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3).fill(0.85), 3))
  g.setAttribute('_tint', new THREE.Float32BufferAttribute(new Float32Array(n).fill(1), 1))
  g.setAttribute('_glow', new THREE.Float32BufferAttribute(new Float32Array(n), 1))
  g.deleteAttribute('uv')
  return g
}

function carMaterial(uni, tU) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.1 })
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, tU)
    sh.uniforms.uTime = uni.uTime
    sh.uniforms.uNight = uni.uNight
    sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>
uniform highp sampler2D uRoutes; uniform float uW; uniform float uTime; uniform float uSpeed; uniform float uNight;
attribute vec4 aA; attribute vec4 aB; attribute vec4 aC; attribute float aS; attribute vec3 aCol; attribute float _tint; attribute float _glow;
varying float vState; varying float vGlowC; varying float vFront;
vec4 rt(float i){ return texelFetch(uRoutes, ivec2(int(mod(i, uW)), int(floor(i / uW))), 0); }
void piece(float start, float count, float t, out vec2 p, out vec2 d, out float flag){
  float lo = 0.0, hi = max(1.0, count - 1.0);
  for (int k = 0; k < 10; k++) { if (hi - lo <= 1.0) break; float mid = floor((lo + hi) * 0.5); if (rt(start + mid).z <= t) lo = mid; else hi = mid; }
  vec4 a = rt(start + lo), b = rt(start + hi);
  float f = clamp((t - a.z) / max(1e-4, b.z - a.z), 0.0, 1.0);
  p = mix(a.xy, b.xy, f); d = b.xy - a.xy; flag = a.w;
  if (dot(d, d) < 1e-8) d = vec2(0.0, 1.0);
  d = normalize(d);
}
vec3 carP; float carA; float carBob; float carHide;
void carState(){
  float T0 = aB.z, T1 = aB.w, T2 = aC.x;
  float T = T0 + T1 + T2;
  float tt = mod(uTime * uSpeed + aC.y * 2.0 * T, 2.0 * T);
  bool back = tt > T;
  float t = back ? 2.0 * T - tt : tt;
  vec2 p; vec2 d; float flag;
  if (t < T0 || (T1 + T2) < 1e-3) piece(aA.x, aA.y, t, p, d, flag);
  else if (t < T0 + T1 || T2 < 1e-3) piece(aA.z, aA.w, t - T0, p, d, flag);
  else piece(aB.x, aB.y, t - T0 - T1, p, d, flag);
  if (back) d = -d;
  float lane = flag > 0.5 && flag < 1.5 ? 1.0 : flag > 1.5 ? 0.35 : 0.55;
  vec2 right = vec2(-d.y, d.x);
  p += right * lane;
  carA = atan(d.x, d.y);
  carBob = flag > 1.5 ? abs(sin(uTime * 13.0 + aC.w * 40.0)) * 0.07 : 0.0;
  carP = vec3(p.x, 0.07 + carBob, p.y);
  carHide = aS > 1.5 && aS < 2.5 ? 0.0 : 1.0;
}
vec3 rotY(vec3 v, float a){ float c = cos(a), s = sin(a); return vec3(c * v.x + s * v.z, v.y, -s * v.x + c * v.z); }`)
      .replace('#include <beginnormal_vertex>', `carState();
vec3 objectNormal = rotY(normal, carA);
#ifdef USE_TANGENT
vec3 objectTangent = vec3(tangent.xyz);
#endif`)
      .replace('#include <begin_vertex>', `vec3 transformed = rotY(position * carHide, carA) + carP;
vState = aS; vGlowC = _glow; vFront = position.z;`)
      .replace('#include <color_vertex>', `vColor = vec3(1.0);
#ifdef USE_COLOR
  vColor *= color.rgb;
#endif
  vColor *= mix(vec3(1.0), aCol, _tint);`)
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
uniform float uNight; uniform float uTime; varying float vState; varying float vGlowC; varying float vFront;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
  if (vState > 0.5 && vState < 1.5) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.42, 1.0), 0.65);
  if (vState > 2.5) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.82, 0.83, 0.82), 0.8);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  // headlights forward, tail lights back — at night the highways become rivers of light
  float head = smoothstep(0.38, 0.5, vFront), tail = smoothstep(-0.38, -0.5, vFront);
  totalEmissiveRadiance += (vec3(1.0, 0.92, 0.7) * head * 2.2 + vec3(1.0, 0.12, 0.08) * tail * 1.6) * uNight * (vState > 2.5 ? 0.15 : 1.0);
  if (vState > 0.5 && vState < 1.5) totalEmissiveRadiance += vec3(0.2, 0.45, 1.0) * 0.5;`)
  }
  mat.customProgramCacheKey = () => 'car-v1'
  return mat
}
