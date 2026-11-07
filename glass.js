// SPDX-License-Identifier: MIT
//
// The look of Liquid Glass that is drawn rather than blurred: the lit rim, the
// sheen across the upper half and the soft shading at the bottom edge.
//
// What this is, and is not
// ------------------------
// A bubble is made of three layers: the backdrop blur (blur.js), the translucent
// fill (CSS), and this overlay on top. The overlay is what makes a flat
// translucent shape read as a piece of glass: a bright hairline that is
// strongest at the top-left and, as bounced light, at the bottom-right, an
// inner glow just inside it, a sheen fading out from the top edge and a faint
// shadow gathering at the bottom.
//
// It does not refract: nothing behind the glass is bent. Refraction needs the
// backdrop as a texture and a shader that samples it, which the Liquid Glass
// extension does by capturing the desktop; a Clutter effect on its own cannot.

import Cairo from 'gi://cairo';
import GObject from 'gi://GObject';
import St from 'gi://St';

/**
 * A rounded rectangle path.
 *
 * @param {Cairo.Context} cr
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} height
 * @param {number} radius clamped to what fits
 */
function roundedRect(cr, x, y, width, height, radius) {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));

    cr.newSubPath();
    cr.arc(x + width - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + width - r, y + height - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + height - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
    cr.closePath();
}

/**
 * White at the given alpha along a gradient between two points.
 *
 * @param {number[]} line [x0, y0, x1, y1]
 * @param {Array<[number, number]>} stops [offset, alpha] pairs
 * @param {number} [shade] 1 for white light, 0 for black shadow
 * @returns {Cairo.LinearGradient}
 */
function gradient(line, stops, shade = 1) {
    const pattern = new Cairo.LinearGradient(...line);
    for (const [offset, alpha] of stops)
        pattern.addColorStopRGBA(offset, shade, shade, shade, alpha);
    return pattern;
}

/**
 * The overlay. Add it as the last child of a bubble that lays its children out
 * on top of each other (a Clutter.BinLayout host); it takes no input.
 */
export const GlassRim = GObject.registerClass(
{ GTypeName: 'MacOsCC_GlassRim' },
class GlassRim extends St.DrawingArea {
    /**
     * @param {object} [params]
     * @param {number|'full'} [params.radius] corner radius, or 'full' for a capsule/circle
     * @param {number} [params.rim] strength of the rim, 1 is the default
     * @param {number} [params.sheen] strength of the sheen and the shading, 1 is the default
     */
    _init({radius = 'full', rim = 1, sheen = 1} = {}) {
        super._init({
            style_class: 'cc-glass-rim',
            reactive: false,
            x_expand: true,
            y_expand: true,
        });

        this._radius = radius;
        this._rim = rim;
        this._sheen = sheen;

        this.connect('repaint', () => this._paint());
    }

    _paint() {
        const cr = this.get_context();

        try {
            const [width, height] = this.get_surface_size();
            if (width < 6 || height < 6)
                return;

            const radius = this._radius === 'full'
                ? Math.min(width, height) / 2
                : this._radius;
            const diagonal = [0, 0, width, height];

            // 1. Sheen and shading, clipped to the shape.
            cr.save();
            roundedRect(cr, 0.5, 0.5, width - 1, height - 1, radius - 0.5);
            cr.clip();

            cr.setSource(gradient([0, 0, 0, height * 0.55], [
                [0, 0.20 * this._sheen],
                [0.5, 0.06 * this._sheen],
                [1, 0],
            ]));
            cr.paint();

            cr.setSource(gradient([0, height * 0.55, 0, height], [
                [0, 0],
                [1, 0.10 * this._sheen],
            ], 0));
            cr.paint();
            cr.restore();

            // 2. The rim: lit from the top left, bounced light at the bottom right.
            roundedRect(cr, 0.75, 0.75, width - 1.5, height - 1.5, radius - 0.75);
            cr.setSource(gradient(diagonal, [
                [0, 0.95 * this._rim],
                [0.26, 0.34 * this._rim],
                [0.5, 0.14 * this._rim],
                [0.74, 0.34 * this._rim],
                [1, 0.80 * this._rim],
            ]));
            cr.setLineWidth(1.5);
            cr.stroke();

            // 3. A soft glow just inside the rim.
            roundedRect(cr, 2.5, 2.5, width - 5, height - 5, radius - 2.5);
            cr.setSource(gradient(diagonal, [
                [0, 0.40 * this._rim],
                [0.35, 0.05 * this._rim],
                [0.65, 0.05 * this._rim],
                [1, 0.26 * this._rim],
            ]));
            cr.setLineWidth(1.2);
            cr.stroke();
        } finally {
            cr.$dispose();
        }
    }
});
