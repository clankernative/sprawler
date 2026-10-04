// Ground: a land-use map painted from the plan (forest, lawns, plazas, dirt), shaded per hex cell like a
// strategy-game board, on a diorama slab. Plus the forest: instanced trees wherever land use says woods.
import * as THREE from 'three'
import { kitMesh, part } from './kit.js'

const RES = 2048

// paint land use into a canvas: R = forest density, G = lawn/plaza, B = dirt, A = road verge
export function paintLanduse(plan) {
  const E = plan.extent + 40
  const cv = document.createElement('canvas')
  cv.width = cv.height = RES
  const g = cv.getContext('2d')
  const s = RES / (2 * E)
  const X = (x) => (x + E) * s, Z = (z) => (z + E) * s
  g.fillStyle = 'rgb(255,0,0)'
  g.fillRect(0, 0, RES, RES)
  // verges along every road: cleared of trees
  g.lineCap = 'round'; g.lineJoin = 'round'
  const W = { ring: 4.2, connector: 3.6, arterial: 3, outer: 2.6, spoke: 2.4, street: 2.2 }
  for (const r of plan.roads) {
    if (r.ctx && r.cls !== 'arterial') continue
    g.strokeStyle = 'rgb(60,40,0)'
    g.lineWidth = (W[r.cls] + 7) * s
    g.beginPath()
    r.pts.forEach(([x, z], i) => (i ? g.lineTo(X(x), Z(z)) : g.moveTo(X(x), Z(z))))
    g.stroke()
  }
  for (const d of plan.districts.values()) {
    const grad = g.createRadialGradient(X(d.x), Z(d.z), d.R * s * 0.7, X(d.x), Z(d.z), (d.R + 6) * s)
    grad.addColorStop(0, 'rgb(0,255,0)'); grad.addColorStop(0.75, 'rgb(0,230,0)'); grad.addColorStop(1, 'rgba(0,120,0,0)')
    g.fillStyle = grad
    g.beginPath(); g.arc(X(d.x), Z(d.z), (d.R + 6) * s, 0, Math.PI * 2); g.fill()
  }
  // the river and its banks: no trees
  if (plan.river) {
    g.strokeStyle = 'rgb(60,40,0)'
    g.lineWidth = (plan.river.w + 9) * s
    g.beginPath()
    plan.river.pts.forEach(([x, z], i) => (i ? g.lineTo(X(x), Z(z)) : g.moveTo(X(x), Z(z))))
    g.stroke()
  }
  // dirt tracks: scars through the woods, wider the more violations use them
  for (const t of plan.tracks) {
    g.strokeStyle = 'rgb(0,60,255)'
    g.lineWidth = (trackWidth(t) + 3) * s
    g.beginPath()
    t.pts.forEach(([x, z], i) => (i ? g.lineTo(X(x), Z(z)) : g.moveTo(X(x), Z(z))))
    g.stroke()
  }
  const data = g.getImageData(0, 0, RES, RES).data
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.NoColorSpace
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.anisotropy = 8
  const sample = (x, z) => {
    const px = Math.max(0, Math.min(RES - 1, Math.floor(X(x)))), pz = Math.max(0, Math.min(RES - 1, Math.floor(Z(z))))
    const i = (pz * RES + px) * 4
    return [data[i], data[i + 1], data[i + 2]]
  }
  return { tex, sample, E }
}

export const trackWidth = (t) => Math.min(6.5, 1.6 + 0.9 * Math.log2(1 + t.n))

const GROUND_FS_HEAD = /* glsl */ `
uniform sampler2D uLand; uniform float uE; uniform float uTime; uniform float uNight; uniform float uDoc;
varying vec3 vGw;
float gh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float gn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(gh(i), gh(i+vec2(1,0)), f.x), mix(gh(i+vec2(0,1)), gh(i+vec2(1,1)), f.x), f.y); }
vec4 hexCell(vec2 uv){ vec2 r = vec2(1.0, 1.732); vec2 h = r * 0.5; vec2 a = mod(uv, r) - h; vec2 b = mod(uv - h, r) - h; vec2 gv = dot(a,a) < dot(b,b) ? a : b; return vec4(gv, uv - gv); }
float hexDist(vec2 p){ p = abs(p); return max(dot(p, normalize(vec2(1.0, 1.732))), p.x); }
`

