// SPDX-License-Identifier: MIT
//
// Real Liquid Glass for this extension's surfaces, built on the renderer of the
// Liquid Glass extension (vendored in ./lg, MIT, see lg/README.md).
//
// How one surface works
// ---------------------
// One glass actor covers a whole monitor and sits in the scene graph just below
// the surface it serves. While the stage is painted it copies what is behind
// itself, blurs the copy, and draws glass.frag over it: refraction at the
// edge, chromatic fringing, rim light, tint. Instead of one rounded rectangle
// it draws up to MAX_REGIONS of them from the same copy, which is how every
// bubble of the control centre or of Spotlight gets a piece of glass of its own
// for the price of one copy and one blur.
//
// The regions are rectangles in stage coordinates taken from the bubbles
// themselves, every frame, so the glass follows whatever they do: the menu
// opening, the cascade, a press.
//
// Where it cannot run (GNOME 45, a Shell without the Cogl API it needs) the
// module reports `glassAvailable = false` and the callers keep their plain blur.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const LOG_PREFIX = '[macos-control-center/glass]';

/** Everything taken from ./lg, or null when it cannot be used. */
let Lg = null;
try {
    const [backdrop, bounds, geometry, allocation, version, copy, cogl, writes, dock] = await Promise.all([
        import('./lg/rendering/backdropGlass.js'),
        import('./lg/actors/glassBounds.js'),
        import('./lg/actors/geometry.js'),
        import('./lg/actors/allocation.js'),
        import('./lg/shellVersion.js'),
        import('./lg/rendering/stageCopy.js'),
        import('gi://Cogl'),
        import('./lg/actors/writes.js'),
        import('./lg/actors/dockGeometry.js'),
    ]);

    // The renderer is written for GNOME 46 and later.
    if (version.SHELL_MAJOR >= 46) {
        Lg = {
            BackdropGlass: backdrop.BackdropGlass,
            placeScreenGlass: bounds.placeScreenGlass,
            getTransformedRect: geometry.getTransformedRect,
            ensureGlassAllocated: allocation.ensureGlassAllocated,
            // For reading the backdrop back (see sampleLuminance()).
            createTarget: copy.createTarget,
            coglContext: version.coglContext,
            Cogl: cogl.default,
            // For the dock (dockGlass.js).
            setClipIfChanged: writes.setClipIfChanged,
            dock,
        };
    }
} catch (e) {
    console.warn(`${LOG_PREFIX} the glass renderer cannot be loaded, using plain blur: ${e.message}`);
}

/** Whether real glass can be used on this Shell. */
export const glassAvailable = Lg !== null;

/** Room (px) the shader keeps around every region for the refraction and the blur. */
const PADDING = 20;

/** glass.frag's MAX_GLASS_REGIONS. */
const MAX_REGIONS = 16;

/* ------------------------------------------------------------------------ *
 * The look the user chose in the extension's settings.
 * ------------------------------------------------------------------------ */

/** GSettings keys of each group of surfaces, by material property. */
const LOOK_KEYS = {
    menu: {
        blurRadius: 'menu-blur',
        tintStrength: 'menu-tint',
        brightness: 'menu-brightness',
        saturation: 'menu-saturation',
    },
    spotlight: {
        blurRadius: 'spot-blur',
        tintStrength: 'spot-tint',
        brightness: 'spot-brightness',
        saturation: 'spot-saturation',
    },
    dock: {
        blurRadius: 'dock-blur',
        tintStrength: 'dock-tint',
        brightness: 'dock-brightness',
        saturation: 'dock-saturation',
        cornerRadius: 'dock-corner',
    },
};

const SMOOTHING_KEY = 'corner-smoothing';

let glassSettings = null;
let glassSettingsId = 0;
const lookListeners = new Set();

/**
 * Hands the module the extension's glass settings (or null to let go of them).
 * Every surface applies them now and again whenever one changes.
 *
 * @param {Gio.Settings|null} settings
 */
export function setGlassSettings(settings) {
    if (glassSettings && glassSettingsId)
        glassSettings.disconnect(glassSettingsId);

    glassSettings = settings;
    glassSettingsId = settings
        ? settings.connect('changed', () => lookListeners.forEach(listener => listener()))
        : 0;

    lookListeners.forEach(listener => listener());
}

/**
 * One of the glass settings, or `fallback` when it is not there (a schema that
 * has not been compiled yet).
 *
 * @param {string} key
 * @param {boolean|number} fallback its type is the type read
 */
