// SPDX-License-Identifier: MIT
//
// The extension's own icons (icons/, made by tools/convert_icons.py from the Apple
// glyphs) next to the theme's.
//
// An icon is named either as a theme icon ("bluetooth-symbolic") or as one of ours
// with a prefix: "ext:wifi-3" is icons/cc-wifi-3-symbolic.svg. Where an icon is
// named in the code it can therefore be either, and setIcon() / iconProps() do the
// right thing for each.
//
// Nothing here can leave a button without an icon: if the extension's directory is
// not known or a file is missing, the nearest theme icon is used instead.

import Gio from 'gi://Gio';

const PREFIX = 'ext:';

// macOS glyphs bundled with the extension. Controls without a matching asset
// continue to use their semantically correct GNOME symbolic icon.
const SF_SYMBOL_FILES = {
    // Spotlight view icons (custom SVGs)
    'airpods': 'cc-airpods-symbolic.svg',
    'appstore': 'cc-appstore-symbolic.svg',
    'appstore-black': 'cc-appstore-symbolic.svg',
    'clipboard': 'cc-clipboard-symbolic.svg',
    'folder': 'cc-folder-symbolic.svg',
    'shortcuts': 'cc-shortcuts-symbolic.svg',

    // Battery icons (custom SVGs)
    'battery-0': 'cc-battery-0-symbolic.svg',
    'battery-0-charging': 'cc-battery-0-charging-symbolic.svg',
    'battery-25': 'cc-battery-25-symbolic.svg',
    'battery-25-charging': 'cc-battery-25-charging-symbolic.svg',
    'battery-50': 'cc-battery-50-symbolic.svg',
    'battery-50-charging': 'cc-battery-50-charging-symbolic.svg',
    'battery-75': 'cc-battery-75-symbolic.svg',
    'battery-75-charging': 'cc-battery-75-charging-symbolic.svg',
    'battery-100': 'cc-battery-100-symbolic.svg',
    'battery-100-charging': 'cc-battery-100-charging-symbolic.svg',
    'battery-0-black': 'cc-battery-0-symbolic.svg',
    'battery-0-charging-black': 'cc-battery-0-charging-symbolic.svg',
    'battery-25-black': 'cc-battery-25-symbolic.svg',
    'battery-25-charging-black': 'cc-battery-25-charging-symbolic.svg',
    'battery-50-black': 'cc-battery-50-symbolic.svg',
    'battery-50-charging-black': 'cc-battery-50-charging-symbolic.svg',
    'battery-75-black': 'cc-battery-75-symbolic.svg',
    'battery-75-charging-black': 'cc-battery-75-charging-symbolic.svg',
    'battery-100-black': 'cc-battery-100-symbolic.svg',
    'battery-100-charging-black': 'cc-battery-100-charging-symbolic.svg',

    // Wi-Fi icons (custom SVGs)
    'wifi-1': 'cc-wifi-1-symbolic.svg',
    'wifi-2': 'cc-wifi-2-symbolic.svg',
    'wifi-3': 'cc-wifi-3-symbolic.svg',
    'wifi-blue': 'cc-wifi-3-symbolic.svg',
    'wifi-error': 'cc-wifi-error-symbolic.svg',
    'wifi-disabled': 'cc-wifi-3-symbolic.svg',
    'wifi-1-black': 'cc-wifi-1-symbolic.svg',
    'wifi-2-black': 'cc-wifi-2-symbolic.svg',
    'wifi-3-black': 'cc-wifi-3-symbolic.svg',
    'wifi-error-black': 'cc-wifi-error-symbolic.svg',
    'wifi-disabled-black': 'cc-wifi-3-symbolic.svg',

    // Panel icons
    'spotlight-panel': 'spotlight-panel-white.svg',
    'spotlight-panel-black': 'spotlight-panel-black.svg',
    'control-center': 'cc-control-center-symbolic.svg',
    'control-center-panel-black': 'control-center-panel-black.svg',
    'control-center-panel-white': 'control-center-panel-white.svg',

    // Bluetooth
    'bluetooth': 'icons8-bluetooth-48.png',
    'bluetooth-black': 'icons8-bluetooth-black.png',
    'bluetooth-blue': 'icons8-bluetooth-blue-48.png',
    'bluetooth-connected': 'icons8-bluetooth-connected-48.png',

    // AirDrop
    'airdrop': 'airdrop.svg',
    'airdrop-blue': 'airdrop-blue.svg',

    // Apps grid
    'apps-grid': 'apps-grid-white.svg',
    'apps-grid-black': 'apps-grid-black.svg',

    // Media & appearance
    'dark-mode': 'dark-mode-svgrepo-com.svg',
    'dark-mode-blue': 'dark-mode-blue.svg',
    'dark-mode-black': 'dark-mode-black.svg',
    'mirror': 'mirror-symbolic.svg',
    'moon': 'moon-symbolic.svg',
    'moon-blue': 'moon-blue.svg',
    'screenshot': 'screenshot-symbolic.svg',
    'media-previous': 'rewind-symbolic.svg',
    'media-play': 'play-symbolic.svg',
    'media-pause': 'pause-symbolic.svg',
    'media-next': 'forward-symbolic.svg',
    'speaker-low': 'speaker-low-symbolic.svg',
    'speaker-high': 'speaker-high-symbolic.svg',
};

