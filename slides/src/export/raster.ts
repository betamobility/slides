// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
// Browser-side SVG rasteriser for the PPTX exporter (plan U5). The mapper is
// DOM-free; this is the one capability it borrows from the page: markup in,
// PNG data URI out, through the same sanitiser the `svg` element renders with,
// so an embed's `view` or a hostile asset can never reach the canvas raw.

import { sanitizeSvg } from '../render'

const SCALE = 1.5 // enough for a projector; 2x doubled a 60-svg deck to 37 MB
const MAX_SIDE = 2048

export async function rasterizeSvg(markup: string, w: number, h: number): Promise<string | null> {
  try {
    const frag = sanitizeSvg(markup, '#beta-pptx-raster')
    const svg = frag.querySelector('svg')
    if (!svg) return null
    svg.setAttribute('width', String(w))
    svg.setAttribute('height', String(h))
    const xml = new XMLSerializer().serializeToString(svg)
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('svg did not decode'))
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml)
    })
    const canvas = document.createElement('canvas')
    const k = Math.min(SCALE, MAX_SIDE / Math.max(w, h, 1))
    canvas.width = Math.max(1, Math.round(w * k))
    canvas.height = Math.max(1, Math.round(h * k))
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}