export function glassSetting(key, fallback) {
    try {
        if (!glassSettings)
            return fallback;
        return typeof fallback === 'boolean'
            ? glassSettings.get_boolean(key)
            : glassSettings.get_double(key);
    } catch {
        return fallback;
    }
}

/**
 * @param {() => void} callback called when any glass setting changes
 * @returns {() => void} the function that stops the calls
 */
export function onGlassSettingsChanged(callback) {
    lookListeners.add(callback);
    return () => lookListeners.delete(callback);
}

/**
 * The glass modules, for the pieces that drive a glass actor themselves (the dock).
 * @returns {object|null} null where the renderer cannot run
 */
export function glassModules() {
    return Lg;
}

/**
 * @param {'menu'|'spotlight'|'dock'} group
 * @returns {object} the material properties the user has set for the group
 */
export function chosenLook(group) {
    const look = {};
    if (!glassSettings)
        return look;

    for (const [property, key] of Object.entries(LOOK_KEYS[group])) {
        try {
            look[property] = glassSettings.get_double(key);
        } catch {
            // A schema that predates the key: the default stays.
        }
    }
    return look;
}

/** @returns {number|null} the corner smoothing the user has set */
export function chosenSmoothing() {
    try {
        return glassSettings?.get_double(SMOOTHING_KEY) ?? null;
    } catch {
        return null;
    }
}

/** The default look: a fairly strong white tint, for a bright glass. */
const DEFAULT_MATERIAL = {
    tint: [1, 1, 1],
    tintStrength: 0.36,
    cornerRadius: 18,
    blurRadius: 8,
    brightness: 1.0,
    saturation: 1.5,
    contrast: 1.0,
};

/**
 * Whether a rect [x, y, w, h] can be drawn.
 * @param {number[]} rect
 */
function usable(rect) {
    return rect.every(Number.isFinite) && rect[2] >= 1 && rect[3] >= 1;
}

/* ------------------------------------------------------------------------ *
 * Reading the backdrop: how bright is what the glass shows?
 *
 * The method is the one of Liquid Glass's contrast sampler. The glass already
 * keeps a copy of the stage behind it; a small part of that copy is drawn into a
 * texture of about SAMPLE_EDGE pixels and read through
 * Shell.Screenshot.composite_to_stream(), which is the one read-back that works
 * from GJS. Each pixel is then measured as the glass will show it (its tint,
 * brightness and saturation applied), and the trimmed mean is the luminance the
 * text sits on. Nothing is written to disk.
 * ------------------------------------------------------------------------ */

