// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
//
// The scene library, seen from the splice tool (2026-10-13-2236 plan, U12,
// KTD9, KTD13): which scenes the store offers, whether a value is one a
// setting keeps, and the slide a library insert writes.
//
// NONE OF IT IS RESTATED HERE. ./library-core.mjs is the editor's own reading
// (slides/src/beta/libraryread.ts with what it imports), bundled by
// scripts/build-beta-plugin-library.mjs because this directory may import
// nothing outside plugins/beta-slides/ (KTD11); CI fails when it is stale.
// So the scenes offered here are the scenes the editor's gallery offers, an
// insert writes the slide the gallery writes, and a value is checked by the
// settings panel's own coerce. This file only adapts that to the tool:
// presets by name, values over a preset, and refusals that name the key.

import { gatedProps, readManifest, runtimeSlideWith, valueRefusal, valuesFor as presetValues } from './library-core.mjs'

/** A slide's settings as the shell keeps them on load: what a values edit may name. */
export { gatedProps }

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

export const LIBRARY_ID = /^[a-z][a-z0-9-]{0,39}$/

/**
 * The scenes a manifest offers, by id; `skipped` names the ones the editor's
 * gallery leaves off too. Throws when the JSON is not a library manifest.
 */
export function readLibrary(json) {
  const read = readManifest(json)
  if (!read) throw new Error('the store answered with something that is not a scene library manifest')
  const scenes = new Map(read.map((s) => [s.id, s]))
  const skipped = []
  for (const raw of json.scenes) {
    const id = isObject(raw) && typeof raw.id === 'string' ? raw.id : '(no id)'
    if (!scenes.has(id) || scenes.get(id).name !== raw?.name) skipped.push(`${id}: does not read cleanly, and the editor's gallery leaves it off too`)
  }
  return { scenes, skipped }
}

/** Why `v` is not a value this setting keeps as given (the panel's own coerce), or null. */
export const settingRefusal = (prop, v) => valueRefusal(prop, v)

/** Every key declared, every value one its setting keeps as given; throws naming the first that is not. */
export function checkValues(props, values, where) {
  if (!isObject(values)) throw new Error(`${where}: values must be an object of setting: value`)
  for (const [k, v] of Object.entries(values)) {
    const prop = props.find((p) => p && p.key === k)
    if (!prop) throw new Error(`${where}: "${k}" is not one of its settings (${props.map((p) => p.key).join(', ') || 'it has none'})`)
    const why = valueRefusal(prop, v)
    if (why) throw new Error(`${where}: "${k}" ${JSON.stringify(v)}: ${why}`)
  }
}

/**
 * The values a library insert writes: the preset's (by name; the first when
 * none is named), every other setting its default, and `values` over them.
 * Throws naming the preset or the key that is wrong.
 */
export function valuesFor(scene, { preset, values = {} } = {}) {
  let chosen = scene.presets[0]
  if (preset !== undefined) {
    chosen = scene.presets.find((p) => p.name === preset)
    if (!chosen) throw new Error(`library scene "${scene.id}" has no preset ${JSON.stringify(preset)} (it has ${scene.presets.map((p) => JSON.stringify(p.name)).join(', ') || 'none'})`)
  }
  checkValues(scene.props, values, `library scene "${scene.id}"`)
  const out = presetValues(scene, chosen)
  for (const p of scene.props) if (hasOwn(values, p.key)) out[p.key] = values[p.key]
  return out
}

/** The runtime slide a library insert writes: the gallery's slide (runtimeSlideWith), under the id the edit names. */
export function librarySlide(doc, scene, values, id) {
  const slide = runtimeSlideWith(doc, scene, values)
  if (!slide) throw new Error(`library scene "${scene.id}" could not be written as a slide the shell keeps`)
  slide.id = id
  return slide
}
