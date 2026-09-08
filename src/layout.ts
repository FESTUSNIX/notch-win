/* Every measurement, quoted in design-frame pixels.
 *
 * A port of Sources/Notch/NotchLayout.swift and Sources/Notch/SideNotchShape.swift.
 * The numbers are kept in frame pixels rather than converted, so they can be
 * checked against docs/design/frame-124-hover-tooltip.png directly and diffed
 * against the Swift line for line. `px()` is Design.px().
 */

export type Edge = "top" | "bottom" | "left" | "right";

/** Two anchors, not one.
 *
 * The frame fixes only ratios; one anchor picks the size and everything follows
 * in proportion — which is `Design.scale`, and it works when the whole surface
 * can be a single size. Here it cannot. At the anchor that makes the card's
 * body text comfortable on Windows (a 56pt ring) the notch itself comes out
 * 89px deep, which is a slab bolted to the bezel; at the anchor that makes the
 * notch right, the card's body text lands at 9.5px, which is too small to read.
 *
 * They are looked at differently — the notch is glanceable chrome you never
 * focus on, the card is something you stop and read — so each gets its own
 * anchor and each stays internally in the frame's proportions. `px()` is the
 * notch's scale, `cpx()` the card's. Nothing mixes them except the window
 * measurement, which sums two already-converted lengths.
 */
export const NOTCH_RING = 46;
export const CARD_RING = 56;

export const DPX = NOTCH_RING / 117;
const CARD_DPX = CARD_RING / 117;

/** Design-frame pixels → CSS pixels, at the notch's scale. */
export const px = (frame: number) => frame * DPX;
/** …and at the card's. */
export const cpx = (frame: number) => frame * CARD_DPX;

export const FRAME = {
  // The notch body
  sideBodyDepth: 186,
  curlRadius: 103,
  bezelFillet: 28,
  cornerRadius: 78.8,
  padTop: 69.5,
  padBottom: 50.1,
  cellSpacing: 83.5,

  // The resting pill
  pillThin: 26,
  pillLong: 210,
  pillHotZone: 90,

  // A provider cell
  ringDiameter: 117,
  trackStroke: 15.5,
  progressStroke: 8,
  glyphSize: 46,
  ringLabelGap: 26.9,

  // The activity indicator
  activityDiameter: 72,
  activityStroke: 5.5,

  // The settings orb
  orbDiameter: 124,
  orbStroke: 18,
  orbGap: 27,
  orbGlyph: 56,
  /* Generous, like the pill's — it is a small target on a screen edge. */
  orbHotZone: 152,

  // The hover tooltip
  cardWidth: 600,
  cardCorner: 49.5,
  cardPadding: 32,
  tailLength: 75,
  tailHeight: 87,
  tailGap: 28,
  barHeight: 10.5,
  headerGap: 17,
  headerToBlock: 21,
  labelToBar: 16.8,
  barToUsed: 17.8,
  blockSpacing: 20,

  /* NSFont.systemFont(size: fontSize(capPixels: 27), weight: .semibold), as
     ascender - descender + leading, rounded up. 17pt on this scale. */
  percentLine: 45.2,
  cardTitleLine: 43.4,
  cardBodyLine: 30.0,

  // Cap heights, converted back to a point size by Design.fontSize.
  capPercent: 27,
  /* The frame's own is 26. Dropped because at the card's anchor that renders
     17.4px against 12.1px body — a heading twice the weight of the thing it
     heads, in a card three lines tall. */
  capCardTitle: 21,
  capCardBody: 18,

  // Task panel: a new design surface based on the supplied narrow task list.
  // 780 frame px at card scale gives ~373 CSS px for readable nested rows.
  // Height is capped to the monitor in the native size command.
  taskPanelWidth: 780,
  taskPanelHeight: 1100,
  /* 108, not 72. The row carries the panel's only real interaction, and at 72
   * (34px) it held a 14px hit target under 13px type. See docs — the day is
   * about eight rows, so the room is there to spend. */
  taskRowHeight: 108,
  taskIndent: 36,
  taskControlHeight: 68,
  // Compact task surface: minimum room for one row plus its header/actions.
  taskPanelMinHeight: 480,
  taskPanelInset: 32,
  taskPanelSlide: 28,
  // Timer pill: slim ~31 x 157 CSS px; a ~7 x 96 px fill is the entire readout.
  focusPillDepth: 80,
  focusPillLength: 400,
  focusBarLength: 244,
  focusBarWidth: 18,
} as const;

/** Cap-height fraction of an em for the UI font. */
const CAP_RATIO = 0.714;
/** The point size whose capitals are `capPixels` tall in the frame. */
export const fontSize = (capPixels: number) => px(capPixels) / CAP_RATIO;
export const cardFontSize = (capPixels: number) => cpx(capPixels) / CAP_RATIO;

export const isVertical = (edge: Edge) => edge === "left" || edge === "right";

