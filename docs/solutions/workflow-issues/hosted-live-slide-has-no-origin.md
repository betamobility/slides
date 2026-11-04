---
title: "A hosted live slide runs with no origin, and a Next.js app inside it never starts"
date: 2026-11-04
category: workflow-issues
module: runtime slides (slides/src/runtime-present.ts, scene.json url)
problem_type: workflow_issue
component: runtime
severity: medium
applies_when:
  - "A live slide's scene.json sets url to a hosted web app, especially a Next.js app"
  - "The hosted page works in a browser tab but stays on its server-rendered first screen inside the slide"
  - "Someone asks whether a signed-in Beta app (behind Cloudflare Access) can be shown inside a slide"
symptoms:
  - "Inside the slide the page shows its server-rendered HTML (for example 'Loading…') and never hydrates"
  - "No error event, no unhandled rejection and no console.error reach the page"
  - "self.next exists without a router; self.__next_f is never consumed"
root_cause: sandbox_without_origin
resolution_type: workaround
tags: [runtime-slides, url, sandbox, allow-same-origin, nextjs, cloudflare-access]
---

# A hosted live slide runs with no origin, and a Next.js app inside it never starts

## What happened

For the Movia workshop on 2026-11-04 the Sonder viewer got a present page
(`sonder.betamobility.com/app/:org/:project/present`, betamobility/sonder-site#17)
to show its street view inside a live slide via `scene.json` `url`. The framing
headers were opened for slides.betamobility.ai (sonder-site#17, sonder#128).

Inside Slides the page stayed on its server-rendered "Loading simulation…".
Directly in a tab it played. What was tested, in Johan's Chrome, on the production
page:

- The Beta sign-in cookie does travel: the frame's page request and credentialed
  requests from a sandboxed frame both get past Cloudflare Access.
- Mapbox style and tiles load from a sandboxed frame.
- Scripts and stylesheets load, a Turbopack chunk executes inside the sandbox, and
  `crypto.subtle` works. `localStorage` and `sessionStorage` throw.
- The same production HTML in a sandbox **with** `allow-same-origin` hydrates and
  plays; **without** it (what `runtime-present.ts` sets for every frame,
  `allow-scripts allow-forms`) Next.js boots (`self.next` set) but never hydrates,
  silently. The same build run locally, with or without `/app`, hydrates in an
  origin-less sandbox, so the trigger is something in the production setup we did
  not isolate.

The harness that settled it: the parent page fetches the production HTML with its
sign-in, adds `<base href>` and a probe script at the top of `<head>`, and loads it
as `srcdoc` into sandboxed frames with and without `allow-same-origin`. The probe
posts its readings to the parent, which is the only way to see inside an origin-less
frame.

## What to do today

Show a hosted app from a browser tab next to the deck, and keep an offline live
scene (inline HTML) on the slide itself.

## The fix to consider

Give `url` frames whose origin differs from the store's an origin of their own:
`sandbox="allow-scripts allow-forms allow-same-origin"` for those frames only.

- `allow-same-origin` gives the frame the hosted page's own origin, not the deck's.
  The page is cross-origin to slides.betamobility.ai, so it still cannot reach the
  deck's document, storage or cookies. The usual warning about `allow-scripts` plus
  `allow-same-origin` applies to a frame on the *same* origin as its parent, which
  could remove its own sandbox; a `url` on the store's own origin must keep today's
  sandbox.
- Inline scenes (`src` as a data URI or `srcdoc`) stay as they are: with
  `allow-same-origin` they would share the deck's origin.
- Test: a hosted page that reads `self.origin` must see its own origin; a hosted page
  on the store's origin must still see `"null"`; an inline scene unchanged.

This changes the runtime every deck presents with, so it ships in a release, not as
a hotfix.
