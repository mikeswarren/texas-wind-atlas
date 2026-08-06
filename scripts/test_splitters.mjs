/**
 * Exercise src/splitters.js against a minimal DOM stub -- no browser involved.
 * Checks the clamp/measure arithmetic and, specifically, that a keyboard nudge is
 * computed from the pane's real px size and not from the "57vh" custom property.
 *
 * Prints one line on success. Pass -v (or let it fail) for the full report.
 */
const VERBOSE = process.argv.includes('-v')
const out = []
const say = (...a) => out.push(a.join(' '))
let checks = 0
const WIN = { w: 1680, h: 1050 }
const panes = { panel: { width: 372 }, dash: { height: Math.round(WIN.h * 0.57) } }

const inline = new Map()
const listeners = {} // "name:type" -> fn
let resizeHandler = null
let onResizeCalls = 0

const handle = (name) => ({
  attrs: {},
  classList: { add() {}, remove() {} },
  setAttribute(k, v) { this.attrs[k] = v },
  addEventListener(type, fn) { listeners[`${name}:${type}`] = fn },
  removeEventListener(type) { delete listeners[`${name}:${type}`] },
  setPointerCapture() {}, releasePointerCapture() {},
})
const handles = { panel: handle('panel'), dash: handle('dash') }

globalThis.document = {
  documentElement: {
    style: {
      setProperty: (k, v) => inline.set(k, v),
      getPropertyValue: (k) => inline.get(k) || '',
      removeProperty: (k) => inline.delete(k),
    },
  },
  getElementById: (id) => {
    if (id === 'panel') return { getBoundingClientRect: () => ({ width: panes.panel.width }) }
    if (id === 'dash') return { getBoundingClientRect: () => ({ height: panes.dash.height }) }
    if (id === 'app') return { getBoundingClientRect: () => ({ left: 0 }) }
    if (id === 'map-wrap') return { getBoundingClientRect: () => ({ bottom: WIN.h }) }
    return null
  },
  querySelector: (sel) => (sel.includes('panel') ? handles.panel : handles.dash),
  body: { classList: { add() {}, remove() {} } },
}
const store = new Map()
globalThis.window = {
  get innerWidth() { return WIN.w },
  get innerHeight() { return WIN.h },
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
  },
  addEventListener: (type, fn) => { if (type === 'resize') resizeHandler = fn },
}
globalThis.requestAnimationFrame = (fn) => fn()

const { createSplitters } = await import(new URL('../src/splitters.js', import.meta.url))

let fails = 0
const check = (label, got, want) => {
  const ok = String(got) === String(want)
  checks++
  if (!ok) fails++
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: got ${got}${ok ? '' : `, want ${want}`}`)
}

say('1. boot with nothing stored -- must NOT write a px override')
createSplitters({ onResize: () => { onResizeCalls++ } })
check('--panel-w override', inline.get('--panel-w') || '(none)', '(none)')
check('--dash-h override', inline.get('--dash-h') || '(none)', '(none)')
check('panel aria-valuenow', handles.panel.attrs['aria-valuenow'], '372')
check('dash aria-valuenow', handles.dash.attrs['aria-valuenow'], '599')
check('dash aria-valuemax', handles.dash.attrs['aria-valuemax'], '860') // h - 190
check('onResize not called at boot', onResizeCalls, 0)

say('\n2. ArrowUp on the analytics splitter -- from 599px, not from "57vh"')
listeners['dash:keydown']({ key: 'ArrowUp', shiftKey: false, preventDefault() {} })
check('--dash-h', inline.get('--dash-h'), '615px') // 599 + 16
say('     (the bug this guards: parseFloat("57vh") -> 57, then 57+16 = 73px)')

say('\n3. Shift+ArrowDown is a coarse step')
panes.dash.height = 615
listeners['dash:keydown']({ key: 'ArrowDown', shiftKey: true, preventDefault() {} })
check('--dash-h', inline.get('--dash-h'), '567px') // 615 - 48

say('\n4. clamping at both ends')
panes.dash.height = 567
listeners['dash:keydown']({ key: 'Home', shiftKey: false, preventDefault() {} })
check('Home -> floor', inline.get('--dash-h'), '56px')
listeners['dash:keydown']({ key: 'End', shiftKey: false, preventDefault() {} })
check('End -> ceiling', inline.get('--dash-h'), '860px')

say('\n5. drag the sidebar: pointer at x=520 -> 520px wide')
listeners['panel:pointerdown']({ button: 0, pointerId: 1, preventDefault() {} })
listeners['panel:pointermove']({ clientX: 520 })
check('--panel-w mid-drag', inline.get('--panel-w'), '520px')
// Storage already holds a dash size from the keyboard steps above, so assert on
// the panel key specifically: it must not appear until the gesture ends.
check('panel not persisted mid-drag', 'panel' in JSON.parse(store.get('twa:layout') || '{}'), false)
listeners['panel:pointerup']({ pointerId: 1, clientX: 520 })
check('persisted on release', JSON.parse(store.get('twa:layout')).panel, 520)

say('\n6. sidebar clamps: pointer at x=60 and x=1600')
listeners['panel:pointerdown']({ button: 0, pointerId: 2, preventDefault() {} })
listeners['panel:pointermove']({ clientX: 60 })
check('floor', inline.get('--panel-w'), '268px')
listeners['panel:pointermove']({ clientX: 1600 })
check('ceiling (min(640, 60vw))', inline.get('--panel-w'), '640px')
listeners['panel:pointerup']({ pointerId: 2, clientX: 1600 })

say('\n7. analytics drag: pointer at y=700 -> 350px tall (1050 - 700)')
listeners['dash:pointerdown']({ button: 0, pointerId: 3, preventDefault() {} })
listeners['dash:pointermove']({ clientY: 700 })
check('--dash-h', inline.get('--dash-h'), '350px')
listeners['dash:pointerup']({ pointerId: 3, clientY: 700 })

say('\n8. double-click resets to the stylesheet default')
listeners['dash:dblclick']({})
check('--dash-h cleared', inline.get('--dash-h') || '(none)', '(none)')
check('dash dropped from storage', 'dash' in JSON.parse(store.get('twa:layout')), false)

say('\n9. window resize must not invent a px value for an un-dragged pane')
inline.delete('--panel-w')
store.clear()
resizeHandler()
check('--panel-w still unset', inline.get('--panel-w') || '(none)', '(none)')

say('\n10. a stored size wider than a shrunken window gets re-clamped')
inline.set('--panel-w', '640px')
WIN.w = 700 // 60vw = 420
resizeHandler()
check('--panel-w re-clamped', inline.get('--panel-w'), '420px')

if (fails || VERBOSE) {
  console.log(out.join('\n'))
  console.log(`\n${fails === 0 ? 'ALL CHECKS PASS' : `${fails} FAILURE(S)`}`)
} else {
  console.log(`Splitter layout OK \u2014 ${checks} checks passed.`)
}
process.exit(fails === 0 ? 0 : 1)
