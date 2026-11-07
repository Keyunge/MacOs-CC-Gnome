// SPDX-License-Identifier: MIT
//
// Liquid Glass for the dock. A port of the dock support of the Liquid Glass
// extension (src/dockManager.ts and src/dockWatcher.ts, MIT, see lg/README.md),
// on the glass renderer vendored in ./lg.
//
// Which docks
// -----------
// Any dock that puts a container of its own, with a background actor in it, on
// the top group. Each dock is described by a profile below, with the actor names
// and style classes that dock itself uses:
//
//   * Dash to Dock, and the Ubuntu Dock, which is the same code under the same
//     actor names: `dashtodockDashContainer` wrapping a `.dash-background`.
//   * Dash2Dock Animated (dash2dock-lite). It pretends to be Dash to Dock, so
//     its root is called `dashtodockContainer` too, but the bar it draws is the
//     actor named `d2daBackground`; the `.dash-background` inside it is a hidden
//     stand-in it keeps for other extensions.
//   * Glide Dock: `.glidedock-container` around `.glidedock-background`, plus a
//     blurred wallpaper layer of its own under the bar.
//
// A dock nobody has written a profile for is still picked up, as long as its
// container is named or styled like a dock and holds a background actor: that is
// the `generic` fallback, so a new dock needs no change here. GNOME's own dash
// lives in the overview and is never touched.
//
// How it works
// ------------
// The dock keeps working as it does. Its own background, and for a dock that
// blurs by itself its blur layer too, is made invisible; one glass actor, the
// size of the monitor, sits in the top group just below the dock. Every frame
// the glass is told where that background is, so it follows the dock when it
// hides, slides, fades, is resized, magnifies its icons, moves to another edge
// or to another monitor. A hook at paint time corrects the position again for a
// dock that moved after the frame was laid out.
//
// The dock's margin from the screen edge, its size and its position are the dock
// extension's own settings; this only gives it glass.

import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    chosenLook,
    chosenSmoothing,
    FrameLoop,
    glassAvailable,
    glassModules,
    glassSetting,
    onGlassSettingsChanged,
} from './glassSurface.js';

const LOG_PREFIX = '[macos-control-center/dock]';

/** Room (px) the shader keeps around the glass for its edge effects. */
const PADDING = 20;

/** The glass draws only this far around the dock, so its shadow is not cut off. */
const CLIP_PADDING = 200;

/** CSS class that clears the dock's own background while it has glass. */
const TRANSPARENT_CLASS = 'cc-dock-transparent';

/** A dock may start after us, and recreates its actors for some settings. */
const SEARCH_DELAY_MS = 2000;
const RESCAN_INTERVAL_MS = 2000;
const RESCAN_IDLE_TICKS = 2;

/** How deep below a dock container its background actor may be. */
const MAX_SCAN_DEPTH = 6;

/** A light, thin glass, like the dock of macOS 26. */
const DOCK_MATERIAL = {
    tint: [1, 1, 1],
    tintStrength: 0.14,
    blurRadius: 6,
    brightness: 1.0,
    saturation: 1.5,
    cornerRadius: 24,
};

/* ------------------------------------------------------------------------ *
 * Reading a dock's actors, without assuming anything about the version.
 * ------------------------------------------------------------------------ */

/** @returns {string} */
function topGroup() {
    return Main.uiGroup ?? Main.layoutManager.uiGroup;
}

/** @param {Clutter.Actor} actor @returns {string} */
function nameOf(actor) {
    try {
        return actor.get_name() ?? '';
    } catch {
        return '';
    }
}

/** @param {Clutter.Actor} actor @returns {string} */
function classesOf(actor) {
    try {
        return actor instanceof St.Widget ? actor.get_style_class_name() ?? '' : '';
    } catch {
        return '';
    }
}

/**
 * Every descendant of an actor, up to `depth` levels, in paint order.
 * @param {Clutter.Actor} actor
 * @param {number} [depth]
 * @returns {Generator<Clutter.Actor>}
 */
function* descendants(actor, depth = 0) {
    let children;
    try {
        children = actor.get_children();
    } catch {
        return;
    }

    for (const child of children) {
        yield child;
        if (depth + 1 < MAX_SCAN_DEPTH)
            yield* descendants(child, depth + 1);
    }
}

