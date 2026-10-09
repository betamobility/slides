// SVG path for independent top-left, top-right, bottom-right, bottom-left radii.
export function barCornerPath(x: number, y: number, w: number, h: number, radii: unknown[]): string {
  const radius = (i: number) => Math.max(0, Math.min(Number(radii[i]) || 0, w / 2, h / 2))
  const [tl, tr, br, bl] = [0, 1, 2, 3].map(radius)
  return `M${x + tl},${y}H${x + w - tr}Q${x + w},${y} ${x + w},${y + tr}V${y + h - br}Q${x + w},${y + h} ${x + w - br},${y + h}H${x + bl}Q${x},${y + h} ${x},${y + h - bl}V${y + tl}Q${x},${y} ${x + tl},${y}Z`
}
