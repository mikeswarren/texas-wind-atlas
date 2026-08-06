/**
 * The chart toolkit behind the analytics dashboard.
 *
 * Hand-rolled SVG rather than a charting library: the atlas already ships 1.9 MB
 * of Mapbox GL, and four chart forms with a shared spec is far less code than a
 * library plus the config needed to talk it out of its defaults.
 *
 * The specs below are fixed and deliberate, not taste:
 *  - bars cap at 18px and never fill their slot; 4px rounded data-end, square at
 *    the baseline; a 2px surface-coloured gap does the separating, never a stroke
 *  - lines are 2px with round joins; end markers are r>=4 with a 2px surface ring
 *  - area fills are the series hue at ~10% -- a wash, never a saturated block
 *  - grid and axis rules are solid 1px one step off the surface, never dashed
 *  - direct labels are SELECTIVE (the endpoint, the extreme). Never a number on
 *    every mark; the axis, the tooltip and the table view carry the rest
 *  - text wears ink tokens only. Identity comes from a coloured mark beside the
 *    text, never from coloured text
 *  - every hover target is at least 24px on its short axis, which is usually
 *    larger than the mark it belongs to
 *
 * Every chart exposes the same shape: `{ update(data), destroy() }`, and every
 * chart's data is also rendered as a real <table> by the dashboard's table view,
 * so no value is reachable only by hovering.
 */

import { INK, SERIES } from './config.js'

const NS = 'http://www.w3.org/2000/svg'

/** Bar/column geometry. */
const BAR_MAX = 18
const GAP = 2
const HIT_MIN = 24

function el(name, attrs = {}) {
  const node = document.createElementNS(NS, name)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  return node
}

function text(x, y, str, cls = 'c-label', anchor = 'start') {
  const t = el('text', { x, y, 'text-anchor': anchor, class: cls })
  t.textContent = str
  return t
}

/**
 * Text measurement, so a label is fitted rather than guessed at.
 *
 * "Siemens Gamesa Renewable Energy" and "Glasscock County" both overflowed a
 * gutter sized by a character-count estimate, and an overflowing SVG label is
 * silently cropped by the viewBox -- the reader gets "newable Energy". One
 * shared canvas context measures the real string, so the ellipsis lands where
 * the text actually stops fitting.
 */
const LABEL_FONT = '11px system-ui, -apple-system, "Segoe UI", sans-serif'
let measureCtx = null

function textWidth(str, font = LABEL_FONT) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d')
  measureCtx.font = font
  return measureCtx.measureText(str).width
}

/** Truncate to fit `maxW`, with an ellipsis. The full string stays in the tooltip. */
function fitText(str, maxW, font = LABEL_FONT) {
  if (maxW <= 0) return ''
  if (textWidth(str, font) <= maxW) return str
  let s = String(str)
  while (s.length > 1 && textWidth(`${s}…`, font) > maxW) s = s.slice(0, -1)
  return `${s}…`
}

/** Column with a rounded cap and a square baseline. */
function columnPath(x, y, w, h, r = 4) {
  const rad = Math.min(r, w / 2, h)
  if (h <= 0.5) return `M${x} ${y + h} h${w}`
  return `M${x} ${y + h} V${y + rad} a${rad} ${rad} 0 0 1 ${rad} ${-rad} h${w - 2 * rad} a${rad} ${rad} 0 0 1 ${rad} ${rad} V${y + h} Z`
}

/** Horizontal bar with a rounded right end and a square origin. */
function barPath(x, y, w, h, r = 4) {
  const rad = Math.min(r, h / 2, w)
  if (w <= 0.5) return `M${x} ${y} v${h}`
  return `M${x} ${y} H${x + w - rad} a${rad} ${rad} 0 0 1 ${rad} ${rad} V${y + h - rad} a${rad} ${rad} 0 0 1 ${-rad} ${rad} H${x} Z`
}

/**
 * Clean axis ticks. Round numbers only (0 / 1,000 / 2,000) -- the ticks carry
 * every value that isn't directly labelled, so they have to be readable.
 */
function ticks(max, count = 3) {
  if (!(max > 0)) return [0]
  const raw = max / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag
  const out = []
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(v)
  return out
}

/** One shared tooltip per chart container. */
function makeTip(container) {
  const tip = document.createElement('div')
  tip.className = 'c-tip'
  tip.hidden = true
  container.appendChild(tip)
  return {
    node: tip,
    show(html, x, y, w) {
      tip.innerHTML = html
      tip.hidden = false
      tip.style.left = `${Math.max(52, Math.min(w - 52, x))}px`
      tip.style.top = `${Math.max(2, y)}px`
    },
    hide() { tip.hidden = true },
  }
}