/**
 * @param {Clutter.Actor} root
 * @param {(actor: Clutter.Actor) => boolean} predicate
 * @returns {Clutter.Actor|null}
 */
function findIn(root, predicate) {
    try {
        if (predicate(root))
            return root;
        for (const actor of descendants(root)) {
            if (predicate(actor))
                return actor;
        }
    } catch {
        // A dock being rebuilt under us: no answer this time.
    }
    return null;
}

/** @returns {Clutter.Actor|null} the descendant at the start of `descent` and back */
const byName = (name) => actor => nameOf(actor) === name;

/** @returns {Clutter.Actor|null} the first descendant with exactly this style class */
const byClass = (className) => actor =>
    classesOf(actor).split(/\s+/).includes(className);

/** @returns {Clutter.Actor|null} the first descendant with a style class containing `part` */
const byClassPart = (part) => actor => classesOf(actor).toLowerCase().includes(part);

/**
 * A dock's root is worth looking into when it calls itself a dock. Every dock
 * here does, and it keeps the scan away from the panel and the overview.
 * @param {Clutter.Actor} actor
 */
function looksLikeDock(actor) {
    return /dock/i.test(`${nameOf(actor)} ${classesOf(actor)}`);
}

/* ------------------------------------------------------------------------ *
 * The docks this file knows by name.
 * ------------------------------------------------------------------------ */

/**
 * @typedef {object} DockMatch
 * @property {string} id what to call this dock in the log
 * @property {Clutter.Actor} container the dock's own container
 * @property {Clutter.Actor} background the actor that draws the bar
 * @property {Clutter.Actor[]} [alsoHide] layers of the dock that blur by
 *           themselves and would double the glass
 * @property {((container: Clutter.Actor) => Clutter.Actor|null)} [reference]
 *           an icon the gaps around the bar are balanced against
 */

const DOCK_PROFILES = [
    {
        id: 'dash-to-dock',
        /** Dash to Dock and the Ubuntu Dock. */
        match(root) {
            const container = findIn(root, byName('dashtodockDashContainer'));
            if (!container)
                return null;
            return {
                id: this.id,
                container,
                background: findIn(container, byClass('dash-background')) ?? container,
                // The running-app indicator, to balance the gaps around the icons.
                // It is a GObject type of the dock's own, not a style class.
                reference: dock => findIn(dock, actor => {
                    try {
                        return String(actor).includes('IndicatorDrawingArea');
                    } catch {
                        return false;
                    }
                }),
            };
        },
    },
    {
        id: 'dash2dock',
        /** Dash2Dock Animated, which wears Dash to Dock's names. */
        match(root) {
            const background = findIn(root, byName('d2daBackground'));
            if (!background)
                return null;
            // The root itself is the dock: its name is `dashtodockContainer`.
            return {id: this.id, container: root, background};
        },
    },
    {
        id: 'glide-dock',
        /** Glide Dock. */
        match(root) {
            const background = findIn(root, byClass('glidedock-background'));
            if (!background)
                return null;
            const container = findIn(root, byClass('glidedock-container')) ?? root;
            return {
                id: this.id,
                container,
                background,
                // Glide Dock blurs the wallpaper itself, in actors of its own
                // that sit beside the bar inside the same layout.
                alsoHide: actor => backgroundSiblings(actor),
            };
        },
    },
    {
        id: 'generic',
        /** A dock with no profile: its container is a dock and draws a bar. */
        match(root) {
            if (!looksLikeDock(root))
                return null;
            const background = findIn(root, byClassPart('background'));
            if (!background || background === root)
                return null;
            return {id: this.id, container: root, background};
        },
    },
];

/**
 * The actors beside a dock's background inside its own layout that are not part
 * of what the user sees as dock content: unnamed layers (Glide Dock's blurred
 * wallpaper) and ones that call themselves a blur or a shadow.
 *
 * @param {Clutter.Actor} background
 * @returns {Clutter.Actor[]}
 */
function backgroundSiblings(background) {
    const found = [];
    try {
        const parent = background.get_parent();
        if (!parent)
            return found;

        for (const sibling of parent.get_children()) {
            if (sibling === background)
                continue;
            const label = `${nameOf(sibling)} ${classesOf(sibling)}`.trim().toLowerCase();
            if (label === '' || label.includes('blur') || label.includes('shadow'))
                found.push(sibling);
        }
    } catch {
        // A dock being rebuilt under us: hide nothing this frame.
    }
    return found;
}

