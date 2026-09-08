// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
// BETA FORK: runtime copies of the design system's mark, for the About header
// (wired by plan U2). Nothing here is drawn: both values are the files in
// beta/logo/, vendored unchanged from Tools/design-system/public/logo/ —
// favicon-32.png as a base64 data URI (the same URI slides/index.html carries
// as its <link rel="icon">) and the <svg> element of wordmark.svg (the same
// element the boot splash inlines). scripts/test-beta-marks.ts asserts every
// copy matches the vendored bytes; re-vendor there first, then regenerate here.
//
// The wordmark fills with currentColor: set `color` on the parent to recolour
// it, and only to a palette value (DESIGN.md §10.4).

export const BETA_FAVICON_DATA_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABb0lEQVR4nO3Uv0vVURjH8Vc/CO5tKkihIRCqoaWlIGhy1Qa3iEAaG4TmlvSPcAiCoMT+g4a2GkKRSLThciFDmgqpEIuQihsHPsIXiXvVFofzhi98z/c5z3M+z+c8fKlUKpXKIWMJHRw5QO4ZnPpfAev4dsDcX1jYb9Lxf3z7gmHcxTE8wVojfhV38BWP8BHj+J28e5jDD4zhCr7jOVYHCeok8Q9eo5fnWuLTWc/jTd4v4n7ei3ufMIJzqfMiTZX45CABy9l4Iet2ChZrhxIrzsicLGdujuaQV7vqnchzEu/SXF8+4POub09T/Ca28Tb7iltbEdXK/DQFjGZfuaKXqbG5Fwe2cTrrMgPvo/58DnuQA1uZ/HYc2Mi17cxWL+J3KOJ+DhKwnsTS2UzjnicSf5b1bdyIG0WYdFpijzMzXazgEm415qkvDzGL6+m82zhcOp2KS72ILA4ULmMxV1P+B2fjyFZyZtJApVKpVCqa/AWMqGJeIiGNyQAAAABJRU5ErkJggg=="

export const BETA_LOGO_WORDMARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="140 185 215 82" fill="currentColor" role="img" aria-label="Beta">
  <g transform="matrix(1, 0, 0, -1, -49.3461, 868.292)">
    <g transform="translate(318.3633 620.9612)">
      <path d="M 0 0 L 0 26.582 L -6.699 26.582 L -6.699 40.193 L 0 40.193 L 0 54.532 L 15.912 54.532 L 15.912 40.193 L 29.096 40.193 L 29.096 26.582 L 15.912 26.582 L 15.912 2.616 C 15.912 -1.048 17.48 -2.829 21.034 -2.829 C 23.966 -2.829 26.582 -2.097 28.892 -0.839 L 28.892 -13.611 C 25.542 -15.596 21.665 -16.853 16.329 -16.853 C 6.597 -16.853 0 -12.98 0 0"/>
    </g>
    <g transform="translate(387.3595 624.8306)">
      <path d="M 0 0 L 0 2.829 C -2.727 4.082 -6.281 4.922 -10.159 4.922 C -16.96 4.922 -21.145 2.199 -21.145 -3.034 C -21.145 -7.325 -17.591 -9.839 -12.46 -9.839 C -5.028 -9.839 0 -5.757 0 0 M -36.536 -3.452 C -36.536 8.795 -27.221 14.446 -13.926 14.446 C -8.275 14.446 -4.193 13.504 -0.213 12.145 L -0.213 13.086 C -0.213 19.679 -4.295 23.343 -12.247 23.343 C -18.324 23.343 -22.611 22.193 -27.741 20.305 L -31.721 32.45 C -25.542 35.169 -19.474 36.95 -9.946 36.95 C -1.261 36.95 5.02 34.644 9 30.669 C 13.184 26.484 15.068 20.305 15.068 12.771 L 15.068 -19.781 L -0.315 -19.781 L -0.315 -13.709 C -4.193 -18 -9.528 -20.829 -17.275 -20.829 C -27.843 -20.829 -36.536 -14.757 -36.536 -3.452"/>
    </g>
    <g transform="translate(235.8703 633.1508)">
      <path d="M 0 0 C 0 9.315 -6.281 15.494 -13.713 15.494 C -21.145 15.494 -27.315 9.315 -27.315 -0.209 C -27.315 -9.524 -21.145 -15.699 -13.713 -15.699 C -6.281 -15.699 0 -9.626 0 0 M -27.11 -20.829 L -27.11 -28.154 L -43.022 -28.154 L -43.022 48.255 L -27.11 48.255 L -27.11 19.888 C -23.233 25.12 -17.898 28.994 -9.631 28.994 C 3.452 28.994 15.912 18.737 15.912 -0.209 C 15.912 -18.942 3.665 -29.203 -9.631 -29.203 C -18.111 -29.203 -23.343 -25.329 -27.11 -20.829"/>
    </g>
    <g transform="translate(295.1933 637.4419)">
      <path d="M 0 0 C -0.946 7.121 -5.131 11.932 -11.829 11.932 C -18.426 11.932 -22.713 7.223 -23.974 0 Z M -39.562 -4.5 C -39.562 11.514 -28.159 24.703 -11.829 24.703 C 6.903 24.703 15.486 10.155 15.486 -5.757 C 15.486 -7.01 15.383 -8.476 15.281 -9.942 L -23.761 -9.942 C -22.193 -17.165 -17.165 -20.932 -10.048 -20.932 C -4.713 -20.932 -0.835 -19.257 3.554 -15.175 L 12.665 -23.233 C 7.432 -29.723 -0.102 -33.703 -10.261 -33.703 C -27.11 -33.703 -39.562 -21.873 -39.562 -4.5"/>
    </g>
  </g>
</svg>`