export function buildGround(plan, land, uni) {
  const group = new THREE.Group()
  const E = land.E
  // the slab: a big hexagon of land with soil sides, so the city reads as a model on a table
  const R = E * 1.0
  const shape = new THREE.Shape()
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + Math.PI / 6
    const x = Math.cos(a) * R, z = Math.sin(a) * R
    k ? shape.lineTo(x, z) : shape.moveTo(x, z)
  }
  const slabGeo = new THREE.ExtrudeGeometry(shape, { depth: 14, bevelEnabled: true, bevelThickness: 1.2, bevelSize: 1.2, bevelSegments: 1, curveSegments: 1 })
  slabGeo.rotateX(Math.PI / 2)
  const sideMat = new THREE.MeshStandardMaterial({ color: '#8c6e52', roughness: 1 })
  const slab = new THREE.Mesh(slabGeo, [new THREE.MeshStandardMaterial({ color: '#6fa35a', roughness: 1 }), sideMat])
  slab.position.y = -1.32 // bevel adds 1.2 above the shape face
  slab.receiveShadow = true
  group.add(slab)
  // soil strata stripes on the slab sides
  sideMat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vY;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvY = position.y;')
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vY;').replace('#include <color_fragment>', `#include <color_fragment>
      float band = smoothstep(-1.6, -0.6, vY);
      diffuseColor.rgb = mix(diffuseColor.rgb * (0.82 + 0.18 * step(0.5, fract(vY * 0.35))), vec3(0.42, 0.62, 0.33), band);`)
  }

  // the playable surface: land-use texture + hex cells + cloud shadows
  const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.97, metalness: 0 })
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uLand = { value: land.tex }
    sh.uniforms.uE = { value: E }
    sh.uniforms.uTime = uni.uTime
    sh.uniforms.uNight = uni.uNight
    sh.uniforms.uDoc = uni.uDoc
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vGw;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGw = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + GROUND_FS_HEAD)
      .replace('#include <color_fragment>', `#include <color_fragment>
      vec2 luv = (vGw.xz + uE) / (2.0 * uE);
      vec4 L = texture2D(uLand, luv);
      vec4 hc = hexCell(vGw.xz / 5.2);
      float cellV = gh(hc.zw);
      float edge = smoothstep(0.42, 0.5, hexDist(hc.xy));
      vec3 forest = mix(vec3(0.27, 0.47, 0.22), vec3(0.33, 0.55, 0.25), cellV);
      vec3 grass = mix(vec3(0.47, 0.68, 0.33), vec3(0.53, 0.73, 0.37), cellV);
      vec3 lawn = mix(vec3(0.58, 0.77, 0.42), vec3(0.62, 0.8, 0.45), cellV);
      vec3 dirt = mix(vec3(0.62, 0.47, 0.31), vec3(0.68, 0.53, 0.36), gn(vGw.xz * 0.7));
      vec3 c = mix(grass, forest, L.r);
      c = mix(c, lawn, L.g);
      c = mix(c, dirt, L.b * 0.95);
      c *= 1.0 - edge * 0.07 * (1.0 - L.b);
      // drifting cloud shadows
      float cl = gn(vGw.xz * 0.006 + vec2(uTime * 0.004, uTime * 0.0025)) * 0.65 + gn(vGw.xz * 0.017 - uTime * 0.003) * 0.35;
      c *= 1.0 - smoothstep(0.55, 0.78, cl) * 0.16 * (1.0 - uNight);
      c = mix(c, vec3(0.93, 0.92, 0.88), uDoc * 0.9);
      diffuseColor.rgb = pow(c, vec3(2.2));`)
  }
  const surf = new THREE.Mesh(new THREE.CircleGeometry(R * 0.995, 6, Math.PI / 6).rotateX(-Math.PI / 2), mat)
  surf.position.y = 0
  surf.receiveShadow = true
  surf.name = 'ground'
  group.add(surf)
  return { group, surf, R }
}

// ── forest ──────────────────────────────────────────────────────────────────
const TREES = ['tree_pine', 'tree_pine_tall', 'tree_round', 'tree_round_small', 'tree_birch', 'bush']
export function buildForest(plan, land, mat, avoid) {
  const E = plan.extent + 30
  const spacing = plan.extent > 650 ? 5.6 : 4.6
  const lists = new Map(TREES.map((t) => [t, []]))
  let seed = 1337
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  for (let z = -E; z < E; z += spacing) {
    for (let x = -E; x < E; x += spacing) {
      const px = x + (rnd() - 0.5) * spacing * 0.9, pz = z + (rnd() - 0.5) * spacing * 0.9
      // inside the hexagonal slab (edge normals at 0°, 60°, 120°; inradius = R·cos 30°), with a margin
      const inR = land.E * 0.866 - 4
      if (Math.abs(px) > inR || Math.abs(px * 0.5 + pz * 0.866) > inR || Math.abs(-px * 0.5 + pz * 0.866) > inR) continue
      const [f, lawn, dirt] = land.sample(px, pz)
      if (dirt > 60 || lawn > 120) continue
      const dens = f / 255
      if (rnd() > dens * 0.95) continue
      if (avoid && avoid(px, pz)) continue
      const r = rnd()
      const type = r < 0.34 ? 'tree_pine' : r < 0.5 ? 'tree_pine_tall' : r < 0.74 ? 'tree_round' : r < 0.86 ? 'tree_round_small' : r < 0.95 ? 'tree_birch' : 'bush'
      lists.get(type).push([px, pz, 1.25 + rnd() * 0.85, rnd() * Math.PI * 2])
    }
  }
  const group = new THREE.Group()
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), P = new THREE.Vector3(), Yax = new THREE.Vector3(0, 1, 0)
  const meshes = []
  // chunk so off-screen woods are culled
  const CH = 140
  for (const [type, list] of lists) {
    const chunks = new Map()
    for (const t of list) {
      const k = Math.floor(t[0] / CH) + ',' + Math.floor(t[1] / CH)
      if (!chunks.has(k)) chunks.set(k, [])
      chunks.get(k).push(t)
    }
    for (const arr of chunks.values()) {
      const mesh = kitMesh(type, arr.length, mat)
      arr.forEach(([x, z, s, ry], i) => {
        Q.setFromAxisAngle(Yax, ry)
        M.compose(P.set(x, 0, z), Q, S.setScalar(s))
        mesh.setMatrixAt(i, M)
      })
      mesh.instanceMatrix.needsUpdate = true
      mesh.computeBoundingSphere()
      mesh.frustumCulled = true
      mesh.receiveShadow = false
      group.add(mesh)
      meshes.push(mesh)
    }
  }
  return { group, count: [...lists.values()].reduce((s, l) => s + l.length, 0), meshes }
}

export { part }
