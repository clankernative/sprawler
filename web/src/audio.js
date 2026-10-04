// Tiny WebAudio synth — no samples, all juice.
const DRONE = 0.012 // ambience level: quiet, under the sound effects
let ctx = null, master = null, muted = false, drone = null

export function initAudio() {
  if (ctx) return
  ctx = new (window.AudioContext || window.webkitAudioContext)()
  const comp = ctx.createDynamicsCompressor()
  master = ctx.createGain()
  master.gain.value = 0.35
  master.connect(comp).connect(ctx.destination)
  startDrone()
}

function env(node, t, a, peak, d) {
  node.gain.setValueAtTime(0.0001, t)
  node.gain.exponentialRampToValueAtTime(peak, t + a)
  node.gain.exponentialRampToValueAtTime(0.0001, t + a + d)
}

function tone(freq, { type = 'sine', dur = 0.12, vol = 0.2, slide = 0, delay = 0, attack = 0.005 } = {}) {
  if (!ctx || muted) return
  const t = ctx.currentTime + delay
  const o = ctx.createOscillator(), g = ctx.createGain()
  o.type = type
  o.frequency.setValueAtTime(freq, t)
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), t + dur)
  env(g, t, attack, vol, dur)
  o.connect(g).connect(master)
  o.start(t)
  o.stop(t + attack + dur + 0.05)
}

function noise(dur = 0.4, { vol = 0.15, from = 400, to = 3000, delay = 0 } = {}) {
  if (!ctx || muted) return
  const t = ctx.currentTime + delay
  const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain()
  src.buffer = buf
  f.type = 'bandpass'
  f.Q.value = 2
  f.frequency.setValueAtTime(from, t)
  f.frequency.exponentialRampToValueAtTime(to, t + dur)
  env(g, t, 0.02, vol, dur)
  src.connect(f).connect(g).connect(master)
  src.start(t)
}

// city ambience instead of a synth drone: distant traffic (filtered brown noise) and the odd bird
function startDrone() {
  const len = ctx.sampleRate * 4
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const d = buf.getChannelData(0)
  let last = 0
  for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.2 }
  const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain()
  src.buffer = buf; src.loop = true
  f.type = 'lowpass'; f.frequency.value = 420
  g.gain.value = DRONE * 3
  src.connect(f).connect(g).connect(master)
  src.start()
  drone = g
  const bird = () => {
    if (!muted && !document.hidden) {
      const base = 2600 + Math.random() * 1400
      for (let k = 0; k < 2 + Math.floor(Math.random() * 3); k++) tone(base, { type: 'sine', dur: 0.07, vol: 0.018, slide: 1.25, delay: k * 0.11 })
    }
    setTimeout(bird, 6000 + Math.random() * 12000)
  }
  setTimeout(bird, 4000)
}

export const sfx = {
  hover: () => tone(1500 + Math.random() * 300, { type: 'square', dur: 0.03, vol: 0.025 }),
  click: () => { tone(660, { type: 'triangle', dur: 0.08, vol: 0.12 }); tone(990, { type: 'sine', dur: 0.1, vol: 0.08, delay: 0.04 }) },
  whoosh: () => noise(0.7, { vol: 0.12, from: 300, to: 2400 }),
  alarm: () => { for (let i = 0; i < 3; i++) tone(880, { type: 'sawtooth', dur: 0.09, vol: 0.09, slide: 0.6, delay: i * 0.13 }) },
  chord: () => [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, { type: 'triangle', dur: 0.6, vol: 0.09, delay: i * 0.07 })),
  scan: () => { tone(120, { type: 'sine', dur: 1.4, vol: 0.2, slide: 6, attack: 0.05 }); noise(1.2, { vol: 0.06, from: 200, to: 5000 }) },
  type: () => tone(2400 + Math.random() * 800, { type: 'square', dur: 0.015, vol: 0.02 }),
  boom: () => { tone(90, { type: 'sine', dur: 0.9, vol: 0.4, slide: 0.3 }); noise(0.8, { vol: 0.2, from: 2000, to: 100 }) },
  tick: () => tone(3000, { type: 'square', dur: 0.01, vol: 0.015 }),
  siren: () => { for (let i = 0; i < 4; i++) tone(i % 2 ? 740 : 960, { type: 'triangle', dur: 0.22, vol: 0.05, delay: i * 0.24 }) },
  thunder: () => { noise(2.2, { vol: 0.22, from: 260, to: 40 }); tone(48, { type: 'sine', dur: 1.6, vol: 0.18, slide: 0.6, delay: 0.05 }) },
  horn: () => { tone(415, { type: 'square', dur: 0.16, vol: 0.05 }); tone(523, { type: 'square', dur: 0.16, vol: 0.04 }); tone(415, { type: 'square', dur: 0.22, vol: 0.05, delay: 0.24 }); tone(523, { type: 'square', dur: 0.22, vol: 0.04, delay: 0.24 }) },
  clank: () => { for (let i = 0; i < 3; i++) { tone(1800 + i * 120, { type: 'triangle', dur: 0.05, vol: 0.06, delay: i * 0.18 }); noise(0.06, { vol: 0.05, from: 3000, to: 5000, delay: i * 0.18 }) } },
  toggle: (on) => tone(on ? 880 : 440, { type: 'triangle', dur: 0.06, vol: 0.1, slide: on ? 1.5 : 0.66 }),
}

export function toggleMute() {
  muted = !muted
  if (drone) drone.gain.value = muted ? 0 : DRONE * 3
  return muted
}
