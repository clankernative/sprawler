// Kit of parts: loads web/public/kit/kit.glb (made by art/kit.py, contract in art/KIT.md) and hands out
// geometries by name. Anything missing gets a simple procedural stand-in so the city always renders.
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

const parts = new Map() // name → { geo, h, box }
let loaded = false

export async function loadKit(url = './kit/kit.glb') {
  try {
    const loader = new GLTFLoader()
    loader.setMeshoptDecoder(MeshoptDecoder)
    const gltf = await loader.loadAsync(url + '?v=' + Date.now())
    gltf.scene.updateMatrixWorld(true)
    const byName = new Map()
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return
      // a node with several primitives comes in as a group of meshes: merge them back
      const name = o.parent && o.parent !== gltf.scene && o.parent.type === 'Group' && o.parent.name ? o.parent.name : o.name
      const g = o.geometry.clone().applyMatrix4(o.matrixWorld)
      if (!byName.has(name)) byName.set(name, { list: [], extras: { ...(o.userData || {}), ...(o.parent?.userData || {}) } })
      byName.get(name).list.push(g)
    })
    for (const [name, { list, extras }] of byName) {
      const geo = normalize(list.length > 1 ? mergeGeometries(list.map(normalize), false) : list[0])
      put(name, geo, extras.h)
    }
    loaded = true
    console.info(`[kit] ${parts.size} parts from ${url}`)
  } catch (e) {
    console.warn('[kit] no kit.glb yet — using stand-ins', e?.message || e)
  }
  return parts
}

export const kitLoaded = () => loaded

function normalize(g) {
  g = g.index ? g.toNonIndexed() : g
  const n = g.attributes.position.count
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'color', '_tint', '_glow', '_siren'].includes(k)) g.deleteAttribute(k)
  if (!g.attributes.normal) g.computeVertexNormals()
  if (!g.attributes.color) g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3).fill(0.9), 3))
  else if (g.attributes.color.itemSize === 4) {
    const c = g.attributes.color, a = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) { a[i * 3] = c.getX(i); a[i * 3 + 1] = c.getY(i); a[i * 3 + 2] = c.getZ(i) }
    g.setAttribute('color', new THREE.Float32BufferAttribute(a, 3))
  } else if (g.attributes.color.normalized || !(g.attributes.color.array instanceof Float32Array)) {
    const c = g.attributes.color, a = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) { a[i * 3] = c.getX(i); a[i * 3 + 1] = c.getY(i); a[i * 3 + 2] = c.getZ(i) }
    g.setAttribute('color', new THREE.Float32BufferAttribute(a, 3))
  }
  for (const k of ['_tint', '_glow', '_siren']) {
    if (!g.attributes[k]) g.setAttribute(k, new THREE.Float32BufferAttribute(new Float32Array(n), 1))
    else if (g.attributes[k].itemSize !== 1) {
      const c = g.attributes[k], a = new Float32Array(n)
      for (let i = 0; i < n; i++) a[i] = c.getX(i)
      g.setAttribute(k, new THREE.Float32BufferAttribute(a, 1))
    }
  }
  return g
}

function put(name, geo, h) {
  geo.computeBoundingBox()
  parts.set(name, { geo, h: h ?? null, box: geo.boundingBox.clone() })
}

export function part(name) {
  if (!parts.has(name)) put(name, normalize(standIn(name)), STACK_H[name.replace(/_base$/, '')] ?? null)
  return parts.get(name)
}

export const has = (name) => parts.has(name)

// ── procedural stand-ins ────────────────────────────────────────────────────
const hex = (h) => new THREE.Color(h)
const WALL = hex('#efeae0'), WALL2 = hex('#e3dccd'), ROOF = hex('#d8d4cc'), GLASS = hex('#9db7c9'), DARK = hex('#5e6873'), YEL = hex('#f2c230'), TRUNK = hex('#7a5a3e')
const STACK_H = { landmark: 0.9, civic: 0.9, factory: 0.9, shop: 0.8, library: 0.8, warehouse: 0.9, prefab: 0.7, apartment: 0.8, office: 0.8, megatower: 1.0 }
const FOOT = { landmark: [2, 2], civic: [2.3, 2], factory: [2.3, 2.1], shop: [2.1, 2], library: [2.2, 2], warehouse: [2.4, 2], prefab: [1.9, 1.9], apartment: [2, 2], office: [2, 2], megatower: [2.4, 2.4] }