/** Re-render on resize; every chart is width-driven. */
function autosize(container, draw) {
  const ro = new ResizeObserver(() => draw())
  ro.observe(container)
  return () => ro.disconnect()
}

/* ------------------------------------------------------------- area chart */

/**
 * A single cumulative series over time, with everything after the selected year
 * de-emphasised rather than hidden -- so the reader sees where the current year
 * sits in the whole build-out instead of a chart that changes length.
 *
 * One measure, one axis. Capacity added per year lives in its own chart in the
 * sidebar; putting a flow and a stock on shared axes would need two y-scales,
 * and a dual-axis chart invents a correlation that isn't in the data.
 */
export function createAreaChart(container, { unit = '', format = String, tickFormat = null }) {
  const tip = makeTip(container)
  const tick = tickFormat || format
  let svg = null
  let state = { points: [], at: 0 }

  function draw() {
    const { points, at } = state
    if (!points.length) return
    const w = container.clientWidth || 320
    const h = container.clientHeight || 132
    const padT = 10
    const padB = 16
    const padR = 8
    const padL = 30
    const plotW = Math.max(10, w - padL - padR)
    const plotH = Math.max(10, h - padT - padB)

    if (svg) svg.remove()
    svg = el('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}`, role: 'img' })

    const max = Math.max(...points.map((p) => p.value), 1)
    const tk = ticks(max)
    const top = tk[tk.length - 1]
    const X = (i) => padL + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW)
    const Y = (v) => padT + plotH - (v / top) * plotH

    for (const t of tk) {
      svg.appendChild(el('line', {
        x1: padL, x2: padL + plotW, y1: Y(t), y2: Y(t),
        stroke: t === 0 ? INK.axis : INK.grid, 'stroke-width': 1,
      }))
      svg.appendChild(text(padL - 5, Y(t) + 3, tick(t), 'c-tick', 'end'))
    }

    const line = (from, to) => points.slice(from, to + 1)
      .map((p, k) => `${k ? 'L' : 'M'}${X(from + k).toFixed(1)} ${Y(p.value).toFixed(1)}`).join('')

    // Area wash under the realised part only.
    if (at > 0) {
      const area = `${line(0, at)}L${X(at).toFixed(1)} ${Y(0)}L${X(0).toFixed(1)} ${Y(0)}Z`
      svg.appendChild(el('path', { d: area, fill: SERIES.standing, 'fill-opacity': 0.1, stroke: 'none' }))
    }
    // Not-yet-built tail: present but recessive, so the axis never rescales.
    if (at < points.length - 1) {
      svg.appendChild(el('path', {
        d: line(at, points.length - 1), fill: 'none', stroke: INK.axis,
        'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      }))
    }
    svg.appendChild(el('path', {
      d: line(0, at), fill: 'none', stroke: SERIES.standing,
      'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    }))

    // End marker + the one direct label this chart gets.
    const cx = X(at)
    const cy = Y(points[at].value)
    svg.appendChild(el('circle', { cx, cy, r: 5, fill: SERIES.standing, stroke: INK.surface, 'stroke-width': 2 }))
    const label = `${format(points[at].value)}${unit ? ` ${unit}` : ''}`
    const flip = cx > padL + plotW * 0.72
    svg.appendChild(text(flip ? cx - 9 : cx + 9, Math.max(padT + 9, cy - 7), label, 'c-value', flip ? 'end' : 'start'))

    svg.appendChild(text(padL, h - 3, points[0].label, 'c-tick', 'start'))
    svg.appendChild(text(padL + plotW, h - 3, points[points.length - 1].label, 'c-tick', 'end'))

    // Nearest-point hover band across the full height.
    const band = plotW / Math.max(1, points.length - 1)
    points.forEach((p, i) => {
      const hit = el('rect', {
        x: X(i) - Math.max(band, HIT_MIN) / 2, y: 0,
        width: Math.max(band, HIT_MIN), height: h, fill: 'transparent', class: 'c-hit',
      })
      hit.addEventListener('pointerenter', () => {
        tip.show(
          `<b>${p.label}</b> · ${format(p.value)} ${unit}` +
          (p.note ? `<br><span class="c-tip-sub">${p.note}</span>` : ''),
          X(i), Math.max(2, Y(p.value) - 34), w
        )
      })
      hit.addEventListener('pointerleave', tip.hide)
      svg.appendChild(hit)
    })

    container.insertBefore(svg, tip.node)
  }

  const stop = autosize(container, draw)
  return {
    update({ points, at }) { state = { points, at }; draw() },
    destroy: stop,
  }
}

/* ------------------------------------------------------------- line chart */

/**
 * Two series on ONE axis -- legal here only because both are measured in metres.
 * Any pair of measures on different scales gets two charts instead; that is the
 * dual-axis trap and it is not negotiable.
 */
export function createLineChart(container, { series, unit = '', format = String, tickFormat = null }) {
  const tip = makeTip(container)
  const tick = tickFormat || format
  let svg = null
  let state = { labels: [], values: [], at: 0 }

  function draw() {
    const { labels, values, at } = state
    if (!labels.length) return
    const w = container.clientWidth || 320
    const h = container.clientHeight || 132
    const padT = 10
    const padB = 16
    const padR = 8
    const padL = 30
    const plotW = Math.max(10, w - padL - padR)
    const plotH = Math.max(10, h - padT - padB)

    if (svg) svg.remove()
    svg = el('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}`, role: 'img' })

    const all = values.flat().filter((v) => v != null)
    const max = all.length ? Math.max(...all) : 1
    const tk = ticks(max)
    const top = tk[tk.length - 1]
    const X = (i) => padL + (labels.length === 1 ? plotW / 2 : (i / (labels.length - 1)) * plotW)
    const Y = (v) => padT + plotH - (v / top) * plotH

    for (const t of tk) {
      svg.appendChild(el('line', {
        x1: padL, x2: padL + plotW, y1: Y(t), y2: Y(t),
        stroke: t === 0 ? INK.axis : INK.grid, 'stroke-width': 1,
      }))
      svg.appendChild(text(padL - 5, Y(t) + 3, tick(t), 'c-tick', 'end'))
    }

    series.forEach((s, si) => {
      const vals = values[si]
      // Break the path across gaps rather than interpolating over missing years.
      let d = ''
      let open = false
      for (let i = 0; i <= at; i++) {
        const v = vals[i]
        if (v == null) { open = false; continue }
        d += `${open ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`
        open = true
      }
      if (d) {
        svg.appendChild(el('path', {
          d, fill: 'none', stroke: s.color, 'stroke-width': 2,
          'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        }))
      }
      const last = vals[at]
      if (last != null) {
        svg.appendChild(el('circle', {
          cx: X(at), cy: Y(last), r: 4.5, fill: s.color, stroke: INK.surface, 'stroke-width': 2,
        }))
      }
    })

    // Direct end labels for both series, in ink -- never in the series colour.
    const ends = series
      .map((s, si) => ({ s, v: values[si][at] }))
      .filter((e) => e.v != null)
      .sort((a, b) => a.v - b.v)
    ends.forEach((e, k) => {
      // Two labels at the same height detach from their lines; nudge only when
      // they would actually collide.
      const nudge = ends.length === 2 && Math.abs(Y(ends[0].v) - Y(ends[1].v)) < 13 ? (k === 0 ? 7 : -7) : 0
      // Clamp inside the plot band. The rotor series tops out at the y-max, so
      // its label sat above padT and the viewBox cropped it in half.
      const y = Math.min(padT + plotH - 1, Math.max(padT + 8, Y(e.v) + 3 + nudge))
      svg.appendChild(text(X(at) - 9, y, format(e.v), 'c-value', 'end'))
    })

    svg.appendChild(text(padL, h - 3, labels[0], 'c-tick', 'start'))
    svg.appendChild(text(padL + plotW, h - 3, labels[labels.length - 1], 'c-tick', 'end'))

    const band = plotW / Math.max(1, labels.length - 1)
    labels.forEach((label, i) => {
      const hit = el('rect', {
        x: X(i) - Math.max(band, HIT_MIN) / 2, y: 0,
        width: Math.max(band, HIT_MIN), height: h, fill: 'transparent', class: 'c-hit',
      })
      hit.addEventListener('pointerenter', () => {
        const rows = series.map((s, si) => values[si][i] == null
          ? ''
          : `<span class="c-key" style="background:${s.color}"></span>${s.name} ${format(values[si][i])} ${unit}`)
          .filter(Boolean).join('<br>')
        tip.show(`<b>${label}</b><br><span class="c-tip-sub">${rows}</span>`, X(i), padT, w)
      })
      hit.addEventListener('pointerleave', tip.hide)
      svg.appendChild(hit)
    })

    container.insertBefore(svg, tip.node)
  }

  const stop = autosize(container, draw)
  return {
    update({ labels, values, at }) { state = { labels, values, at }; draw() },
    destroy: stop,
  }
}

/* ------------------------------------------------------------ ranked bars */

/**
 * Horizontal ranked bars: one hue for every bar. A darker-where-bigger ramp
 * would double-encode length as colour and buy nothing.
 *
 * Values live in a fixed right-hand gutter rather than floating at the bar tip,
 * which is what guarantees a label is never clipped by a short bar and never
 * overflows the card -- no text measurement needed.
 */
export function createRankedBars(container, { format = String, unit = '', noun = 'rows', onPick = null }) {
  const tip = makeTip(container)
  let svg = null
  let state = { rows: [], total: 0, other: null }

  function draw() {
    const { rows, total, other } = state
    if (!rows.length) {
      if (svg) svg.remove()
      svg = null
      return
    }
    const w = container.clientWidth || 320
    const gutterL = Math.min(136, Math.max(88, Math.round(w * 0.36)))
    const gutterR = 54
    const plotW = Math.max(10, w - gutterL - gutterR)
    const rowH = Math.max(HIT_MIN, BAR_MAX + GAP * 2)
    const captionH = other ? 20 : 0
    const h = rows.length * rowH + 2 + captionH

    if (svg) svg.remove()
    svg = el('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}`, role: 'img' })

    // Scale to the ranked rows only. The tail is a caption, not a bar, so it
    // cannot flatten the ranking it is the remainder of.
    const max = Math.max(...rows.map((r) => r.value), 1)
    const labelW = gutterL - 10

    rows.forEach((r, i) => {
      const yBand = i * rowH + 1
      const barH = BAR_MAX
      const y = yBand + (rowH - barH) / 2
      const bw = (r.value / max) * plotW
      const clickable = Boolean(onPick)

      const hit = el('rect', {
        x: 0, y: yBand, width: w, height: rowH,
        fill: 'transparent', class: clickable ? 'c-hit c-hit-click' : 'c-hit',
      })

      svg.appendChild(el('path', {
        d: barPath(gutterL, y, Math.max(1, bw), barH),
        fill: SERIES.standing,
        class: 'c-bar',
      }))

      const shown = fitText(r.label, labelW)
      const cat = text(gutterL - 8, y + barH / 2 + 3.5, shown, 'c-cat', 'end')
      // A truncated label still needs to be readable somewhere without a mouse.
      if (shown !== r.label) {
        const title = document.createElementNS(NS, 'title')
        title.textContent = r.label
        cat.appendChild(title)
      }
      svg.appendChild(cat)
      svg.appendChild(text(w - 4, y + barH / 2 + 3.5, format(r.value), 'c-value', 'end'))

      hit.addEventListener('pointerenter', () => {
        const share = total ? ` · ${((r.value / total) * 100).toFixed(1)}% of total` : ''
        tip.show(
          `<b>${r.label}</b><br><span class="c-tip-sub">${format(r.value)} ${unit}${share}` +
          `${clickable ? '<br>Click to filter' : ''}</span>`,
          gutterL + Math.min(bw, plotW) / 2, Math.max(2, yBand - 30), w
        )
      })
      hit.addEventListener('pointerleave', tip.hide)
      if (clickable) hit.addEventListener('click', () => onPick(r))
      svg.appendChild(hit)
    })

    // Never a silent truncation: say exactly what the top-N leaves out.
    if (other) {
      const pct = total ? ` · ${((other.value / total) * 100).toFixed(0)}% of total` : ''
      // Left-anchored, not end-anchored on the label gutter: "+ 16 more
      // manufacturers" is wider than the gutter and ran off the left edge.
      svg.appendChild(text(
        2, rows.length * rowH + 14,
        `+ ${other.count} more ${noun}`, 'c-tick', 'start'
      ))
      svg.appendChild(text(
        w - 4, rows.length * rowH + 14,
        `${format(other.value)}${pct}`, 'c-tick', 'end'
      ))
    }

    container.insertBefore(svg, tip.node)
  }

  const stop = autosize(container, draw)
  return {
    update({ rows, total, other = null }) { state = { rows, total, other }; draw() },
    destroy: stop,
  }
}

/* --------------------------------------------------------------- histogram */

/**
 * Ordered bins, one hue. Only the tallest column is directly labelled -- a
 * number on all seven is noise, and the axis plus the tooltip carry the rest.
 */
export function createHistogram(container, { format = String, unit = '', tickFormat = null }) {
  const tip = makeTip(container)
  const tick = tickFormat || format
  let svg = null
  let state = { bins: [] }

  function draw() {
    const { bins } = state
    if (!bins.length) return
    const w = container.clientWidth || 320
    const h = container.clientHeight || 132
    const padT = 14
    const padB = 17
    const padL = 30
    const padR = 6
    const plotW = Math.max(10, w - padL - padR)
    const plotH = Math.max(10, h - padT - padB)

    if (svg) svg.remove()
    svg = el('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}`, role: 'img' })

    const max = Math.max(...bins.map((b) => b.value), 1)
    const tk = ticks(max, 2)
    const top = tk[tk.length - 1]
    const Y = (v) => padT + plotH - (v / top) * plotH

    for (const t of tk) {
      svg.appendChild(el('line', {
        x1: padL, x2: padL + plotW, y1: Y(t), y2: Y(t),
        stroke: t === 0 ? INK.axis : INK.grid, 'stroke-width': 1,
      }))
      svg.appendChild(text(padL - 5, Y(t) + 3, tick(t), 'c-tick', 'end'))
    }

    const slot = plotW / bins.length
    const barW = Math.min(BAR_MAX * 1.6, slot - GAP * 2)
    const peak = bins.reduce((best, b, i) => (b.value > bins[best].value ? i : best), 0)

    bins.forEach((b, i) => {
      const cx = padL + slot * (i + 0.5)
      const bh = (b.value / top) * plotH
      svg.appendChild(el('path', {
        d: columnPath(cx - barW / 2, Y(b.value), barW, bh),
        fill: SERIES.standing, class: 'c-bar',
      }))
      if (i === peak && b.value > 0) {
        svg.appendChild(text(cx, Math.max(padT - 3, Y(b.value) - 5), format(b.value), 'c-value', 'middle'))
      }
      svg.appendChild(text(cx, h - 4, b.label, 'c-tick', 'middle'))

      const hit = el('rect', {
        x: cx - Math.max(slot, HIT_MIN) / 2, y: 0,
        width: Math.max(slot, HIT_MIN), height: h, fill: 'transparent', class: 'c-hit',
      })
      hit.addEventListener('pointerenter', () => {
        tip.show(
          `<b>${b.label} MW</b><br><span class="c-tip-sub">${format(b.value)} ${unit}` +
          `${b.note ? ` · ${b.note}` : ''}</span>`,
          cx, Math.max(2, Y(b.value) - 32), w
        )
      })
      hit.addEventListener('pointerleave', tip.hide)
      svg.appendChild(hit)
    })

    container.insertBefore(svg, tip.node)
  }

  const stop = autosize(container, draw)
  return {
    update({ bins }) { state = { bins }; draw() },
    destroy: stop,
  }
}

/* ---------------------------------------------------------------- sparkline */

/**
 * 27-point trend for a stat tile. De-emphasis grey for the series, the accent
 * only on the current year -- the tile's value is the headline, and the spark
 * exists to say "rising" or "flat", not to be read off.
 */
export function sparkline(values, at, w = 74, h = 22) {
  const vals = values.map((v) => (v == null ? null : v))
  const present = vals.filter((v) => v != null)
  if (present.length < 2) return ''
  const max = Math.max(...present)
  const min = Math.min(...present)
  const span = max - min || 1
  const X = (i) => (i / (vals.length - 1)) * (w - 4) + 2
  const Y = (v) => h - 3 - ((v - min) / span) * (h - 6)

  let d = ''
  let open = false
  for (let i = 0; i <= at; i++) {
    if (vals[i] == null) { open = false; continue }
    d += `${open ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(vals[i]).toFixed(1)}`
    open = true
  }
  const cur = vals[at]
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
    ${d ? `<path d="${d}" fill="none" stroke="${INK.axis}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>` : ''}
    ${cur == null ? '' : `<circle cx="${X(at).toFixed(1)}" cy="${Y(cur).toFixed(1)}" r="2.6" fill="${SERIES.added}"/>`}
  </svg>`
}

/* -------------------------------------------------------------- table twin */

/**
 * The WCAG-clean equivalent of a chart. Every dashboard card can swap to this,
 * so no value is reachable by hover alone.
 */
export function renderTable(columns, rows) {
  return `<table class="c-table">
    <thead><tr>${columns.map((c, i) => `<th${i ? ' class="num"' : ''}>${c}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((cell, i) => `<td${i ? ' class="num"' : ''}>${cell}</td>`).join('')}</tr>`).join('')}</tbody>
  </table>`
}
