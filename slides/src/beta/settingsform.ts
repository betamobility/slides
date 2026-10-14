// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Beta build: the settings form in the properties panel (2026-10-13-2236
// plan, U10, R13). Drawn from a scene instance's declared settings, the same
// for a runtime slide (its `runtime.props`) and a web scene (its embed's
// `doc.props`); the panel hands over where values are read and written, so
// this file knows nothing about slides, elements or the store.
//
// The hint picks the control: select a dropdown, bool a toggle, range a slider
// with a number field, latlon two number fields; otherwise the kind's own
// control. Every value goes through scenesettings.ts `coerce` first: a value
// held to its range is written and the note says so; a refused one is not
// written, the control goes back to what is stored, and the note says why.
// Applying a preset is one change. In a read-only copy every control is off.

import type { RuntimeProp } from '../model.ts'
import { t } from '../i18n.ts'
import { activePreset, applyPreset, coerce, parseHint, parseLatLon, type Note, type Preset, type Value } from './scenesettings.ts'

export interface SettingsFormHost {
  /** Which scene instance this is (a slide id, an element id): a note outlives the panel's redraw only for its own scene. */
  scope: string
  props: RuntimeProp[]
  /** The values as they are now (read at every change, never cached). */
  values(): Record<string, Value>
  /** Write one setting; `final` ends a burst of input as one undo step. Returns a refusal to show, or null. */
  write(key: string, value: Value, final: boolean): string | null
  /** Write every setting at once, as one change (a preset). */
  writeAll(values: Record<string, Value>): void
  /** The scene's presets, when the library is at hand. */
  presets: Preset[] | null
  readOnly: boolean
  /** The panel's colour control, so a scene's colour offers the deck's palette. */
  color(value: string, onEdit: (v: string, final: boolean) => void): HTMLElement
}

const noteText = (n: Note): string => {
  const vars: Record<string, string> = {}
  if ('value' in n) vars.value = String(n.value)
  if ('min' in n) vars.min = String(n.min)
  if ('max' in n) vars.max = String(n.max)
  return t(n.says, vars)
}

// The panel redraws after every write (and again with the autosave pass), so a
// note that lived only in the DOM would vanish the moment it was earned. Each
// note is kept here with the value it is about, and shown again for as long as
// that value is the stored one; a refusal is kept until the next write to that
// setting.
const notes = new Map<string, { value: Value | undefined; text: string }>()

/** The form, as one element the panel appends. */
export function settingsForm(host: SettingsFormHost): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'ed-scene-settings'
  const now = host.values()

  if (host.presets && host.presets.length) {
    const sel = document.createElement('select')
    sel.dataset.scenePreset = '1'
    const active = activePreset(host.props, now, host.presets)
    const custom = document.createElement('option')
    custom.value = ''
    custom.textContent = t('Custom')
    custom.disabled = true
    sel.appendChild(custom)
    for (const p of host.presets) {
      const o = document.createElement('option')
      o.value = p.name
      o.textContent = p.name // the scene author's words
      sel.appendChild(o)
    }
    sel.value = active ?? ''
    sel.disabled = host.readOnly
    sel.addEventListener('change', () => {
      const preset = host.presets!.find((p) => p.name === sel.value)
      if (preset) host.writeAll(applyPreset(host.props, preset))
    })
    wrap.appendChild(row(t('Preset'), sel))
  }

  for (const prop of host.props) {
    const note = document.createElement('p')
    note.className = 'ed-hint ed-scene-note'
    note.hidden = true
    const id = `${host.scope}\u001f${prop.key}`
    const say = (text: string | null, about?: Value) => {
      note.textContent = text ?? ''
      note.hidden = !text
      if (text) notes.set(id, { value: about, text }); else notes.delete(id)
    }
    const kept = notes.get(id)
    if (kept && (kept.value === undefined || kept.value === now[prop.key])) say(kept.text, kept.value)
    else notes.delete(id)
    /** Coerce, then write; returns what the control should now show. */
    const commit = (input: unknown, final: boolean): Value => {
      const r = coerce(prop, input)
      if (r.value === undefined) { say(r.note ? noteText(r.note) : null); return host.values()[prop.key] }
      // said before the write: the write redraws the panel, which reads it back
      say(r.note ? noteText(r.note) : null, r.value)
      const refused = host.write(prop.key, r.value, final)
      if (refused) { say(t(refused)); return host.values()[prop.key] }
      return r.value
    }
    const control = controlFor(prop, now[prop.key], commit, host)
    control.dataset.sceneSetting = prop.key
    for (const el of [control, ...control.querySelectorAll<HTMLElement>('input, select, button')]) {
      if ('disabled' in el) (el as HTMLInputElement).disabled = host.readOnly
    }
    const r = row(prop.label, control) // the scene author's words: not translated
    wrap.append(r, note)
  }
  return wrap
}