function colored(geo, color, tint = 0, glow = 0) {
  geo = geo.index ? geo.toNonIndexed() : geo
  const n = geo.attributes.position.count
  const c = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) { c[i * 3] = color.r; c[i * 3 + 1] = color.g; c[i * 3 + 2] = color.b }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(c, 3))
  geo.setAttribute('_tint', new THREE.Float32BufferAttribute(new Float32Array(n).fill(tint), 1))
  geo.setAttribute('_glow', new THREE.Float32BufferAttribute(new Float32Array(n).fill(glow), 1))
  geo.setAttribute('_siren', new THREE.Float32BufferAttribute(new Float32Array(n), 1))
  for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'color', '_tint', '_glow', '_siren'].includes(k)) geo.deleteAttribute(k)
  return geo
}
const box = (w, h, d, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, d).translate(x, y + h / 2, z)
const merge = (list) => mergeGeometries(list, false)

function standIn(name) {
  const m = name.match(/^(.*)_(base|floor|roof)$/)
  if (m && FOOT[m[1]]) {
    const [w, d] = FOOT[m[1]]
    const H = STACK_H[m[1]]
    if (m[2] === 'base') return merge([colored(box(w, H, d), WALL2), colored(box(w * 0.5, H * 0.55, 0.05, 0, 0, d / 2), DARK)])
    if (m[2] === 'floor') return merge([colored(box(w, 0.5, d), WALL), colored(box(w + 0.02, 0.2, d + 0.02, 0, 0.17), GLASS, 0, 1)])
    return merge([colored(box(w + 0.1, 0.12, d + 0.1), ROOF, 1), colored(box(w * 0.35, 0.3, d * 0.35, 0, 0.12), hex('#c7c3bb'))])
  }
  switch (name) {
    case 'tree_pine': case 'tree_pine_tall': {
      const s = name === 'tree_pine_tall' ? 1.4 : 1
      return merge([colored(new THREE.CylinderGeometry(0.08, 0.1, 0.5 * s, 5).translate(0, 0.25 * s, 0), TRUNK),
        colored(new THREE.ConeGeometry(0.75, 1.3 * s, 6).translate(0, 1.05 * s, 0), hex('#3e7b45')),
        colored(new THREE.ConeGeometry(0.55, 1.0 * s, 6).translate(0, 1.65 * s, 0), hex('#356b3d'))])
    }
    case 'tree_round': case 'tree_round_small': case 'tree_birch': case 'bush': {
      const s = name === 'tree_round' ? 1 : name === 'bush' ? 0.45 : 0.75
      return merge([colored(new THREE.CylinderGeometry(0.08, 0.1, 0.8 * s, 5).translate(0, 0.4 * s, 0), name === 'tree_birch' ? hex('#e8e4da') : TRUNK),
        colored(new THREE.IcosahedronGeometry(0.75 * s, 0).translate(0, 1.2 * s, 0), hex(name === 'tree_birch' ? '#79b95a' : '#5fa845'))])
    }
    case 'rock': return colored(new THREE.DodecahedronGeometry(0.4, 0).scale(1, 0.6, 1).translate(0, 0.2, 0), hex('#a7a49c'))
    case 'car': return merge([colored(box(0.55, 0.22, 1.0, 0, 0.06), ROOF, 1), colored(box(0.5, 0.16, 0.5, 0, 0.28, 0.05), GLASS)])
    case 'van': return merge([colored(box(0.6, 0.5, 1.15, 0, 0.06), ROOF, 1), colored(box(0.56, 0.18, 0.2, 0, 0.32, -0.48), GLASS)])
    case 'truck': return merge([colored(box(0.7, 0.55, 0.45, 0, 0.08, -0.6), WALL), colored(box(0.7, 0.75, 1.15, 0, 0.1, 0.22), ROOF, 1)])
    case 'bulldozer': case 'excavator': return merge([colored(box(0.8, 0.45, 1.1, 0, 0.1), YEL), colored(box(0.5, 0.3, 0.5, 0, 0.55), YEL), colored(box(0.9, 0.3, 0.12, 0, 0.05, -0.65), DARK)])
    case 'police': {
      const bar = (x, v) => { const g = colored(box(0.18, 0.08, 0.12, x, 0.42), v > 0 ? hex('#e8483b') : hex('#3b6be8'), 0, 1); g.setAttribute('_siren', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count).fill(v), 1)); return g }
      return merge([colored(box(0.55, 0.24, 1.0, 0, 0.06), hex('#ffffff')), colored(box(0.56, 0.1, 0.5, 0, 0.12, 0.05), hex('#1d2b4f')), colored(box(0.48, 0.14, 0.5, 0, 0.3, 0.05), GLASS), bar(-0.1, 1), bar(0.1, -1)])
    }
    case 'cloud': case 'rain_cloud': {
      const c = name === 'cloud' ? hex('#f4f6f8') : hex('#8f98a3')
      return merge([colored(new THREE.IcosahedronGeometry(1.4, 0).translate(0, 1.2, 0), c), colored(new THREE.IcosahedronGeometry(1.1, 0).translate(1.5, 0.9, 0.2), c), colored(new THREE.IcosahedronGeometry(1.0, 0).translate(-1.5, 0.85, -0.2), c), colored(new THREE.IcosahedronGeometry(0.9, 0).translate(0.4, 0.7, 1.0), c)])
    }
    case 'inspector': return merge([colored(box(0.55, 0.24, 1.0, 0, 0.06), hex('#ffffff')), colored(box(0.4, 0.08, 0.12, 0, 0.42), hex('#e8483b'), 0, 1)])
    case 'crane_mast': {
      const legs = []
      for (const [x, z] of [[-0.22, -0.22], [0.22, -0.22], [-0.22, 0.22], [0.22, 0.22]]) legs.push(colored(box(0.06, 1, 0.06, x, 0, z), YEL))
      legs.push(colored(box(0.5, 0.05, 0.5, 0, 0.95), YEL))
      return merge(legs)
    }
    case 'crane_top': return merge([colored(box(0.6, 0.5, 0.6), YEL), colored(box(0.3, 0.3, 6.2, 0, 0.5, -3.1), YEL), colored(box(0.3, 0.3, 2.2, 0, 0.5, 1.1), YEL), colored(box(0.7, 0.5, 0.6, 0, 0.2, 1.9), hex('#c7c3bb')), colored(box(0.08, 1.4, 0.08, 0, 0.5), YEL)])
    case 'crane_hook': return merge([colored(box(0.03, 1.0, 0.03, 0, -1.0), DARK), colored(box(0.18, 0.2, 0.18, 0, -1.2), YEL)])
    case 'scaffold': {
      const p = []
      for (const [x, z] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) p.push(colored(box(0.03, 1, 0.03, x, 0, z), hex('#b5bbc2')))
      p.push(colored(box(1.02, 0.03, 1.02, 0, 0.5), hex('#a98463')))
      return merge(p)
    }
    case 'foundation': return merge([colored(box(2.4, 0.08, 2.4, 0, -0.08), hex('#b48a5e')), colored(box(1.9, 0.1, 1.9, 0, -0.04), hex('#c7c3bb'))])
    case 'rubble': return merge([colored(new THREE.DodecahedronGeometry(0.7, 0).scale(1.4, 0.5, 1.2).translate(0, 0.2, 0), hex('#a7a49c')), colored(box(1.6, 0.06, 0.1, 0.2, 0.3, 0.2), DARK)])
    case 'cone': return colored(new THREE.ConeGeometry(0.1, 0.25, 6).translate(0, 0.125, 0), hex('#f07a2a'))
    case 'barrier': return colored(box(1.0, 0.25, 0.1, 0, 0.1), hex('#f07a2a'))
    case 'streetlight': return merge([colored(box(0.05, 1.8, 0.05), DARK), colored(box(0.3, 0.06, 0.12, 0.13, 1.75), hex('#fff2c0'), 0, 1)])
    case 'sign_board': return merge([colored(box(0.06, 1.2, 0.06, -0.7), DARK), colored(box(0.06, 1.2, 0.06, 0.7), DARK), colored(box(1.6, 0.6, 0.06, 0, 0.7), hex('#2f3a45'))])
    case 'fountain': return merge([colored(new THREE.CylinderGeometry(0.8, 0.85, 0.25, 12).translate(0, 0.125, 0), hex('#d9d2c3')), colored(new THREE.CylinderGeometry(0.7, 0.7, 0.05, 12).translate(0, 0.26, 0), hex('#8fd0ea'))])
    case 'flowerbed': return merge([colored(box(1, 0.2, 1), hex('#a98463')), colored(box(0.85, 0.12, 0.85, 0, 0.2), hex('#e86f8f'))])
    case 'smoke_stack': return colored(new THREE.CylinderGeometry(0.22, 0.3, 3, 8).translate(0, 1.5, 0), hex('#9a8f86'))
    case 'airport': return merge([colored(box(6, 0.8, 3), WALL), colored(box(0.6, 2.5, 0.6, 2.4, 0, -1), WALL2), colored(box(0.9, 0.5, 0.9, 2.4, 2.5, -1), GLASS, 0, 1)])
    case 'plane': return merge([colored(box(0.4, 0.4, 3, 0, 0.3), hex('#ffffff')), colored(box(3, 0.08, 0.6, 0, 0.45, 0.1), hex('#ffffff'))])
    case 'bridge_span': return merge([colored(box(8, 0.3, 3.2), hex('#c7c3bb')), colored(box(8, 0.3, 0.1, 0, 0.3, 1.55), DARK), colored(box(8, 0.3, 0.1, 0, 0.3, -1.55), DARK)])
    case 'bridge_pier': return colored(box(0.8, 3, 2.6, 0, -3), hex('#c7c3bb'))
    case 'hall': return merge([colored(box(2.3, 1.2, 1.8), WALL), colored(box(2.4, 0.15, 1.9, 0, 1.2), ROOF, 1), colored(box(0.7, 2.6, 0.7, 0, 1.2), WALL2), colored(new THREE.ConeGeometry(0.55, 0.8, 4).rotateY(Math.PI / 4).translate(0, 4.2, 0), ROOF, 1)])
    case 'tollgate': return merge([colored(box(2.4, 0.15, 1.6, 0, 1.1), ROOF, 1), ...[-0.8, 0, 0.8].map((x) => colored(box(0.35, 0.9, 0.5, x), WALL))])
    case 'station': return merge([colored(box(1.4, 1.0, 1.4, -0.4), WALL), colored(box(2.4, 0.1, 1.0, 0, 1.0, 0.6), ROOF, 1)])
    case 'substation': return merge([colored(box(2.0, 0.1, 2.0), hex('#c7c3bb')), colored(box(0.6, 0.9, 0.5, -0.5), hex('#b5bbc2')), colored(box(0.6, 0.9, 0.5, 0.5), hex('#b5bbc2'))])
    case 'shed': return merge([colored(box(1.2, 0.8, 1.0, -0.2), WALL2), colored(new THREE.CylinderGeometry(0.35, 0.35, 1.3, 10).translate(0.55, 0.65, 0.3), hex('#b5bbc2'))])
    case 'tent': return colored(new THREE.ConeGeometry(0.9, 1.0, 4).rotateY(Math.PI / 4).translate(0, 0.5, 0), hex('#f6f4ee'))
    case 'house': case 'house2': return merge([colored(box(1.5, 0.8, 1.3), WALL), colored(new THREE.ConeGeometry(1.15, 0.6, 4).rotateY(Math.PI / 4).scale(1, 1, 0.85).translate(0, 1.1, 0), ROOF, 1)])
    case 'shack': return merge([colored(box(1.2, 0.7, 1.0), hex('#b5a58c')), colored(box(1.3, 0.06, 1.1, 0, 0.72), hex('#8e959e'))])
    default: return colored(box(1, 1, 1), hex('#ff00ff'))
  }
}

