// Findings inbox: turns raw findings into a short list of things worth looking at.
// kind: fix (breaks the architecture / fails at runtime) · improve (design drift) · check (maybe a problem, or a blind spot)


const ORDER = { fix: 0, improve: 1, check: 2 }
const SEVW = { critical: 3, major: 2, minor: 1 }

const storeKey = (A) => `sprawler:${A.project.name}:inbox`
export function loadMarks(A) {
  try { return JSON.parse(localStorage.getItem(storeKey(A)) || '{}') } catch { return {} }
}
export function mark(A, id, state, count) {
  const m = loadMarks(A)
  if (!state) delete m[id]
  else m[id] = { state, count, at: Date.now(), until: state === 'snooze' ? Date.now() + 7 * 864e5 : null }
  localStorage.setItem(storeKey(A), JSON.stringify(m))
}
// open · worse (marked done, but it grew) · done · snooze
export function status(item, marks) {
  const m = marks[item.id]
  if (!m) return 'open'
  if (m.state === 'snooze' && Date.now() > m.until) return 'open'
  if (m.state === 'done' && item.count > m.count) return 'worse'
  return m.state
}
export const visible = (st) => st === 'open' || st === 'worse'

// The core builds the inbox (sprawler_domain::inbox) and ships it in the atlas, so the UI, the CLI
// (`sprawler check --json`) and agents all see the same list. Done / snoozed marks stay in the browser.
export function buildInbox(A) {
  return A.inbox || []
}

export function summarize(A) {
  const marks = loadMarks(A)
  const out = { fix: 0, improve: 0, check: 0 }
  for (const it of buildInbox(A)) if (visible(status(it, marks))) out[it.kind]++
  return out
}