/**
 * The first profile that claims this actor.
 * @param {Clutter.Actor} root
 * @returns {DockMatch|null}
 */
function matchDock(root) {
    if (!looksLikeDock(root))
        return null;

    for (const profile of DOCK_PROFILES) {
        try {
            const match = profile.match(root);
            if (match)
                return match;
        } catch {
            // A profile that cannot read this actor passes to the next one.
        }
    }
    return null;
}

/**
 * @param {Clutter.Actor} actor
 * @returns {{absX: number, absY: number, baseW: number, baseH: number}}
 */
function actorBounds(actor) {
    try {
        const [baseW, baseH] = actor.get_size();
        const [absX, absY] = actor.get_transformed_position();
        return {absX, absY, baseW, baseH};
    } catch {
        return {absX: NaN, absY: NaN, baseW: 0, baseH: 0};
    }
}

/**
 * Whether an actor is still part of a dock, rather than destroyed or dropped out
 * of the scene. A dock that rebuilds its bar leaves the old actor alive but
 * detached, and a detached actor never moves again: it must not be followed.
 *
 * @param {Clutter.Actor} actor
 * @param {Clutter.Actor} [within]
 */
function stillInScene(actor, within = null) {
    try {
        const parent = actor.get_parent();
        if (!parent)
            return false;
        if (!within)
            return true;

        // A few levels up: the dock's own tree is shallow.
        let node = parent;
        for (let depth = 0; node && depth < MAX_SCAN_DEPTH + 2; depth++) {
            if (node === within)
                return true;
            node = node.get_parent();
        }
        return false;
    } catch {
        return false;
    }
}

/* ------------------------------------------------------------------------ *
 * One glass, behind one dock.
 * ------------------------------------------------------------------------ */

/** The glass behind one dock. */
class DockGlass {
    #path;
    #root;
    #match = null;
    #glass = null;
    #loop = null;
    #styled = [];
    #hidden = new Map();
    #live = null;
    #liveRef = null;
    #glassLast = null;
    #active = false;
    #unsubscribe;

    /**
     * @param {string} path the extension's directory
     * @param {Clutter.Actor} root a top-level actor of the dock
     * @param {DockMatch} match what the profile found in it
     */
    constructor(path, root, match) {
        this.#path = path;
        this.#root = root;
        this.#match = match;

        this.#unsubscribe = onGlassSettingsChanged(() => this.#settingsChanged());
        this.#settingsChanged();
    }

    /** Glass comes and goes with the setting, and follows the look chosen. */
    #settingsChanged() {
        const enabled = glassSetting('dock-glass', true);