const ringMargin = (FRAME.sideBodyDepth - FRAME.ringDiameter) / 2;

/** A cell's full extent: the ring, the gap, and the percent under it. */
export const cellExtent =
  FRAME.ringDiameter + FRAME.ringLabelGap + FRAME.percentLine;

/** How deep the notch is, which is not the same on every edge.
 *  Turning the stack is more than a rotation: on a side edge the label follows
 *  the ring down the stack's length, on a horizontal one it has nowhere to go
 *  but into the depth. */
export function bodyDepth(edge: Edge): number {
  return isVertical(edge) ? FRAME.sideBodyDepth : 2 * ringMargin + cellExtent;
}

export function padStart(edge: Edge): number {
  return isVertical(edge) ? FRAME.padTop : (FRAME.padTop + FRAME.padBottom) / 2;
}

export function padEnd(edge: Edge): number {
  return isVertical(edge) ? FRAME.padBottom : (FRAME.padTop + FRAME.padBottom) / 2;
}

/** The ring leads its cell on every edge; only a side edge carries the label
 *  along the stack too. */
export function cellAlong(edge: Edge): number {
  return isVertical(edge) ? cellExtent : FRAME.ringDiameter;
}

export function cellPitch(edge: Edge): number {
  return cellAlong(edge) + FRAME.cellSpacing;
}

export function bodyLength(cellCount: number, edge: Edge): number {
  const start = padStart(edge);
  const end = padEnd(edge);
  if (cellCount <= 0) return start + end;
  return (
    start +
    cellCount * cellAlong(edge) +
    (cellCount - 1) * FRAME.cellSpacing +
    end
  );
}

/** Full shape length, flares included. */
export function shapeLength(
  cellCount: number,
  edge: Edge,
  flare: number = FRAME.curlRadius,
): number {
  return bodyLength(cellCount, edge) + 2 * flare;
}

/** Distance from the start of the whole shape to cell `index`'s ring centre. */
export function ringCenter(
  index: number,
  edge: Edge,
  flare: number = FRAME.curlRadius,
): number {
  return (
    flare + padStart(edge) + FRAME.ringDiameter / 2 + index * cellPitch(edge)
  );
}

/* ------------------------------------------------------------------ shape */

/** Clamped corner and flare for a shape of this size.
 *
 * ⚠️ Order matters. Clamping the corner by `depth - curl` — the obvious
 * reading — collapses it to zero as soon as the flare is as wide as the body,
 * which is exactly what happens when the notch folds to its pill: a 10pt-wide
 * shape comes out with square corners. The corner is claimed first, out of
 * half the depth, and the flare takes what is left.
 */
function clampCorners(depth: number, length: number, flare: number) {
  const wanted = Math.max(0, Math.min(FRAME.cornerRadius, depth / 2));
  const curl = Math.max(0, Math.min(flare, length / 2, depth - wanted));
  const corner = Math.max(0, Math.min(wanted, (length - 2 * curl) / 2));
  return { curl, corner };
}

/** The notch body: a pill welded to one edge, with *inverse* rounded corners
 *  at each end that flare back out to the edge so it reads as part of the bezel
 *  rather than a floating panel.
 *
 *  Written once for the right edge in canonical space — depth across, length
 *  along, bezel at maxX — and transformed onto whichever edge it is on. Writing
 *  four variants would mean four copies of the clamping above, and three of
 *  them would never be the one under the cursor when it broke.
 */
export function notchPath(
  depth: number,
  length: number,
  flare: number = FRAME.curlRadius,
): string {
  const { curl, corner } = clampCorners(depth, length, flare);
  const bodyTop = curl;
  const bodyBottom = length - curl;
  const n = (v: number) => v.toFixed(2);

  const parts: string[] = [`M${n(depth)} 0`];

  // Flare inward and down onto the top edge.
  if (curl > 0) {
    parts.push(`A${n(curl)} ${n(curl)} 0 0 1 ${n(depth - curl)} ${n(curl)}`);
  }
  parts.push(`L${n(corner)} ${n(bodyTop)}`);
  parts.push(`A${n(corner)} ${n(corner)} 0 0 0 0 ${n(bodyTop + corner)}`);
  parts.push(`L0 ${n(bodyBottom - corner)}`);
  parts.push(`A${n(corner)} ${n(corner)} 0 0 0 ${n(corner)} ${n(bodyBottom)}`);
  parts.push(`L${n(depth - curl)} ${n(bodyBottom)}`);
  // Flare back out to the screen edge.
  if (curl > 0) {
    parts.push(`A${n(curl)} ${n(curl)} 0 0 1 ${n(depth)} ${n(length)}`);
  }
  parts.push("Z");
  return parts.join("");
}

/** Canonical (across, along) onto the rect's own coordinates, bezel on the
 *  named edge. The same four matrices as SideNotchShape.transform. */
