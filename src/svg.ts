/* One line of SVG plumbing, so the charts do not each carry their own.
 *
 * ⚠️ `createElementNS`, never `createElement`. An `<svg>` built in the HTML
 * namespace parses, appends and lays out at zero by zero with no error
 * anywhere — the shape simply is not there, which is indistinguishable from a
 * bad path. Same for every child: a `path` in the wrong namespace is an
 * unknown element that draws nothing.
 */
const NS = "http://www.w3.org/2000/svg";

/** An SVG node with its attributes, in one call. */
export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}