        if (enabled && !this.#active)
            this.#attach();
        else if (!enabled && this.#active)
            this.#detach();

        if (this.#active)
            this.#applyLook();
    }

    #attach() {
        const Lg = glassModules();
        if (!Lg?.dock || !Lg.BackdropGlass)
            return;

        // The nearest ancestor that sits directly in the top group.
        let root = this.#root;
        const group = topGroup();
        try {
            while (root.get_parent() && root.get_parent() !== group)
                root = root.get_parent();
            if (root.get_parent() !== group)
                return;
        } catch {
            return;
        }

        try {
            this.#glass = new Lg.BackdropGlass({extensionPath: this.#path, owner: 'dock'});
        } catch (e) {
            console.warn(`${LOG_PREFIX} could not create the glass for ${this.#match.id}: ${e.message}`);
            return;
        }

        const glass = this.#glass;
        glass.set_size(1, 1);
        glass.hide();
        group.insert_child_below(glass, root);

        glass.setPadding(PADDING);
        glass.setIsDock(true);
        glass.setContrast(1);
        glass.setTintColor(...DOCK_MATERIAL.tint);
        // After the frame is laid out the dock may have moved again; this puts the
        // glass where the dock is at the moment it is painted.
        glass.setLiveGeometryHook(() => this.#syncLive());

        // The dock's own background steps aside. The class covers themes that
        // paint through CSS; the opacity below covers the ones that set it from
        // their own code, which CSS cannot override.
        this.#styled = [];
        let styleTargets = [];
        try {
            styleTargets = [this.#match.container, this.#match.container.get_parent()];
        } catch {
            styleTargets = [];
        }
        for (const actor of styleTargets) {
            // The top group holds every window and the overview's own dash: it
            // must never carry a class that hides `.dash-background`.
            if (!actor || actor === group)
                continue;
            try {
                actor.add_style_class_name(TRANSPARENT_CLASS);
                this.#styled.push(actor);
            } catch {
                // Not an St widget: nothing to style.
            }
        }

        this.#active = true;
        this.#applyLook();

        this.#loop = new FrameLoop(() => this.#sync());
        this.#loop.start();
    }

    #detach() {
        this.#active = false;
        this.#loop?.stop();
        this.#loop = null;
        this.#live = null;
        this.#liveRef = null;
        this.#glassLast = null;

        for (const actor of this.#styled) {
            try {
                actor.remove_style_class_name(TRANSPARENT_CLASS);
            } catch {
                // The dock may already have destroyed it.
            }
        }
        this.#styled = [];

        // Whatever was made invisible comes back as it was.
        for (const [actor, opacity] of this.#hidden) {
            try {
                actor.opacity = opacity;
            } catch {
                // The dock may already have destroyed it.
            }
        }
        this.#hidden.clear();

        const glass = this.#glass;
        this.#glass = null;
        if (glass) {
            glass.cleanup();
            glass.destroy();
        }
    }

    destroy() {
        this.#unsubscribe();
        this.#detach();
    }

    /** What the user has set, over the defaults. */
    #applyLook() {
        const glass = this.#glass;
        if (!glass)
            return;

        const look = {...DOCK_MATERIAL, ...chosenLook('dock')};
        glass.setTintStrength(look.tintStrength);
        glass.setBlurRadius(look.blurRadius);
        glass.setBrightness(look.brightness);
        glass.setSaturation(look.saturation);
        glass.setCornerRadius(look.cornerRadius);

        const smoothing = chosenSmoothing();
        const renderer = glass._renderer;
        if (smoothing !== null && renderer) {
            renderer.uniforms.set('corner_smoothing', Math.max(0, Math.min(1, smoothing)));
            renderer._repaintIfDirty?.();
        }
    }

    /**
     * The dock as it is now. A dock may rebuild its bar (Dash2Dock Animated does
     * for some of its settings, Glide Dock recreates its blur), so the match is
     * asked again whenever the actor it named is gone.
     * @returns {DockMatch|null}
     */
    #current() {
        if (this.#match &&
            stillInScene(this.#match.background, this.#match.container) &&
            stillInScene(this.#match.container))
            return this.#match;

        const match = matchDock(this.#root);
        if (match?.id !== this.#match?.id)
            console.log(`${LOG_PREFIX} glass behind ${match ? match.id : 'no dock'}`);
        this.#match = match;
        return this.#match;
    }

    /**
     * Lets the dock's own bar and its own blur go, remembering what they were, so
     * that the glass is the only thing drawn behind the icons.
     * @param {DockMatch} match
     */
    #hideOwn(match) {
        const actors = [match.background];

        if (match.alsoHide) {
            try {
                actors.push(...match.alsoHide(match.background));
            } catch {
                // Nothing extra to hide this frame.
            }
        }

        for (const actor of actors) {
            try {
                if (!this.#hidden.has(actor))
                    this.#hidden.set(actor, actor.opacity);
                if (actor.opacity !== 0)
                    actor.opacity = 0;
            } catch {
                // Destroyed while we looked at it.
            }
        }
    }

    /** Once per frame: where the dock is, and so where the glass goes. */
    #sync() {
        const Lg = glassModules();
        const glass = this.#glass;
        if (!glass || !Lg?.dock) {
            glass?.hide();
            return;
        }

        const match = this.#current();
        if (!match) {
            glass.hide();
            this.#glassLast = null;
            return;
        }

        const {container, background} = match;

        let mapped = false;
        try {
            mapped = container.mapped && background.mapped;
        } catch {
            mapped = false;
        }

        if (!mapped) {
            glass.hide();
            this.#glassLast = null;
            return;
        }

        this.#hideOwn(match);

        let bounds = actorBounds(background);
        if (!Number.isFinite(bounds.absX) || !Number.isFinite(bounds.absY))
            return;
        if (bounds.baseW <= 9 || bounds.baseH <= 9) {
            glass.hide();
            this.#glassLast = null;
            return;
        }

        // Where the bar is before anything is trimmed off it, which is what the
        // paint-time hook measures its movement against.
        this.#live = {actor: background, rawX: bounds.absX, rawY: bounds.absY};

        const index = Main.layoutManager.findIndexForActor(container);
        const monitor = Main.layoutManager.monitors[index] ?? Main.layoutManager.primaryMonitor;
        if (!monitor) {
            glass.hide();
            return;
        }

        // A bar drawn inside a padded container must not spill over the padding.
        const containerBounds = actorBounds(container);
        if (containerBounds.baseW > 0 && containerBounds.baseH > 0)
            bounds = Lg.dock.clipDockBounds(bounds, containerBounds);

        // Balance the gaps around the icons, where the dock offers an icon to
        // measure them against (Dash to Dock does; the others already are tight).
        const reference = match.reference?.(container);
        if (reference) {
            const refBounds = actorBounds(reference);
            if (refBounds.baseW > 0 && refBounds.baseH > 0) {
                const edges = Lg.dock.dockEdges(bounds, monitor);
                bounds = Lg.dock.balanceDockBounds(bounds, refBounds, edges);
            }
        }

        if (bounds.baseW <= 9 || bounds.baseH <= 9) {
            glass.hide();
            this.#glassLast = null;
            return;
        }

        // A dock flush against the screen edge is only a few pixels on screen:
        // there is nothing to draw glass on.
        const [visibleW, visibleH] = Lg.dock.visibleDockSize(bounds, monitor);
        if (visibleW <= 1 || visibleH <= 1) {
            glass.hide();
            this.#glassLast = null;
            return;
        }

        if (!glass.visible)
            glass.show();

        // Fades with the dock: the paint opacity counts a parent that is fading
        // too, which is how a dock that hides by fading does it.
        let opacity = 255;
        try {
            opacity = container.get_paint_opacity();
        } catch {
            opacity = 255;
        }
        if (glass.opacity !== opacity)
            glass.opacity = opacity;

        this.#placeGlass(bounds, monitor);
    }

    /** Puts the monitor-sized glass in place and tells it where the dock is. */
    #placeGlass(bounds, monitor) {
        const Lg = glassModules();
        const glass = this.#glass;
        if (!glass || !Lg?.dock)
            return;

        const {absX, absY, baseW, baseH} = bounds;

        const width = Math.max(1, baseW) + PADDING * 2;
        const height = Math.max(1, baseH) + PADDING * 2;
        // Monitor-local, as the shader uses them.
        const localX = absX - PADDING - monitor.x;
        const localY = absY - PADDING - monitor.y;

        const key = `${monitor.x},${monitor.y},${monitor.width},${monitor.height}`;
        if (this.#glassLast !== key) {
            glass.remove_transition('size');
            glass.remove_transition('position');
            glass.set_position(monitor.x, monitor.y);
            glass.set_size(monitor.width, monitor.height);
            glass.remove_transition('size');
            glass.remove_transition('position');
            this.#glassLast = key;
        }

        // Draw only around the dock, with room for its shadow.
        Lg.setClipIfChanged(glass,
            localX - CLIP_PADDING, localY - CLIP_PADDING,
            width + CLIP_PADDING * 2, height + CLIP_PADDING * 2);
        glass.setShadowMaxRadius(CLIP_PADDING - 20);

        glass.setResolution(monitor.width, monitor.height);
        glass.setGlassGeometry(localX, localY, width, height);

        const source = this.#live;
        this.#liveRef = source
            ? {actor: source.actor, rawX: source.rawX, rawY: source.rawY,
                rect: [localX, localY, width, height]}
            : null;

        // After the geometry setters, so the relays cover this frame's rect.
        glass.syncSources();
    }

    /** At paint time: the dock may have moved since the frame was laid out. */
    #syncLive() {
        const reference = this.#liveRef;
        const glass = this.#glass;
        if (!reference || !glass)
            return;

        try {
            const [x, y] = reference.actor.get_transformed_position();
            if (!Number.isFinite(x) || !Number.isFinite(y))
                return;

            glass.setGlassGeometry(
                reference.rect[0] + (x - reference.rawX),
                reference.rect[1] + (y - reference.rawY),
                reference.rect[2], reference.rect[3]);
        } catch {
            // The dock was destroyed under us; the watcher will notice.
        }
    }
}

/* ------------------------------------------------------------------------ *
 * Finding the docks.
 * ------------------------------------------------------------------------ */

/**
 * Finds the docks and gives each its glass. A dock may create its actors after
 * this extension is enabled, and recreates them when the monitors change, when it
 * is enabled again and for some of its settings, so it is looked for after a
 * delay and again whenever one may have appeared.
 */
export class DockWatcher {
    #path;
    #docks = [];
    #searchId = 0;
    #rescanId = 0;
    #monitorsChangedId = 0;
    #childAddedIds = [];

    /** @param {string} path the extension's directory */
    constructor(path) {
        this.#path = path;
    }

    start() {
        if (!glassAvailable)
            return;

        this.#monitorsChangedId = Main.layoutManager.connect('monitors-changed',
            () => this.#scheduleRescan());

        // Any new top-level actor may be a dock, or a dock rebuilding itself.
        for (const group of this.#groups()) {
            const id = group.connect('child-added', () => this.#scheduleRescan());
            this.#childAddedIds.push([group, id]);
        }

        this.#searchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SEARCH_DELAY_MS, () => {
            this.#searchId = 0;
            this.#find();
            this.#scheduleRescan();
            return GLib.SOURCE_REMOVE;
        });
    }

    stop() {
        if (this.#monitorsChangedId)
            Main.layoutManager.disconnect(this.#monitorsChangedId);
        this.#monitorsChangedId = 0;

        for (const [group, id] of this.#childAddedIds) {
            try {
                group.disconnect(id);
            } catch {
                // Already gone with the session mode.
            }
        }
        this.#childAddedIds = [];

        if (this.#searchId)
            GLib.source_remove(this.#searchId);
        if (this.#rescanId)
            GLib.source_remove(this.#rescanId);
        this.#searchId = 0;
        this.#rescanId = 0;

        for (const entry of [...this.#docks])
            this.#release(entry);
    }

    /** The groups docks are put in: `addChrome()` uses the layout manager's. */
    #groups() {
        const groups = [];
        for (const group of [Main.uiGroup, Main.layoutManager.uiGroup]) {
            if (group && !groups.includes(group))
                groups.push(group);
        }
        return groups;
    }

    /** @returns {Clutter.Actor[]} the top-level actors of the docks */
    #roots() {
        const roots = [];

        for (const group of this.#groups()) {
            let children;
            try {
                children = group.get_children();
            } catch {
                continue;
            }

            for (const child of children) {
                // Our own glass sits in here too, and is not a dock.
                if (this.#docks.some(entry => entry.root === child))
                    continue;
                if (looksLikeDock(child))
                    roots.push(child);
            }
        }
        return roots;
    }

    /** @returns {boolean} true when a dock was found that had no glass yet */
    #find() {
        let added = 0;

        for (const root of this.#roots()) {
            if (this.#docks.some(entry => entry.root === root))
                continue;

            const match = matchDock(root);
            if (!match)
                continue;

            let glass;
            try {
                glass = new DockGlass(this.#path, root, match);
            } catch (e) {
                console.warn(`${LOG_PREFIX} could not start glass on ${match.id}: ${e.message}`);
                continue;
            }

            const entry = {root, glass, destroyId: 0};
            try {
                entry.destroyId = root.connect('destroy', () => {
                    entry.destroyId = 0;
                    this.#release(entry);
                    this.#scheduleRescan();
                });
            } catch {
                // It went away between the scan and now.
                entry.glass.destroy();
                continue;
            }

            this.#docks.push(entry);
            added++;
        }

        if (added > 0)
            console.log(`${LOG_PREFIX} docks with glass: ${this.#docks.length}`);
        return added > 0;
    }

    #release(entry) {
        this.#docks = this.#docks.filter(candidate => candidate !== entry);
        if (entry.destroyId) {
            try {
                entry.root.disconnect(entry.destroyId);
            } catch {
                // Already destroyed.
            }
        }
        entry.destroyId = 0;
        entry.glass.destroy();
    }

    /** Keeps looking until RESCAN_IDLE_TICKS scans in a row find nothing new. */
    #scheduleRescan() {
        if (this.#rescanId)
            GLib.source_remove(this.#rescanId);

        let idleTicks = 0;
        this.#rescanId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESCAN_INTERVAL_MS, () => {
            idleTicks = this.#find() ? 0 : idleTicks + 1;
            if (idleTicks < RESCAN_IDLE_TICKS)
                return GLib.SOURCE_CONTINUE;

            this.#rescanId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }
}