const SAMPLE_EDGE = 48;

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/** @param {number} c 0..255 @returns {number} linear 0..1 */
function srgbToLinear(c) {
    const n = c / 255;
    return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of an sRGB colour, 0..1. */
function luminanceOf(r, g, b) {
    return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/**
 * What the glass does to a colour away from its edges: brightness and contrast,
 * saturation, then the tint, as glass.frag applies them.
 *
 * @param {ReadonlyMap<string, number>} values the glass's uniform values
 */
function glassToneOf(values) {
    const get = (name, fallback) => {
        const v = values?.get(name);
        return v !== undefined && Number.isFinite(v) ? v : fallback;
    };
    return {
        brightness: get('brightness', 1),
        contrast: get('contrast', 1),
        saturation: get('saturation', 1),
        tint: [get('tint_r', 1), get('tint_g', 1), get('tint_b', 1)],
        tintStrength: clamp(get('tint_strength', 0), 0, 1),
    };
}

/** The luminance of one backdrop pixel as the glass shows it. */
function tonedLuminance(r, g, b, tone) {
    const scb = c => 0.5 + ((c / 255) * tone.brightness - 0.5) * tone.contrast;
    let cr = scb(r);
    let cg = scb(g);
    let cb = scb(b);

    const luma = 0.299 * cr + 0.587 * cg + 0.114 * cb;
    const t = tone.tintStrength;
    const finish = (c, tint) => Math.max(0, luma + (c - luma) * tone.saturation) * (1 - t) + tint * t;
    cr = finish(cr, tone.tint[0]);
    cg = finish(cg, tone.tint[1]);
    cb = finish(cb, tone.tint[2]);

    // The shader scales an overbright colour down by its largest channel.
    const peak = Math.max(1, cr, cg, cb);
    return luminanceOf(clamp(cr / peak, 0, 1) * 255, clamp(cg / peak, 0, 1) * 255,
        clamp(cb / peak, 0, 1) * 255);
}

/** @returns {Promise<object|null>} the pixels of a texture, or null if it cannot be read */
function readTexture(texture, width, height) {
    return new Promise(resolve => {
        Shell.Screenshot.composite_to_stream(texture, 0, 0, width, height, 1, null, 0, 0, 1,
            Gio.MemoryOutputStream.new_resizable(), (_object, result) => {
                // The finish call throws a GError on failure.
                try {
                    const pixbuf = Shell.Screenshot.composite_to_stream_finish(result);
                    resolve(pixbuf
                        ? {
                            data: pixbuf.get_pixels(),
                            width: pixbuf.get_width(),
                            height: pixbuf.get_height(),
                            stride: pixbuf.get_rowstride(),
                            channels: pixbuf.get_n_channels(),
                        }
                        : null);
                } catch {
                    resolve(null);
                }
            });
    });
}

/**
 * Draws the part [s0, t0]-[s1, t1] of `texture` into a new texture of
 * width x height and reads that. Drawing with `texture` also flushes what is
 * still queued for it.
 */
function drawAndRead(texture, s0, t0, s1, t1, width, height) {
    const target = Lg.createTarget(width, height);
    if (!target)
        return Promise.resolve(null);

    const {Cogl} = Lg;
    const pipeline = Cogl.Pipeline.new(Lg.coglContext());
    pipeline.set_layer_texture(0, texture);
    pipeline.set_layer_filters(0, Cogl.PipelineFilter.LINEAR, Cogl.PipelineFilter.LINEAR);

    const framebuffer = target.framebuffer;
    framebuffer.orthographic(0, 0, width, height, -1, 1);
    framebuffer.clear4f(Cogl.BufferBit.COLOR, 0, 0, 0, 0);
    framebuffer.draw_textured_rectangle(pipeline, 0, 0, width, height, s0, t0, s1, t1);
    // The read goes through a sub-texture, which does not flush the drawing
    // queued on this framebuffer.
    framebuffer.flush();

    return readTexture(target.texture, width, height);
}

/** The trimmed mean of a picture's toned luminance, or null if it has no pixels. */
function averageLuminance(shot, tone) {
    const {data, width, height, stride, channels} = shot;
    const values = [];

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * stride + x * channels;
            let r = data[i];
            let g = data[i + 1];
            let b = data[i + 2];

            if (channels > 3) {
                const a = data[i + 3];
                if (a < 32)
                    continue;
                if (a < 255) {
                    // Un-premultiply semi-transparent pixels before measuring.
                    r = clamp(Math.round(r * 255 / a), 0, 255);
                    g = clamp(Math.round(g * 255 / a), 0, 255);
                    b = clamp(Math.round(b * 255 / a), 0, 255);
                }
            }
            values.push(tonedLuminance(r, g, b, tone));
        }
    }

    if (values.length === 0)
        return null;

    // Drop the brightest and darkest tenth: a bright window edge or a dark icon
    // must not decide the colour of the text.
    values.sort((a, b) => a - b);
    const trim = Math.floor(values.length * 0.1);
    const kept = values.slice(trim, Math.max(trim + 1, values.length - trim));
    return kept.reduce((sum, v) => sum + v, 0) / kept.length;
}

/**
 * The glass behind a set of rectangles. It is only a drawing layer: the owner
 * adds `actor` to the scene, calls sync() once per frame while it is shown, and
 * destroys it.
 */
export class GlassSurface {
    #glass;
    #regionTint;
    #group;
    #defaults;
    #listener;