// ── the one material every kit instance uses ────────────────────────────────
// instance attributes: iTint (vec3, multiplies `_tint` surfaces) · iFx (x highlight, y dim, z flash, w spare)
export function cityMaterial(uni, opts = {}) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0.0, flatShading: opts.flat ?? false })
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = uni.uNight
    sh.uniforms.uTime = uni.uTime
    sh.uniforms.uDoc = uni.uDoc
    sh.uniforms.uLens = uni.uLens
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute float _tint; attribute float _glow; attribute float _siren; attribute vec3 iTint; attribute vec4 iFx; attribute vec4 iImp;
varying float vGlow; varying vec4 vFx; varying vec3 vWp; varying float vSiren; varying vec4 vImp;`)
      .replace('#include <color_vertex>', `vColor = vec3(1.0);
#ifdef USE_COLOR
  vColor *= color.rgb;
#endif
  vColor *= mix(vec3(1.0), iTint, _tint);
  vGlow = _glow; vFx = iFx; vSiren = _siren; vImp = iImp;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
  vWp = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;`)
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uNight; uniform float uTime; uniform float uDoc; varying float vGlow; varying vec4 vFx; varying vec3 vWp; varying float vSiren; varying vec4 vImp; uniform float uLens;
float wh(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.4, 1.0), vFx.x * 0.55);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.80, 0.82, 0.80), vFx.y * 0.8);
  // demolition preview: 1 = direct dependent (red), 2 = second ring (orange), 3 = third (amber)
  vec3 impC = vImp.x < 1.5 ? vec3(0.93, 0.25, 0.2) : vImp.x < 2.5 ? vec3(0.98, 0.55, 0.18) : vec3(0.98, 0.8, 0.3);
  diffuseColor.rgb = mix(diffuseColor.rgb, impC, step(0.5, vImp.x) * 0.7);
  // smell: stained, weathered facades (vertical streaks), stronger the worse the file
  float streak = wh(vec2(floor(vWp.x * 2.3 + vWp.z * 1.7), floor(vWp.y * 0.6)));
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.72, 0.68, 0.55), clamp(vImp.y, 0.0, 1.0) * (0.45 + 0.55 * streak) * (1.0 - vGlow));
  // data lens: buildings become a heat map (cool → hot); buildings without data turn pale clay
  vec3 lc = vImp.z < 0.33 ? mix(vec3(0.23, 0.51, 0.96), vec3(0.13, 0.77, 0.37), vImp.z / 0.33)
          : vImp.z < 0.66 ? mix(vec3(0.13, 0.77, 0.37), vec3(0.98, 0.8, 0.08), (vImp.z - 0.33) / 0.33)
          : mix(vec3(0.98, 0.8, 0.08), vec3(0.94, 0.27, 0.27), (vImp.z - 0.66) / 0.34);
  diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.86, 0.86, 0.84), lc, vImp.w) * (0.75 + 0.25 * dot(diffuseColor.rgb, vec3(0.33))), uLens * 0.92);
  // plan mode: everything becomes a white clay architectural model; red roofs (rule breaks) and selection keep their colour
  float keep = max(vFx.x, step(0.5, diffuseColor.r - diffuseColor.g) * step(0.3, diffuseColor.r));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.92, 0.9) * (0.9 + 0.1 * dot(diffuseColor.rgb, vec3(0.33))), uDoc * 0.88 * (1.0 - keep));`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  // night: some windows are lit (per-window hash so the city twinkles unevenly)
  float lit = step(0.38, wh(floor(vWp.xz * 1.7) + floor(vWp.y * 2.0)));
  totalEmissiveRadiance += vec3(1.0, 0.74, 0.42) * vGlow * uNight * (0.25 + 1.6 * lit) * (1.0 - vFx.y);
  totalEmissiveRadiance += vec3(0.25, 0.5, 1.0) * vFx.x * (0.18 + 0.12 * sin(uTime * 3.0));
  totalEmissiveRadiance += vec3(1.0) * vFx.z * 0.7;
  totalEmissiveRadiance += impC * step(0.5, vImp.x) * (0.25 + 0.2 * sin(uTime * 5.0 - vImp.x));
  totalEmissiveRadiance += lc * vImp.w * uLens * 0.12;
  // police light bar: red half and blue half alternate (phase per cruiser in iFx.w)
  float flash = step(0.5, fract(uTime * 2.4 + vFx.w));
  totalEmissiveRadiance += vec3(1.0, 0.1, 0.08) * step(0.5, vSiren) * flash * 4.0 * step(0.5, vFx.w);
  totalEmissiveRadiance += vec3(0.15, 0.35, 1.0) * step(0.5, -vSiren) * (1.0 - flash) * 4.0 * step(0.5, vFx.w);`)
  }
  mat.customProgramCacheKey = () => 'city-kit-v4' + (opts.flat ? 'f' : '')
  return mat
}

// an InstancedMesh of a kit part with iTint / iFx instance attributes ready to fill
export function kitMesh(name, count, mat) {
  const p = part(name)
  const geo = p.geo.clone()
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, count))
  mesh.count = count
  const tint = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, count) * 3).fill(1), 3)
  const fx = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, count) * 4), 4)
  const imp = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, count) * 4), 4)
  tint.setUsage(THREE.DynamicDrawUsage); fx.setUsage(THREE.DynamicDrawUsage); imp.setUsage(THREE.DynamicDrawUsage)
  geo.setAttribute('iTint', tint)
  geo.setAttribute('iFx', fx)
  geo.setAttribute('iImp', imp)
  mesh.castShadow = true
  mesh.receiveShadow = true
  mesh.frustumCulled = false
  return mesh
}

export { mergeVertices }