let iconsPath = null;
const cache = new Map();

/** @param {string|null} path the extension's directory */
export function setIconsPath(path) {
    iconsPath = path;
    cache.clear();
}

/**
 * The theme icon that stands in for one of ours.
 *
 * @param {string} key the name after the prefix
 * @returns {string}
 */
function fallbackFor(key) {
    const battery = /^battery-(\d+)(-charging)?$/.exec(key);
    if (battery)
        return `battery-level-${battery[1]}${battery[2] ?? ''}-symbolic`;

    if (key.startsWith('apps-grid'))
        return 'view-app-grid-symbolic';

    return {
        'wifi-1': 'network-wireless-signal-weak-symbolic',
        'wifi-2': 'network-wireless-signal-ok-symbolic',
        'wifi-3': 'network-wireless-signal-excellent-symbolic',
        'wifi-error': 'network-wireless-no-route-symbolic',
        'airpods': 'audio-headphones-symbolic',
        'shortcuts': 'system-run-symbolic',
        'folder': 'folder-symbolic',
        'clipboard': 'edit-paste-symbolic',
    }[key] ?? 'image-missing-symbolic';
}

/**
 * The props that make a St.Icon show `name`: {gicon} for one of ours,
 * {icon_name} for a theme icon.
 *
 * @param {string} name
 * @returns {{gicon: Gio.Icon}|{icon_name: string}}
 */
export function iconProps(name) {
    if (!name.startsWith(PREFIX))
        return {icon_name: name};

    const key = name.slice(PREFIX.length);

    if (!cache.has(key)) {
        let icon = null;
        if (iconsPath) {
            const sfSymbol = SF_SYMBOL_FILES[key];
            const candidates = [
                ...(sfSymbol ? [`${iconsPath}/icons-sfsymbols/${sfSymbol}`] : []),
                `${iconsPath}/icons/cc-${key}-symbolic.svg`,
            ];
            for (const path of candidates) {
                const file = Gio.File.new_for_path(path);
                if (file.query_exists(null)) {
                    icon = new Gio.FileIcon({file});
                    break;
                }
            }
        }
        cache.set(key, icon);
    }

    const icon = cache.get(key);
    return icon ? {gicon: icon} : {icon_name: fallbackFor(key)};
}

/**
 * Changes an existing St.Icon to `name`. Only touches it if something changes,
 * so it is cheap to call on every refresh.
 *
 * @param {St.Icon} actor
 * @param {string} name
 */
export function setIcon(actor, name) {
    const props = iconProps(name);

    if (props.gicon) {
        if (actor.gicon !== props.gicon)
            actor.gicon = props.gicon;
        return;
    }

    // A theme icon: the file icon, if any, has to go first, or it would stay.
    if (actor.gicon)
        actor.gicon = null;
    if (actor.icon_name !== props.icon_name)
        actor.icon_name = props.icon_name;
}

const PANEL_DARK_VARIANTS = new Set([
    'ext:battery-0', 'ext:battery-0-charging',
    'ext:battery-25', 'ext:battery-25-charging',
    'ext:battery-50', 'ext:battery-50-charging',
    'ext:battery-75', 'ext:battery-75-charging',
    'ext:battery-100', 'ext:battery-100-charging',
    'ext:wifi-1', 'ext:wifi-2', 'ext:wifi-3',
    'ext:wifi-error', 'ext:wifi-disabled',
    'ext:bluetooth',
    'ext:spotlight-panel',
]);

/** Applies Kiwi's dark panel foreground to our explicit-color panel glyphs. */
export function setPanelIcon(actor, name, darkText) {
    const themedName = darkText && PANEL_DARK_VARIANTS.has(name)
        ? `${name}-black`
        : name;
    setIcon(actor, themedName);
}