    /**
     * @param {object} params
     * @param {string} params.path the extension's directory, where shaders/ lives
     * @param {string} params.owner a name for the log
     * @param {'menu'|'spotlight'} params.group which of the user's settings apply
     * @param {object} [params.material] overrides of DEFAULT_MATERIAL
     */
    constructor({path, owner, group, material = {}}) {
        this.#group = group;
        this.#defaults = {...DEFAULT_MATERIAL, ...material};
        const look = {...this.#defaults, ...chosenLook(group)};
        this.#regionTint = look.tint;

        // The glass starts at 1x1: a 0x0 actor with a shader crashes Cogl.
        this.#glass = new Lg.BackdropGlass({extensionPath: path, owner});
        this.#glass.set_size(1, 1);
        this.#glass.set_pivot_point(0, 0);
        this.#glass.hide();

        this.#glass.setPadding(PADDING);
        this.#glass.setIsDock(false);
        this.#glass.setTintColor(...look.tint);
        this.#glass.setTintStrength(look.tintStrength);
        this.#glass.setCornerRadius(look.cornerRadius);
        this.#glass.setBrightness(look.brightness);
        this.#glass.setSaturation(look.saturation);
        this.#glass.setContrast(look.contrast);
        this.#glass.setBlurRadius(look.blurRadius);
        this.#glass.setMultiRegionMode(true);
        this.#applySmoothing();

        // Follow the settings while the surface lives.
        this.#listener = () => this.#applyLook();
        lookListeners.add(this.#listener);
    }

    /** Applies what the user has set; what they have not set keeps its default. */
    #applyLook() {
        const glass = this.#glass;
        if (!glass)
            return;

        const look = {...this.#defaults, ...chosenLook(this.#group)};
        glass.setTintStrength(look.tintStrength);
        glass.setBlurRadius(look.blurRadius);
        glass.setBrightness(look.brightness);
        glass.setSaturation(look.saturation);
        this.#applySmoothing();
    }

    /**
     * How continuous the corners are: 0 is a plain circular arc, 1 the full
     * superellipse. The renderer has no setter for it, so it is written to the
     * uniform directly.
     */
    #applySmoothing() {
        const smoothing = chosenSmoothing();
        if (smoothing === null)
            return;

        const renderer = this.#glass._renderer;
        renderer.uniforms.set('corner_smoothing', Math.max(0, Math.min(1, smoothing)));
        renderer._repaintIfDirty?.();
    }

    /** @returns {Clutter.Actor} the actor to put into the scene */
    get actor() {
        return this.#glass;
    }

    /**
     * Whether the shaders are loaded. Until then nothing is drawn, so the owner
     * keeps its own fills and only drops them once this is true.
     */
    get ready() {
        return this.#glass._shadersLoaded === true;
    }

    /** @param {number} opacity 0 to 255: the glass fades with whatever it serves */
    setOpacity(opacity) {
        if (this.#glass.opacity !== opacity)
            this.#glass.opacity = opacity;
    }

    /**
     * Draws a piece of glass behind each rect. Call it every frame, after the
     * rects are known and before the frame is painted.
     *
     * @param {number[][]} rects [x, y, w, h, radius] in stage coordinates; a
     *        missing or 0 radius takes the surface's, a large one makes a capsule
     * @param {{x: number, y: number, width: number, height: number}} monitor
     * @param {[number, number]} origin where the glass actor goes in its parent:
     *        the monitor's position when the parent is the stage's top group, or
     *        [0, 0] inside a parent that already sits on the monitor
     */
    sync(rects, monitor, origin) {
        const glass = this.#glass;
        const drawable = rects.filter(usable).slice(0, MAX_REGIONS);

        if (drawable.length === 0) {
            if (glass.visible)
                glass.hide();
            return;
        }

        // Region rects are monitor-local and include the shader padding.
        const regions = drawable.map(([x, y, w, h, radius]) => ({
            x: x - monitor.x - PADDING,
            y: y - monitor.y - PADDING,
            w: w + PADDING * 2,
            h: h + PADDING * 2,
            radius: radius ?? 0,
            tintR: this.#regionTint[0],
            tintG: this.#regionTint[1],
            tintB: this.#regionTint[2],
            baseStrength: 0,
        }));

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const region of regions) {
            minX = Math.min(minX, region.x);
            minY = Math.min(minY, region.y);
            maxX = Math.max(maxX, region.x + region.w);
            maxY = Math.max(maxY, region.y + region.h);
        }

        if (!glass.visible)
            glass.show();

        glass.setGlassRegions(regions);
        Lg.placeScreenGlass(glass, origin[0], origin[1], monitor.width, monitor.height,
            {x: minX, y: minY, w: maxX - minX, h: maxY - minY});
        glass.setResolution(monitor.width, monitor.height);

        Lg.ensureGlassAllocated(glass);
        // After the geometry setters, so the relays cover this frame's rects.
        glass.syncSources();
    }

    /**
     * How bright the glass is under a rect, as it is shown: 0 is black, 1 white.
     * The answer comes from the copy of the backdrop the glass keeps, so it is
     * what is behind the glass and not the text drawn over it.
     *
     * @param {number[]} rect [x, y, w, h] in stage coordinates
     * @returns {Promise<number|null>} null when it cannot be read just now
     */
    async sampleLuminance(rect) {
        const copy = this.#glass?.backdropCopy?.();
        if (!copy)
            return null;

        const [cx0, cy0, cx1, cy1] = copy.rect;
        const x0 = Math.max(rect[0], cx0);
        const y0 = Math.max(rect[1], cy0);
        const x1 = Math.min(rect[0] + rect[2], cx1);
        const y1 = Math.min(rect[1] + rect[3], cy1);
        if (x1 - x0 < 1 || y1 - y0 < 1)
            return null;

        const k = Math.min(1, SAMPLE_EDGE / Math.max(x1 - x0, y1 - y0));
        const shot = await drawAndRead(copy.texture,
            (x0 - cx0) / (cx1 - cx0), (y0 - cy0) / (cy1 - cy0),
            (x1 - cx0) / (cx1 - cx0), (y1 - cy0) / (cy1 - cy0),
            Math.max(1, Math.round((x1 - x0) * k)), Math.max(1, Math.round((y1 - y0) * k)));
        if (!shot)
            return null;

        return averageLuminance(shot, glassToneOf(this.#glass?.uniformValues));
    }

    hide() {
        if (this.#glass.visible)
            this.#glass.hide();
    }

    destroy() {
        lookListeners.delete(this.#listener);
        this.#glass.cleanup();
        this.#glass.destroy();
        this.#glass = null;
    }
}

/**
 * An actor's on-screen rect [x, y, w, h] with every ancestor transform applied,
 * which is what the glass has to follow while a menu or an animation scales it.
 *
 * @param {Clutter.Actor} actor
 * @returns {number[]}
 */
export function screenRect(actor) {
    return Lg.getTransformedRect(actor);
}

/**
 * The part of an actor that can be seen: its on-screen rect, cut to the scroll
 * views it sits in. A row scrolled out of a list has no glass.
 *
 * @param {Clutter.Actor} actor
 * @returns {number[]|null} [x, y, w, h], or null when nothing of it shows
 */
export function visibleRect(actor) {
    let [x0, y0, w, h] = screenRect(actor);
    let x1 = x0 + w;
    let y1 = y0 + h;

    for (let parent = actor.get_parent(); parent; parent = parent.get_parent()) {
        if (!(parent instanceof St.ScrollView))
            continue;

        const [cx, cy, cw, ch] = screenRect(parent);
        x0 = Math.max(x0, cx);
        y0 = Math.max(y0, cy);
        x1 = Math.min(x1, cx + cw);
        y1 = Math.min(y1, cy + ch);
    }

    return x1 - x0 >= 1 && y1 - y0 >= 1 ? [x0, y0, x1 - x0, y1 - y0] : null;
}

/**
 * Runs `step` once per stage frame, from before the frame is laid out and
 * painted, which is when the glass must be told where its regions are. It does
 * not ask for frames of its own: an idle stage stays idle.
 */
export class FrameLoop {
    #step;
    #signalId = 0;
    #laterId = 0;
    #lastUs = 0;
    #failed = false;

    /** @param {() => void} step */
    constructor(step) {
        this.#step = step;
    }

    start() {
        if (this.#signalId)
            return;

        this.#signalId = global.stage.connect('before-update', () => this.#tick());
        // The frame the loop starts in has already begun.
        this.#laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this.#laterId = 0;
            this.#tick();
            return GLib.SOURCE_REMOVE;
        });
    }

    stop() {
        if (this.#signalId) {
            global.stage.disconnect(this.#signalId);
            this.#signalId = 0;
        }
        if (this.#laterId) {
            global.compositor.get_laters().remove(this.#laterId);
            this.#laterId = 0;
        }
    }

    /** Runs the step now, outside the frame clock. */
    runNow() {
        this.#run();
    }

    #tick() {
        // Several stage views update in one frame; the step runs once.
        const nowUs = GLib.get_monotonic_time();
        if (nowUs - this.#lastUs < 4000)
            return;
        this.#lastUs = nowUs;
        this.#run();
    }

    #run() {
        try {
            this.#step();
        } catch (e) {
            // One failure must not stop the glass following; it is logged once.
            if (!this.#failed) {
                this.#failed = true;
                console.warn(`${LOG_PREFIX} sync failed: ${e.message}`);
            }
        }
    }
}

/**
 * The monitor a menu or an overlay is on.
 *
 * @param {Clutter.Actor} actor
 * @returns {object}
 */
export function monitorOf(actor) {
    const index = Main.layoutManager.findIndexForActor(actor);
    return Main.layoutManager.monitors[index] ?? Main.layoutManager.primaryMonitor;
}

/**
 * A surface for a PopupMenu with no sheet of its own: the glass sits in the top
 * group just below the menu, and follows `collect()`'s bubbles while it is open.
 * Nothing is created until the menu is first opened.
 */
export class MenuGlass {
    #params;
    #surface = null;
    #loop = null;
    #menuRoot = null;
    #active = false;

    /**
     * @param {object} params
     * @param {string} params.path the extension's directory
     * @param {string} params.owner a name for the log
     * @param {import('resource:///org/gnome/shell/ui/popupMenu.js').PopupMenu} params.menu
     * @param {() => Clutter.Actor[]} params.collect the bubbles to put glass behind
     * @param {(active: boolean) => void} params.onActive called when glass starts or stops
     * @param {(actor: Clutter.Actor) => number} [params.radiusOf] corner radius of a bubble
     * @param {object} [params.material]
     */
    constructor(params) {
        this.#params = params;
        params.menu.connectObject('open-state-changed',
            (_menu, open) => (open ? this.#start() : this.#stop()), this);
    }

    #start() {
        const {path, owner, menu, material, onActive} = this.#params;

        // The nearest ancestor that sits directly in the top group.
        let root = menu.actor;
        while (root.get_parent() && root.get_parent() !== Main.uiGroup)
            root = root.get_parent();
        if (root.get_parent() !== Main.uiGroup)
            return;

        if (!this.#surface) {
            this.#surface = new GlassSurface({path, owner, group: 'menu', material});
            this.#loop = new FrameLoop(() => this.#sync());
        }

        this.#menuRoot = root;
        const glass = this.#surface.actor;
        if (glass.get_parent() !== Main.uiGroup)
            Main.uiGroup.insert_child_below(glass, root);
        else
            Main.uiGroup.set_child_below_sibling(glass, root);

        this.#loop.start();
    }

    #stop() {
        this.#loop?.stop();
        this.#surface?.hide();
        this.#setActive(false);
    }

    /**
     * The owner drops its own fills only while the glass is really drawing, and
     * is told again on every change: its content may have been built after the
     * menu opened.
     *
     * @param {boolean} active
     */
    #setActive(active) {
        if (this.#active === active)
            return;
        this.#active = active;
        this.#params.onActive(active);
    }

    /**
     * Samples the wallpaper behind a visible actor using this menu's current
     * backdrop copy.
     * @param {number[]} rect [x, y, width, height] in stage coordinates
     * @returns {Promise<number|null>}
     */
    sampleLuminance(rect) {
        return this.#surface?.sampleLuminance(rect) ?? Promise.resolve(null);
    }

    #sync() {
        const {menu, collect} = this.#params;
        const root = this.#menuRoot;

        if (!menu.actor.mapped || !root) {
            this.#surface.hide();
            return;
        }

        // The Shell may reorder the top group; the glass stays just below the menu.
        if (root.get_previous_sibling() !== this.#surface.actor)
            Main.uiGroup.set_child_below_sibling(this.#surface.actor, root);

        const {radiusOf} = this.#params;
        const rects = [];
        for (const actor of collect()) {
            if (!actor.visible || !actor.mapped)
                continue;
            // A bubble fading in (the opening cascade) has no glass until it shows.
            if (actor.get_paint_opacity() < 12)
                continue;

            // Cut to the scroll views the bubble sits in: a long list (the networks,
            // the controls to add) only has glass where it can be seen.
            const rect = visibleRect(actor);
            if (rect)
                rects.push([...rect, radiusOf?.(actor) ?? 0]);
        }

        const monitor = monitorOf(menu.actor);
        this.#surface.setOpacity(root.get_paint_opacity());
        this.#surface.sync(rects, monitor, [monitor.x, monitor.y]);
        this.#setActive(this.#surface.ready && rects.length > 0);
    }

    destroy() {
        this.#params.menu.disconnectObject(this);
        this.#loop?.stop();
        this.#loop = null;
        this.#surface?.destroy();
        this.#surface = null;
        this.#menuRoot = null;
    }
}
