// SPDX-License-Identifier: MIT
//
// Background blur for the control centre, its dropdowns and Spotlight.
//
// Why this is its own module
// --------------------------
// Shell.BlurEffect blurs what is behind an actor, but only as a rectangle, and a
// corner mask added after it cannot round it (in background mode the effect
// paints the backdrop and then continues the chain, so a later mask only sees
// the actor's own, empty, content). The clipping has to happen inside the blur
// effect. That is what the GNOME Rounded Blur library provides (GI namespace
// `Blur`, class Blur.BlurEffect with a `corner_radius`), so it is used when it is
// installed.
//
// Where the real glass renderer runs (glassSurface.js), most surfaces use it
// instead of this effect. A caller can explicitly request conventional blur
// with `force`, which the Wi-Fi and battery popovers use.
//
// Without it the Shell's own Shell.BlurEffect is used. That is rectangular, so a
// blurred capsule shows a little blurred backdrop in its four corners, outside
// its rim. It is the price of having blur at all without the library; with the
// library installed the corners are exact. `backend` says which one is active.

import Shell from 'gi://Shell';

import {glassAvailable} from './glassSurface.js';

const EFFECT_NAME = 'cc-blur';
const LOG_PREFIX = '[macos-control-center/blur]';

/** The GNOME Rounded Blur namespace when its typelib is installed, else null. */
let Rounded = null;
try {
    Rounded = (await import('gi://Blur')).default ?? null;
} catch {
    Rounded = null;
}

/** Whether every bubble can be blurred with real rounded corners. */
export const roundedBlurAvailable = Rounded !== null &&
    typeof Rounded.BlurEffect === 'function';

/**
 * Which blur this session has:
 *   'glass'    the Liquid Glass renderer; the surfaces draw their own glass;
 *   'rounded'  the GNOME Rounded Blur library, corners clipped exactly;
 *   'square'   the Shell's own effect, rectangular;
 *   'none'     neither could be created.
 *
 * @type {'glass'|'rounded'|'square'|'none'}
 */
export let backend = 'none';

if (glassAvailable) {
    backend = 'glass';
} else if (roundedBlurAvailable) {
    backend = 'rounded';
} else {
    try {
        new Shell.BlurEffect({mode: Shell.BlurMode.BACKGROUND});
        backend = 'square';
    } catch {
        backend = 'none';
    }
}

console.log(`${LOG_PREFIX} blur backend: ${backend}`);

let warned = false;

/** @param {string} message logs once, so a broken backend does not flood the journal */
function warnOnce(message) {
    if (warned)
        return;
    warned = true;
    console.warn(`${LOG_PREFIX} ${message}`);
}

/**
 * Builds the effect, or null when this surface should not be blurred.
 *
 * @param {number} sigma gaussian sigma; the rounded library takes a radius, which is twice that
 * @param {number} brightness 1 keeps the backdrop as is, below 1 darkens it
 * @param {number} cornerRadius in logical pixels
 * @param {boolean} allowSquare accept the rectangular Shell effect as a fallback
 * @returns {Clutter.Effect|null}
 */
function createEffect(sigma, brightness, cornerRadius, allowSquare) {
    if (roundedBlurAvailable) {
        return new Rounded.BlurEffect({
            mode: Rounded.BlurMode.BACKGROUND,
            radius: Math.round(sigma * 2),
            brightness,
            corner_radius: cornerRadius,
        });
    }

    if (!allowSquare)
        return null;

    const effect = new Shell.BlurEffect({mode: Shell.BlurMode.BACKGROUND});

    // `sigma` replaced `radius` in newer Shells; a property a GObject does not
    // have reads as undefined, which is the test used here.
    if (effect.sigma !== undefined)
        effect.sigma = sigma;
    else if (effect.radius !== undefined)
        effect.radius = Math.round(sigma * 2);

    if (effect.brightness !== undefined)
        effect.brightness = brightness;

    return effect;
}

/**
 * Blurs what is behind `actor`, clipped to its rounded shape.
 *
 * The effect sits on the actor that also paints the fill, so the order on screen
 * is: blurred backdrop, then the actor's own background and children.
 *
 * @param {Clutter.Actor} actor
 * @param {object} [params]
 * @param {number} [params.sigma]
 * @param {number} [params.brightness]
 * @param {number|'full'} [params.radius] corner radius in px, or 'full' for a capsule/circle
 * @param {boolean} [params.allowSquare] accept the rectangular fallback (default true)
 * @param {boolean} [params.force] use regular blur even while Liquid Glass is available
 * @returns {Clutter.Effect|null} the effect, or null when nothing was attached
 */
export function attachBlur(actor, {
    sigma = 24,
    brightness = 1.0,
    radius = 0,
    allowSquare = true,
    force = false,
} = {}) {
    // The glass surfaces blur for themselves.
    if (glassAvailable && !force)
        return null;

    if (actor.get_effect(EFFECT_NAME))
        return actor.get_effect(EFFECT_NAME);

    let effect = null;
    try {
        effect = createEffect(sigma, brightness, radius === 'full' ? 0 : radius, allowSquare);
    } catch (e) {
        warnOnce(`could not create the blur effect: ${e.message}`);
        return null;
    }

    if (!effect)
        return null;

    actor.add_effect_with_name(EFFECT_NAME, effect);

    // A capsule's radius is half of its shorter side, which is only known once
    // the actor has been allocated (and changes when it is resized).
    if (radius === 'full' && roundedBlurAvailable) {
        const update = () => {
            const [width, height] = actor.get_size();
            const cornerRadius = Math.floor(Math.min(width, height) / 2);
            if (effect.corner_radius !== cornerRadius)
                effect.corner_radius = cornerRadius;
        };
        actor.connect('notify::allocation', update);
        update();
    }

    return effect;
}

/** @param {Clutter.Actor} actor */
export function detachBlur(actor) {
    if (actor.get_effect(EFFECT_NAME))
        actor.remove_effect_by_name(EFFECT_NAME);
}