function row(label: string, control: HTMLElement): HTMLElement {
  const r = document.createElement('label')
  r.className = 'ed-row'
  const span = document.createElement('span')
  span.textContent = label
  r.append(span, control)
  return r
}

function controlFor(prop: RuntimeProp, value: Value, commit: (input: unknown, final: boolean) => Value, host: SettingsFormHost): HTMLElement {
  const hint = parseHint(prop.format, prop.kind)
  if (hint?.kind === 'bool') {
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.className = 'ed-toggle'
    cb.checked = value === 1
    cb.addEventListener('change', () => { cb.checked = commit(cb.checked, true) === 1 })
    return cb
  }
  if (hint?.kind === 'select') {
    const sel = document.createElement('select')
    for (const o of hint.options) {
      const opt = document.createElement('option')
      opt.value = o
      opt.textContent = o
      sel.appendChild(opt)
    }
    // a stored value that is not a choice (an older copy, a hand edit) still shows
    if (!hint.options.includes(String(value))) {
      const opt = document.createElement('option')
      opt.value = String(value)
      opt.textContent = String(value)
      sel.prepend(opt)
    }
    sel.value = String(value)
    sel.addEventListener('change', () => { sel.value = String(commit(sel.value, true)) })
    return sel
  }
  if (hint?.kind === 'range') {
    const box = document.createElement('span')
    box.className = 'ed-scene-range'
    const slider = document.createElement('input')
    slider.type = 'range'
    const num = document.createElement('input')
    num.type = 'number'
    for (const el of [slider, num]) { el.min = String(hint.min); el.max = String(hint.max); el.step = String(hint.step); el.value = String(value) }
    const show = (v: Value) => { slider.value = String(v); num.value = String(v) }
    // While dragging only the number follows; the value is written once, when the
    // drag ends: the panel redraws after every write, which would end the drag
    // and split one change into several undo steps.
    slider.addEventListener('input', () => { num.value = slider.value })
    slider.addEventListener('change', () => show(commit(slider.value, true)))
    num.addEventListener('change', () => show(commit(num.value, true)))
    box.append(slider, num)
    return box
  }
  if (hint?.kind === 'latlon') {
    const box = document.createElement('span')
    box.className = 'ed-scene-latlon'
    const [lat, lon] = parseLatLon(String(value)) ?? [0, 0]
    const mk = (v: number, label: string) => {
      const i = document.createElement('input')
      i.type = 'number'
      i.step = 'any'
      i.value = String(v)
      i.title = label
      i.setAttribute('aria-label', label)
      return i
    }
    const a = mk(lat, t('Latitude')), b = mk(lon, t('Longitude'))
    const send = () => {
      const v = commit(`${a.value}, ${b.value}`, true)
      const pos = parseLatLon(String(v))
      if (pos) { a.value = String(pos[0]); b.value = String(pos[1]) }
    }
    a.addEventListener('change', send)
    b.addEventListener('change', send)
    box.append(a, b)
    return box
  }
  if (prop.kind === 'color') {
    return host.color(String(value), (v, fin) => { commit(v, fin) })
  }
  const input = document.createElement('input')
  input.type = prop.kind === 'number' ? 'number' : 'text'
  if (prop.kind === 'number') input.step = 'any'
  input.value = String(value)
  // written when the field is left or Enter is pressed, as one undo step (see the slider)
  input.addEventListener('change', () => { input.value = String(commit(input.value, true)) })
  return input
}
