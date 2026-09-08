"""Convert GlyphOutline.swift's traced point arrays into SVG path data.

The outlines are normalised into a unit box and filled even-odd, so each glyph
becomes one path in a 0..100 viewBox with fill-rule="evenodd" — the counters
inside the OpenAI knot stay open exactly as they do in SwiftUI.
"""
import json
import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent

# The macOS app, expected as a sibling checkout; pass a path to override.
#   python tools/generate-glyphs.py [path/to/GlyphOutline.swift]
SRC = (
    pathlib.Path(sys.argv[1])
    if len(sys.argv) > 1
    else REPO.parent / "codenotch" / "Sources" / "Providers" / "GlyphOutline.swift"
)
OUT = REPO / "src" / "glyphs.ts"

if not SRC.exists():
    sys.exit(
        f"GlyphOutline.swift not found at {SRC}\n"
        "Pass its path as an argument, or check the macOS app out beside this repo.\n"
        "src/glyphs.ts is committed, so this is only needed to regenerate it."
    )

text = SRC.read_text(encoding="utf-8")

# Optical scales, from ProviderGlyph.opticalScale — boxes of equal size are not
# marks of equal size, and the eye reads the mark.
OPTICAL = {
    "claude": 0.97,
    "cursor": 0.97,
    "openai": 0.94,
    "antigravity": 1.0,
    "glm": 0.95,
    "grok": 1.0,
    "opencode": 0.95,
    "third": 1.0,
}

point_re = re.compile(r"CGPoint\(x:\s*(-?[\d.]+),\s*y:\s*(-?[\d.]+)\)")

glyphs = {}

for match in re.finditer(r"static let (\w+): \[\[CGPoint\]\] = \[", text):
    name = match.group(1)
    start = match.end() - 1  # at the opening bracket of the outer array

    # Scan to the matching close bracket.
    depth = 0
    i = start
    while i < len(text):
        if text[i] == "[":
            depth += 1
        elif text[i] == "]":
            depth -= 1
            if depth == 0:
                break
        i += 1
    body = text[start + 1 : i]

    # Each subpath is a bracketed group one level in.
    subpaths = []
    depth = 0
    buf = []
    for ch in body:
        if ch == "[":
            depth += 1
            if depth == 1:
                buf = []
                continue
        elif ch == "]":
            depth -= 1
            if depth == 0:
                subpaths.append("".join(buf))
                continue
        if depth >= 1:
            buf.append(ch)

    commands = []
    total_points = 0
    for sub in subpaths:
        pts = point_re.findall(sub)
        if len(pts) < 3:
            continue
        total_points += len(pts)
        coords = [(float(x) * 100.0, float(y) * 100.0) for x, y in pts]
        parts = [f"M{coords[0][0]:.2f} {coords[0][1]:.2f}"]
        for x, y in coords[1:]:
            parts.append(f"L{x:.2f} {y:.2f}")
        parts.append("Z")
        commands.append("".join(parts))

    if commands:
        glyphs[name] = {
            "d": "".join(commands),
            "scale": OPTICAL.get(name, 1.0),
            "subpaths": len(commands),
            "points": total_points,
        }

lines = [
    "/* Generated from Sources/Providers/GlyphOutline.swift in the macOS app.",
    " *",
    " * Each mark was traced off docs/design/frame-124-hover-tooltip.png (marching",
    " * squares over the 46px glyph, smoothed, simplified) and normalised into a unit",
    " * box; here that box is a 0..100 viewBox. Filled even-odd, so the counters",
    " * inside the OpenAI knot stay open.",
    " *",
    " * `scale` is ProviderGlyph.opticalScale: boxes of equal size are not marks of",
    " * equal size, and the eye reads the mark.",
    " *",
    " * Do not hand-edit — regenerate from the Swift.",
    " */",
    "export interface Glyph {",
    "  d: string;",
    "  scale: number;",
    "}",
    "",
    "export const GLYPHS: Record<string, Glyph> = {",
]
for name, g in sorted(glyphs.items()):
    lines.append(f'  // {g["subpaths"]} subpath(s), {g["points"]} points')
    lines.append(f'  {name}: {{ scale: {g["scale"]}, d: {json.dumps(g["d"])} }},')
lines.append("};")
lines.append("")

OUT.write_text("\n".join(lines), encoding="utf-8")

for name, g in sorted(glyphs.items()):
    print(f'{name:14s} {g["subpaths"]} subpath(s)  {g["points"]:5d} points  scale {g["scale"]}')
print(f"\nwrote {OUT} ({OUT.stat().st_size} bytes)")
