#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""
Turns the Apple icons (SF Symbols exports and two line icons) into symbolic
icons GNOME can recolour, in ../icons/.

    python3 tools/convert_icons.py SOURCE_DIR

Why they cannot be used as they are
  * An SF Symbols export is one filled path inside a group that flips it, on a
    canvas of an arbitrary size, with `stroke='black'` added to it. GNOME recolours
    the fill of a symbolic icon but not the stroke, so the outline would stay
    black. The flip is applied to the coordinates here, the stroke is dropped, and
    the icon is placed on a 24 x 24 canvas.
  * The Shortcuts icon is drawn with strokes only. A stroke is turned into filled
    shapes (a quad for every segment, a disc at every corner; nonzero fill unions
    them), which recolours like any other icon.

What is derived rather than converted
  * Wi-Fi with one and two bars: the SF Symbols wifi is three shapes (the dot, the
    middle arc, the outer arc); fewer bars is fewer of them.
  * A charging battery at 0, 25, 50 and 75 %: the bolt of the 100 % charging
    symbol is laid over the battery, with fill-rule evenodd, so it shows as a
    solid bolt on the empty part of the battery and as a bolt-shaped gap in the
    fill and in the outline.

The icons of one family (the Wi-Fi ones, the batteries) share one scale and one
position, so they can replace each other without the glyph jumping.
"""
import math
import os
import re
import sys

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.svgLib.path import parse_path
from fontTools.misc.transform import Transform

CANVAS = 24.0


def read_sf(path):
    """An SF Symbols export -> list of subpaths in y-up coordinates."""
    text = open(path).read()
    height = float(re.search(r"height='([\d.]+)px'", text).group(1))
    ds = re.findall(r"\sd='([^']*)'", text)
    subpaths = []
    for d in ds:
        pen = RecordingPen()
        parse_path(d, pen)
        current = []
        for op, args in pen.value:
            if op == 'moveTo' and current:
                subpaths.append(current)
                current = []
            current.append((op, args))
        if current:
            subpaths.append(current)
    return subpaths, height


def read_plain(path):
    """A plain 24-unit icon -> subpaths in y-up coordinates (flipped here)."""
    text = open(path).read()
    ds = re.findall(r'\sd="([^"]*)"', text)
    subpaths = []
    for d in ds:
        pen = RecordingPen()
        parse_path(d, pen)
        current = []
        for op, args in pen.value:
            if op == 'moveTo' and current:
                subpaths.append(current)
                current = []
            current.append((op, args))
        if current:
            subpaths.append(current)
    return [flip(sp, CANVAS) for sp in subpaths]


def flip(subpath, height):
    """y-down -> y-up."""
    return [(op, tuple((x, height - y) for x, y in args)) for op, args in subpath]


def shift(subpath, dx, dy):
    return [(op, tuple((x + dx, y + dy) for x, y in args)) for op, args in subpath]


def bounds(subpaths):
    pen = BoundsPen(None)
    for sp in subpaths:
        for op, args in sp:
            getattr(pen, op)(*args)
    return pen.bounds


def stroke_to_fill(subpaths, width):
    """Filled shapes with the outline of a stroked path (butt caps, round joins)."""
    hw = width / 2
    polygons = []

    def area(poly):
        return sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(poly, poly[1:] + poly[:1])) / 2

    def add(poly):
        polygons.append(poly if area(poly) >= 0 else poly[::-1])

    def disc(cx, cy):
        add([(cx + hw * math.cos(a * math.pi / 6), cy + hw * math.sin(a * math.pi / 6))
             for a in range(12)])

    for sp in subpaths:
        points = []
        closed = False
        for op, args in sp:
            if op == 'moveTo':
                points = [args[0]]
            elif op == 'lineTo':
                points.append(args[0])
            elif op == 'curveTo':
                p0 = points[-1]
                p1, p2, p3 = args
                for i in range(1, 25):
                    t = i / 24
                    u = 1 - t
                    points.append((
                        u**3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0],
                        u**3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1]))
            elif op in ('closePath', 'endPath'):
                closed = op == 'closePath'

        if closed and points[0] != points[-1]:
            points.append(points[0])

        for (x0, y0), (x1, y1) in zip(points, points[1:]):
            length = math.hypot(x1 - x0, y1 - y0)
            if length < 1e-9:
                continue
            nx, ny = -(y1 - y0) / length * hw, (x1 - x0) / length * hw
            add([(x0 + nx, y0 + ny), (x1 + nx, y1 + ny), (x1 - nx, y1 - ny), (x0 - nx, y0 - ny)])

        # A disc at every bend, which is what a round join is. Even a gentle bend
        # leaves a thin wedge between two quads on its outer side, and along a
        # curve those wedges add up to a comb on the edge.
        for a, b, c in zip(points, points[1:], points[2:]):
            v1 = (b[0] - a[0], b[1] - a[1])
            v2 = (c[0] - b[0], c[1] - b[1])
            n1, n2 = math.hypot(*v1), math.hypot(*v2)
            if n1 < 1e-9 or n2 < 1e-9:
                continue
            cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2)
            if math.degrees(math.acos(max(-1, min(1, cos)))) > 0.5:
                disc(*b)

    # As recorded subpaths (all one winding), so they go through the same pipeline.
    return [[('moveTo', (poly[0],))] + [('lineTo', (p,)) for p in poly[1:]] + [('closePath', ())]
            for poly in polygons]


def to_d(subpaths, scale, tx, ty):
    """Subpaths (y-up) -> an SVG path (y-down) placed on the canvas."""
    pen = SVGPathPen(None, ntos=lambda v: ('%.3f' % v).rstrip('0').rstrip('.'))
    # x' = x*scale + tx;  y' = ty - y*scale  (the flip back to y-down)
    transform = TransformPen(pen, Transform(scale, 0, 0, -scale, tx, ty))
    for sp in subpaths:
        for op, args in sp:
            getattr(transform, op)(*args)
    return pen.getCommands()


def write_family(outdir, family, content):
    """family: {name: (subpaths, fill_rule)}. One scale and position for all."""
    box = bounds([sp for subpaths, _ in family.values() for sp in subpaths])
    x0, y0, x1, y1 = box
    size = max(x1 - x0, y1 - y0)
    scale = content / size
    tx = CANVAS / 2 - (x0 + x1) / 2 * scale
    ty = CANVAS / 2 + (y0 + y1) / 2 * scale

    for name, (subpaths, rule) in family.items():
        d = to_d(subpaths, scale, tx, ty)
        svg = (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24">\n'
            f'  <path fill="#bebebe" fill-rule="{rule}" d="{d}"/>\n'
            '</svg>\n')
        path = os.path.join(outdir, name + '-symbolic.svg')
        open(path, 'w').write(svg)
        print('wrote', os.path.relpath(path), len(svg), 'bytes')


def main(src):
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'icons')
    os.makedirs(out, exist_ok=True)

    def sf(name):
        subpaths, height = read_sf(os.path.join(src, name + '.svg'))
        return subpaths, height

    # ---- Wi-Fi: three shapes, so one, two or three bars --------------------
    wifi, _ = sf('wifi')
    # In y-up order the dot is first, then the middle arc, then the outer arc
    # (the file lists them bottom to top).
    dots = sorted(wifi, key=lambda sp: bounds([sp])[1])
    error, _ = sf('wifi_exclamationmark')
    write_family(out, {
        'cc-wifi-1': (dots[:1], 'nonzero'),
        'cc-wifi-2': (dots[:2], 'nonzero'),
        'cc-wifi-3': (dots, 'nonzero'),
        'cc-wifi-error': (error, 'nonzero'),
    }, 22)

    # ---- batteries ---------------------------------------------------------
    battery = {}
    for level in (0, 25, 50, 75, 100):
        battery[level], _ = sf('battery_%dpercent' % level)

    bolt_file, _ = sf('battery_100percent_bolt')
    # The bolt canvas is taller; align it to the plain battery by their outlines.
    plain_outline = bounds([max(battery[100], key=lambda sp: bounds([sp])[2] - bounds([sp])[0])])
    bolt_outline = bounds([sp for sp in bolt_file if bounds([sp])[2] - bounds([sp])[0] > 30 and
                           bounds([sp])[3] - bounds([sp])[1] > 30 and bounds([sp])[0] < 20])
    # Use the vertical position of the outline halves (the pieces left and right of the bolt).
    halves = [sp for sp in bolt_file if bounds([sp])[0] in (bounds([bolt_file[0]])[0], bounds([bolt_file[1]])[0])
              and (bounds([sp])[2] - bounds([sp])[0]) > 30]
    halves_box = bounds(halves)
    dy = plain_outline[1] - halves_box[1]
    bolt_all = [shift(sp, 0, dy) for sp in bolt_file]
    bolt = max(bolt_all, key=lambda sp: bounds([sp])[3] - bounds([sp])[1])   # the tallest piece

    fam = {}
    for level in (0, 25, 50, 75, 100):
        fam['cc-battery-%d' % level] = (battery[level], 'nonzero')
    for level in (0, 25, 50, 75):
        fam['cc-battery-%d-charging' % level] = (battery[level] + [bolt], 'evenodd')
    fam['cc-battery-100-charging'] = (bolt_all, 'nonzero')
    write_family(out, fam, 22)

    # ---- single icons ------------------------------------------------------
    for src_name, dst, content in (
            ('airpods_pro', 'cc-airpods', 20),
            ('folder', 'cc-folder', 20),
            ('clipboard', 'cc-clipboard', 20),
            ('switch_2', 'control-center', 20)):
        subpaths, _ = sf(src_name)
        write_family(out, {dst: (subpaths, 'nonzero')}, content)

    appstore = read_plain(os.path.join(src, 'app-store-logo.svg'))
    write_family(out, {'cc-appstore': (appstore, 'evenodd')}, 20)

    shortcuts = read_plain(os.path.join(src, 'apple-shortcuts.svg'))
    write_family(out, {'cc-shortcuts': (stroke_to_fill(shortcuts, 1.5), 'nonzero')}, 20)


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else '.')