export function notchTransform(edge: Edge, depth: number): string {
  switch (edge) {
    case "right":
      return "matrix(1,0,0,1,0,0)";
    case "left":
      // Mirrored: the flares point the other way.
      return `matrix(-1,0,0,1,${depth},0)`;
    case "top":
      // Quarter turn, bezel to the top.
      return `matrix(0,-1,1,0,0,${depth})`;
    case "bottom":
      return "matrix(0,1,1,0,0,0)";
  }
}

/* --------------------------------------------------------------- the orb */

/** Radius of the resting arc: the flare's radius, less the gap.
 *  Concentric with the notch's own end flare — that is what makes it follow
 *  the contour of the edge instead of merely sitting near it. */
export const orbArcRadius = FRAME.curlRadius - FRAME.orbGap;

/** Which quarter of the circle the resting arc occupies. It faces two ways at
 *  once: back along the stack toward the notch it hangs off, and outward toward
 *  the bezel it is about to merge into. On the right edge that is twelve
 *  o'clock round to three. Trim starts at three o'clock, clockwise, y down. */
export function restingTrim(edge: Edge): [number, number] {
  switch (edge) {
    case "right":
      return [0.75, 1.0];
    case "left":
      return [0.5, 0.75];
    case "top":
      return [0.5, 0.75];
    case "bottom":
      return [0.25, 0.5];
  }
}

/** How far past the shape's own ends the orb reaches, so the window can leave
 *  it room. Added at both ends rather than one, which keeps the shape centred
 *  in the window and the placement maths unchanged. */
export const orbOverhang = FRAME.orbDiameter / 2 + FRAME.orbStroke;

/** A gear, drawn rather than imported: `Image(systemName: "gearshape")` has no
 *  counterpart here, and a traced one would be a screenshot of a system font.
 *  Teeth are a smooth square wave in polar coordinates, so the transitions are
 *  rounded rather than cut — a gear with hard steps reads as a cog sprite. */
export function gearPath(
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  hole: number,
  teeth = 8,
): string {
  const steps = teeth * 24;
  const points: string[] = [];
  for (let i = 0; i < steps; i++) {
    const t = i / steps;
    const angle = t * 2 * Math.PI;
    // A raised cosine between the two radii, sharpened so the flanks are
    // steep but never vertical.
    const wave = Math.cos(teeth * angle);
    const shaped = Math.tanh(wave * 2.6);
    const radius = inner + ((shaped + 1) / 2) * (outer - inner);
    const x = cx + radius * Math.cos(angle);
    const y = cy + radius * Math.sin(angle);
    points.push(`${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`);
  }
  points.push("Z");

  // The hub, as a second subpath. Filled even-odd, so it is a hole.
  const n = (v: number) => v.toFixed(2);
  points.push(
    `M${n(cx + hole)} ${n(cy)}` +
      `A${n(hole)} ${n(hole)} 0 1 0 ${n(cx - hole)} ${n(cy)}` +
      `A${n(hole)} ${n(hole)} 0 1 0 ${n(cx + hole)} ${n(cy)}Z`,
  );
  return points.join("");
}

/** An SVG arc for a trim range on a circle, in the same convention. */
export function arcPath(
  cx: number,
  cy: number,
  radius: number,
  from: number,
  to: number,
): string {
  const point = (t: number) => {
    const angle = t * 2 * Math.PI;
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
  };
  const [x0, y0] = point(from);
  const [x1, y1] = point(to);
  const large = to - from > 0.5 ? 1 : 0;
  const n = (v: number) => v.toFixed(2);
  return `M${n(x0)} ${n(y0)}A${n(radius)} ${n(radius)} 0 ${large} 1 ${n(x1)} ${n(y1)}`;
}

/* ------------------------------------------------------------ the tooltip */

/** Height of the card for a given number of limit windows, worked out here
 *  rather than left to layout so the card and its tail can never disagree
 *  about where the middle is. */
export function cardHeight(windowCount: number): number {
  const header = Math.max(FRAME.glyphSize, FRAME.cardTitleLine);
  let height = 2 * FRAME.cardPadding + header;

  if (windowCount > 0) {
    const block =
      2 * FRAME.cardBodyLine +
      FRAME.labelToBar +
      FRAME.barHeight +
      FRAME.barToUsed;
    height +=
      FRAME.headerToBlock +
      windowCount * block +
      (windowCount - 1) * FRAME.blockSpacing;
  } else {
    height += FRAME.headerToBlock + FRAME.cardBodyLine;
  }
  return height;
}

/* --------------------------------------------------------------- banding */

export type Band = "ample" | "watch" | "critical" | "exhausted";

/** Thresholds from the mockup, which shows 21% green, 52% yellow and 73%
 *  orange. The prose in the design spec says 50–79 is yellow, which would make
 *  73% yellow and contradict the frame it claims to describe — the frame wins. */
export function band(usedFraction: number): Band {
  if (usedFraction < 0.5) return "ample";
  if (usedFraction < 0.7) return "watch";
  if (usedFraction < 1.0) return "critical";
  return "exhausted";
}
