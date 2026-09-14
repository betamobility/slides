// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
//
// Stands in for Reveal inside ONE runtime-slide scene, so a section ported
// from a reveal.js deck runs its own markup, CSS and script unchanged. The
// shell owns navigation: it sends bento:init and bento:step, and this turns
// them into the Reveal events the deck script already listens to
// (ready, slidechanged, fragmentshown, fragmenthidden). reveal.js itself is
// never loaded. First used for the Danmarks Mobilitetsatlas port, 2026-09-14.
//
// Inlined verbatim before the deck's own script (SKILL.md, "Porting a
// reveal.js deck"). Contract:
//   - the page holds exactly one `.reveal .slides > section` (class present);
//   - step k shows the first k fragment GROUPS, so steps = groups + 1;
//   - `fetch('assets/<name>')` resolves from the Blobs of bento:assets.
(function () {
  // The deck's own Reveal.initialize({ width, height }), set by the scene page.
  var SIZE = window.BENTO_REVEAL_SIZE || { width: 960, height: 700 }
  var section = document.querySelector('.reveal .slides > section')
  if (!section) { console.error('reveal shim: no .reveal .slides > section'); return }

  // Reveal's order (sortFragments): groups with data-fragment-index by index,
  // then every fragment without one, each alone, in document order.
  var all = Array.prototype.slice.call(section.querySelectorAll('.fragment'))
  var indexed = []
  var loose = []
  all.forEach(function (f) {
    var i = parseInt(f.getAttribute('data-fragment-index'), 10)
    if (isFinite(i)) (indexed[i] = indexed[i] || []).push(f)
    else loose.push([f])
  })
  var groups = indexed.filter(Boolean).concat(loose)

  var handlers = {}
  function emit(type, ev) {
    ev = ev || {}
    ev.type = type
    ;(handlers[type] || []).slice().forEach(function (fn) {
      try { fn(ev) } catch (e) { console.error(e) }
    })
  }

  var shown = 0
  function show(k) {
    k = Math.max(0, Math.min(groups.length, k | 0))
    while (shown < k) {
      var g = groups[shown++]
      g.forEach(function (f) { f.classList.add('visible') })
      emit('fragmentshown', { fragment: g[0], fragments: g })
    }
    while (shown > k) {
      var h = groups[--shown]
      h.forEach(function (f) { f.classList.remove('visible') })
      emit('fragmenthidden', { fragment: h[0], fragments: h })
    }
    all.forEach(function (f) { f.classList.remove('current-fragment') })
    if (shown) groups[shown - 1].forEach(function (f) { f.classList.add('current-fragment') })
  }

  var api = {
    initialize: function () { return Promise.resolve(api) },
    configure: function () {},
    on: function (type, fn) { (handlers[type] = handlers[type] || []).push(fn) },
    off: function (type, fn) { handlers[type] = (handlers[type] || []).filter(function (x) { return x !== fn }) },
    addEventListener: function (type, fn) { api.on(type, fn) },
    removeEventListener: function (type, fn) { api.off(type, fn) },
    isReady: function () { return true },
    getCurrentSlide: function () { return section },
    getSlides: function () { return [section] },
    getIndices: function () { return { h: 0, v: 0, f: shown ? shown - 1 : undefined } },
    getTotalSlides: function () { return 1 },
    getScale: function () { return scale },
    getConfig: function () { return { width: SIZE.width, height: SIZE.height } },
    getRevealElement: function () { return document.querySelector('.reveal') },
    isOverview: function () { return false },
    isPaused: function () { return false },
    layout: function () { fit() },
    sync: function () {},
  }
  // Navigation calls (next, prev, slide, …) belong to the shell; anything the
  // shim does not implement is a logged no-op rather than a crash.
  window.Reveal = typeof Proxy === 'function'
    ? new Proxy(api, { get: function (t, k) {
        if (k in t) return t[k]
        if (typeof k !== 'string') return undefined
        return function () { console.warn('reveal shim: Reveal.' + k + '() is not supported in a runtime slide') }
      } })
    : api

  // Heavy files arrive once as Blobs (bento:assets). The deck fetches them as
  // "assets/<name>" the way it did beside index.html.
  var gotAssets
  var assetsReady = new Promise(function (r) { gotAssets = r })
  var realFetch = window.fetch ? window.fetch.bind(window) : null
  window.fetch = function (input, init) {
    var m = /^(?:\.\/)?assets\/([^?#]+)/.exec(String(input && input.url ? input.url : input))
    if (!m) return realFetch ? realFetch(input, init) : Promise.reject(new Error('no fetch'))
    return assetsReady.then(function (a) {
      var b = a[decodeURIComponent(m[1])]
      if (!b) throw new Error('asset not delivered: ' + m[1] + ' (list it in scene.json, and open the deck from the store)')
      return new Response(b)
    })
  }

  var started = false
  addEventListener('message', function (e) {
    if (e.source !== parent) return
    var m = e.data || {}
    if (m.type === 'bento:init') {
      document.documentElement.classList.toggle('reduce-motion', !!m.reduceMotion)
      if (!started) {
        started = true
        emit('ready', { currentSlide: section, indexh: 0, indexv: 0 })
        emit('slidechanged', { currentSlide: section, previousSlide: null, indexh: 0, indexv: 0 })
      }
      show(m.step || 0)
    } else if (m.type === 'bento:step') {
      show(m.index)
    } else if (m.type === 'bento:motion') {
      document.documentElement.classList.toggle('reduce-motion', !!m.reduce)
    } else if (m.type === 'bento:assets') {
      gotAssets(m.assets || {})
    }
  })
  // Opened on its own (no shell), the assets never come; do not hang forever.
  if (window.parent === window) gotAssets({})

  // Keys pressed inside the frame never reach the shell: hand them back.
  var KEYS = { ArrowRight: 'next', ArrowDown: 'next', PageDown: 'next', ' ': 'next', ArrowLeft: 'prev', ArrowUp: 'prev', PageUp: 'prev', Escape: 'exit' }
  addEventListener('keydown', function (e) {
    var dir = KEYS[e.key]
    if (!dir || e.defaultPrevented || (e.target.closest && e.target.closest('input, textarea, select'))) return
    e.preventDefault()
    parent.postMessage({ type: 'bento:navigate', dir: dir }, '*')
  })

  // Lay the slide out the way Reveal does: its configured size, centred and scaled.
  var slides = document.querySelector('.reveal .slides')
  var scale = 1
  function fit() {
    scale = Math.min(innerWidth / SIZE.width, innerHeight / SIZE.height)
    slides.style.cssText = 'width:' + SIZE.width + 'px;height:' + SIZE.height + 'px;left:50%;top:50%;bottom:auto;right:auto;margin:0;' +
      'transform:translate(-50%,-50%) scale(' + scale + ')'
    emit('resize', { scale: scale, oldScale: scale, size: { width: SIZE.width, height: SIZE.height } })
  }
  addEventListener('resize', fit)
  fit()
})()
