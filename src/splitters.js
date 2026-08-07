/**
 * Draggable splitters: the sidebar/map divider and the map/analytics divider.
 *
 * Both are grid tracks, not overlays. `#app` is `var(--panel-w) var(--split) 1fr`
 * and `#map-wrap` is `1fr var(--split) var(--dash-h)`, so dragging a splitter is
 * only ever "write one CSS custom property" -- the browser reflows the grid and
 * nothing has to be positioned by hand or kept in sync.
 *
 * Four things this has to get right:
 *
 *  - **Measure the pane, never the custom property.** The stylesheet's defaults
 *    are viewport-relative (`--dash-h: 57vh`), so reading the property back gives
 *    the string "57vh" -- and `parseFloat` happily turns that into the number 57.
 *    An arrow-key press computed from that would collapse the panel to ~57px. The
 *    current size therefore always comes from the pane's own
 *    `getBoundingClientRect()`, which is in px whatever the CSS said.
 *  - **Don't write a px override until asked.** Publishing a measured px value at
 *    boot would freeze the layout for visitors who never touch a splitter, and an
 *    inline style would also beat the mobile `62vh` media query. Until the first
 *    drag or a restore from storage, the stylesheet stays in charge.
 *  - **Pointer capture**, so a fast drag that leaves the 8px strip keeps tracking
 *    instead of dropping the gesture onto the map canvas.
 *  - **Clamping**, so neither pane can be dragged into uselessness. The analytics
 *    floor is 56px rather than 0 because there is no button to bring the panel
 *    back -- the splitter is the only handle, and a 0px pane is unhittable.
 *
 * Keyboard operation is not optional: these are focusable `role="separator"`
 * elements that respond to arrows, Home and End.
 */

const STORE_KEY = 'twa:layout'

/**
 * Space above the divider a drag must never eat, on top of the site header:
 * the map's mat, the splitter track, and a strip of map canvas still worth
 * looking at. Undersized, this is how the map ends up a letterbox -- the
 * analytics get the window and the pane that matters gets the remainder.
 */
const MAP_RESERVE = 250

/** Height of the site header band, which is outside both resizable panes. */
function headerHeight() {
  const el = document.querySelector('.topbar')
  return el ? el.getBoundingClientRect().height : 0
}

const AXES = {
  panel: {
    prop: '--panel-w',
    min: 268,
    max: () => Math.max(300, Math.min(640, window.innerWidth * 0.6)),
    /** Live size, straight off the pane -- always px, whatever unit the CSS used. */
    current: () => document.getElementById('panel').getBoundingClientRect().width,
    /** Pointer position -> desired sidebar width. */
    measure: (e) => e.clientX - document.getElementById('app').getBoundingClientRect().left,
    keys: { less: 'ArrowLeft', more: 'ArrowRight' },
  },
  dash: {
    prop: '--dash-h',
    min: 56,
    // The site header sits outside both panes, so its band comes off the
    // viewport before the reserve -- otherwise the reserve is spent on chrome
    // and the map keeps whatever is left.
    max: () => Math.max(120, window.innerHeight - MAP_RESERVE - headerHeight()),
    current: () => document.getElementById('dash').getBoundingClientRect().height,
    /** Pointer position -> desired analytics height. */
    measure: (e) => document.getElementById('map-wrap').getBoundingClientRect().bottom - e.clientY,
    keys: { less: 'ArrowDown', more: 'ArrowUp' },
  },
}

function clamp(axis, px) {
  return Math.round(Math.min(axis.max(), Math.max(axis.min, px)))
}

function read() {
  try {
    return JSON.parse(window.localStorage.getItem(STORE_KEY) || '{}')
  } catch {
    return {}
  }
}

function write(state) {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(state))
  } catch { /* private-mode browsers throw; the layout just won't persist */ }
}

/**
 * @param {{ onResize?: () => void }} opts  called on every applied size change --
 *        Mapbox needs an explicit resize() when its container changes; the charts
 *        pick it up through their own ResizeObserver.
 */
export function createSplitters({ onResize = () => {} } = {}) {
  const saved = read()
  const handles = {
    panel: document.querySelector('[data-split="panel"]'),
    dash: document.querySelector('[data-split="dash"]'),
  }

  /** Report the pane's real size to assistive tech. Never writes CSS. */
  function publish(name) {
    const axis = AXES[name]
    const el = handles[name]
    if (!el) return
    el.setAttribute('aria-valuenow', String(Math.round(axis.current())))
    el.setAttribute('aria-valuemin', String(axis.min))
    el.setAttribute('aria-valuemax', String(Math.round(axis.max())))
  }

  function apply(name, px, { persist = true } = {}) {
    const axis = AXES[name]
    const value = clamp(axis, px)
    document.documentElement.style.setProperty(axis.prop, `${value}px`)
    publish(name)
    if (persist) {
      saved[name] = value
      write(saved)
    }
    onResize()
  }

  for (const [name, el] of Object.entries(handles)) {
    if (!el) continue
    const axis = AXES[name]

    // Restore a stored size; otherwise leave the stylesheet's (viewport-relative)
    // default completely alone and only report where the divider currently sits.
    if (typeof saved[name] === 'number') apply(name, saved[name], { persist: false })
    else publish(name)

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return // ignore secondary buttons
      e.preventDefault()
      el.setPointerCapture(e.pointerId)
      el.classList.add('dragging')
      document.body.classList.add(name === 'panel' ? 'resizing-col' : 'resizing-row')

      const move = (ev) => apply(name, axis.measure(ev), { persist: false })
      const end = (ev) => {
        try { el.releasePointerCapture(ev.pointerId) } catch { /* already released */ }
        el.classList.remove('dragging')
        document.body.classList.remove('resizing-col', 'resizing-row')
        el.removeEventListener('pointermove', move)
        el.removeEventListener('pointerup', end)
        el.removeEventListener('pointercancel', end)
        apply(name, axis.measure(ev)) // persist once, at the end of the gesture
      }
      el.addEventListener('pointermove', move)
      el.addEventListener('pointerup', end)
      el.addEventListener('pointercancel', end)
    })

    el.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 48 : 16
      if (e.key === axis.keys.less) apply(name, axis.current() - step)
      else if (e.key === axis.keys.more) apply(name, axis.current() + step)
      else if (e.key === 'Home') apply(name, axis.min)
      else if (e.key === 'End') apply(name, axis.max())
      else return
      e.preventDefault()
    })

    // Double-click clears the override so the stylesheet's default -- which is
    // viewport-relative, and mode-specific on mobile -- takes over again.
    el.addEventListener('dblclick', () => {
      document.documentElement.style.removeProperty(axis.prop)
      delete saved[name]
      write(saved)
      onResize()
      requestAnimationFrame(() => publish(name)) // measure after the reflow
    })
  }

  // A viewport change can put a stored size outside its clamp. Only re-clamp panes
  // that actually carry an override; the rest are the stylesheet's business.
  window.addEventListener('resize', () => {
    for (const [name, axis] of Object.entries(AXES)) {
      const override = document.documentElement.style.getPropertyValue(axis.prop)
      if (!override) { publish(name); continue }
      const px = parseFloat(override)
      if (Number.isFinite(px)) apply(name, px, { persist: false })
    }
  })
}
