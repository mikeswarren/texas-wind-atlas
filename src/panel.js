/**
 * Panel rendering: stat tiles, the build-out timeline, and the legend.
 *
 * The timeline is one measure only -- megawatts added per year. Cumulative
 * capacity is a stat tile rather than a second line on the same axes, because
 * two measures of different scale on one chart means two y-scales, and that
 * chart is unreadable by construction.
 */

import { SERIES, MW_LEGEND, INK } from './config.js'
import { fmt } from './stats.js'

const SVG_NS = 'http://www.w3.org/2000/svg'

function el(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  return node
}

/** Bar with rounded top corners, anchored flat to the baseline. */
function barPath(x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h)
  if (h <= 0.5) return `M${x} ${y + h} h${w}`
  return `M${x} ${y + h} V${y + rad} a${rad} ${rad} 0 0 1 ${rad} ${-rad} h${w - 2 * rad} a${rad} ${rad} 0 0 1 ${rad} ${rad} V${y + h} Z`
}

export function createTimeline(container, { onPick }) {
  const tip = document.createElement('div')
  tip.className = 'tl-tip'
  tip.hidden = true
  container.appendChild(tip)

  let svg = null
  let state = { perYear: [], year: 0, max: 1 }

  function draw() {
    const { perYear, year, max } = state
    if (!perYear.length) return
    const w = container.clientWidth || 336
    const h = container.clientHeight || 78
    const axisH = 13
    const plotH = h - axisH - 2

    if (svg) svg.remove()
    svg = el('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}` })

    const slot = w / perYear.length
    const gap = Math.min(2, slot * 0.22) // 2px surface gap between bars
    const barW = Math.max(1.5, slot - gap)

    // Baseline -- recessive, not a data mark.
    svg.appendChild(el('line', {
      x1: 0, x2: w, y1: plotH + 1, y2: plotH + 1, stroke: INK.axis, 'stroke-width': 1,
    }))

    perYear.forEach((d, i) => {
      const barH = max > 0 ? (d.addedMw / max) * plotH : 0
      const x = i * slot + gap / 2
      const y = plotH + 1 - barH
      const isYear = d.year === year
      const isFuture = d.year > year
      const path = el('path', {
        d: barPath(x, y, barW, barH, 3),
        // Orange marks the selected year in both the chart and the map, so the
        // two read as the same encoding. Grey = not yet built at this point.
        fill: isYear ? SERIES.added : isFuture ? '#33332f' : SERIES.standing,
        class: 'bar',
      })
      path.dataset.year = d.year
      svg.appendChild(path)

      // Hit target wider than the mark itself.
      const hit = el('rect', {
        x: i * slot, y: 0, width: slot, height: h, fill: 'transparent', class: 'bar',
      })
      hit.dataset.year = d.year
      hit.addEventListener('pointerenter', () => {
        tip.innerHTML = `<b>${d.year}</b> · ${fmt.mw(d.addedMw)} MW added<br>` +
          `<span style="color:${INK.muted}">${fmt.int(d.added)} turbines · ` +
          `${fmt.mw(d.cumulativeMw)} MW standing</span>`
        tip.hidden = false
        const cx = i * slot + slot / 2
        tip.style.left = `${Math.max(60, Math.min(w - 60, cx))}px`
        tip.style.top = `${Math.max(24, y - 6)}px`
      })
      hit.addEventListener('pointerleave', () => { tip.hidden = true })
      hit.addEventListener('click', () => onPick(d.year))
      svg.appendChild(hit)
    })

    // Only the endpoints and the selected year get a label -- never every bar.
    const label = (i, text, anchor) => {
      const t = el('text', {
        x: Math.min(w - 1, Math.max(1, i * slot + slot / 2)),
        y: h - 2,
        'text-anchor': anchor,
        class: 'axis-label',
      })
      t.textContent = text
      svg.appendChild(t)
    }
    label(0, perYear[0].year, 'start')
    label(perYear.length - 1, perYear[perYear.length - 1].year, 'end')

    container.insertBefore(svg, tip)
  }

  const ro = new ResizeObserver(() => draw())
  ro.observe(container)

  return {
    update(index, year) {
      state = { perYear: index.perYear, year, max: index.maxAddedMw || 1 }
      draw()
    },
  }
}

export function updateStats(index, year) {
  const d = index.perYear[year - index.yearMin]
  if (!d) return
  document.getElementById('stat-mw').textContent = fmt.mw(d.cumulativeMw)
  document.getElementById('stat-year').textContent = year
  document.getElementById('stat-turbines').textContent = fmt.int(d.cumulative)
  document.getElementById('stat-counties').textContent = fmt.int(d.counties)
  document.getElementById('stat-hub').textContent = d.medianHub == null ? '—' : fmt.one(d.medianHub)
}

export function renderLegend(mode, year) {
  const box = document.getElementById('legend')
  if (mode === 'counties') {
    box.innerHTML = `
      <div class="ramp">${MW_LEGEND.map((s) => `<span class="ramp-cell" style="background:${s.color}"></span>`).join('')}</div>
      <div class="ramp-scale"><span>none</span><span>1,600+ MW</span></div>
      <p class="legend-note">Installed capacity per county through ${year}. One hue, stepped —
        brighter means more megawatts. In 3D, tower height carries the same value.</p>`
    return
  }
  box.innerHTML = `
    <div class="legend-row">
      <span class="swatch swatch-dot" style="background:${SERIES.added}"></span>
      <span>Commissioned in ${year}</span>
    </div>
    <div class="legend-row">
      <span class="swatch swatch-dot" style="background:${SERIES.standing};border-color:rgba(13,13,13,0.65)"></span>
      <span>Already standing</span>
    </div>
    <p class="legend-note">Circle size scales with nameplate capacity (0.6–6 MW).
      Below zoom 9 the points give way to a capacity-weighted density surface.</p>`
}
