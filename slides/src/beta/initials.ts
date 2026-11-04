// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
// BETA FORK: the letters on a presence avatar. Upstream showed the first
// letter of the name, so "Johan Høgåsen-Hallesby" read as "J" and every
// unnamed visitor as "G" (for "Guest"). Two letters, first and last word,
// tell a small team apart: JH, RM, LH, OS.

/** First letter of the first word and of the last word, upper-cased. One
 *  word gives one letter; no name gives "?". Code points, not UTF-16 units,
 *  so a letter outside the BMP is not split in half. */
export function initialsOf(name: string | undefined | null): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return '?'
  const first = Array.from(words[0])[0] ?? ''
  const last = words.length > 1 ? Array.from(words[words.length - 1])[0] ?? '' : ''
  return (first + last).toLocaleUpperCase() || '?'
}
