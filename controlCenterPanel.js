// SPDX-License-Identifier: MIT
//
// macOS Control Center — layout, backends and the arrange mode.
//
// Layout tree (every node carries a style class for CSS targeting):
//
//   .cc-menu                              (PopupMenu content box)
//   └── .macos-control-center             (St.BoxLayout, vertical)
//       ├── .cc-toggle-grid               Clutter.GridLayout, 4 cols, one tile per
//       │   │                             built-in module. The cells are packed
//       │   │                             from the module order, so the default
//       │   │                             arrangement of the reference comes out
//       │   │                             as the cells below and removing one
//       │   │                             module makes the rest close the gap.
//       │   ├── .cc-pill.cc-wifi-pill              (0,0) span 2x1
//       │   ├── .cc-card.cc-media-card             (2,0) span 2x2
//       │   ├── .cc-pill.cc-bluetooth-pill         (0,1) span 2x1
//       │   ├── .cc-pill.cc-airdrop-pill           (0,2) span 2x1
//       │   ├── .cc-icon-button.cc-display-button  (2,2) span 1x1
//       │   ├── .cc-icon-button.cc-screenshot-button (3,2) span 1x1
//       │   ├── .cc-icon-button.cc-darkmode-button   (0,3) span 1x1
//       │   ├── .cc-icon-button.cc-record-button   (1,3) span 1x1
//       │   ├── .cc-pill.cc-focus-pill             (2,3) span 2x1
//       │   └── .cc-edit-overlay           (arrange mode only, one per module:
//       │                                   remove badge, no drag frame)
//       ├── .cc-custom-grid               Clutter.GridLayout, 4 cols, free rows
//       │   ├── .cc-tile-tint             (one per adopted control, beneath it)
//       │   ├── adopted QuickToggle / QuickMenuToggle actors
//       │   └── .cc-edit-overlay          (arrange mode only, one per item:
//       │                                   remove badge + resize grip)
//       ├── .cc-card.cc-slider-card       "Display" label + brightness slider
//       ├── .cc-card.cc-slider-card       "Sound" label + volume slider
//       └── .cc-bottom-bar                centered: Edit / + Add / Done
//
//   Every button of this panel additionally holds a hidden-until-glass
//   `.cc-tile-tint` layer as its first child; see createTileTint().
//
//   .cc-gallery                           (second view, swapped in place)
//   ├── .cc-gallery-header                back button + title
//   ├── .cc-gallery-hint
//   ├── .cc-gallery-scroll                St.ScrollView -> .cc-gallery-list
//   └── .cc-gallery-done
//
// Top bar
// -------
// The Wi-Fi, Bluetooth and battery glyphs of the reference are their own
// PanelMenu.Buttons (WifiStatusIndicator, BluetoothStatusIndicator,
// BatteryStatusIndicator). Each one opens a dropdown of its own, built from the
// control centre's own classes — `.cc-menu` for the sheet, `.cc-pill` for the
// master toggle, `.cc-gallery-row` for a list entry — so a glyph menu and the
// control centre are the same surface at the same width. Being real PopupMenus
// they are also picked up by Liquid Glass exactly like the control centre's.
// extension.js registers the three of them next to the control centre button and
// re-appends that group plus the clock to the right box, which is what puts the
// clock at the far right of the bar with the control centre directly to its left.
//
//   .cc-menu                              one sheet per glyph, the control
//   └── .macos-control-center             centre's own surface and width
//       ├── .cc-pill                      the master switch (Wi-Fi, Bluetooth)
//       ├── .cc-battery-hero              the battery: glyph, level, state
//       ├── .cc-slider-bin                the level as a bar (read-only slider)
//       │   └── .cc-battery-bar
//       ├── .cc-status-scroll             the list part
//       │   └── .cc-status-column
//       │       ├── .cc-status-section    "Known Networks", "My Devices"
//       │       ├── .cc-status-list       one .cc-gallery-row per entry
//       │       └── .cc-status-hint       stands in for an empty list
//       ├── .cc-status-section            "Power Mode"
//       └── .cc-segment                   one .cc-segment-button per profile
//
// Liquid Glass integration
// ------------------------
// The Liquid Glass extension (liquid-glass@thinkingcoding1231.gmail.com) finds
// every dropdown in Main.panel.statusArea whose menu is a real PopupMenu, adds
// `.liquid-glass-transparent` to menu.actor/menu.box and `.liquid-glass-menu-root`
// to menu.box, and draws one sheet of glass behind the box. Its stylesheet then
// forces every descendant StButton to a transparent background (`!important`).
//
// So the panel is built as a *glyph layer on a single sheet*: every tile keeps a
// faint fill, grouping comes from that fill, from the icon circles and from
// spacing, and nothing is nested glass-on-glass as Apple's Liquid Glass guidance
// requires. Because that stylesheet's `!important` cannot be outranked from here
// (and JavaScript cannot write `!important`), the tile fill lives in a
// `.cc-tile-tint` layer under each control's content, which CSS paints only while
// `_syncGlassHost()` has mirrored `.liquid-glass-menu-root` onto `.cc-glass-host`.
// See createTileTint() and the stylesheet for the whole mechanism.
//
// IMPORTANT: St.BoxLayout has no `spacing` GObject property (verified against
// st-box-layout.c on 45 -> 51: it only ever exposed `orientation`, plus the
// removed `vertical`/`pack-start`). Spacing is read exclusively from the theme
// node via st_theme_node_get_length (node, "spacing") and re-applied on every
// style change, so it MUST be declared in stylesheet.css. Passing `spacing` to
// a constructor throws "No property spacing on StBoxLayout".

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gvc from 'gi://Gvc';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { isActorValid } from './lg/actors/lifecycle.js';
    // One owner of blur per surface: ease helpers are written to silently no-op
    // when the actor has been disposed / detached, so a race between teardown
    // and an in-flight animation cannot throw (and cannot leave a stale
    // transition on a destroyed actor).
    function safeEase(a, props) {
        if (!isActorValid(a)) return;
        try {
            a.ease(props);
        } catch (e) {
            // Drop animations that start on an actor already going away.
        }
    }

import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {QuickMenuToggle, QuickToggle} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';

import {attachBlur, backend as blurBackend, detachBlur} from './blur.js';
import {AppearanceController} from './appearance.js';
import {GlassRim} from './glass.js';
import {
    glassAvailable,
    MenuGlass,
    screenRect,
} from './glassSurface.js';
import {iconProps as namedIconProps, setIcon, setPanelIcon} from './icons.js';

const LOG_PREFIX = '[macos-control-center]';
const INTERFACE_SCHEMA = 'org.gnome.desktop.interface';
const USER_THEME_SCHEMA = 'org.gnome.shell.extensions.user-theme';

// Gio.DBusConnection.call() is callback based; promisify it once so every
// helper below can be written as plain async/await.
Gio._promisify(Gio.DBusConnection.prototype, 'call', 'call_finish');
Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');

const DBUS_NAME = 'org.freedesktop.DBus';
const DBUS_PATH = '/org/freedesktop/DBus';
const DBUS_IFACE = 'org.freedesktop.DBus';
const DBUS_PROPERTIES_IFACE = 'org.freedesktop.DBus.Properties';

// NetworkManager and BlueZ are SYSTEM bus services; MPRIS, the screencast
// service and the power plugin are session services. Getting this wrong is
// silent: the proxy simply never initialises and the toggle looks dead.
const NM_NAME = 'org.freedesktop.NetworkManager';
const NM_PATH = '/org/freedesktop/NetworkManager';
const NM_IFACE = 'org.freedesktop.NetworkManager';
const NM_CONNECTION_IFACE = 'org.freedesktop.NetworkManager.Connection.Active';
const NM_DEVICE_IFACE = 'org.freedesktop.NetworkManager.Device';
const NM_WIRELESS_IFACE = 'org.freedesktop.NetworkManager.Device.Wireless';
const NM_ACCESS_POINT_IFACE = 'org.freedesktop.NetworkManager.AccessPoint';
// The settings service, which is a separate object from NetworkManager itself:
// its `Connections` property (and `ListConnections`) is where the saved
// connections live. `org.freedesktop.NetworkManager` has no such property.
const NM_SETTINGS_PATH = '/org/freedesktop/NetworkManager/Settings';
const NM_SETTINGS_IFACE = 'org.freedesktop.NetworkManager.Settings';
// A saved connection, read for its SSID and activated by object path.
const NM_SETTINGS_CONNECTION_IFACE = 'org.freedesktop.NetworkManager.Settings.Connection';
// NMDeviceType.WIFI (the Wi-Fi glyph needs the device's own interface: Device
// caches DeviceType and State, Device.Wireless caches ActiveAccessPoint, and a
// Gio.DBusProxy only ever caches the one interface it was built with).
const NM_DEVICE_WIFI = 2;
// NM80211ApMode.INFRASTRUCTURE and NM80211ApFlags.PRIVACY (the access point
// encrypts even when it advertises no WPA key management).
const NM_AP_MODE_INFRASTRUCTURE = 2;
const NM_AP_FLAG_PRIVACY = 0x1;

/** @returns {'light'|'dark'} the user's GNOME appearance preference */
function statusMenuTheme(interfaceSettings, shellThemeSettings) {
    const source = Gio.SettingsSchemaSource.get_default();
    const interfaceSchema = source?.lookup(INTERFACE_SCHEMA, true);
    const shellThemeSchema = source?.lookup(USER_THEME_SCHEMA, true);
    const scheme = interfaceSchema?.has_key('color-scheme')
        ? interfaceSettings.get_string('color-scheme')
        : 'default';
    if (scheme === 'prefer-dark')
        return 'dark';
    if (scheme === 'prefer-light')
        return 'light';

    // In default mode, the shell theme is the best signal; GTK theme is the
    // fallback for GNOME installations without the User Themes extension.
    const shellTheme = shellThemeSchema?.has_key('name')
        ? shellThemeSettings?.get_string('name') ?? ''
        : '';
    const gtkTheme = interfaceSchema?.has_key('gtk-theme')
        ? interfaceSettings.get_string('gtk-theme')
        : '';
    return /dark|night|black/i.test(shellTheme || gtkTheme) ? 'dark' : 'light';
}

function flatpakAppInstalled(appId) {
    const home = GLib.get_home_dir();
    const roots = [
        `${home}/.local/share/flatpak/app`,
        '/var/lib/flatpak/app',
    ];
    return roots.some(root => {
        const appDirectory = Gio.File.new_for_path(`${root}/${appId}`);
        try {
            const enumerator = appDirectory.enumerate_children(
                'standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
            try {
                return Boolean(enumerator.next_file(null));
            } finally {
                enumerator.close(null);
            }
        } catch {
            return false;
        }
    });
}

/** Finds installed LocalSend / Blip launchers independently of package type. */
function findFileTransferApps() {
    const apps = new Map();
    const flatpakIds = {
        localsend: 'org.localsend.localsend_app',
        blip: 'net.blip.Blip',
    };
    for (const appInfo of Gio.AppInfo.get_all()) {
        if (!appInfo.should_show())
            continue;

        const identity = [appInfo.get_id(), appInfo.get_name(),
            appInfo.get_executable(), appInfo.get_commandline()]
            .filter(Boolean).join(' ').toLowerCase();
        const kind = /localsend|org\.localsend/.test(identity) ? 'localsend'
            : /\bblip\b|net\.blip/.test(identity) ? 'blip' : null;
        if (!kind || apps.has(kind))
            continue;

        const desktopFile = appInfo.get_filename?.() ?? '';
        apps.set(kind, {
            kind,
            name: appInfo.get_name() || (kind === 'blip' ? 'Blip' : 'LocalSend'),
            flatpakId: desktopFile.includes('/flatpak/exports/') ? flatpakIds[kind] : null,
            appInfo,
        });
    }

    // Usually Flatpak's exported .desktop file is enough. This also covers
    // installations that expose only a hidden share action in the app menu.
    const flatpak = GLib.find_program_in_path('flatpak');
    if (flatpak) {
        for (const [kind, appId] of Object.entries(flatpakIds)) {
            if (apps.has(kind) || !flatpakAppInstalled(appId))
                continue;
            const name = kind === 'blip' ? 'Blip' : 'LocalSend';
            apps.set(kind, {
                kind,
                name,
                flatpakId: appId,
                appInfo: Gio.AppInfo.create_from_commandline(
                    `${GLib.shell_quote(flatpak)} run ${appId}`, name,
                    Gio.AppInfoCreateFlags.SUPPORTS_STARTUP_NOTIFICATION),
            });
        }
    }

    // Some hand-installed packages omit a desktop file but put a launcher in PATH.
    const commands = {
        localsend: ['localsend', 'localsend_app'],
        blip: ['blip'],
    };
    for (const [kind, candidates] of Object.entries(commands)) {
        if (apps.has(kind))
            continue;
        for (const command of candidates) {
            const executable = GLib.find_program_in_path(command);
            if (!executable)
                continue;
            apps.set(kind, {
                kind,
                name: kind === 'blip' ? 'Blip' : 'LocalSend',
                appInfo: Gio.AppInfo.create_from_commandline(
                    GLib.shell_quote(executable),
                    kind === 'blip' ? 'Blip' : 'LocalSend',
                    Gio.AppInfoCreateFlags.SUPPORTS_STARTUP_NOTIFICATION),
            });
            break;
        }
    }

    // AppImages that have not registered a .desktop launcher are checked in
    // their usual user locations. Integrated AppImages were already found above.
    const home = GLib.get_home_dir();
    const downloadDirectory = GLib.get_user_special_dir(
        GLib.UserDirectory.DIRECTORY_DOWNLOAD);
    const roots = new Set([
        `${home}/Applications`, `${home}/AppImages`, `${home}/Downloads`,
        `${home}/Descargas`, '/opt',
        ...(downloadDirectory ? [downloadDirectory] : []),
    ]);
    for (const [kind, tokens] of [
        ['localsend', ['localsend']],
        ['blip', ['blip']],
    ]) {
        if (apps.has(kind))
            continue;
        for (const root of roots) {
            let enumerator;
            try {
                enumerator = Gio.File.new_for_path(root).enumerate_children(
                    'standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
            } catch {
                continue;
            }

            try {
                let info;
                while ((info = enumerator.next_file(null))) {
                    const name = info.get_name();
                    const path = GLib.build_filenamev([root, name]);
                    if (info.get_file_type() !== Gio.FileType.REGULAR ||
                        !name.toLowerCase().endsWith('.appimage') ||
                        !tokens.some(token => name.toLowerCase().includes(token)) ||
                        !GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE))
                        continue;

                    apps.set(kind, {
                        kind,
                        name: kind === 'blip' ? 'Blip' : 'LocalSend',
                        appInfo: Gio.AppInfo.create_from_commandline(
                            GLib.shell_quote(path),
                            kind === 'blip' ? 'Blip' : 'LocalSend',
                            Gio.AppInfoCreateFlags.SUPPORTS_STARTUP_NOTIFICATION),
                    });
                    break;
                }
            } catch {
                // Ignore a folder that becomes unavailable while scanning.
            } finally {
                enumerator.close(null);
            }
            if (apps.has(kind))
                break;
        }
    }

    return [...apps.values()];
}

const BLUEZ_NAME = 'org.bluez';
const BLUEZ_PATH = '/';
const BLUEZ_ADAPTER_IFACE = 'org.bluez.Adapter1';
const BLUEZ_DEVICE_IFACE = 'org.bluez.Device1';
const OBJECT_MANAGER_IFACE = 'org.freedesktop.DBus.ObjectManager';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const MPRIS_PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';

const POWER_NAME = 'org.gnome.SettingsDaemon.Power';
const POWER_PATH = '/org/gnome/SettingsDaemon/Power';
const POWER_SCREEN_IFACE = 'org.gnome.SettingsDaemon.Power.Screen';

const UPOWER_NAME = 'org.freedesktop.UPower';
const UPOWER_PATH = '/org/freedesktop/UPower';
const UPOWER_IFACE = 'org.freedesktop.UPower';
const UPOWER_DEVICE_IFACE = 'org.freedesktop.UPower.Device';
// org.freedesktop.UPower.Device.State
const UPOWER_STATE_CHARGING = 1;
const UPOWER_STATE_DISCHARGING = 2;
const UPOWER_STATE_EMPTY = 3;
const UPOWER_STATE_FULLY_CHARGED = 4;
const UPOWER_STATE_PENDING_CHARGE = 5;
const UPOWER_STATE_PENDING_DISCHARGE = 6;

// power-profiles-daemon, the power mode switcher of the battery menu. It is a
// SYSTEM bus service (like UPower itself) and writes `ActiveProfile`.
const POWER_PROFILES_NAME = 'org.freedesktop.UPower.PowerProfiles';
const POWER_PROFILES_PATH = '/org/freedesktop/UPower/PowerProfiles';
const POWER_PROFILES_IFACE = 'org.freedesktop.UPower.PowerProfiles';

const SCREENCAST_NAME = 'org.gnome.Shell.Screencast';
const SCREENCAST_PATH = '/org/gnome/Shell/Screencast';
const SCREENCAST_IFACE = 'org.gnome.Shell.Screencast';

const NOTIFICATIONS_SCHEMA = 'org.gnome.desktop.notifications';

const ADOPTED_TOGGLES_KEY = 'adopted-toggles';
const CUSTOM_LAYOUT_KEY = 'custom-layout';
const HIDDEN_BUILTINS_KEY = 'hidden-builtins';
const CUSTOM_LAYOUT_SIZE_VERSION = 2;

// The custom grid. Items are placed in cells of a four-column grid, two columns
// wide and one row tall by default.
const CUSTOM_COLUMNS = 4;
const CUSTOM_SPACING = 10;
const DEFAULT_SPAN_W = 2;
const DEFAULT_SPAN_H = 1;

/* ------------------------------------------------------------------------ */
/* D-Bus helpers                                                            */
/* ------------------------------------------------------------------------ */

/**
 * @param {object} params
 * @param {Gio.DBusConnection} [params.bus] defaults to the session bus
 * @param {string} params.busName
 * @param {string} params.objectPath
 * @param {string} params.interfaceName
 * @param {(changed: GLib.Variant) => void} [params.onPropertiesChanged]
 * @returns {Gio.DBusProxy} an uninitialised proxy
 */
function createProxy({bus = Gio.DBus.session, busName, objectPath, interfaceName, onPropertiesChanged = null}) {
    const proxy = new Gio.DBusProxy({
        g_connection: bus,
        g_name: busName,
        g_object_path: objectPath,
        g_interface_name: interfaceName,
        g_flags: Gio.DBusProxyFlags.NONE,
    });

    // The handler captures the panel, so its id is kept on the proxy: without
    // an explicit disconnect a proxy that outlives disable() would keep the
    // whole widget tree alive. proxy.dispose() below is the counterpart.
    if (onPropertiesChanged) {
        proxy._ccPropertiesChangedId = proxy.connect('g-properties-changed',
            (_proxy, changed) => onPropertiesChanged(changed));
    }

    return proxy;
}

/** Detaches a proxy's handler so nothing keeps the panel reachable. */
function disposeProxy(proxy) {
    if (proxy?._ccPropertiesChangedId) {
        proxy.disconnect(proxy._ccPropertiesChangedId);
        proxy._ccPropertiesChangedId = 0;
    }
}

/**
 * Initialises a proxy and checks that something is really on the other end.
 *
 * `init_async()` only fails when the connection itself is broken: asking for a
 * well-known name nobody owns still "succeeds" and leaves a proxy whose every
 * property reads back null. That is exactly how a control ends up looking dead
 * (the service was simply on the other bus), so the name owner — not the init
 * result — decides whether a service counts as available.
 *
 * @param {Gio.DBusProxy} proxy
 * @returns {Promise<boolean>} whether the service behind the proxy is there
 */
async function initProxy(proxy) {
    try {
        await proxy.init_async(GLib.PRIORITY_DEFAULT, null);
    } catch (e) {
        console.warn(`${LOG_PREFIX} ${proxy.get_name()}${proxy.get_object_path()} unavailable: ${e.message}`);
        return false;
    }

    if (!proxy.g_name_owner) {
        const bus = proxy.get_connection() === Gio.DBus.system
            ? 'the system bus'
            : 'the session bus';
        console.warn(`${LOG_PREFIX} ${proxy.get_name()} has no owner on ${bus}`);
        return false;
    }

    return true;
}

/**
 * Writes a property through org.freedesktop.DBus.Properties, on whichever bus
 * the proxy was built for — never assume the session bus.
 *
 * @returns {Promise<boolean>} whether the property was written
 */
async function setDBusProperty(proxy, interfaceName, propertyName, value) {
    if (!proxy)
        return false;

    const connection = proxy.get_connection() ?? Gio.DBus.session;

    try {
        await connection.call(
            proxy.get_name(), proxy.get_object_path(), DBUS_PROPERTIES_IFACE, 'Set',
            new GLib.Variant('(ssv)', [interfaceName, propertyName, value]),
            null, Gio.DBusCallFlags.NONE, -1, null);
        return true;
    } catch (e) {
        console.warn(`${LOG_PREFIX} cannot set ${interfaceName}.${propertyName}: ${e.message}`);
        return false;
    }
}

function callDBusMethod(proxy, methodName, parameters = null) {
    if (!proxy)
        return;

    const connection = proxy.get_connection() ?? Gio.DBus.session;

    connection.call(
        proxy.get_name(), proxy.get_object_path(), proxy.get_interface_name(),
        methodName, parameters, null, Gio.DBusCallFlags.NONE, -1, null)
        .catch(e => console.warn(`${LOG_PREFIX} ${methodName}() failed: ${e.message}`));
}

/** @returns {boolean} whether two grid rectangles overlap */
function rectsOverlap(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/* ------------------------------------------------------------------------ */
/* Reusable widgets                                                         */
/* ------------------------------------------------------------------------ */

/**
 * The tint layer every tile carries.
 *
 * The Liquid Glass stylesheet clears `background-color`, `border-color` and
 * `box-shadow` on *every* StButton with `!important`, and JavaScript cannot add
 * `!important`. A tile therefore keeps its fill in a plain St.Widget stacked
 * under the tile's own content. The stylesheet only paints it while the glass
 * sheet hosts the menu (`.cc-glass-host`), which is precisely when a button's
 * own fill has been taken away — standalone the layer stays invisible and the
 * button styles itself as it always did.
 *
 * @param {boolean} [fill] whether the layer must cover its parent, which an
 *   empty widget only does when it expands: Clutter.BinLayout gives a
 *   non-expanding child its natural size (zero) centred, while a grid cell is
 *   handed straight to the child and filled by its default `FILL` alignment.
 * @returns {St.Widget}
 */
function createTileTint(fill = false) {
    const tint = new St.Widget({
        style_class: 'cc-tile-tint',
        reactive: false,
    });

    if (fill) {
        tint.x_expand = true;
        tint.y_expand = true;
    }

    return tint;
}

/**
 * Adds the tint layer to a button, underneath whatever the button is built
 * from. `st_bin_set_child()` only removes the child it set itself, so a layer
 * added here survives a later `set_child()`.
 *
 * @param {St.Button} button
 * @returns {St.Button} the same button, for chaining
 */
function addTileTint(button, {rim = 'full'} = {}) {
    // St.Bin only allocates the one child it manages, so a tint inserted as a
    // second child of the button is never given a size and never paints (this is
    // why the round shortcuts, Focus and Edit Controls had no fill on the glass).
    // The button's single child is therefore a BinLayout host that stacks the
    // tint under the real content, and set_child() is redirected into that host
    // so every call site keeps working unchanged.
    const host = new St.Widget({
        layout_manager: new Clutter.BinLayout(),
        x_expand: true,
        y_expand: true,
    });
    host.add_child(createTileTint(true));

    // The glass rim is the topmost layer: tint, content, rim.
    const rimActor = rim ? new GlassRim({radius: rim}) : null;
    if (rimActor)
        host.add_child(rimActor);

    button.set_child(host);

    let content = null;
    button.set_child = child => {
        if (content)
            host.remove_child(content);
        content = child ?? null;
        if (content) {
            content.get_parent()?.remove_child(content);
            host.add_child(content);
            if (rimActor)
                host.set_child_below_sibling(content, rimActor);
        }
    };

    return button;
}

/**
 * The pieces of a menu that are a bubble of glass: what the glass has to be put
 * behind, and what the opening cascade animates. The transport buttons of the
 * media card are not bubbles.
 *
 * @param {Clutter.Actor} root
 * @returns {St.Widget[]} visible bubbles in layout order
 */
function collectBubbles(root) {
    const targets = [];

    const isBubble = actor => actor instanceof St.Widget && (
        actor.has_style_class_name('cc-pill') ||
        actor.has_style_class_name('cc-card') ||
        actor.has_style_class_name('cc-bottom-button') ||
        actor.has_style_class_name('cc-gallery-row') ||
        actor.has_style_class_name('cc-segment-button') ||
        actor.has_style_class_name('cc-battery-hero') ||
        // Adopted Quick Settings are regions of the same menu glass surface;
        // they inherit its user-selected Control Center material and radius.
        actor.has_style_class_name('quick-toggle') ||
        (actor.has_style_class_name('cc-icon-button') &&
            !actor.has_style_class_name('cc-media-button')));

    const visit = parent => {
        for (const child of parent.get_children()) {
            if (!child.visible)
                continue;

            if (isBubble(child))
                targets.push(child);
            else
                visit(child);
        }
    };
    visit(root);

    return targets;
}

/**
 * Real glass takes over the look of a menu: the fills, borders and the drawn
 * rim of the bubbles give way to the glass behind them.
 *
 * @param {St.Widget} box the menu's box
 * @param {boolean} active
 */
function setGlassActive(box, active) {
    if (active)
        box.add_style_class_name('cc-glass-active');
    else
        box.remove_style_class_name('cc-glass-active');

    const setRims = actor => {
        for (const child of actor.get_children()) {
            if (child instanceof GlassRim)
                child.visible = !active;
            else
                setRims(child);
        }
    };
    setRims(box);
}

/**
 * The corner radius of a bubble's glass, px. Capsules and circles ask for more
 * than they can have, which the shader limits to half their shorter side; the
 * cards keep the radius macOS gives them.
 *
 * @param {Clutter.Actor} actor
 * @returns {number}
 */
function glassRadiusOf(actor) {
    if (actor.has_style_class_name('cc-media-card'))
        return 30;
    if (actor.has_style_class_name('cc-card') || actor.has_style_class_name('cc-battery-hero'))
        return 26;
    return 999;
}

/** What the glass behind a menu is made of: dark and smoked, under white text. */
const MENU_GLASS = {
    tint: [0.10, 0.10, 0.14],
    tintStrength: 0.30,
    cornerRadius: 30,
    blurRadius: 10,
    brightness: 1.0,
    saturation: 1.4,
};

/** Status sheets keep compositor glass blur and tint to the active Shell theme. */
const STATUS_MENU_GLASS = {
    tint: [1, 1, 1],
    tintStrength: 0,
    cornerRadius: 22,
    blurRadius: 18,
    brightness: 1.0,
    saturation: 1.0,
    contrast: 1.0,
};

/** The blur every bubble carries: a capsule/circle clipped to its own shape. */
const BUBBLE_BLUR = {sigma: 22, brightness: 1.0, radius: 'full'};

/**
 * Press feedback: the bubble gives a little under the pointer and springs back.
 * Only paint-time transforms are animated, so the layout never moves.
 *
 * @param {St.Button} button
 */
function addPressFeedback(button) {
    button.set_pivot_point(0.5, 0.5);
    button.connect('notify::pressed', () => {
        const down = button.pressed;
        button.ease({
            scale_x: down ? 0.94 : 1,
            scale_y: down ? 0.94 : 1,
            duration: down ? 80 : 300,
            mode: down
                ? Clutter.AnimationMode.EASE_OUT_QUAD
                : Clutter.AnimationMode.EASE_OUT_BACK,
        });
    });
}

/** Circular, icon-only button used for every small square in the grid. */
const CCIconButton = GObject.registerClass(
class CCIconButton extends St.Button {
    /**
     * @param {object} params
     * @param {string} params.iconName
     * @param {string} [params.styleClass]
     * @param {boolean} [params.toggleMode]
     * @param {string} [params.accessibleName]
     */
    _init({iconName, styleClass = '', toggleMode = false, accessibleName = '', fill = false}) {
        super._init({
            style_class: `cc-icon-button ${styleClass}`.trim(),
            can_focus: true,
            reactive: true,
            track_hover: true,
            toggle_mode: toggleMode,
            accessible_name: accessibleName,
            // Keep the circle centred (and circular) when the grid cell is
            // taller or wider than the button itself.
            x_align: fill ? Clutter.ActorAlign.FILL : Clutter.ActorAlign.CENTER,
            y_align: fill ? Clutter.ActorAlign.FILL : Clutter.ActorAlign.CENTER,
            x_expand: fill,
            y_expand: fill,
        });

        this._iconWidget = new St.Icon({
            ...namedIconProps(iconName),
            style_class: 'cc-icon-button-icon',
        });
        // Paint order: the tile tint first, the glyph on top of it.
        addTileTint(this);
        this.set_child(this._iconWidget);

        // Only the grid shortcuts are bubbles; the media transport buttons are
        // bare glyphs.
        if (fill) {
            attachBlur(this, BUBBLE_BLUR);
            addPressFeedback(this);
        }
    }

    /** @type {St.Icon} */
    get icon() {
        return this._iconWidget;
    }
});

/**
 * Wide tile: circular icon + title + optional subtitle and/or network chip.
 * Matches the Wi-Fi / Bluetooth / AirDrop / Focus modules of the reference.
 */
const CCPillButton = GObject.registerClass(
class CCPillButton extends St.Button {
    /**
     * @param {object} params
     * @param {string} params.iconName
     * @param {string} params.title
     * @param {string|null} [params.subtitle]
     * @param {string} [params.styleClass]
     * @param {boolean} [params.toggleMode]
     * @param {boolean} [params.hasChip] render a small network chip under the title
     * @param {boolean} [params.rim] draw the decorative tile rim (default true)
     * @param {boolean} [params.pressFeedback] animate the tile on press (default true)
     */
    _init({iconName, title, subtitle = null, styleClass = '', toggleMode = false,
        hasChip = false, withSwitch = false, blur = true, rim = true,
        pressFeedback = true}) {
        super._init({
            style_class: `cc-pill ${styleClass}`.trim(),
            can_focus: true,
            reactive: true,
            track_hover: true,
            toggle_mode: toggleMode,
            x_expand: true,
        });

        const content = new St.BoxLayout({
            style_class: 'cc-pill-content',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
        });

        this._iconCircle = new St.Bin({
            style_class: 'cc-pill-icon-circle',
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({
                ...namedIconProps(iconName),
                style_class: 'cc-pill-icon',
            }),
        });
        content.add_child(this._iconCircle);

        const textBox = new St.BoxLayout({
            style_class: 'cc-pill-text',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._titleLabel = new St.Label({
            text: title,
            style_class: 'cc-pill-title',
            x_align: Clutter.ActorAlign.START,
        });
        this._titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        textBox.add_child(this._titleLabel);

        this._subtitleLabel = null;
        if (subtitle !== null) {
            this._subtitleLabel = new St.Label({
                text: subtitle,
                style_class: 'cc-pill-subtitle',
                x_align: Clutter.ActorAlign.START,
            });
            this._subtitleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            textBox.add_child(this._subtitleLabel);
        }

        // The reference shows a small rounded chip under "Wi-Fi" holding the
        // network name, or an empty placeholder when nothing is connected.
        this._chipLabel = null;
        this._chip = null;
        if (hasChip) {
            this._chipLabel = new St.Label({
                text: '',
                style_class: 'cc-pill-chip-label',
            });
            this._chipLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            this._chip = new St.Bin({
                style_class: 'cc-pill-chip',
                x_align: Clutter.ActorAlign.START,
                child: this._chipLabel,
            });
            textBox.add_child(this._chip);
        }

        content.add_child(textBox);

        // The header of a menu-bar dropdown: title on the left and a switch on
        // the right, with no icon disc, as in the macOS Wi-Fi / Bluetooth menus.
        // The switch is only a display of `checked`; the pill stays the control.
        if (withSwitch) {
            this._iconCircle.visible = false;
            this._switch = new PopupMenu.Switch(this.checked);
            this._switch.y_align = Clutter.ActorAlign.CENTER;
            content.add_child(this._switch);
            this.connectObject('notify::checked', () => {
                this._switch.state = this.checked;
            }, this);
        }

        // Paint order: the tile tint first, the pill's content on top of it.
        addTileTint(this, {rim: rim ? 'full' : null});
        this.set_child(content);

        if (blur)
            attachBlur(this, BUBBLE_BLUR);
        if (pressFeedback)
            addPressFeedback(this);
        if (!withSwitch)
            this.connectObject('notify::checked', () => this._pulseIcon(), this);
    }

    /** The icon disc pops when the tile is switched. */
    _pulseIcon() {
        const disc = this._iconCircle;
        disc.remove_all_transitions();
        disc.set_pivot_point(0.5, 0.5);
        disc.set({scale_x: 0.68, scale_y: 0.68});
        disc.ease({
            scale_x: 1,
            scale_y: 1,
            duration: 420,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
    }

    /** @type {St.Icon} */
    get icon() {
        return this._iconCircle.get_child();
    }

    /** @type {St.Label} */
    get titleLabel() {
        return this._titleLabel;
    }

    /** @type {St.Label|null} */
    get subtitleLabel() {
        return this._subtitleLabel;
    }

    /**
     * @param {string|null} text network name, or null for the empty placeholder
     */
    setChipText(text) {
        if (!this._chip)
            return;

        this._chipLabel.text = text ?? '';
        this._chipLabel.visible = Boolean(text);
    }
});

/** One "icon + St.Slider + icon" row, wrapped by a .cc-slider-card. */
const CCSliderRow = GObject.registerClass(
class CCSliderRow extends St.BoxLayout {
    /**
     * @param {object} params
     * @param {string} params.startIcon
     * @param {string} params.endIcon
     * @param {string} params.accessibleName
     */
    _init({startIcon, endIcon, accessibleName}) {
        super._init({
            style_class: 'cc-slider-row',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
        });

        this.add_child(new St.Icon({
            ...namedIconProps(startIcon),
            style_class: 'cc-slider-icon cc-slider-icon-start',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        this.slider = new Slider(0);
        this.slider.accessible_name = accessibleName;

        // The track is BarLevel's own bar; the knob is a separate piece of glass
        // laid over it, because BarLevel can only draw a round handle. The knob
        // takes no input, so every press and drag still goes to the slider.
        this._track = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this._track.add_child(this.slider);

        this._thumb = new St.Widget({
            style_class: 'cc-slider-thumb',
            layout_manager: new Clutter.BinLayout(),
            reactive: false,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._thumb.set_pivot_point(0.5, 0.5);
        this._thumb.add_child(new GlassRim({radius: 'full', rim: 1.1}));
        this._track.add_child(this._thumb);

        this._sliderBin = new St.Bin({
            style_class: 'cc-slider-bin cc-slider-glass',
            child: this._track,
            reactive: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._sliderBin);

        this.add_child(new St.Icon({
            ...namedIconProps(endIcon),
            style_class: 'cc-slider-icon cc-slider-icon-end',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        this.slider.connectObject(
            'key-focus-in', () => this._sliderBin.add_style_pseudo_class('focus'),
            'key-focus-out', () => this._sliderBin.remove_style_pseudo_class('focus'),
            'notify::value', () => this._syncThumb(),
            this);
        this._track.connectObject('notify::allocation', () => this._syncThumb(), this);
        this._thumb.connectObject('notify::allocation', () => this._syncThumb(), this);

        // The knob swells while it is held, and springs back.
        try {
            this.slider.connectObject(
                'drag-begin', () => this._holdThumb(true),
                'drag-end', () => this._holdThumb(false),
                this);
        } catch (e) {
            console.warn(`macos-control-center: no drag signals on the slider: ${e.message}`);
        }
    }

    /**
     * The knob sits on the end of the fill, kept inside the track: at the ends
     * the fill reaches past the knob's centre, as on macOS.
     */
    _syncThumb() {
        const trackWidth = this._track.width;
        if (trackWidth <= 0)
            return;

        // BarLevel draws value / maximum: a volume slider's maximum is above 1
        // (it can be pushed past 100%), so the plain value would put the knob
        // beyond the end of the fill.
        const maximum = this.slider.maximum_value > 0 ? this.slider.maximum_value : 1;
        const fraction = Math.max(0, Math.min(1, this.slider.value / maximum));

        const knobWidth = this._thumb.width > 0 ? this._thumb.width : 34;
        const wanted = Math.max(0, Math.min(trackWidth - knobWidth,
            fraction * trackWidth - knobWidth / 2));

        // The layout puts the knob wherever its alignment says (the middle of the
        // track, as it turned out); the translation is what is needed on top of
        // that to get it to `wanted`.
        this._thumb.translation_x = wanted - this._thumb.x;
    }

    /** @param {boolean} held */
    _holdThumb(held) {
        this._thumb.ease({
            scale_x: held ? 1.22 : 1,
            scale_y: held ? 1.22 : 1,
            duration: held ? 120 : 340,
            mode: held
                ? Clutter.AnimationMode.EASE_OUT_QUAD
                : Clutter.AnimationMode.EASE_OUT_BACK,
        });
    }
});

/** A single row of a list: the "add controls" gallery, and the Wi-Fi,
 *  Bluetooth and battery menus, which reuse it verbatim so a network row and a
 *  gallery row are the same object at the same size. */
const CCGalleryRow = GObject.registerClass(
class CCGalleryRow extends St.Button {
    /**
     * @param {object} params
     * @param {string|null} params.iconName
     * @param {Gio.Icon|null} [params.gicon]
     * @param {string} params.title
     * @param {string|null} [params.subtitle] shown under the title when set; the
     *   label itself always exists, so a menu can write to it later on
     * @param {string|null} [params.trailingIcon] glyph between text and check,
     *   e.g. the lock of a secured network
     * @param {boolean} [params.available]
     * @param {boolean} [params.toggleMode] false for a row that is shown as
     *   selected but does nothing when clicked, e.g. the network in use
     * @param {boolean} [params.flat] render as an unboxed row, for a Wi-Fi list
     */
    _init({iconName, gicon = null, title, subtitle = null, trailingIcon = null,
        available = true, toggleMode = true, flat = false}) {
        super._init({
            style_class: `cc-gallery-row${flat ? ' cc-status-flat-row' : ''}${available ? '' : ' cc-gallery-row-unavailable'}`,
            can_focus: true,
            reactive: true,
            track_hover: true,
            toggle_mode: toggleMode,
            x_expand: true,
        });

        const box = new St.BoxLayout({
            style_class: 'cc-gallery-row-content',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
        });

        const iconProps = {
            style_class: 'cc-gallery-row-icon',
            y_align: Clutter.ActorAlign.CENTER,
        };
        if (gicon)
            iconProps.gicon = gicon;
        else
            Object.assign(iconProps, namedIconProps(iconName ?? 'application-x-executable-symbolic'));
        this._iconWidget = new St.Icon(iconProps);
        box.add_child(this._iconWidget);

        const textBox = new St.BoxLayout({
            style_class: 'cc-gallery-row-text',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._titleLabel = new St.Label({
            text: title,
            style_class: 'cc-gallery-row-title',
            x_align: Clutter.ActorAlign.START,
        });
        this._titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        textBox.add_child(this._titleLabel);

        this._subtitleLabel = new St.Label({
            text: subtitle ?? '',
            style_class: 'cc-gallery-row-subtitle',
            x_align: Clutter.ActorAlign.START,
            visible: subtitle !== null && subtitle !== '',
        });
        this._subtitleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        textBox.add_child(this._subtitleLabel);
        box.add_child(textBox);

        this._trailing = null;
        if (trailingIcon) {
            this._trailing = new St.Icon({
                icon_name: trailingIcon,
                style_class: 'cc-gallery-row-trailing',
                y_align: Clutter.ActorAlign.CENTER,
            });
            box.add_child(this._trailing);
        }

        this._check = new St.Icon({
            icon_name: 'object-select-symbolic',
            style_class: 'cc-gallery-row-check',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        box.add_child(this._check);

        // Paint order: the tile tint first, the row's content on top of it.
        addTileTint(this, {rim: flat ? null : 'full'});
        this.set_child(box);
        if (!flat) {
            attachBlur(this, BUBBLE_BLUR);
            addPressFeedback(this);
        }

        this.connect('notify::checked', () => {
            this._check.visible = this.checked;
        });
    }

    /** @type {St.Icon} */
    get icon() {
        return this._iconWidget;
    }

    /** @type {St.Label} */
    get titleLabel() {
        return this._titleLabel;
    }

    /** @type {St.Label} */
    get subtitleLabel() {
        return this._subtitleLabel;
    }
});

/**
 * The frame a control is edited with in arrange mode: a "−" badge in the
 * top-left corner that removes the control, plus — for a control adopted from
 * the Shell, which can also be moved and resized — a grip in the bottom-right
 * corner.
 *
 * This is a plain St.Widget on purpose: the Liquid Glass stylesheet forces every
 * StButton background to transparent, and a StButton frame would therefore
 * disappear on the glass sheet. Being a sibling placed over the real control it
 * also swallows the clicks, so arranging never toggles the control underneath.
 */
const CCEditOverlay = GObject.registerClass({
    Signals: {
        'move-request': {},
        'resize-request': {},
        'remove-request': {},
    },
}, class CCEditOverlay extends St.Widget {
    /**
     * @param {object} [params]
     * @param {boolean} [params.rearrangeable] whether the control can be moved
     *   and resized (one adopted from the Shell) or only removed
     */
    _init({rearrangeable = true} = {}) {
        super._init({
            style_class: rearrangeable
                ? 'cc-edit-overlay'
                : 'cc-edit-overlay cc-edit-overlay-remove',
            reactive: true,
            track_hover: true,
            x_expand: true,
            y_expand: true,
            // BinLayout gives every child the whole frame and honours its align.
            layout_manager: new Clutter.BinLayout(),
        });

        // `x_expand`/`y_expand` are what make the align properties below mean
        // anything: Clutter.BinLayout gives a non-expanding child the whole
        // frame and centres it, and only consults the child's alignment once it
        // expands.
        this._remove = new St.Bin({
            style_class: 'cc-edit-remove',
            reactive: true,
            track_hover: true,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
            child: new St.Icon({
                icon_name: 'list-remove-symbolic',
                style_class: 'cc-edit-remove-icon',
            }),
        });
        this.add_child(this._remove);

        // Like the grip, the badge sits on top of the frame, so it wins the
        // press and EVENT_STOP keeps it from starting a move.
        this._remove.connect('button-press-event', () => {
            this.emit('remove-request');
            return Clutter.EVENT_STOP;
        });

        this._grip = null;
        if (rearrangeable) {
            this._grip = new St.Widget({
                style_class: 'cc-edit-grip',
                reactive: true,
                track_hover: true,
                x_expand: true,
                y_expand: true,
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.END,
            });
            this.add_child(this._grip);

            this._grip.connect('button-press-event', () => {
                this.emit('resize-request');
                return Clutter.EVENT_STOP;
            });
        }

        // Swallow the press so arranging never reaches the control underneath;
        // on a rearrangeable frame it starts a move instead.
        this.connect('button-press-event', () => {
            if (rearrangeable)
                this.emit('move-request');
            return Clutter.EVENT_STOP;
        });
    }
});

/* ------------------------------------------------------------------------ */
/* MPRIS                                                                    */
/* ------------------------------------------------------------------------ */

const MprisController = GObject.registerClass({
    Signals: {
        'changed': {},
    },
}, class MprisController extends GObject.Object {
    _init() {
        super._init();

        this._proxy = null;
        this._busName = null;
        this._title = '';
        this._artist = '';
        this._artUrl = '';
        this._playing = false;

        this._nameOwnerId = Gio.DBus.session.signal_subscribe(
            DBUS_NAME, DBUS_IFACE, 'NameOwnerChanged', DBUS_PATH, null,
            Gio.DBusSignalFlags.NONE,
            (_connection, _sender, _path, _iface, _signal, params) => {
                const [name] = params.deepUnpack();
                if (name.startsWith(MPRIS_PREFIX))
                    this._selectPlayer();
            });
    }

    get title() {
        return this._title;
    }

    get artist() {
        return this._artist;
    }

    get artUrl() {
        return this._artUrl;
    }

    get playing() {
        return this._playing;
    }

    playPause() {
        callDBusMethod(this._proxy, 'PlayPause');
    }

    next() {
        callDBusMethod(this._proxy, 'Next');
    }

    previous() {
        callDBusMethod(this._proxy, 'Previous');
    }

    /** Pick the most suitable MPRIS player and attach to it. */
    async _selectPlayer() {
        let players = [];

        try {
            const reply = await Gio.DBus.session.call(
                DBUS_NAME, DBUS_PATH, DBUS_IFACE, 'ListNames',
                null, new GLib.VariantType('(as)'),
                Gio.DBusCallFlags.NONE, -1, null);
            const [names] = reply.deepUnpack();
            players = names.filter(name => name.startsWith(MPRIS_PREFIX));
        } catch (e) {
            console.warn(`${LOG_PREFIX} MPRIS lookup failed: ${e.message}`);
        }

        const busName = players.includes(this._busName)
            ? this._busName
            : players[0] ?? null;

        if (busName === this._busName && this._proxy)
            return;

        await this._attachPlayer(busName);
    }

    async _attachPlayer(busName) {
        this._proxy = null;
        this._busName = busName;

        if (!busName) {
            this._setState('', '', '', false);
            return;
        }

        const proxy = createProxy({
            busName,
            objectPath: MPRIS_PATH,
            interfaceName: MPRIS_PLAYER_IFACE,
            onPropertiesChanged: () => this._sync(),
        });

        if (!await initProxy(proxy))
            return;

        // A newer player may have won the race while we were awaiting.
        if (this._busName !== busName)
            return;

        this._proxy = proxy;
        this._sync();
    }

    _sync() {
        const metadata = this._proxy?.get_cached_property('Metadata');
        const playbackStatus =
            this._proxy?.get_cached_property('PlaybackStatus')?.unpack() ?? 'Stopped';

        let title = '';
        let artist = '';
        let artUrl = '';

        if (metadata) {
            const track = metadata.recursiveUnpack();
            title = track['xesam:title'] ?? '';
            artUrl = track['mpris:artUrl'] ?? '';

            const artists = track['xesam:artist'];
            if (Array.isArray(artists))
                artist = artists.join(', ');
            else if (typeof artists === 'string')
                artist = artists;
        }

        this._setState(title, artist, artUrl, playbackStatus === 'Playing');
    }

    _setState(title, artist, artUrl, playing) {
        if (this._title === title && this._artist === artist &&
            this._artUrl === artUrl && this._playing === playing)
            return;

        this._title = title;
        this._artist = artist;
        this._artUrl = artUrl;
        this._playing = playing;
        this.emit('changed');
    }

    destroy() {
        if (this._nameOwnerId) {
            Gio.DBus.session.signal_unsubscribe(this._nameOwnerId);
            this._nameOwnerId = 0;
        }

        disposeProxy(this._proxy);
        this._proxy = null;
        this._busName = null;
    }
});

/* ------------------------------------------------------------------------ */
/* Panel                                                                    */
/* ------------------------------------------------------------------------ */

export class ControlCenterPanel extends PanelMenu.Button {
    static {
        GObject.registerClass(this);
    }

    /** @param {import('resource:///org/gnome/shell/extensions/extension.js').Extension} extension */
    _init(extension) {
        super._init(0.0, extension.gettext('Control Center'));

        this._extension = extension;
        this._gettext = extension.gettext.bind(extension);

        this._settings = null;
        this._proxies = [];

        this._mpris = null;
        this._mediaArtSession = Soup.Session.new();
        this._mediaArtGeneration = 0;
        this._mediaArtCacheDirectory = GLib.build_filenamev([
            GLib.get_user_cache_dir(), 'macos-control-center', 'media-art',
        ]);

        this._mixerControl = null;
        this._volumeStream = null;
        this._volumeSliderSyncing = false;
        this._volumeCcChangeUntil = 0;

        this._brightnessManager = null;
        this._brightnessScale = null;
        this._brightnessProxy = null;
        this._brightnessSliderSyncing = false;
        this._brightnessCcChangeUntil = 0;

        this._nativeFeedbackHideId = 0;

        this._wifiProxy = null;
        this._wifiConnectionProxy = null;
        this._wifiConnectionName = '';
        this._wifiReady = false;

        this._adapterProxy = null;
        this._bluetoothReady = false;
        this._bluezOwnerId = 0;

        this._recording = false;
        this._screenDialog = null;
        this._airdropDialog = null;
        this._activeFileTransferApp = null;
        this._airdropClosing = false;
        this._appSystem = Shell.AppSystem.get_default();
        this._appStateChangedId = this._appSystem.connect('app-state-changed', (_system, app) => {
            const activeApp = this._activeFileTransferApp;
            if (activeApp && this._matchesFileTransferApp(app, activeApp) &&
                app.state === Shell.AppState.STOPPED && !this._airdropClosing)
                this._setAirDropInactive();
        });

        // Adopted Quick Settings items. `_desired` is the persisted wish-list
        // (titles), `_adopted` maps title -> live record while materialised and
        // `_layout` maps title -> {x, y, w, h} cell rectangle.
        this._desired = new Set();
        this._adopted = new Map();
        this._layout = new Map();
        this._layoutNeedsSizeMigration = false;
        this._galleryRows = [];

        // Arrange mode.
        this._editMode = false;
        this._overlays = new Map();
        this._builtInButtons = [];
        // Whether each built-in module is usable right now. Kept separate from
        // `reactive` so that leaving arrange mode cannot revive a control whose
        // backend never came up (a missing BlueZ adapter, say).
        this._builtInEnabled = new Map();
        // The panel's own modules in slot order, and the ones kept out of the
        // panel. Filled in by `_buildToggleGrid()`.
        this._builtInModules = [];
        this._hiddenBuiltIns = new Set();
        this._drag = null;
        this._stageMotionId = 0;
        this._stageReleaseId = 0;

        this._initSettings();

        // ---- status area button -------------------------------------------
        this.add_style_class_name('cc-panel-button');
        this._panelIcon = new St.Icon({
            ...namedIconProps('ext:control-center-panel-white'),
            style_class: 'system-status-icon cc-panel-icon',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._panelIcon);
        this._syncPanelIconTone();
        this._panelStyleSignal = Main.panel.connect('style-changed',
            () => this._syncPanelIconTone());

        // ---- menu ---------------------------------------------------------
        this.menu.box.add_style_class_name('cc-menu');
        // Bubble mode: no sheet behind the tiles, every control is its own piece
        // of glass. The BoxPointer (menu.actor) paints its own fill and outline
        // unless a glass extension clears them, so it gets a class too.
        this.menu.box.add_style_class_name('cc-bubbles');
        this.menu.actor.add_style_class_name('cc-bubbles-pointer');
        // With real (rounded) blur behind them the bubbles are clear glass; without
        // it they stay smoked so the text remains legible.
        if (blurBackend === 'rounded' || blurBackend === 'square')
            this.menu.box.add_style_class_name('cc-blur-active');

        // The glass behind the bubbles, created when the menu is first opened.
        this._menuGlass = glassAvailable
            ? new MenuGlass({
                path: extension.path,
                owner: 'control-center',
                menu: this.menu,
                collect: () => collectBubbles(this.menu.box),
                onActive: active => setGlassActive(this.menu.box, active),
                radiusOf: glassRadiusOf,
                material: MENU_GLASS,
            })
            : null;
        // The main centre menu is hosted by our own MenuGlass (Real Liquid
        // Glass) when the renderer is available. We create it eagerly so the
        // sheet is already on stage before the tiles animate — the menu should
        // never see an empty backdrop then glass: the sheet is present from the
        // first open and stays for the whole lifetime of the menu.
        if (this._menuGlass) {
            // MenuGlass only becomes visible after the menu is shown. Push the
            // first activation to the next main-loop iteration so we never hit
            // signal-contract issues in headless/early-stage maps and so the
            // sheet is already there by the time the tiles start animating.
            this._menuGlassOversight = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                if (!this._menuGlass) return GLib.SOURCE_REMOVE;
                if (this._menuGlass.active !== true) {
                    this._menuGlass.active = true;
                    this._menuGlass.refresh?.();
                }
                return GLib.SOURCE_REMOVE;
            });

        }

        this._section = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._section);
        this._section.box.add_child(this._buildContent());
        this._section.box.add_child(this._buildGallery());

        this._setupGlassDetection();

        // ---- backends -----------------------------------------------------
        this._mpris = new MprisController();
        this._mpris.connectObject('changed', () => this._syncMediaCard(), this);

        this._initFocusMode();
        this._initDarkMode();
        this._initVolume();
        this._initBrightness();
        this._initWifi();
        this._initBluetooth();

        this._syncMediaCard();
        this._syncRecordingButton();

        // Re-resolve the active MPRIS player, retry any backend that was not up
        // yet and pick up late-registering third-party toggles on every open.
        this.menu.connectObject('open-state-changed', (_menu, isOpen) => {
            // The stage-level drag listeners must not outlive the popup.
            if (!isOpen) {
                this._endDrag();
                this._resetBubbles();
                return;
            }

            // The glass sheet must already be drawn before the tiles animate, so the
            // opening reads as one in-place reveal rather than tiles appearing onto an
            // empty backdrop. When a renderer is available, MenuGlass is created
            // eagerly in _init() and stays hidden until the popup is mapped; this
            // call makes sure it is active and refreshed before the animation.
            this._ensureGlassReady();
            this._playOpenAnimation();
            this._mpris?._selectPlayer();

            if (!this._wifiReady)
                this._initWifi();
            // Always re-checked: BlueZ may have gained, lost or swapped an
            // adapter since the last open, and the call is a cheap round trip.
            this._initBluetooth();

            this._reconcileAdoptedToggles();
            if (this._gallery.visible)
                this._refreshGallery();
        }, this);
    }

    /* ------------------------------------------------------------- animation */

    /**
     * The bubbles of the main page, in layout order.
     * @returns {St.Widget[]}
     */
    _ensureGlassReady = function() {
        if (!this._menuGlass) return;
        // When a renderer is available, make sure the sheet is active and
        // refreshed before the tiles animate. MenuGlass may not have mapped
        // yet, so this is a no-op until the popup is actually shown.
        if (this._menuGlass.active !== true) {
            this._menuGlass.active = true;
            this._menuGlass.refresh?.();
        }
    };

    _bubbleTargets() {
        return this._content ? collectBubbles(this._content) : [];
    }

    /**
     * The bubbles rise into place one after another, each overshooting a little
     * before it settles. Opacity and the transform ease with different curves:
     * an overshooting curve would push the opacity past its range.
     */
    _playOpenAnimation() {
        this._resetBubbles();

        const targets = this._bubbleTargets();
        this._animatedBubbles = targets;

        targets.forEach((actor, index) => {
            const delay = 30 + index * 26;

            actor.remove_all_transitions();
            actor.set_pivot_point(0.5, 0.5);
            actor.set({opacity: 0, scale_x: 0.86, scale_y: 0.86, translation_y: 14});

            actor.ease({
                opacity: 255,
                duration: 220,
                delay,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
            actor.ease({
                scale_x: 1,
                scale_y: 1,
                translation_y: 0,
                duration: 420,
                delay,
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
            });
        });
    }

    /** Puts every bubble back to rest, so a closed menu never keeps a half-played state. */
    _resetBubbles() {
        for (const actor of this._animatedBubbles ?? []) {
            try {
                actor.remove_all_transitions();
                actor.set({opacity: 255, scale_x: 1, scale_y: 1, translation_y: 0});
            } catch {
                // The actor was destroyed since (arrange mode, an adopted control removed).
            }
        }
        this._animatedBubbles = [];
    }

    /* ---------------------------------------------------------------- layout */

    _buildContent() {
        this._content = new St.BoxLayout({
            style_class: 'macos-control-center',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });

        this._content.add_child(this._buildToggleGrid());
        this._content.add_child(this._buildCustomGrid());

        const brightness = this._buildSliderCard({
            title: this._gettext('Display'),
            // Adwaita only ships one brightness glyph; the "small sun / large
            // sun" pairing of the reference is done with icon-size in CSS.
            startIcon: 'display-brightness-symbolic',
            endIcon: 'display-brightness-symbolic',
            accessibleName: this._gettext('Display Brightness'),
        });
        this._brightnessRow = brightness.row;
        this._brightnessRow.slider.connect('notify::value',
            () => this._onBrightnessChanged());
        this._content.add_child(brightness.card);

        const sound = this._buildSliderCard({
            title: this._gettext('Sound'),
            startIcon: 'ext:speaker-low',
            endIcon: 'ext:speaker-high',
            accessibleName: this._gettext('Sound Volume'),
        });
        this._volumeRow = sound.row;
        this._volumeRow.slider.connect('notify::value',
            () => this._onVolumeChanged());
        this._content.add_child(sound.card);

        this._content.add_child(this._buildBottomBar());

        return this._content;
    }

    _buildToggleGrid() {
        this._toggleGrid = new St.Widget({
            style_class: 'cc-grid cc-toggle-grid',
            layout_manager: new Clutter.GridLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                // Homogeneous cells keep the round buttons perfectly circular,
                // split the panel into two equal halves and let the media card
                // spanning two rows stay square with the tiles beside it.
                column_homogeneous: true,
                row_homogeneous: true,
                column_spacing: CUSTOM_SPACING,
                row_spacing: CUSTOM_SPACING,
            }),
            x_expand: true,
        });
        this._toggleLayout = this._toggleGrid.layout_manager;

        // --- the modules ----------------------------------------------------
        this._wifiPill = new CCPillButton({
            iconName: 'ext:wifi-3',
            title: this._gettext('Wi-Fi'),
            styleClass: 'cc-wifi-pill',
            toggleMode: true,
            hasChip: true,
        });
        this._wifiPill.connect('clicked', () => this._onWifiClicked());

        this._mediaCard = this._buildMediaCard();

        this._bluetoothPill = new CCPillButton({
            iconName: 'ext:bluetooth',
            title: this._gettext('Bluetooth'),
            subtitle: this._gettext('Off'),
            styleClass: 'cc-bluetooth-pill',
            toggleMode: true,
        });
        this._bluetoothPill.connect('clicked', () => this._onBluetoothClicked());

        this._airdropPill = new CCPillButton({
            iconName: 'ext:airdrop',
            title: this._gettext('AirDrop'),
            subtitle: this._gettext('Send and receive files'),
            styleClass: 'cc-airdrop-pill',
            toggleMode: false,
        });
        setIcon(this._airdropPill.icon, 'ext:airdrop');
        this._airdropPill.connect('clicked', () => this._onAirDropClicked());

        this._displayButton = new CCIconButton({
            iconName: 'ext:mirror',
            styleClass: 'cc-display-button',
            fill: true,
            accessibleName: this._gettext('Screen Mirroring'),
        });
        this._displayButton.connect('clicked', () => this._openScreenMirroringDialog());

        this._screenshotButton = new CCIconButton({
            iconName: 'ext:screenshot',
            styleClass: 'cc-screenshot-button',
            fill: true,
            accessibleName: this._gettext('Screenshot'),
        });
        this._screenshotButton.connect('clicked', () => this._openScreenshotUI());

        this._darkModeButton = new CCIconButton({
            iconName: 'ext:dark-mode',
            styleClass: 'cc-darkmode-button',
            fill: true,
            toggleMode: true,
            accessibleName: this._gettext('Dark Mode'),
        });

        this._recordButton = new CCIconButton({
            iconName: 'camera-video-symbolic',
            styleClass: 'cc-record-button',
            fill: true,
            toggleMode: true,
            accessibleName: this._gettext('Screen Recording'),
        });
        this._recordButton.connect('clicked', () => this._onRecordClicked());

        this._focusPill = new CCPillButton({
            iconName: 'ext:moon',
            title: this._gettext('Focus'),
            styleClass: 'cc-focus-pill',
            toggleMode: true,
        });

        /**
         * The panel's own controls, in slot order, with the cell span each one
         * needs. `_relayoutBuiltInGrid()` packs them, which is what produces
         * the arrangement of the reference — Wi-Fi beside the media card that
         * spans two rows, Bluetooth, AirDrop, the four round shortcuts, Focus —
         * and what makes the rest close the gap once one is removed.
         */
        this._builtInModules = [
            {id: 'wifi', widget: this._wifiPill, w: 2, h: 1,
             title: this._gettext('Wi-Fi'), icon: 'ext:wifi-3'},
            {id: 'media', widget: this._mediaCard, w: 2, h: 2,
             title: this._gettext('Now Playing'), icon: 'audio-x-generic-symbolic'},
            {id: 'bluetooth', widget: this._bluetoothPill, w: 2, h: 1,
             title: this._gettext('Bluetooth'), icon: 'ext:bluetooth'},
            {id: 'airdrop', widget: this._airdropPill, w: 2, h: 1,
             title: this._gettext('AirDrop'), icon: 'ext:airdrop'},
            {id: 'display', widget: this._displayButton, w: 1, h: 1,
             title: this._gettext('Screen Mirroring'), icon: 'ext:mirror'},
            {id: 'screenshot', widget: this._screenshotButton, w: 1, h: 1,
             title: this._gettext('Screenshot'), icon: 'ext:screenshot'},
            {id: 'darkmode', widget: this._darkModeButton, w: 1, h: 1,
             title: this._gettext('Dark Mode'), icon: 'ext:dark-mode'},
            {id: 'record', widget: this._recordButton, w: 1, h: 1,
             title: this._gettext('Screen Recording'), icon: 'camera-video-symbolic'},
            {id: 'focus', widget: this._focusPill, w: 2, h: 1,
             title: this._gettext('Focus'), icon: 'ext:moon'},
        ];

        // The built-in modules cannot be moved, only removed, so they are dimmed
        // and made inert while arranging.
        this._builtInButtons = [
            this._wifiPill, this._bluetoothPill, this._airdropPill, this._focusPill,
            this._displayButton, this._screenshotButton,
            this._darkModeButton, this._recordButton,
        ];

        this._relayoutBuiltInGrid();

        return this._toggleGrid;
    }

    /**
     * Packs the built-in modules the user kept into the first free cell of the
     * toggle grid, in the order of `_builtInModules`.
     *
     * Slots are searched with the same first-free-cell walk the custom grid
     * uses, so removing a module closes the gap instead of leaving a hole and
     * re-adding it puts it back where the reference has it. Homogeneous rows and
     * columns keep every tile the same size, empty lanes included.
     */
    _relayoutBuiltInGrid() {
        const occupied = [];

        for (const module of this._builtInModules) {
            const hidden = this._hiddenBuiltIns.has(module.id);

            module.widget.visible = !hidden;
            // Arranging dims the modules themselves rather than the grid, so
            // the edit frames drawn over them stay crisp.
            module.widget.opacity = this._editMode && !hidden ? 110 : 255;

            if (hidden)
                continue;

            const rect = this._firstFreeSlot(occupied, module.w, module.h);
            occupied.push(rect);
            module.rect = rect;

            this._placeChild(module.widget, rect, this._toggleGrid, this._toggleLayout);

            const overlay = this._overlays.get(this._builtInOverlayKey(module));
            if (overlay)
                this._placeChild(overlay, rect, this._toggleGrid, this._toggleLayout);
        }

        // Nothing left to show: the grid would only add its spacing.
        this._toggleGrid.visible = occupied.length > 0;
    }

    /** @param {object} module @returns {string} overlay key, namespaced */
    _builtInOverlayKey(module) {
        return `builtin:${module.id}`;
    }

    /**
     * Keeps or drops one of the panel's own modules — the gallery section for
     * built-in controls and the "−" badge of a module both end up here.
     *
     * @param {string} id
     * @param {boolean} visible
     */
    _setBuiltInVisible(id, visible) {
        if (visible)
            this._hiddenBuiltIns.delete(id);
        else
            this._hiddenBuiltIns.add(id);

        this._saveHiddenBuiltIns();
        this._relayoutBuiltInGrid();
        this._syncBuiltInOverlays();
    }

    /**
     * One edit frame per visible built-in module, in arrange mode only. Built-in
     * modules cannot be moved or resized, so their frame is only the "−" badge.
     */
    _syncBuiltInOverlays() {
        for (const module of this._builtInModules) {
            const key = this._builtInOverlayKey(module);

            if (!this._editMode || this._hiddenBuiltIns.has(module.id)) {
                this._removeEditOverlay(key);
                continue;
            }

            if (this._overlays.has(key))
                continue;

            const overlay = new CCEditOverlay({rearrangeable: false});
            overlay.connect('remove-request', () => this._setBuiltInVisible(module.id, false));

            this._overlays.set(key, overlay);
            this._placeChild(overlay, module.rect, this._toggleGrid, this._toggleLayout);
        }
    }

    /** Grid that hosts toggles adopted from the Shell / other extensions. */
    _buildCustomGrid() {
        this._customGrid = new St.Widget({
            style_class: 'cc-grid cc-custom-grid',
            layout_manager: new Clutter.GridLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                column_homogeneous: true,
                row_homogeneous: true,
                column_spacing: CUSTOM_SPACING,
                row_spacing: CUSTOM_SPACING,
            }),
            x_expand: true,
            visible: false,
        });
        this._customLayout = this._customGrid.layout_manager;

        return this._customGrid;
    }

    _buildMediaCard() {
        const card = new St.BoxLayout({
            style_class: 'cc-card cc-media-card',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        attachBlur(card, {sigma: 22, radius: 28});

        this._mediaArtIcon = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            style_class: 'cc-media-art-icon',
        });
        this._mediaArt = new St.Bin({
            style_class: 'cc-media-art',
            child: this._mediaArtIcon,
            x_align: Clutter.ActorAlign.START,
        });
        card.add_child(this._mediaArt);

        const meta = new St.BoxLayout({
            style_class: 'cc-media-meta',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_expand: true,
        });

        this._mediaTitle = new St.Label({
            text: this._gettext('Not Playing'),
            style_class: 'cc-media-title',
            x_align: Clutter.ActorAlign.START,
        });
        this._mediaTitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        meta.add_child(this._mediaTitle);

        this._mediaArtist = new St.Label({
            text: this._gettext('No media player'),
            style_class: 'cc-media-artist',
            x_align: Clutter.ActorAlign.START,
        });
        this._mediaArtist.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        meta.add_child(this._mediaArtist);
        card.add_child(meta);

        this._mediaControls = new St.BoxLayout({
            style_class: 'cc-media-controls',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_align: Clutter.ActorAlign.CENTER,
        });

        const previous = new CCIconButton({
            iconName: 'ext:media-previous',
            styleClass: 'cc-media-button',
            accessibleName: this._gettext('Previous'),
        });
        previous.connect('clicked', () => this._mpris?.previous());
        this._mediaControls.add_child(previous);

        this._playPauseButton = new CCIconButton({
            iconName: 'ext:media-play',
            styleClass: 'cc-media-button cc-media-button-primary',
            accessibleName: this._gettext('Play / Pause'),
        });
        this._playPauseButton.connect('clicked', () => this._mpris?.playPause());
        this._mediaControls.add_child(this._playPauseButton);

        const next = new CCIconButton({
            iconName: 'ext:media-next',
            styleClass: 'cc-media-button',
            accessibleName: this._gettext('Next'),
        });
        next.connect('clicked', () => this._mpris?.next());
        this._mediaControls.add_child(next);

        card.add_child(this._mediaControls);

        return card;
    }

    /**
     * @param {object} params
     * @param {string} params.title
     * @param {string} params.startIcon
     * @param {string} params.endIcon
     * @param {string} params.accessibleName
     * @returns {{card: St.BoxLayout, row: CCSliderRow}}
     */
    _buildSliderCard({title, startIcon, endIcon, accessibleName}) {
        const card = new St.BoxLayout({
            style_class: 'cc-card cc-slider-card',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        attachBlur(card, {sigma: 22, radius: 24});

        card.add_child(new St.Label({
            text: title,
            style_class: 'cc-slider-title',
            x_align: Clutter.ActorAlign.START,
        }));

        const row = new CCSliderRow({startIcon, endIcon, accessibleName});
        card.add_child(row);

        return {card, row};
    }

    /** Centered row holding Edit Controls / + Add Control / Done. */
    _buildBottomBar() {
        const bar = new St.BoxLayout({
            style_class: 'cc-bottom-bar',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_align: Clutter.ActorAlign.CENTER,
        });

        this._editButton = addTileTint(new St.Button({
            style_class: 'cc-bottom-button cc-edit-controls-button',
            can_focus: true,
            reactive: true,
            track_hover: true,
            accessible_name: this._gettext('Edit Controls'),
        }));
        const editBox = new St.BoxLayout({
            style_class: 'cc-edit-controls-content',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        editBox.add_child(new St.Label({
            text: this._gettext('Edit Controls'),
            style_class: 'cc-edit-controls-label',
        }));
        this._editButton.set_child(editBox);
        this._editButton.connect('clicked', () => this._setEditMode(true));
        bar.add_child(this._editButton);

        this._addButton = addTileTint(new St.Button({
            style_class: 'cc-bottom-button',
            can_focus: true,
            reactive: true,
            track_hover: true,
            visible: false,
            accessible_name: this._gettext('Add Control'),
        }));
        const addBox = new St.BoxLayout({
            style_class: 'cc-edit-controls-content',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        addBox.add_child(new St.Icon({
            icon_name: 'list-add-symbolic',
            style_class: 'cc-edit-controls-icon',
        }));
        addBox.add_child(new St.Label({
            text: this._gettext('Add Control'),
            style_class: 'cc-edit-controls-label',
        }));
        this._addButton.set_child(addBox);
        this._addButton.connect('clicked', () => this._showGallery());
        bar.add_child(this._addButton);

        this._doneButton = addTileTint(new St.Button({
            style_class: 'cc-bottom-button cc-bottom-done',
            can_focus: true,
            reactive: true,
            track_hover: true,
            visible: false,
            accessible_name: this._gettext('Done'),
        }));
        // The label sits in a box of its own: the tile's padding moves there so
        // that it cannot inset the tint layer (see the stylesheet).
        const doneBox = new St.BoxLayout({
            style_class: 'cc-edit-controls-content',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        doneBox.add_child(new St.Label({
            text: this._gettext('Done'),
            style_class: 'cc-edit-controls-label',
        }));
        this._doneButton.set_child(doneBox);
        this._doneButton.connect('clicked', () => this._setEditMode(false));
        bar.add_child(this._doneButton);

        for (const button of [this._editButton, this._addButton, this._doneButton]) {
            attachBlur(button, BUBBLE_BLUR);
            addPressFeedback(button);
        }

        return bar;
    }

    _buildGallery() {
        this._gallery = new St.BoxLayout({
            style_class: 'cc-gallery',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            visible: false,
        });

        const header = new St.BoxLayout({
            style_class: 'cc-gallery-header',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
        });

        this._galleryBack = new CCIconButton({
            iconName: 'go-previous-symbolic',
            styleClass: 'cc-gallery-back',
            accessibleName: this._gettext('Back'),
        });
        this._galleryBack.connect('clicked', () => this._hideGallery());
        header.add_child(this._galleryBack);

        header.add_child(new St.Label({
            text: this._gettext('Add Control'),
            style_class: 'cc-gallery-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._gallery.add_child(header);

        this._gallery.add_child(new St.Label({
            text: this._gettext('Controls built into the panel, plus switches from GNOME Shell and other extensions. An adopted switch leaves the standard Quick Settings until you remove it.'),
            style_class: 'cc-gallery-hint',
            x_align: Clutter.ActorAlign.START,
        }));

        this._galleryList = new St.BoxLayout({
            style_class: 'cc-gallery-list',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });

        this._gallery.add_child(new St.ScrollView({
            style_class: 'cc-gallery-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            child: this._galleryList,
            x_expand: true,
        }));

        this._galleryEmpty = new St.Label({
            text: this._gettext('No additional controls were found.'),
            style_class: 'cc-gallery-empty',
            x_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._gallery.add_child(this._galleryEmpty);

        const done = addTileTint(new St.Button({
            style_class: 'cc-gallery-done',
            can_focus: true,
            reactive: true,
            track_hover: true,
            x_align: Clutter.ActorAlign.CENTER,
            accessible_name: this._gettext('Done'),
        }));
        const doneBox = new St.BoxLayout({
            style_class: 'cc-edit-controls-content',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        doneBox.add_child(new St.Label({
            text: this._gettext('Done'),
            style_class: 'cc-edit-controls-label',
        }));
        done.set_child(doneBox);
        done.connect('clicked', () => this._hideGallery());
        this._gallery.add_child(done);

        return this._gallery;
    }

    /* -------------------------------------------------------- arrange mode */

    /**
     * Recomputes `reactive`/`can_focus`/the dimmed style of every built-in
     * module from its backend availability and the current mode. Single point
     * of truth, so a late backend cannot fight arrange mode (or the reverse).
     */
    _applyBuiltInState() {
        for (const button of this._builtInButtons) {
            const available = this._builtInEnabled.get(button) ?? true;
            const interactive = available && !this._editMode;

            button.reactive = interactive;
            button.can_focus = interactive;

            if (available)
                button.remove_style_class_name('cc-disabled');
            else
                button.add_style_class_name('cc-disabled');
        }
    }

    /**
     * Marks a built-in module as usable or not.
     * @param {St.Widget} button
     * @param {boolean} available
     */
    _setBuiltInAvailable(button, available) {
        this._builtInEnabled.set(button, available);
        this._applyBuiltInState();
    }

    /** @param {boolean} enabled */
    _setEditMode(enabled) {
        if (this._editMode === enabled)
            return;

        this._editMode = enabled;

        this._editButton.visible = !enabled;
        this._addButton.visible = enabled;
        this._doneButton.visible = enabled;

        this._content.add_style_class_name('cc-editing');
        if (!enabled)
            this._content.remove_style_class_name('cc-editing');

        // Built-in modules cannot be moved: dim them and take them out of the
        // tab and click order while arranging, so only the custom ones react.
        this._applyBuiltInState();
        this._relayoutBuiltInGrid();

        if (enabled) {
            this._createEditOverlays();
            this._syncBuiltInOverlays();
        } else {
            this._destroyEditOverlays();
        }

        if (!enabled)
            this._hideGallery();
    }

    /** @param {string} identifier */
    _ensureEditOverlay(identifier) {
        if (this._overlays.has(identifier) || !this._adopted.has(identifier))
            return;

        const overlay = new CCEditOverlay();
        overlay.connect('move-request', () => this._beginDrag(identifier, 'move'));
        overlay.connect('resize-request', () => this._beginDrag(identifier, 'resize'));
        overlay.connect('remove-request', () => this._removeCustomControl(identifier));

        this._overlays.set(identifier, overlay);
        this._placeChild(overlay, this._layout.get(identifier) ??
            {x: 0, y: 0, w: DEFAULT_SPAN_W, h: DEFAULT_SPAN_H}, this._customGrid,
            this._customLayout);
    }

    /**
     * The "−" badge of an adopted control: it goes back to the Shell's Quick
     * Settings and out of the saved list, exactly like unticking it in the
     * gallery.
     *
     * @param {string} identifier
     */
    _removeCustomControl(identifier) {
        this._desired.delete(identifier);
        this._detachAdopted(identifier);
        this._saveAdopted();
        this._saveLayout();

        if (this._gallery.visible)
            this._refreshGallery();
    }

    _createEditOverlays() {
        for (const identifier of this._adopted.keys())
            this._ensureEditOverlay(identifier);

        this._relayoutCustomGrid();
    }

    _destroyEditOverlays() {
        this._endDrag();

        for (const overlay of this._overlays.values()) {
            overlay.get_parent()?.remove_child(overlay);
            overlay.destroy();
        }
        this._overlays.clear();
    }

    _showGallery() {
        this._refreshGallery();
        this._content.hide();
        this._gallery.show();
    }

    _hideGallery() {
        this._gallery.hide();
        this._content.show();
    }

    /**
     * Every QuickToggle / QuickMenuToggle the Shell currently exposes, minus
     * the ones this panel already provides as built-in tiles.
     * @returns {Array<QuickToggle|QuickMenuToggle>}
     */
    _collectAvailableToggles() {
        const grid = Main.panel.statusArea?.quickSettings?.menu?._grid ?? null;
        if (!grid)
            return [];

        const builtIn = new Set([
            this._gettext('Wi-Fi').toLowerCase(),
            this._gettext('Bluetooth').toLowerCase(),
            this._gettext('AirDrop').toLowerCase(),
            this._gettext('Focus').toLowerCase(),
        ]);

        return grid.get_children().filter(child => {
            if (!(child instanceof QuickToggle) && !(child instanceof QuickMenuToggle))
                return false;

            return !builtIn.has((child.title ?? '').toLowerCase());
        });
    }

    /**
     * The handle used for persistence. Quick settings toggles only expose
     * `title`, and their `icon-name` is regularly empty because they use a
     * `gicon` instead, so the icon is used as the next best fallback — without
     * it every gicon-only toggle would collapse onto the same identifier.
     *
     * @returns {string}
     */
    _identifierFor(item) {
        return item.title || item.icon_name ||
            item.gicon?.to_string() || item.constructor.name;
    }

    _refreshGallery() {
        this._galleryList.destroy_all_children();
        this._galleryRows = [];

        // --- the panel's own modules ----------------------------------------
        this._galleryList.add_child(new St.Label({
            text: this._gettext('Built-in controls'),
            style_class: 'cc-gallery-section',
            x_align: Clutter.ActorAlign.START,
        }));

        for (const module of this._builtInModules) {
            const row = new CCGalleryRow({
                iconName: module.icon,
                title: module.title,
            });
            row.checked = !this._hiddenBuiltIns.has(module.id);
            row.connect('clicked', () => this._setBuiltInVisible(module.id, row.checked));

            this._galleryList.add_child(row);
        }

        // --- controls adopted from the Shell --------------------------------
        this._galleryList.add_child(new St.Label({
            text: this._gettext('Quick Settings'),
            style_class: 'cc-gallery-section',
            x_align: Clutter.ActorAlign.START,
        }));

        // identifier -> {item, available}. Adopted items have left the Shell's
        // grid, so they are merged back in from our own bookkeeping.
        const candidates = new Map();

        for (const item of this._collectAvailableToggles())
            candidates.set(this._identifierFor(item), {item, available: true});

        for (const [identifier, record] of this._adopted)
            candidates.set(identifier, {item: record.item, available: true});

        // Entries that are stored but whose owner is not loaded right now
        // (e.g. the extension is disabled) stay visible and removable.
        for (const identifier of this._desired) {
            if (!candidates.has(identifier))
                candidates.set(identifier, {item: null, available: false});
        }

        for (const [identifier, {item, available}] of candidates) {
            const row = new CCGalleryRow({
                iconName: item?.icon_name ?? (available ? null : 'dialog-question-symbolic'),
                gicon: item?.gicon ?? null,
                title: identifier,
                subtitle: item?.subtitle ??
                    (available ? null : this._gettext('Not available right now')),
                available,
            });
            row.checked = this._desired.has(identifier);
            row.connect('clicked', () => this._onGalleryRowToggled(item, identifier, row.checked));

            this._galleryList.add_child(row);
            this._galleryRows.push({identifier, row, item});
        }

        // Only the adopted half can be empty; the built-in list never is.
        this._galleryEmpty.visible = this._galleryRows.length === 0;
    }

    _onGalleryRowToggled(item, identifier, shouldAdopt) {
        if (shouldAdopt) {
            this._desired.add(identifier);
            if (item)
                this._adopt(item, identifier);
        } else {
            this._desired.delete(identifier);
            this._detachAdopted(identifier);
        }

        this._saveAdopted();
        this._relayoutCustomGrid();
        this._saveLayout();
    }

    /* ------------------------------------------------------------ adoption */

    /**
     * Moves a live Shell toggle into our custom grid.
     *
     * Clutter refuses to reparent an actor that still has a parent, so the
     * actor is detached first; Clutter.GridLayout.attach() then re-adds it.
     * The original parent, index and column span are kept so the item can be
     * handed back to the Shell untouched.
     *
     * @param {QuickToggle|QuickMenuToggle} item
     * @param {string} identifier
     */
    _adopt(item, identifier) {
        if (this._adopted.has(identifier))
            return;

        const parent = item.get_parent();
        let index = -1;
        let span = 1;

        if (parent) {
            index = parent.get_children().indexOf(item);
            try {
                span = parent.layout_manager?.child_get_property(parent, item, 'column-span') ?? 1;
            } catch {
                span = 1;
            }
        }

        // A QuickMenuToggle's popup lives in the Shell's own overlay, which is
        // invisible while our menu is open, so hide its submenu affordance.
        let menuEnabled = null;
        if (item instanceof QuickMenuToggle) {
            menuEnabled = item.menuEnabled;
            item.menuEnabled = false;
        }

        // Use the same tint layer as the built-in tiles. The control keeps the
        // panel's shared material; a separate blur and rim would create a
        // second, brighter halo around adopted Quick Settings.
        const tint = createTileTint();
        tint.set_layout_manager(new Clutter.BinLayout());
        const syncTint = () => {
            if (item.checked)
                tint.add_style_class_name('cc-tile-on');
            else
                tint.remove_style_class_name('cc-tile-on');
        };
        syncTint();
        item.connectObject('notify::checked', syncTint, tint);

        this._adopted.set(identifier, {
            item, parent, index, span, menuEnabled, tint,
        });

        if (!this._layout.has(identifier))
            this._layout.set(identifier, this._nextFreeRect());

        item.connectObject('destroy', () => this._onAdoptedItemDestroyed(identifier), this);

        try {
            this._relayoutCustomGrid();
            // A control added from the gallery while the panel is already in
            // arrange mode has to be rearrangeable straight away.
            if (this._editMode)
                this._ensureEditOverlay(identifier);
        } catch (e) {
            // Private Shell API — never let a failed adoption wedge the panel.
            console.warn(`${LOG_PREFIX} cannot adopt "${identifier}": ${e.message}`);
            this._detachAdopted(identifier);
        }
    }

    /** @param {string} identifier */
    _detachAdopted(identifier) {
        const record = this._adopted.get(identifier);
        if (!record)
            return;

        this._adopted.delete(identifier);
        this._removeEditOverlay(identifier);

        const {item, parent, index, span, menuEnabled, tint} = record;
        item.disconnectObject(this);

        const currentParent = item.get_parent();
        if (currentParent)
            currentParent.remove_child(item);

        // The tint layer is ours, so unlike the control it is thrown away.
        tint?.get_parent()?.remove_child(tint);
        tint?.destroy();

        if (menuEnabled !== null)
            item.menuEnabled = menuEnabled;

        if (parent) {
            try {
                const at = Math.max(0, Math.min(index, parent.get_n_children()));
                parent.insert_child_at_index(item, at);

                if (span > 1) {
                    parent.layout_manager?.child_set_property(parent, item, 'column-span', span);
                }
            } catch (e) {
                // The original container may be gone (menu rebuild, extension
                // reload); the toggle simply stays detached.
                console.warn(`${LOG_PREFIX} cannot restore "${identifier}": ${e.message}`);
            }
        }

        this._layout.delete(identifier);
        this._relayoutCustomGrid();
    }

    _removeEditOverlay(identifier) {
        const overlay = this._overlays.get(identifier);
        if (!overlay)
            return;

        this._overlays.delete(identifier);
        overlay.get_parent()?.remove_child(overlay);
        overlay.destroy();
    }

    _onAdoptedItemDestroyed(identifier) {
        const record = this._adopted.get(identifier);
        if (!record)
            return;

        record.tint?.get_parent()?.remove_child(record.tint);
        record.tint?.destroy();

        this._adopted.delete(identifier);
        this._removeEditOverlay(identifier);
        this._relayoutCustomGrid();
    }

    /** Re-materialise persisted adoptions (extensions may load after us). */
    _reconcileAdoptedToggles() {
        if (this._desired.size === 0)
            return;

        const available = this._collectAvailableToggles();

        for (const identifier of this._desired) {
            if (this._adopted.has(identifier))
                continue;

            const item = available.find(candidate => this._identifierFor(candidate) === identifier);
            if (item)
                this._adopt(item, identifier);   // re-lays out the custom grid
        }

        if (this._layoutNeedsSizeMigration) {
            this._saveLayout();
            this._layoutNeedsSizeMigration = false;
        }
    }

    /* -------------------------------------------------------- custom layout */

    /**
     * The rectangles of the controls that are actually on screen right now.
     * Saved entries whose owner has not loaded (a disabled extension, say) still
     * reserve their cell for the next session but must not push live controls
     * around in this one.
     *
     * @returns {Array<{x: number, y: number, w: number, h: number}>}
     */
    _liveRects() {
        const rects = [];
        for (const identifier of this._adopted.keys()) {
            const rect = this._layout.get(identifier);
            if (rect)
                rects.push(rect);
        }
        return rects;
    }

    _nextFreeRect() {
        return this._firstFreeSlot(this._liveRects(), DEFAULT_SPAN_W, DEFAULT_SPAN_H);
    }

    /**
     * @param {Array<{x: number, y: number, w: number, h: number}>} occupied
     * @returns {{x: number, y: number, w: number, h: number}} first free slot
     */
    _firstFreeSlot(occupied, w, h) {
        for (let y = 0; y < 256; y++) {
            for (let x = 0; x + w <= CUSTOM_COLUMNS; x++) {
                const rect = {x, y, w, h};
                if (!occupied.some(other => rectsOverlap(rect, other)))
                    return rect;
            }
        }

        return {x: 0, y: 0, w, h};
    }

    /**
     * Pushes items that overlap another one into the first free slot. The item
     * the user just placed wins its cell, so dragging A onto B moves B.
     *
     * @param {string} [priority] identifier to keep in place
     */
    _resolveCollisions(priority = null) {
        const order = [...this._adopted.keys()].filter(id => this._layout.has(id));
        if (priority && order.includes(priority)) {
            order.splice(order.indexOf(priority), 1);
            order.unshift(priority);
        }

        const occupied = [];

        for (const identifier of order) {
            const rect = this._layout.get(identifier);
            if (!occupied.some(other => rectsOverlap(rect, other))) {
                occupied.push(rect);
                continue;
            }

            const free = this._firstFreeSlot(occupied, rect.w, rect.h);
            rect.x = free.x;
            rect.y = free.y;
            occupied.push(rect);
        }
    }

    /** Number of rows the custom grid currently needs. */
    _rowCount() {
        let rows = 1;
        for (const rect of this._liveRects())
            rows = Math.max(rows, rect.y + rect.h);
        return rows;
    }

    /** Re-places every adopted control (and its edit overlay) in its cell. */
    _relayoutCustomGrid() {
        this._resolveCollisions();

        for (const [identifier, record] of this._adopted) {
            const rect = this._layout.get(identifier);
            if (!rect)
                continue;

            this._placeCustomRecord(record, rect);

            const overlay = this._overlays.get(identifier);
            if (overlay)
                this._placeChild(overlay, rect, this._customGrid, this._customLayout);
        }

        this._customGrid.visible = this._adopted.size > 0;
    }

    /**
     * Places an adopted control together with the tint layer that keeps its tile
     * filled on the glass sheet. The layer is stacked below the control, so the
     * control's own glyphs and labels stay on top of it.
     *
     * @param {{item: Clutter.Actor, tint: St.Widget}} record
     * @param {{x: number, y: number, w: number, h: number}} rect
     */
    _placeCustomRecord(record, rect) {
        this._placeChild(record.item, rect, this._customGrid, this._customLayout);

        const {tint} = record;
        if (!tint)
            return;

        // The control is a sibling of the layer by now, so a plain attach would
        // paint the layer over it.
        if (tint.get_parent() !== this._customGrid)
            this._customGrid.insert_child_below(tint, record.item);

        this._placeChild(tint, rect, this._customGrid, this._customLayout);
    }

    /**
     * Puts an actor in a grid cell, preserving child order (and therefore the
     * overlays' place on top) when it is already parented.
     *
     * @param {Clutter.Actor} actor
     * @param {{x: number, y: number, w: number, h: number}} rect
     * @param {Clutter.Actor} grid
     * @param {Clutter.GridLayout} layout
     */
    _placeChild(actor, rect, grid, layout) {
        if (actor.get_parent() === grid) {
            layout.child_set_property(grid, actor, 'left-attach', rect.x);
            layout.child_set_property(grid, actor, 'top-attach', rect.y);
            layout.child_set_property(grid, actor, 'width', rect.w);
            layout.child_set_property(grid, actor, 'height', rect.h);
            return;
        }

        // clutter_actor_add_child() warns when the actor still has a parent, and
        // GridLayout.attach() ends in exactly that call.
        actor.get_parent()?.remove_child(actor);
        layout.attach(actor, rect.x, rect.y, rect.w, rect.h);
    }

    /* --------------------------------------------------------------- drag */

    /**
     * @param {string} identifier
     * @param {'move'|'resize'} mode
     */
    _beginDrag(identifier, mode) {
        const rect = this._layout.get(identifier);
        if (!rect || !this._adopted.has(identifier) || this._drag)
            return;

        const event = Clutter.get_current_event();
        const point = event ? this._gridPoint(event) : null;
        if (!point)
            return;

        const cell = this._cellAt(point.x, point.y);

        this._drag = {
            identifier,
            mode,
            rect,
            origin: {...rect},
            // Remember which cell was grabbed so the item keeps its offset
            // under the pointer instead of snapping its corner to it.
            grabCol: cell.col,
            grabRow: cell.row,
        };

        this._customGrid.add_style_class_name('cc-dragging');
        this._stageMotionId = global.stage.connect('motion-event', (_actor, motionEvent) => {
            this._onDragMotion(motionEvent);
            return Clutter.EVENT_PROPAGATE;
        });
        this._stageReleaseId = global.stage.connect('button-release-event', () => {
            this._endDrag();
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _onDragMotion(event) {
        const drag = this._drag;
        if (!drag)
            return;

        const point = this._gridPoint(event);
        if (!point)
            return;

        const cell = this._cellAt(point.x, point.y);

        if (drag.mode === 'move') {
            drag.rect.x = Math.clamp(drag.origin.x + cell.col - drag.grabCol, 0,
                CUSTOM_COLUMNS - drag.rect.w);
            drag.rect.y = Math.max(0, drag.origin.y + cell.row - drag.grabRow);
        } else {
            drag.rect.w = Math.clamp(cell.col - drag.rect.x + 1, 1,
                CUSTOM_COLUMNS - drag.rect.x);
            drag.rect.h = Math.max(1, cell.row - drag.rect.y + 1);
        }

        const record = this._adopted.get(drag.identifier);
        if (record)
            this._placeCustomRecord(record, drag.rect);

        const overlay = this._overlays.get(drag.identifier);
        if (overlay)
            this._placeChild(overlay, drag.rect, this._customGrid, this._customLayout);
    }

    _endDrag() {
        if (this._stageMotionId) {
            global.stage.disconnect(this._stageMotionId);
            this._stageMotionId = 0;
        }
        if (this._stageReleaseId) {
            global.stage.disconnect(this._stageReleaseId);
            this._stageReleaseId = 0;
        }

        const drag = this._drag;
        this._drag = null;
        this._customGrid.remove_style_class_name('cc-dragging');

        if (!drag)
            return;

        this._resolveCollisions(drag.identifier);
        this._relayoutCustomGrid();
        this._saveLayout();
    }

    /**
     * Stage point -> custom grid coordinates.
     * @returns {{x: number, y: number}|null}
     */
    _gridPoint(event) {
        const [x, y] = event.get_coords();
        const [ok, localX, localY] = this._customGrid.transform_stage_point(x, y);
        return ok ? {x: localX, y: localY} : null;
    }

    /** @returns {{col: number, row: number}} cell under a grid-local point */
    _cellAt(x, y) {
        const width = this._customGrid.get_width();
        const height = this._customGrid.get_height();
        const rows = this._rowCount();

        const cellW = Math.max(1, (width - (CUSTOM_COLUMNS - 1) * CUSTOM_SPACING) / CUSTOM_COLUMNS);
        const cellH = Math.max(1, (height - (rows - 1) * CUSTOM_SPACING) / rows);

        return {
            col: Math.clamp(Math.floor(x / (cellW + CUSTOM_SPACING)), 0, CUSTOM_COLUMNS - 1),
            row: Math.max(0, Math.floor(y / (cellH + CUSTOM_SPACING))),
        };
    }

    /* ---------------------------------------------------------- persistence */

    _initSettings() {
        try {
            this._settings = this._extension.getSettings();
            this._desired = new Set(this._settings.get_strv(ADOPTED_TOGGLES_KEY));
            this._layout = this._loadLayout();
        } catch (e) {
            // No schema installed (e.g. running straight from a checkout):
            // the picker still works, it just does not survive a restart.
            console.warn(`${LOG_PREFIX} settings unavailable, adoptions will not persist: ${e.message}`);
            this._settings = null;
            return;
        }

        try {
            this._hiddenBuiltIns = new Set(this._settings.get_strv(HIDDEN_BUILTINS_KEY));
            // Keep the user's previous decision to remove this slot when its
            // old Night Light module becomes the Dark Mode module.
            if (this._hiddenBuiltIns.delete('nightlight')) {
                this._hiddenBuiltIns.add('darkmode');
                this._settings.set_strv(HIDDEN_BUILTINS_KEY,
                    [...this._hiddenBuiltIns]);
            }
        } catch (e) {
            // The schema was compiled before the key existed: keep every module
            // rather than lose the rest of the stored layout as well.
            console.warn(`${LOG_PREFIX} cannot read ${HIDDEN_BUILTINS_KEY}: ${e.message}`);
        }
    }

    /** @returns {Map<string, {x: number, y: number, w: number, h: number}>} */
    _loadLayout() {
        const layout = new Map();
        if (!this._settings)
            return layout;

        for (const raw of this._settings.get_strv(CUSTOM_LAYOUT_KEY)) {
            try {
                const entry = JSON.parse(raw);
                if (typeof entry?.t !== 'string')
                    continue;

                // Bring existing tiles to the Wi-Fi pill's 2×1 baseline once.
                // Later user-resized dimensions carry the current version and
                // continue to persist normally.
                const hasCurrentSize = entry.v === CUSTOM_LAYOUT_SIZE_VERSION;
                if (!hasCurrentSize)
                    this._layoutNeedsSizeMigration = true;

                layout.set(entry.t, {
                    x: Math.max(0, entry.x | 0),
                    y: Math.max(0, entry.y | 0),
                    w: hasCurrentSize
                        ? Math.clamp(entry.w | 0 || DEFAULT_SPAN_W, 1, CUSTOM_COLUMNS)
                        : DEFAULT_SPAN_W,
                    h: hasCurrentSize
                        ? Math.max(1, entry.h | 0 || DEFAULT_SPAN_H)
                        : DEFAULT_SPAN_H,
                });
            } catch {
                // Ignore malformed entries rather than dropping the whole list.
            }
        }

        return layout;
    }

    _saveAdopted() {
        if (!this._settings)
            return;

        this._settings.set_strv(ADOPTED_TOGGLES_KEY, [...this._desired]);
    }

    _saveHiddenBuiltIns() {
        if (!this._settings)
            return;

        // Written from the module table, so ids of modules that no longer exist
        // are dropped instead of accumulating.
        this._settings.set_strv(HIDDEN_BUILTINS_KEY, this._builtInModules
            .filter(module => this._hiddenBuiltIns.has(module.id))
            .map(module => module.id));
    }

    _saveLayout() {
        if (!this._settings)
            return;

        const entries = [];
        for (const [identifier, rect] of this._layout) {
            // Prune entries whose control was removed.
            if (!this._desired.has(identifier))
                continue;

            entries.push(JSON.stringify({
                t: identifier, x: rect.x, y: rect.y, w: rect.w, h: rect.h,
                v: CUSTOM_LAYOUT_SIZE_VERSION,
            }));
        }

        this._settings.set_strv(CUSTOM_LAYOUT_KEY, entries);
    }

    /* -------------------------------------------------------- liquid glass */

    /**
     * The Liquid Glass extension marks the menus it covers with
     * `.liquid-glass-menu-root`; mirror that onto `.cc-glass-host` so the
     * stylesheet can drop the last of our own fills and leave exactly one
     * material behind. No hard dependency: if the extension is not installed
     * the class never appears and the standalone look is used.
     */
    _setupGlassDetection() {
        this._syncGlassHost();
        this.menu.box.connectObject('notify::style-class',
            () => this._syncGlassHost(), this);
    }

    _syncGlassHost() {
        const hosted = this.menu.box.has_style_class_name('liquid-glass-menu-root');
        const marked = this.menu.box.has_style_class_name('cc-glass-host');

        if (hosted && !marked)
            this.menu.box.add_style_class_name('cc-glass-host');
        else if (!hosted && marked)
            this.menu.box.remove_style_class_name('cc-glass-host');
    }

    /* -------------------------------------------------------------- wifi */

    async _initWifi() {
        if (this._wifiProxy)
            return;

        // NetworkManager lives on the SYSTEM bus.
        this._wifiProxy = createProxy({
            bus: Gio.DBus.system,
            busName: NM_NAME,
            objectPath: NM_PATH,
            interfaceName: NM_IFACE,
            onPropertiesChanged: changed => {
                if (changed.lookup_value('WirelessEnabled', null))
                    this._syncWifiPill();
                if (changed.lookup_value('PrimaryConnection', null))
                    this._syncWifiConnection();
            },
        });
        this._proxies.push(this._wifiProxy);

        if (!await initProxy(this._wifiProxy)) {
            this._wifiProxy = null;
            this._wifiReady = false;
            this._setBuiltInAvailable(this._wifiPill, false);
            return;
        }

        this._wifiReady = true;
        this._setBuiltInAvailable(this._wifiPill, true);

        this._syncWifiPill();
        await this._syncWifiConnection();
    }

    _syncWifiPill() {
        const enabled =
            this._wifiProxy?.get_cached_property('WirelessEnabled')?.unpack() ?? false;
        const connected = enabled && Boolean(this._wifiConnectionName);

        this._wifiPill.checked = enabled;
        setIcon(this._wifiPill.icon, enabled ? 'ext:wifi-blue' : 'ext:wifi-3');

        // An enabled Wi-Fi control gets the blue active-state glyph.
        if (connected)
            this._wifiPill.add_style_class_name('cc-connected');
        else
            this._wifiPill.remove_style_class_name('cc-connected');

        this._wifiPill.setChipText(connected ? this._wifiConnectionName : null);
    }

    async _syncWifiConnection() {
        this._disposeWifiConnectionProxy();
        this._wifiConnectionName = '';

        const path = this._wifiProxy?.get_cached_property('PrimaryConnection')?.unpack();
        if (!path || path === '/') {
            this._syncWifiPill();
            return;
        }

        const proxy = createProxy({
            bus: Gio.DBus.system,
            busName: NM_NAME,
            objectPath: path,
            interfaceName: NM_CONNECTION_IFACE,
            onPropertiesChanged: changed => {
                if (changed.lookup_value('Id', null) && this._wifiConnectionProxy === proxy)
                    this._setWifiConnectionName(proxy);
            },
        });

        this._proxies.push(proxy);
        this._wifiConnectionProxy = proxy;

        if (!await initProxy(proxy) || this._wifiConnectionProxy !== proxy)
            return;

        this._setWifiConnectionName(proxy);
    }

    _disposeWifiConnectionProxy() {
        const proxy = this._wifiConnectionProxy;
        this._wifiConnectionProxy = null;

        if (!proxy)
            return;

        const index = this._proxies.indexOf(proxy);
        if (index !== -1)
            this._proxies.splice(index, 1);

        disposeProxy(proxy);
    }

    _setWifiConnectionName(proxy) {
        const type = proxy.get_cached_property('Type')?.unpack() ?? '';
        const isWireless = type === '802-11-wireless';

        // Only show a network name when the primary connection really is Wi-Fi
        // (on a wired machine the primary connection is the Ethernet one).
        this._wifiConnectionName =
            isWireless ? proxy.get_cached_property('Id')?.unpack() ?? '' : '';

        this._syncWifiPill();
    }

    _onWifiClicked() {
        setDBusProperty(this._wifiProxy, NM_IFACE, 'WirelessEnabled',
            new GLib.Variant('b', this._wifiPill.checked));
    }

    /* --------------------------------------------------------- bluetooth */

    /** @returns {Promise<string|null>} object path of the first BlueZ adapter */
    async _findAdapterPath() {
        try {
            const reply = await Gio.DBus.system.call(
                BLUEZ_NAME, BLUEZ_PATH, OBJECT_MANAGER_IFACE, 'GetManagedObjects',
                null, new GLib.VariantType('(a{oa{sa{sv}}})'),
                Gio.DBusCallFlags.NONE, -1, null);
            const [objects] = reply.deepUnpack();

            return Object.keys(objects)
                .find(path => BLUEZ_ADAPTER_IFACE in objects[path]) ?? null;
        } catch (e) {
            console.warn(`${LOG_PREFIX} BlueZ unavailable: ${e.message}`);
            return null;
        }
    }

    async _initBluetooth() {
        // bluetoothd comes and goes; re-arm when it (re)appears.
        if (!this._bluezOwnerId) {
            this._bluezOwnerId = Gio.DBus.system.signal_subscribe(
                DBUS_NAME, DBUS_IFACE, 'NameOwnerChanged', DBUS_PATH, BLUEZ_NAME,
                Gio.DBusSignalFlags.NONE,
                (_connection, _sender, _path, _iface, _signal, params) => {
                    const [, , newOwner] = params.deepUnpack();
                    if (newOwner) {
                        this._adapterProxy = null;
                        this._bluetoothReady = false;
                        this._initBluetooth();
                    }
                });
        }

        const adapterPath = await this._findAdapterPath();

        if (!adapterPath) {
            this._adapterProxy = null;
            this._bluetoothReady = false;
            this._disableBluetoothButtons();
            return;
        }

        // Called on every menu open, so bail out when the adapter we are
        // already watching is still the right one: a dongle plugged in (or
        // swapped) since the last open has a different path and is picked up.
        if (this._adapterProxy?.get_object_path() === adapterPath) {
            this._bluetoothReady = true;
            this._syncBluetoothButtons();
            return;
        }

        // BlueZ lives on the SYSTEM bus too.
        this._adapterProxy = createProxy({
            bus: Gio.DBus.system,
            busName: BLUEZ_NAME,
            objectPath: adapterPath,
            interfaceName: BLUEZ_ADAPTER_IFACE,
            onPropertiesChanged: changed => {
                if (changed.lookup_value('Powered', null))
                    this._syncBluetoothButtons();
            },
        });
        this._proxies.push(this._adapterProxy);

        if (!await initProxy(this._adapterProxy)) {
            this._adapterProxy = null;
            this._bluetoothReady = false;
            this._disableBluetoothButtons();
            return;
        }

        this._bluetoothReady = true;
        this._syncBluetoothButtons();
    }

    _disableBluetoothButtons() {
        this._builtInEnabled.set(this._bluetoothPill, false);
        // File transfer uses LocalSend / Blip over Wi-Fi, so it stays available
        // even when the computer has no Bluetooth adapter.
        this._builtInEnabled.set(this._airdropPill, true);
        this._applyBuiltInState();
    }

    _syncBluetoothButtons() {
        const powered = this._adapterProxy?.get_cached_property('Powered')?.unpack() ?? false;

        this._bluetoothPill.checked = powered;
        setIcon(this._bluetoothPill.icon,
            powered ? 'ext:bluetooth-blue' : 'ext:bluetooth');
        this._bluetoothPill.subtitleLabel.text =
            powered ? this._gettext('On') : this._gettext('Off');

        this._builtInEnabled.set(this._bluetoothPill, true);
        this._builtInEnabled.set(this._airdropPill, true);
        this._applyBuiltInState();
    }

    async _onBluetoothClicked() {
        const powered = this._bluetoothPill.checked;

        // BlueZ refuses to power the adapter off while it is discoverable, so
        // the two writes have to be serialised.
        if (!powered) {
            await setDBusProperty(this._adapterProxy, BLUEZ_ADAPTER_IFACE, 'Discoverable',
                new GLib.Variant('b', false));
        }

        await setDBusProperty(this._adapterProxy, BLUEZ_ADAPTER_IFACE, 'Powered',
            new GLib.Variant('b', powered));
    }

    _onAirDropClicked() {
        this.menu.close();

        if (this._activeFileTransferApp) {
            this._closeFileTransferApp();
            return;
        }

        const apps = findFileTransferApps();

        if (apps.length === 1) {
            this._launchFileTransferApp(apps[0]);
            return;
        }

        if (apps.length > 1) {
            this._showFileTransferChoices(apps);
            return;
        }

        this._showFileTransferMessage(
            this._gettext('AirDrop'),
            this._gettext('Install LocalSend or Blip to send and receive files.'));
    }

    _showFileTransferChoices(apps) {
        this._airdropDialog?.close();
        const dialog = new ModalDialog.ModalDialog({styleClass: 'cc-mirroring-dialog'});
        this._airdropDialog = dialog;
        dialog.contentLayout.add_style_class_name('cc-mirroring-dialog-content');
        this._clearMirroringDialog(dialog,
            this._gettext('Send and receive files'),
            this._gettext('Choose which app to use for file sharing.'));

        dialog.setButtons([
            {
                label: this._gettext('Cancel'),
                action: () => this._closeFileTransferDialog(dialog),
                key: Clutter.KEY_Escape,
            },
            ...apps.map(app => ({
                label: app.name,
                action: () => {
                    this._closeFileTransferDialog(dialog);
                    this._launchFileTransferApp(app);
                },
                default: app.kind === 'localsend',
            })),
        ]);
        dialog.open();
    }

    _showFileTransferMessage(title, message, error = false) {
        this._airdropDialog?.close();
        const dialog = new ModalDialog.ModalDialog({styleClass: 'cc-mirroring-dialog'});
        this._airdropDialog = dialog;
        dialog.contentLayout.add_style_class_name('cc-mirroring-dialog-content');
        this._clearMirroringDialog(dialog, title, message);
        dialog.setButtons([{
            label: this._gettext('Close'),
            action: () => this._closeFileTransferDialog(dialog),
            key: Clutter.KEY_Escape,
            default: true,
        }]);
        if (error)
            console.warn(`${LOG_PREFIX} ${message}`);
        dialog.open();
    }

    _closeFileTransferDialog(dialog) {
        if (this._airdropDialog === dialog)
            this._airdropDialog = null;
        dialog.close();
    }

    _launchFileTransferApp(app) {
        try {
            const launched = app.appInfo.launch([], global.create_app_launch_context(0, -1));
            if (!launched)
                throw new Error(this._gettext('GNOME could not start the app.'));

            this._activeFileTransferApp = app;
            this._airdropPill.checked = true;
            setIcon(this._airdropPill.icon, 'ext:airdrop-blue');
        } catch (error) {
            const appName = app.name || (app.kind === 'blip' ? 'Blip' : 'LocalSend');
            this._showFileTransferMessage(
                this._gettext('Could not open file sharing'),
                this._gettext('%s could not be started: %s').format(appName, error.message),
                true);
        }
    }

    _matchesFileTransferApp(shellApp, target) {
        const normaliseId = id => (id ?? '').replace(/\.desktop$/i, '').toLowerCase();
        const targetIds = new Set([
            target.appInfo?.get_id?.(),
            target.flatpakId,
        ].map(normaliseId).filter(Boolean));
        const shellAppId = normaliseId(shellApp.get_id?.());
        if (shellAppId && targetIds.has(shellAppId))
            return true;

        const appInfo = shellApp.get_app_info?.();
        const name = (appInfo?.get_name?.() ?? shellApp.get_name?.() ?? '').toLowerCase();
        if (name && name === target.name.toLowerCase())
            return true;

        const executable = (appInfo?.get_executable?.() ?? '').toLowerCase();
        return target.kind === 'localsend'
            ? /localsend/.test(executable)
            : /(?:^|\/)blip(?:\s|$)/.test(executable);
    }

    _setAirDropInactive() {
        this._activeFileTransferApp = null;
        this._airdropClosing = false;
        this._airdropPill.checked = false;
        setIcon(this._airdropPill.icon, 'ext:airdrop');
    }

    _closeFileTransferApp() {
        const target = this._activeFileTransferApp;
        if (!target || this._airdropClosing)
            return;

        this._airdropClosing = true;
        const runningApp = this._appSystem.get_running()
            .find(app => this._matchesFileTransferApp(app, target));
        if (runningApp)
            runningApp.request_quit();

        const systemctl = GLib.find_program_in_path('systemctl');
        if (!systemctl) {
            this._finishFileTransferClose(target, false,
                this._gettext('The session process manager is unavailable.'));
            return;
        }

        // GNOME starts desktop apps inside app-scoped systemd units. Stopping
        // that exact unit after asking the app to quit also terminates helpers
        // and tray/background processes that do not close with the last window.
        try {
            const listing = Gio.Subprocess.new([
                systemctl, '--user', 'list-units', '--type=scope', '--all',
                '--no-legend', '--plain',
            ], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            listing.communicate_utf8_async(null, null, (process, result) => {
                let stdout;
                try {
                    const [success, output, errorOutput] =
                        process.communicate_utf8_finish(result);
                    if (!success)
                        throw new Error(errorOutput || this._gettext('Could not list running app processes.'));
                    stdout = output ?? '';
                } catch (error) {
                    this._finishFileTransferClose(target, false, error.message);
                    return;
                }

                const targetIds = [target.appInfo?.get_id?.(), target.flatpakId]
                    .filter(Boolean)
                    .map(id => id.replace(/\.desktop$/i, '').toLowerCase());
                const kindToken = target.kind === 'localsend' ? 'localsend' : 'blip';
                const scopeUnits = stdout.split('\n')
                    .map(line => line.trim().split(/\s+/)[0])
                    .filter(unit => (unit?.startsWith('app-gnome-') ||
                        unit?.startsWith('app-flatpak-')) && unit.endsWith('.scope'))
                    .map(unit => {
                        const prefix = unit.startsWith('app-flatpak-')
                            ? 'app-flatpak-' : 'app-gnome-';
                        return {unit, scopeAppId: unit.slice(prefix.length)
                            .replace(/-\d+\.scope$/i, '').toLowerCase()};
                    });
                const exactUnits = scopeUnits.filter(({scopeAppId}) =>
                    targetIds.some(id => scopeAppId === id || scopeAppId.startsWith(`${id}-`)));
                const units = (exactUnits.length > 0 ? exactUnits :
                    scopeUnits.filter(({scopeAppId}) => scopeAppId.includes(kindToken)))
                    .map(({unit}) => unit);

                if (units.length === 0) {
                    // For Flatpaks without a GNOME-exported app scope, Flatpak
                    // knows the application's complete process group by ID.
                    if (target.flatpakId) {
                        this._stopFlatpakTransferApp(target);
                        return;
                    }

                    // A normal app may already have exited as a result of the
                    // graceful request_quit above.
                    const stillRunning = this._appSystem.get_running()
                        .some(app => this._matchesFileTransferApp(app, target));
                    this._finishFileTransferClose(target, !stillRunning,
                        stillRunning ? this._gettext('GNOME could not locate this app’s process group.') : '');
                    return;
                }

                let stopper;
                try {
                    stopper = Gio.Subprocess.new(
                        [systemctl, '--user', 'stop', ...units],
                        Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE);
                    stopper.wait_check_async(null, (stopProcess, stopResult) => {
                        try {
                            stopProcess.wait_check_finish(stopResult);
                            this._finishFileTransferClose(target, true);
                        } catch (error) {
                            this._finishFileTransferClose(target, false, error.message);
                        }
                    });
                } catch (error) {
                    this._finishFileTransferClose(target, false, error.message);
                }
            });
        } catch (error) {
            this._finishFileTransferClose(target, false, error.message);
        }
    }

    _stopFlatpakTransferApp(target) {
        const flatpak = GLib.find_program_in_path('flatpak');
        if (!flatpak) {
            this._finishFileTransferClose(target, false,
                this._gettext('Flatpak is not available to stop the app.'));
            return;
        }

        try {
            const process = Gio.Subprocess.new(
                [flatpak, 'kill', target.flatpakId],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE);
            process.wait_check_async(null, (subprocess, result) => {
                try {
                    subprocess.wait_check_finish(result);
                    this._finishFileTransferClose(target, true);
                } catch (error) {
                    this._finishFileTransferClose(target, false, error.message);
                }
            });
        } catch (error) {
            this._finishFileTransferClose(target, false, error.message);
        }
    }

    _finishFileTransferClose(target, closed, reason = '') {
        if (this._activeFileTransferApp !== target)
            return;

        if (closed) {
            this._setAirDropInactive();
            return;
        }

        this._airdropClosing = false;
        this._showFileTransferMessage(
            this._gettext('Could not fully close file sharing'),
            this._gettext('%s is still running in the background. %s')
                .format(target.name, reason), true);
    }

    /* ------------------------------------------------------- focus / DND */

    _initFocusMode() {
        this._notificationsSettings = new Gio.Settings({schema_id: NOTIFICATIONS_SCHEMA});
        this._notificationsSettings.bind('show-banners', this._focusPill, 'checked',
            Gio.SettingsBindFlags.DEFAULT | Gio.SettingsBindFlags.INVERT_BOOLEAN);
        this._focusPill.connectObject('notify::checked',
            () => this._syncFocusPill(), this);
        this._syncFocusPill();
    }

    _syncFocusPill() {
        setIcon(this._focusPill.icon,
            this._focusPill.checked ? 'ext:moon-blue' : 'ext:moon');
    }

    /* ------------------------------------------------------------ appearance */

    _initDarkMode() {
        this._appearance = new AppearanceController(this._extension,
            dark => this._syncDarkModeButton(dark));
        this._darkModeButton.connect('clicked', () =>
            this._appearance?.setDark(this._darkModeButton.checked));
    }

    _syncDarkModeButton(dark) {
        if (!this._darkModeButton)
            return;

        this._darkModeButton.checked = dark;
        setIcon(this._darkModeButton.icon,
            dark ? 'ext:dark-mode-black' : 'ext:dark-mode');
    }

    /* --------------------------------------------------------------- volume */

    _suppressSystemFeedback() {
        if (this._nativeFeedbackHideId)
            GLib.source_remove(this._nativeFeedbackHideId);

        // Keep GNOME's built-in media-key notification hidden as well, so
        // removing the extension surface does not reveal a replacement OSD.
        this._nativeFeedbackHideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            this._nativeFeedbackHideId = 0;
            Main.osdWindowManager?.hideAll?.();
            return GLib.SOURCE_REMOVE;
        });
    }

    _initVolume() {
        this._mixerControl = new Gvc.MixerControl({name: 'macOS Control Center'});
        this._mixerControl.connectObject(
            'state-changed', () => this._syncVolume(),
            'default-sink-changed', () => this._syncVolume(),
            this);
        this._mixerControl.open();

        this._syncVolume();
    }

    _syncVolume() {
        const stream = this._mixerControl?.get_default_sink() ?? null;

        if (this._volumeStream !== stream) {
            this._volumeStream?.disconnectObject(this);
            this._volumeStream = stream;
            stream?.connectObject(
                'notify::volume', () => this._onSystemVolumeChanged(),
                'notify::is-muted', () => this._onSystemVolumeChanged(),
                this);
        }

        this._updateVolumeSlider();
    }

    _updateVolumeSlider() {
        const stream = this._volumeStream;
        if (!stream || !this._mixerControl)
            return;

        const maxVolume = this._mixerControl.get_vol_max_norm();
        const value = stream.is_muted ? 0 : Math.clamp(stream.volume / maxVolume, 0, 1);

        this._volumeSliderSyncing = true;
        this._volumeRow.slider.value = value;
        this._volumeSliderSyncing = false;
    }

    _onSystemVolumeChanged() {
        this._updateVolumeSlider();
        if (GLib.get_monotonic_time() < this._volumeCcChangeUntil)
            return;

        this._suppressSystemFeedback();
    }

    _onVolumeChanged() {
        if (this._volumeSliderSyncing || !this._volumeStream || !this._mixerControl)
            return;

        const {value} = this._volumeRow.slider;
        const maxVolume = this._mixerControl.get_vol_max_norm();
        this._volumeCcChangeUntil = GLib.get_monotonic_time() + 500_000;

        if (value === 0) {
            this._volumeStream.change_is_muted(true);
        } else {
            if (this._volumeStream.is_muted)
                this._volumeStream.change_is_muted(false);
            this._volumeStream.set_volume(Math.round(value * maxVolume));
        }

        this._volumeStream.push_volume();
    }

    /* ----------------------------------------------------------- brightness */

    _initBrightness() {
        // GNOME 49+ manages brightness in the Shell itself.
        this._brightnessManager = Main.brightnessManager ?? null;

        if (this._brightnessManager) {
            this._brightnessManager.connectObject('changed',
                () => this._syncBrightness(), this);
            this._syncBrightness();
            return;
        }

        // Fallback for older shells: the power plugin owns the screen backlight.
        this._brightnessProxy = createProxy({
            busName: POWER_NAME,
            objectPath: POWER_PATH,
            interfaceName: POWER_SCREEN_IFACE,
            onPropertiesChanged: changed => {
                if (changed.lookup_value('Brightness', null)) {
                    this._updateBrightnessSlider();
                    this._onSystemBrightnessChanged();
                }
            },
        });
        this._proxies.push(this._brightnessProxy);

        initProxy(this._brightnessProxy).then(available => {
            if (!available) {
                this._brightnessProxy = null;
                this._brightnessRow.hide();
                return;
            }

            this._updateBrightnessSlider();
        });
    }

    _syncBrightness() {
        const scale = this._brightnessManager?.globalScale ?? null;

        if (this._brightnessScale !== scale) {
            this._brightnessScale?.disconnectObject(this);
            this._brightnessScale = scale;
            scale?.connectObject('notify::value',
                () => {
                    this._updateBrightnessSlider();
                    this._onSystemBrightnessChanged();
                }, this);
        }

        this._brightnessRow.visible = scale !== null;
        this._updateBrightnessSlider();
    }

    _updateBrightnessSlider() {
        let value = null;

        if (this._brightnessScale)
            value = this._brightnessScale.value;
        else if (this._brightnessProxy)
            value = (this._brightnessProxy.get_cached_property('Brightness')?.unpack() ?? 0) / 100;

        if (value === null) {
            this._brightnessRow.hide();
            return;
        }

        this._brightnessSliderSyncing = true;
        this._brightnessRow.slider.value = Math.clamp(value, 0, 1);
        this._brightnessSliderSyncing = false;
    }

    _onSystemBrightnessChanged() {
        if (GLib.get_monotonic_time() < this._brightnessCcChangeUntil)
            return;

        this._suppressSystemFeedback();
    }

    _onBrightnessChanged() {
        if (this._brightnessSliderSyncing)
            return;

        const {value} = this._brightnessRow.slider;
        this._brightnessCcChangeUntil = GLib.get_monotonic_time() + 500_000;

        if (this._brightnessScale)
            this._brightnessScale.value = value;
        else if (this._brightnessProxy)
            setDBusProperty(this._brightnessProxy, POWER_SCREEN_IFACE, 'Brightness',
                new GLib.Variant('i', Math.round(value * 100)));
    }

    /* ---------------------------------------------------------------- media */

    _syncMediaCard() {
        if (!this._mpris)
            return;

        const {title, artist, artUrl, playing} = this._mpris;

        this._mediaTitle.text = title || this._gettext('Not Playing');
        this._mediaArtist.text = artist || this._gettext('No media player');

        this._loadMediaArtwork(artUrl, ++this._mediaArtGeneration);

        setIcon(this._playPauseButton.icon,
            playing ? 'ext:media-pause' : 'ext:media-play');

        // Dim the transport row while there is nothing to control.
        if (title || artist)
            this._mediaControls.remove_style_class_name('cc-inactive');
        else
            this._mediaControls.add_style_class_name('cc-inactive');
    }

    async _loadMediaArtwork(artUrl, generation) {
        this._resetMediaArtwork();
        if (!artUrl)
            return;

        try {
            if (artUrl.startsWith('file://')) {
                const file = Gio.File.new_for_uri(artUrl);
                if (file.query_exists(null))
                    this._showMediaArtwork(file.get_uri(), generation);
                return;
            }

            const dataUri = /^data:image\/(png|jpeg|webp|gif);base64,([a-z\d+/=]+)$/i.exec(artUrl);
            if (dataUri) {
                if (dataUri[2].length > 12 * 1024 * 1024)
                    return;
                const data = GLib.base64_decode(dataUri[2]);
                const ext = dataUri[1].toLowerCase() === 'jpeg'
                    ? 'jpg' : dataUri[1].toLowerCase();
                const uri = this._cacheMediaArtwork(data, ext, artUrl);
                this._showMediaArtwork(uri, generation);
                return;
            }

            if (!/^https?:\/\//i.test(artUrl) || !this._mediaArtSession)
                return;

            const message = Soup.Message.new('GET', artUrl);
            const bytes = await this._mediaArtSession.send_and_read_async(
                message, GLib.PRIORITY_DEFAULT, null);
            if (generation !== this._mediaArtGeneration || !this._mediaArtSession)
                return;

            const contentType = message.get_response_headers()
                .get_one('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
            const extension = {
                'image/jpeg': 'jpg',
                'image/png': 'png',
                'image/webp': 'webp',
                'image/gif': 'gif',
            }[contentType];
            if (message.get_status() < 200 || message.get_status() >= 300 ||
                !extension || bytes.get_size() > 12 * 1024 * 1024)
                return;

            const uri = this._cacheMediaArtwork(bytes.get_data(), extension, artUrl);
            this._showMediaArtwork(uri, generation);
        } catch (e) {
            if (generation === this._mediaArtGeneration)
                console.debug(`${LOG_PREFIX} could not load album artwork: ${e.message}`);
        }
    }

    _cacheMediaArtwork(data, extension, key) {
        GLib.mkdir_with_parents(this._mediaArtCacheDirectory, 0o700);
        const checksum = GLib.compute_checksum_for_string(
            GLib.ChecksumType.SHA256, key, -1).slice(0, 24);
        const path = GLib.build_filenamev([
            this._mediaArtCacheDirectory, `art-${checksum}.${extension}`,
        ]);
        Gio.File.new_for_path(path).replace_contents(
            data, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        return Gio.File.new_for_path(path).get_uri();
    }

    _showMediaArtwork(uri, generation) {
        if (generation !== this._mediaArtGeneration || !this._mediaArt)
            return;

        this._mediaArt.set_style(
            `background-image: url("${uri}"); background-size: cover; ` +
            'background-position: center; background-repeat: no-repeat;');
        this._mediaArtIcon.hide();
    }

    _resetMediaArtwork() {
        if (!this._mediaArt || !this._mediaArtIcon)
            return;

        this._mediaArt.set_style('');
        this._mediaArtIcon.icon_name = 'audio-x-generic-symbolic';
        this._mediaArtIcon.show();
    }

    /* ------------------------------------------------------------ utilities */

    /**
     * @param {string} panel a gnome-control-center panel id (e.g. "display")
     */
    _openSettingsPanel(panel) {
        this.menu.close();

        if (!Util.trySpawn(['gnome-control-center', panel]))
            console.warn(`${LOG_PREFIX} could not launch gnome-control-center ${panel}`);
    }

    _openScreenMirroringDialog() {
        this.menu.close();
        this._screenDialog?.close();

        const dialog = new ModalDialog.ModalDialog({styleClass: 'cc-mirroring-dialog'});
        this._screenDialog = dialog;
        dialog.contentLayout.add_style_class_name('cc-mirroring-dialog-content');
        this._showScreenMirroringChoices(dialog);
        dialog.open();
    }

    _clearMirroringDialog(dialog, title, description) {
        for (const child of dialog.contentLayout.get_children())
            dialog.contentLayout.remove_child(child);

        const titleLabel = new St.Label({
            text: title,
            style_class: 'cc-mirroring-dialog-title',
        });
        const descriptionLabel = new St.Label({
            text: description,
            style_class: 'cc-mirroring-dialog-description',
        });
        descriptionLabel.clutter_text.line_wrap = true;
        descriptionLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        dialog.contentLayout.add_child(titleLabel);
        dialog.contentLayout.add_child(descriptionLabel);
    }

    _showScreenMirroringChoices(dialog) {
        this._clearMirroringDialog(dialog,
            this._gettext('Screen Mirroring'),
            this._gettext('Choose how to mirror a device on this computer.'));
        dialog.setButtons([
            {
                label: this._gettext('Cancel'),
                action: () => this._closeScreenDialog(dialog),
                key: Clutter.KEY_Escape,
            },
            {
                label: 'UXPlay',
                action: () => this._launchMirroringTool(dialog, ['uxplay'], 'UXPlay',
                    () => this._showScreenMirroringChoices(dialog)),
            },
            {
                label: 'scrcpy',
                action: () => this._showScrcpyConnectionChoices(dialog),
                default: true,
            },
        ]);
    }

    _showScrcpyConnectionChoices(dialog) {
        this._clearMirroringDialog(dialog,
            'scrcpy',
            this._gettext('Choose USB for a cable connection, or Wi-Fi to enter the Android device IP.'));
        dialog.setButtons([
            {
                label: this._gettext('Cancel'),
                action: () => this._closeScreenDialog(dialog),
                key: Clutter.KEY_Escape,
            },
            {
                label: this._gettext('Back'),
                action: () => this._showScreenMirroringChoices(dialog),
            },
            {
                label: this._gettext('USB Cable'),
                action: () => this._launchMirroringTool(dialog,
                    ['scrcpy', '--select-usb'], 'scrcpy',
                    () => this._showScrcpyConnectionChoices(dialog)),
                default: true,
            },
            {
                label: 'Wi-Fi',
                action: () => this._showScrcpyWifiEntry(dialog),
            },
        ]);
    }

    _showScrcpyWifiEntry(dialog, errorText = '') {
        this._clearMirroringDialog(dialog,
            this._gettext('Connect over Wi-Fi'),
            this._gettext('Enter the Android device IP address, for example 192.168.1.25 or 192.168.1.25:5555. Wireless debugging or ADB over TCP must already be enabled.'));

        const entry = new St.Entry({
            style_class: 'cc-mirroring-ip-entry',
            can_focus: true,
            track_hover: true,
            hint_text: this._gettext('Device IP address'),
            x_expand: true,
        });
        dialog.contentLayout.add_child(entry);

        if (errorText) {
            const errorLabel = new St.Label({
                text: errorText,
                style_class: 'cc-mirroring-dialog-error',
            });
            errorLabel.clutter_text.line_wrap = true;
            dialog.contentLayout.add_child(errorLabel);
        }

        dialog.setButtons([
            {
                label: this._gettext('Cancel'),
                action: () => this._closeScreenDialog(dialog),
                key: Clutter.KEY_Escape,
            },
            {
                label: this._gettext('Back'),
                action: () => this._showScrcpyConnectionChoices(dialog),
            },
            {
                label: this._gettext('Connect'),
                action: () => {
                    const address = entry.get_text().trim();
                    if (!this._isValidScrcpyAddress(address)) {
                        this._showScrcpyWifiEntry(dialog,
                            this._gettext('Enter a valid IPv4 address and optional port (1–65535).'));
                        return;
                    }

                    this._launchMirroringTool(dialog,
                        ['scrcpy', `--tcpip=${address}`], 'scrcpy',
                        () => this._showScrcpyConnectionChoices(dialog));
                },
                default: true,
            },
        ]);

        entry.grab_key_focus();
    }

    _isValidScrcpyAddress(address) {
        const match = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/.exec(address);
        if (!match)
            return false;

        const octets = match[1].split('.').map(Number);
        if (octets.some(octet => octet < 0 || octet > 255))
            return false;

        return match[2] === undefined || (Number(match[2]) >= 1 && Number(match[2]) <= 65535);
    }

    _launchMirroringTool(dialog, argv, name, onFailure) {
        if (!GLib.find_program_in_path(argv[0])) {
            this._showMirroringToolError(dialog,
                this._gettext('%s is not installed or is not available in PATH.').replace('%s', name),
                onFailure);
            return;
        }

        let launched = false;
        try {
            launched = Util.trySpawn(argv);
        } catch (e) {
            console.warn(`${LOG_PREFIX} could not start ${name}: ${e.message}`);
        }

        if (launched) {
            this._closeScreenDialog(dialog);
            return;
        }

        this._showMirroringToolError(dialog,
            this._gettext('Could not start %s.').replace('%s', name), onFailure);
    }

    _showMirroringToolError(dialog, message, onBack) {
        this._clearMirroringDialog(dialog,
            this._gettext('Could not start screen mirroring'), message);
        dialog.setButtons([
            {
                label: this._gettext('Close'),
                action: () => this._closeScreenDialog(dialog),
                key: Clutter.KEY_Escape,
            },
            {
                label: this._gettext('Back'),
                action: onBack,
                default: true,
            },
        ]);
    }

    _closeScreenDialog(dialog) {
        if (this._screenDialog === dialog)
            this._screenDialog = null;
        dialog.close();
    }

    _openScreenshotUI() {
        this.menu.close();

        // open() returns a promise; if screenshotUI is not up yet the optional
        // chain short-circuits and nothing is called at all.
        Main.screenshotUI?.open()
            .catch(e => console.warn(`${LOG_PREFIX} screenshot UI unavailable: ${e.message}`));
    }

    /* --------------------------------------------------------- screencast */

    _syncRecordingButton() {
        this._recordButton.checked = this._recording;
        if (this._recording)
            this._recordButton.add_style_class_name('cc-recording');
        else
            this._recordButton.remove_style_class_name('cc-recording');
    }

    _onRecordClicked() {
        if (this._recordButton.checked)
            this._startRecording();
        else
            this._stopRecording();
    }

    async _startRecording() {
        const directory =
            GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_VIDEOS) ??
            GLib.get_home_dir();
        const stamp = GLib.DateTime.new_now_local().format('%Y-%m-%d %H-%M-%S');
        const template = GLib.build_filenamev([directory, `Screencast from ${stamp}.webm`]);

        try {
            const reply = await Gio.DBus.session.call(
                SCREENCAST_NAME, SCREENCAST_PATH, SCREENCAST_IFACE, 'Screencast',
                new GLib.Variant('(sa{sv})', [template, {
                    'framerate': GLib.Variant.new_int32(30),
                    'draw-cursor': GLib.Variant.new_boolean(true),
                }]),
                new GLib.VariantType('(bs)'),
                Gio.DBusCallFlags.NONE, -1, null);

            const [success, filename] = reply.deepUnpack();
            this._recording = Boolean(success);

            if (this._recording)
                console.log(`${LOG_PREFIX} recording to ${filename}`);
        } catch (e) {
            console.warn(`${LOG_PREFIX} screencast unavailable: ${e.message}`);
            this._recording = false;
        }

        this._syncRecordingButton();
    }

    async _stopRecording() {
        try {
            await Gio.DBus.session.call(
                SCREENCAST_NAME, SCREENCAST_PATH, SCREENCAST_IFACE, 'StopScreencast',
                null, new GLib.VariantType('(b)'),
                Gio.DBusCallFlags.NONE, -1, null);
        } catch (e) {
            console.warn(`${LOG_PREFIX} could not stop screencast: ${e.message}`);
        }

        this._recording = false;
        this._syncRecordingButton();
    }

    /* ------------------------------------------------------------ teardown */

    destroy() {
        this._menuGlass?.destroy();
        this._menuGlass = null;

        this._screenDialog?.close();
        this._screenDialog = null;
        this._airdropDialog?.close();
        this._airdropDialog = null;
        this._activeFileTransferApp = null;
        if (this._appStateChangedId) {
            this._appSystem.disconnect(this._appStateChangedId);
            this._appStateChangedId = 0;
        }

        this._endDrag();
        this._destroyEditOverlays();

        // Hand every adopted toggle back to the Shell before anything else.
        for (const identifier of [...this._adopted.keys()].reverse())
            this._detachAdopted(identifier);

        if (this._bluezOwnerId) {
            Gio.DBus.system.signal_unsubscribe(this._bluezOwnerId);
            this._bluezOwnerId = 0;
        }

        this._volumeStream?.disconnectObject(this);
        this._volumeStream = null;

        this._brightnessScale?.disconnectObject(this);
        this._brightnessScale = null;
        this._brightnessManager = null;

        this._mixerControl?.close();
        this._mixerControl = null;

        if (this._nativeFeedbackHideId) {
            GLib.source_remove(this._nativeFeedbackHideId);
            this._nativeFeedbackHideId = 0;
        }

        this._mpris?.destroy();
        this._mpris = null;

        this._mediaArtGeneration++;
        this._mediaArtSession?.abort();
        this._mediaArtSession = null;

        this._notificationsSettings = null;
        this._appearance?.destroy();
        this._appearance = null;
        this._settings = null;

        this._galleryRows = [];
        if (this._panelStyleSignal) {
            Main.panel.disconnect(this._panelStyleSignal);
            this._panelStyleSignal = 0;
        }
        this._panelIcon = null;
        for (const proxy of this._proxies)
            disposeProxy(proxy);
        this._proxies = [];
        this._wifiProxy = null;
        this._wifiConnectionProxy = null;
        this._brightnessProxy = null;
        this._adapterProxy = null;

        // PanelMenu.Button._onDestroy() destroys this.menu for us.
        super.destroy();
    }

    _syncPanelIconTone() {
        if (!this._panelIcon)
            return;

        const panelHasDarkText = Main.panel.has_style_class_name('kiwi-panel-dark-text');
        setIcon(this._panelIcon, panelHasDarkText
            ? 'ext:control-center-panel-black'
            : 'ext:control-center-panel-white');
    }
}

/* ------------------------------------------------------------------------ */
/* Top-bar glyphs and their menus                                           */
/* ------------------------------------------------------------------------ */

/** BlueZ icon names the icon theme has a symbolic twin for. */
const BLUETOOTH_DEVICE_ICONS = new Set([
    'audio-card-symbolic',
    'audio-headphones-symbolic',
    'audio-headset-symbolic',
    'camera-photo-symbolic',
    'camera-video-symbolic',
    'computer-symbolic',
    'input-gaming-symbolic',
    'input-keyboard-symbolic',
    'input-mouse-symbolic',
    'input-tablet-symbolic',
    'phone-symbolic',
    'printer-symbolic',
    'scanner-symbolic',
    'video-display-symbolic',
]);

const BLUETOOTH_DEVICE_ICON_FALLBACK = 'bluetooth-symbolic';

/**
 * BlueZ hands out freedesktop icon names ("audio-card", "input-mouse"); the bar
 * and the sheet are drawn with symbolic glyphs, so each one is mapped to its
 * symbolic twin and anything unknown falls back to the generic Bluetooth glyph.
 *
 * @param {string|null} icon a BlueZ `Icon` property
 * @returns {string} an Adwaita icon name
 */
export function bluetoothDeviceIcon(icon) {
    const name = `${icon ?? ''}-symbolic`;
    return BLUETOOTH_DEVICE_ICONS.has(name) ? name : BLUETOOTH_DEVICE_ICON_FALLBACK;
}

/**
 * NetworkManager reports an SSID as a byte array and a label wants a string.
 * The bytes are the SSID exactly as the access point sends it, so a name like
 * "Café" decodes correctly (NM.Utils would do the same, but that is libnm).
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function decodeSsid(bytes) {
    if (!bytes || bytes.length === 0)
        return '';

    let text;
    try {
        text = new TextDecoder('utf-8', {fatal: false}).decode(bytes);
    } catch (e) {
        text = String.fromCharCode(...bytes);
    }

    // A hidden network announces an SSID of NUL bytes (or blanks). That is no
    // name, and listing it gives rows with nothing written on them.
    text = text.replace(/[\u0000-\u001f\u007f]/g, '');
    return text.trim() === '' ? '' : text;
}

/**
 * @param {*} value an `ay` as GLib hands it over
 * @returns {Uint8Array}
 */
function toBytes(value) {
    if (!value)
        return new Uint8Array(0);

    return value instanceof Uint8Array ? value : Uint8Array.from(value);
}

/**
 * A property out of an `a{sv}` read back as a plain JavaScript value.
 *
 * `deepUnpack()` unwraps the containers but deliberately leaves the members of a
 * dictionary of variants as `GLib.Variant`s, so every property taken out of a
 * Get / GetAll / GetManagedObjects answer has to be unwrapped before it can be
 * compared or displayed.
 *
 * @param {*} value
 * @returns {*}
 */
function unpackProperty(value) {
    return value instanceof GLib.Variant ? value.unpack() : value;
}

/** @returns {string} a fresh UUID, for the connection NetworkManager stores */
function newUuid() {
    if (typeof GLib.uuid_string_random === 'function')
        return GLib.uuid_string_random();

    let uuid = '';
    for (let i = 0; i < 32; i++)
        uuid += Math.floor(Math.random() * 16).toString(16);

    return `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-4${uuid.slice(13, 16)}-8${uuid.slice(17, 20)}-${uuid.slice(20)}`;
}

/**
 * The signal glyph for a Wi-Fi strength: one, two or three bars. The boundaries
 * are the Shell's own (weak below 40, medium below 80), so the bars still agree
 * with the Quick Settings tile next to them. Even a very weak signal keeps its
 * one-bar glyph; the exclamation icon is reserved for missing connectivity.
 *
 * @param {number} strength 0-100
 * @returns {string} an icon name, see icons.js
 */
export function wifiSignalIcon(strength) {
    if (strength < 40)
        return 'ext:wifi-1';
    if (strength < 80)
        return 'ext:wifi-2';
    return 'ext:wifi-3';
}

/**
 * The battery glyph: empty, a quarter, half, three quarters or full, with a bolt
 * while the battery is charging (or held at a charge limit with the charger in).
 * A full battery that is no longer charging has no bolt. UPower's own `IconName`
 * is deliberately unused: it names the theme's icons, not these.
 *
 * @param {number} percentage 0-100
 * @param {number} state a UPower device state, see the UPOWER_STATE_* constants
 * @param {boolean} chargeThresholdEnabled UPower's `ChargeThresholdEnabled`
 * @returns {string} an icon name, see icons.js
 */
export function batteryGlyphIcon(percentage, state, chargeThresholdEnabled) {
    if (state === UPOWER_STATE_FULLY_CHARGED)
        return 'ext:battery-100';

    const charging = state === UPOWER_STATE_CHARGING ||
        (state === UPOWER_STATE_PENDING_CHARGE && chargeThresholdEnabled);

    // Each picture stands for the range around it.
    let level = 100;
    if (percentage < 10)
        level = 0;
    else if (percentage < 37)
        level = 25;
    else if (percentage < 62)
        level = 50;
    else if (percentage < 87)
        level = 75;

    return `ext:battery-${level}${charging ? '-charging' : ''}`;
}

/**
 * Battery glyph for the top bar. Use the same level artwork as the battery
 * menu so the panel can select a matching black or white version for Kiwi.
 *
 * @param {number} percentage 0-100
 * @param {number} state a UPower device state
 * @param {boolean} chargeThresholdEnabled UPower's `ChargeThresholdEnabled`
 * @returns {string}
 */
function batteryPanelIcon(percentage, state, chargeThresholdEnabled) {
    return batteryGlyphIcon(percentage, state, chargeThresholdEnabled);
}

/* ------------------------------------------------------------------------ */
/* The shared indicator                                                     */
/* ------------------------------------------------------------------------ */

/**
 * One glyph in the top bar, with a sheet of its own behind it.
 *
 * The Wi-Fi, Bluetooth and battery glyphs are real PanelMenu.Buttons. Their
 * menus share controls with the main centre; Wi-Fi and battery opt into a
 * regular blurred sheet, while Bluetooth keeps the extension's glass menu.
 *
 * A subclass talks to its own daemon, calls `_setGlyph()` with the outcome and
 * fills the sheet through `_buildMenu()` / `_refreshMenu()`.
 */
const CCStatusIndicator = GObject.registerClass(
class CCStatusIndicator extends PanelMenu.Button {
    /**
     * @param {object} params
     * @param {(text: string) => string} params.gettext
     * @param {string} params.accessibleName
     * @param {string} params.iconName
     * @param {string} params.path the extension's directory, where the glass shaders live
     * @param {boolean} [params.blurOnly] use a conventional blurred sheet, not Liquid Glass
     */
    _init({gettext, accessibleName, iconName, path, blurOnly = false}) {
        super._init(0.0, accessibleName);

        this._gettext = gettext;
        this._proxies = [];
        this._ownerId = 0;
        this._visibilityId = 0;
        this._reloadId = 0;
        // Set by _setGlyph(). The container starts hidden, so a daemon that
        // never answers cannot leave a bogus glyph sitting in the bar.
        this._available = false;
        this._panelEnabled = true;
        // Set in destroy(): a D-Bus answer that arrives later must not touch a
        // widget that is already gone.
        this._destroyed = false;
        this._menuBuilt = false;
        this._glyphName = iconName;
        this._blurOnlyMenu = blurOnly;
        this._appearanceSettings = null;
        this._shellThemeSettings = null;
        this._themeSignalIds = [];
        this._statusBackdropActive = false;
        this._statusHasBackdropSample = false;
        this._statusAdaptId = 0;
        this._statusBlurFallbackId = 0;
        this._statusSampling = false;

        this._icon = new St.Icon({
            ...namedIconProps(iconName),
            style_class: 'system-status-icon',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this.add_style_class_name('cc-status-indicator');
        this.add_child(this._icon);
        this._panelStyleSignal = Main.panel.connect('style-changed',
            () => this._syncPanelGlyphTone());
        this._syncPanelGlyphTone();

        // ---- the sheet -----------------------------------------------------
        // Shared menu structure; Wi-Fi and battery use a single blur sheet,
        // Bluetooth retains the control centre's individual glass bubbles.
        this.menu.box.add_style_class_name('cc-menu');
        // A dropdown, not a grid of bubbles: flat rows on one sheet.
        this.menu.box.add_style_class_name('cc-glyph-menu');
        this.menu.actor.add_style_class_name('cc-bubbles-pointer');

        if (blurOnly) {
            this.menu.box.add_style_class_name('cc-status-blur-sheet');
            // On supported Shells the menu glass supplies both the rounded
            // backdrop copy and a sample to detect when the glass renderer is
            // ready. Keep conventional blur as a fallback on older Shells.
            if (!glassAvailable)
                attachBlur(this.menu.box, {sigma: 18, radius: 24, force: true});
            this._watchStatusTheme();
        } else {
            // The Bluetooth sheet retains the extension's regular bubble glass.
            this.menu.box.add_style_class_name('cc-bubbles');
            if (blurBackend === 'rounded' || blurBackend === 'square')
                this.menu.box.add_style_class_name('cc-blur-active');
        }

        this._menuGlass = glassAvailable
            ? new MenuGlass({
                path,
                owner: 'status-menu',
                menu: this.menu,
                collect: () => blurOnly ? [this.menu.box] : collectBubbles(this.menu.box),
                onActive: active => blurOnly
                    ? this._syncStatusGlass(active)
                    : setGlassActive(this.menu.box, active),
                radiusOf: actor => blurOnly ? 22 : glassRadiusOf(actor),
                material: blurOnly ? STATUS_MENU_GLASS : MENU_GLASS,
            })
            : null;

        this._section = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._section);

        this._menuContent = new St.BoxLayout({
            style_class: 'macos-control-center',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._section.box.add_child(this._menuContent);

        if (!blurOnly)
            this._setupGlassDetection();

        this.menu.connectObject('open-state-changed', (_menu, isOpen) => {
            if (isOpen)
                this._onMenuOpened();
        }, this);

        // addToStatusArea() shows the container right after construction, and
        // that show happens inside Clutter's map pass: flipping visibility back
        // from the map signal itself trips clutter_actor_set_mapped's
        // re-entrancy assertion, so the correction is deferred by one idle.
        this._visibilityId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._visibilityId = 0;
            this._applyVisibility();
            return GLib.SOURCE_REMOVE;
        });

        this._applyVisibility();
    }

    /* --------------------------------------------------------------- menu */

    /** Builds the sheet the first time it is opened, then brings it up to date. */
    _onMenuOpened() {
        if (this._destroyed)
            return;

        if (!this._menuBuilt) {
            this._menuBuilt = true;
            this._buildMenu();
        }

        // If the GPU glass shader cannot become ready on this machine, keep a
        // conventional background blur behind the same translucent sheet.
        if (this._blurOnlyMenu && glassAvailable && !this._statusBlurFallbackId) {
            this._statusBlurFallbackId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 450, () => {
                this._statusBlurFallbackId = 0;
                if (this.menu?.isOpen && !this._statusHasBackdropSample)
                    attachBlur(this.menu.box, {sigma: 18, radius: 24, force: true});
                return GLib.SOURCE_REMOVE;
            });
        }

        // Reading a daemon is asynchronous, and a daemon that answers with
        // something unexpected must not become an unhandled rejection: the
        // sheet simply keeps the state it already has.
        const refresh = this._refreshMenu();

        if (refresh instanceof Promise) {
            refresh.catch(e => console.warn(
                `${LOG_PREFIX} ${this.constructor.name} sheet failed to refresh: ${e.message}`));
        }
    }

    /** Fills `_menuContent`. Called once, on the first open. */
    _buildMenu() {
    }

    /** Brings the sheet up to date. Called on every open. */
    _refreshMenu() {
    }

    /* ------------------------------------------------------------ widgets */

    /**
     * @param {string} text
     * @returns {St.Label} the small heading above a group of rows
     */
    _createSectionTitle(text) {
        return new St.Label({
            text,
            style_class: 'cc-status-section',
            x_align: Clutter.ActorAlign.START,
        });
    }

    /**
     * @param {string} text
     * @returns {St.Label} a quiet line shown in place of an empty list
     */
    _createHint(text) {
        const label = new St.Label({
            text,
            style_class: 'cc-status-hint',
            x_align: Clutter.ActorAlign.START,
        });
        label.clutter_text.line_wrap = true;
        return label;
    }

    /**
     * @returns {St.BoxLayout} a list column: the rows themselves
     */
    _createList() {
        return new St.BoxLayout({
            style_class: 'cc-status-list',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
    }

    /**
     * A scrolling column for the list part of a sheet, so a long list of
     * networks or devices cannot push the sheet off the screen.
     *
     * @returns {{scroll: St.ScrollView, column: St.BoxLayout}}
     */
    _createListColumn() {
        const column = new St.BoxLayout({
            style_class: 'cc-status-column',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });

        const scroll = new St.ScrollView({
            style_class: 'cc-status-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            child: column,
            x_expand: true,
        });

        return {scroll, column};
    }

    /**
     * @param {string} iconName
     * @param {boolean} available whether the glyph means anything right now: a
     *   machine with no battery, no Wi-Fi adapter or Bluetooth switched off
     *   hides its glyph entirely.
     */
    _setGlyph(iconName, available) {
        this._glyphName = iconName;
        this._syncPanelGlyphTone();

        this._available = available;
        this._applyVisibility();
    }

    setPanelEnabled(enabled) {
        this._panelEnabled = Boolean(enabled);
        this._applyVisibility();
    }

    _syncPanelGlyphTone() {
        if (!this._icon || !this._glyphName)
            return;

        const darkText = Main.panel.has_style_class_name('kiwi-panel-dark-text');
        setPanelIcon(this._icon, this._glyphName, darkText);
    }

    /** Follow GNOME's active light/dark appearance for this indicator's popup. */
    _watchStatusTheme() {
        const source = Gio.SettingsSchemaSource.get_default();
        const interfaceSchema = source?.lookup(INTERFACE_SCHEMA, true);
        const shellThemeSchema = source?.lookup(USER_THEME_SCHEMA, true);

        this._appearanceSettings = interfaceSchema
            ? new Gio.Settings({settings_schema: interfaceSchema})
            : null;
        this._shellThemeSettings = shellThemeSchema
            ? new Gio.Settings({settings_schema: shellThemeSchema})
            : null;

        for (const [settings, schema, keys] of [
            [this._appearanceSettings, interfaceSchema, ['color-scheme', 'gtk-theme']],
            [this._shellThemeSettings, shellThemeSchema, ['name']],
        ]) {
            if (!settings || !schema)
                continue;

            for (const key of keys) {
                if (!schema.has_key(key))
                    continue;
                const id = settings.connect(`changed::${key}`,
                    () => this._syncStatusTheme());
                this._themeSignalIds.push({settings, id});
            }
        }

        this._syncStatusTheme();
    }

    _syncStatusTheme() {
        if (!this.menu?.box)
            return;

        const theme = statusMenuTheme(this._appearanceSettings, this._shellThemeSettings);
        this._applyStatusTheme(theme);
    }

    _applyStatusTheme(theme) {
        const nextClass = theme === 'dark' ? 'cc-status-theme-dark' : 'cc-status-theme-light';
        const previousClass = theme === 'dark' ? 'cc-status-theme-light' : 'cc-status-theme-dark';
        this.menu.box.remove_style_class_name(previousClass);
        this.menu.box.add_style_class_name(nextClass);
        this._syncStatusGlyphs(theme);
    }

    /** Subclasses can swap explicit-color glyphs when the Shell theme changes. */
    _syncStatusGlyphs(_theme) {
    }

    _syncStatusGlass(active) {
        this._statusBackdropActive = active;
        if (active) {
            detachBlur(this.menu.box);
            this.menu.box.add_style_class_name('cc-status-glass-active');
            // Glass controls only the material. Foreground and tint follow the
            // Shell theme, not the brightness of the wallpaper underneath.
            this._syncStatusTheme();
            this._sampleStatusBackdrop();
            if (!this._statusAdaptId) {
                this._statusAdaptId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 650, () => {
                    this._sampleStatusBackdrop();
                    if (this._statusHasBackdropSample) {
                        this._statusAdaptId = 0;
                        return GLib.SOURCE_REMOVE;
                    }
                    return GLib.SOURCE_CONTINUE;
                });
            }
            return;
        }

        this.menu.box.remove_style_class_name('cc-status-glass-active');
        this._statusHasBackdropSample = false;
        detachBlur(this.menu.box);
        if (this._statusAdaptId) {
            GLib.source_remove(this._statusAdaptId);
            this._statusAdaptId = 0;
        }

        if (this._statusBlurFallbackId) {
            GLib.source_remove(this._statusBlurFallbackId);
            this._statusBlurFallbackId = 0;
        }
        this._syncStatusTheme();
    }

    async _sampleStatusBackdrop() {
        if (this._statusSampling || !this._statusBackdropActive ||
            !this.menu?.isOpen || !this._menuGlass)
            return;

        this._statusSampling = true;
        try {
            const luminance = await this._menuGlass.sampleLuminance(screenRect(this.menu.box));
            if (luminance === null || luminance === undefined || !this._statusBackdropActive)
                return;

            this._statusHasBackdropSample = true;
            detachBlur(this.menu.box);
            if (this._statusBlurFallbackId) {
                GLib.source_remove(this._statusBlurFallbackId);
                this._statusBlurFallbackId = 0;
            }
        } catch (e) {
            console.warn(`${LOG_PREFIX} glass backdrop readiness check failed: ${e.message}`);
        } finally {
            this._statusSampling = false;
        }
    }

    /**
     * The container is the panel's child: hiding the button alone would leave
     * its padding behind as an empty slot in the bar. Hardware availability
     * (such as the presence of a battery) and the user's panel choice both
     * have to permit the icon to be shown.
     */
    _applyVisibility() {
        this.container.visible = this._available && this._panelEnabled;
    }

    /* ------------------------------------------------------------ helpers */

    /** Adds a proxy to the list torn down by destroy(). */
    _track(proxy) {
        this._proxies.push(proxy);
        return proxy;
    }

    /** Detaches a proxy's handler and forgets it: a newer one replaced it. */
    _forget(proxy) {
        if (!proxy)
            return;

        const index = this._proxies.indexOf(proxy);
        if (index !== -1)
            this._proxies.splice(index, 1);

        disposeProxy(proxy);
    }

    /**
     * Coalesces a burst of daemon signals (a scan in progress, say) into one
     * reload.
     *
     * @param {() => void} reload
     */
    _debounceReload(reload) {
        if (this._reloadId) {
            GLib.source_remove(this._reloadId);
            this._reloadId = 0;
        }

        this._reloadId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._reloadId = 0;
            reload();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * Re-arms `restart()` whenever the daemon behind `busName` (re)appears. Like
     * the panel's own backends these services live on the system bus, where they
     * are routinely up before or after the Shell is.
     */
    _watchOwner(busName, restart) {
        if (this._ownerId)
            return;

        this._ownerId = Gio.DBus.system.signal_subscribe(
            DBUS_NAME, DBUS_IFACE, 'NameOwnerChanged', DBUS_PATH, busName,
            Gio.DBusSignalFlags.NONE,
            (_connection, _sender, _path, _iface, _signal, params) => {
                const [, , newOwner] = params.deepUnpack();
                if (newOwner)
                    restart();
            });
    }

    /* -------------------------------------------------------- liquid glass */

    /**
     * The Liquid Glass extension marks the menus it covers with
     * `.liquid-glass-menu-root`; mirror that onto `.cc-glass-host` so the
     * stylesheet can drop our own fills and leave exactly one material behind.
     * No hard dependency: if the extension is not installed the class never
     * appears and the standalone look is used.
     */
    _setupGlassDetection() {
        this._syncGlassHost();
        this.menu.box.connectObject('notify::style-class',
            () => this._syncGlassHost(), this);
    }

    _syncGlassHost() {
        const hosted = this.menu.box.has_style_class_name('liquid-glass-menu-root');
        const marked = this.menu.box.has_style_class_name('cc-glass-host');

        if (hosted && !marked)
            this.menu.box.add_style_class_name('cc-glass-host');
        else if (!hosted && marked)
            this.menu.box.remove_style_class_name('cc-glass-host');
    }

    destroy() {
        this._destroyed = true;
        detachBlur(this.menu.box);

        if (this._statusAdaptId) {
            GLib.source_remove(this._statusAdaptId);
            this._statusAdaptId = 0;
        }

        if (this._statusBlurFallbackId) {
            GLib.source_remove(this._statusBlurFallbackId);
            this._statusBlurFallbackId = 0;
        }

        if (this._panelStyleSignal) {
            Main.panel.disconnect(this._panelStyleSignal);
            this._panelStyleSignal = 0;
        }

        for (const {settings, id} of this._themeSignalIds)
            settings.disconnect(id);
        this._themeSignalIds = [];
        this._appearanceSettings = null;
        this._shellThemeSettings = null;

        this._menuGlass?.destroy();
        this._menuGlass = null;

        if (this._visibilityId) {
            GLib.source_remove(this._visibilityId);
            this._visibilityId = 0;
        }

        if (this._reloadId) {
            GLib.source_remove(this._reloadId);
            this._reloadId = 0;
        }

        if (this._ownerId) {
            Gio.DBus.system.signal_unsubscribe(this._ownerId);
            this._ownerId = 0;
        }

        for (const proxy of this._proxies)
            disposeProxy(proxy);
        this._proxies = [];

        // PanelMenu.Button._onDestroy() destroys this.menu for us.
        super.destroy();
    }
});

/* ------------------------------------------------------------------------ */
/* Wi-Fi                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * NetworkManager on the system bus: a signal-strength glyph whose dropdown is
 * a compact, blurred Wi-Fi sheet — radio switch, active connection, nearby
 * networks, and links to the full Network and Wi-Fi settings.
 *
 * `org.freedesktop.NetworkManager.Device.Wireless` is the interface that owns
 * `ActiveAccessPoint`; the strength of that access point then lives on the
 * access point object itself, so the glyph needs both proxies to stay live.
 */
export class WifiStatusIndicator extends CCStatusIndicator {
    static {
        GObject.registerClass(this);
    }

    /** @param {object} params see CCStatusIndicator */
    _init(params) {
        super._init({
            ...params,
            accessibleName: params.gettext('Wi-Fi'),
            iconName: 'network-wireless-disabled-symbolic',
            blurOnly: true,
        });
        this.add_style_class_name('cc-wifi-indicator');

        this._nm = null;           // org.freedesktop.NetworkManager
        this._device = null;       // the Device.Wireless of the Wi-Fi device
        this._accessPoint = null;  // its active access point
        this._hasAdapter = false;
        this._ethernetConnectionName = null;
        this._ethernetGeneration = 0;
        this._connectionInfoGeneration = 0;
        // Saved connections by SSID, so a known network is activated (with its
        // stored secrets) instead of being added a second time.
        this._connections = new Map();
        this._connectionsLoaded = false;
        // The networks of the last read, strongest first.
        this._networks = [];
        this._networkScanRequested = false;
        // Bumped by every rescan: a chain of awaits that started before the
        // last rescan must not publish its (now stale) state.
        this._generation = 0;
        this._networksGeneration = 0;

        this._start();
    }

    async _start() {
        this._watchOwner(NM_NAME, () => {
            this._teardown();
            this._start();
        });

        if (this._nm)
            return;

        // NetworkManager lives on the SYSTEM bus (see the panel's _initWifi).
        this._nm = this._track(createProxy({
            bus: Gio.DBus.system,
            busName: NM_NAME,
            objectPath: NM_PATH,
            interfaceName: NM_IFACE,
            onPropertiesChanged: changed => {
                if (changed.lookup_value('WirelessEnabled', null) ||
                    changed.lookup_value('WirelessHardwareEnabled', null) ||
                    changed.lookup_value('Connectivity', null))
                    this._sync();
                if (changed.lookup_value('Devices', null))
                    this._selectDevice();
                if (changed.lookup_value('ActiveConnections', null)) {
                    this._refreshEthernetConnection();
                    this._syncConnectionInfo();
                }
            },
        }));

        if (!await initProxy(this._nm) || this._destroyed) {
            this._forget(this._nm);
            this._nm = null;
            this._sync();
            return;
        }

        this._sync();
        this._refreshEthernetConnection();
        await this._selectDevice();
    }

    _teardown() {
        this._generation++;
        this._networksGeneration++;

        this._forget(this._accessPoint);
        this._forget(this._device);
        this._forget(this._nm);

        this._accessPoint = null;
        this._device = null;
        this._nm = null;
        this._hasAdapter = false;
        this._ethernetGeneration++;
        this._ethernetConnectionName = null;
        this._networks = [];
        this._connections.clear();
        this._connectionsLoaded = false;

        this._sync();
        this._renderNetworks();
    }

    /**
     * Picks the Wi-Fi device out of NetworkManager's `Devices` list. Each device
     * has to be asked for its `DeviceType` separately: that property belongs to
     * the plain Device interface, while `ActiveAccessPoint` belongs to
     * Device.Wireless, and one proxy only ever caches one interface.
     */
    async _selectDevice() {
        const generation = ++this._generation;

        this._forget(this._accessPoint);
        this._forget(this._device);
        this._accessPoint = null;
        this._device = null;

        const path = await this._findWirelessDevice();
        if (this._destroyed || generation !== this._generation)
            return;

        this._hasAdapter = Boolean(path);
        this._sync();

        if (!path)
            return;

        const device = this._track(createProxy({
            bus: Gio.DBus.system,
            busName: NM_NAME,
            objectPath: path,
            interfaceName: NM_WIRELESS_IFACE,
            onPropertiesChanged: changed => {
                if (changed.lookup_value('ActiveAccessPoint', null)) {
                    this._selectAccessPoint();
                    this._scheduleNetworks();
                }
                // The scan NetworkManager runs on its own keeps replacing this
                // list, which is exactly what the open sheet should show.
                if (changed.lookup_value('AccessPoints', null))
                    this._scheduleNetworks();
            },
        }));

        if (!await initProxy(device) || this._destroyed || generation !== this._generation) {
            this._forget(device);
            return;
        }

        this._device = device;
        await this._selectAccessPoint(generation);
        this._scheduleNetworks(true);
    }

    /** @returns {Promise<string|null>} object path of the first Wi-Fi device */
    async _findWirelessDevice() {
        const devices = this._nm?.get_cached_property('Devices')?.deepUnpack() ?? [];

        for (const path of devices) {
            try {
                const reply = await Gio.DBus.system.call(
                    NM_NAME, path, DBUS_PROPERTIES_IFACE, 'Get',
                    new GLib.Variant('(ss)', [NM_DEVICE_IFACE, 'DeviceType']),
                    new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, -1, null);
                const [type] = reply.deepUnpack();
                if (unpackProperty(type) === NM_DEVICE_WIFI)
                    return path;
            } catch (e) {
                console.warn(`${LOG_PREFIX} NetworkManager device ${path} unavailable: ${e.message}`);
            }
        }

        return null;
    }

    /** Watches the access point of the current device, which owns the strength. */
    async _selectAccessPoint(generation = this._generation) {
        const path = this._device?.get_cached_property('ActiveAccessPoint')?.deepUnpack();

        this._forget(this._accessPoint);
        this._accessPoint = null;

        if (!path || path === '/') {
            this._sync();
            return;
        }

        const accessPoint = this._track(createProxy({
            bus: Gio.DBus.system,
            busName: NM_NAME,
            objectPath: path,
            interfaceName: NM_ACCESS_POINT_IFACE,
            onPropertiesChanged: changed => {
                if (changed.lookup_value('Strength', null))
                    this._sync();
            },
        }));

        if (!await initProxy(accessPoint) || this._destroyed ||
            generation !== this._generation || this._device === null) {
            this._forget(accessPoint);
            return;
        }

        this._accessPoint = accessPoint;
        this._sync();
    }

    _sync() {
        const ethernetConnected = Boolean(this._ethernetConnectionName);
        const available = Boolean(this._nm) && (this._hasAdapter || ethernetConnected);
        const enabled = this._nm?.get_cached_property('WirelessEnabled')?.unpack() ?? false;
        const hardwareEnabled =
            this._nm?.get_cached_property('WirelessHardwareEnabled')?.unpack() ?? true;

        const connectivity = this._nm?.get_cached_property('Connectivity')?.unpack() ?? 0;
        let iconName = 'ext:wifi-error';
        this.accessible_name = ethernetConnected
            ? this._gettext('Ethernet')
            : this._gettext('Wi-Fi');
        if (ethernetConnected)
            iconName = 'network-wired-symbolic';
        else if (!hardwareEnabled || !enabled)
            iconName = 'ext:wifi-disabled';
        else if (this._accessPoint) {
            // NetworkManager: NONE=1, PORTAL=2, LIMITED=3, FULL=4.
            // UNKNOWN=0 is common during startup; in that case the signal
            // strength still gives useful feedback while NM finishes probing.
            if (connectivity === 0 || connectivity === 4) {
                const strength = this._accessPoint.get_cached_property('Strength')?.unpack() ?? 0;
                iconName = wifiSignalIcon(strength);
            }
        }

        this._setGlyph(iconName, available);
        this._syncMenuPill();
        this._syncConnectionInfo();
    }

    /* ------------------------------------------------------------- the menu */

    _buildMenu() {
        this._wifiToggle = new CCPillButton({
            iconName: 'ext:wifi-3',
            title: this._gettext('Wi-Fi'),
            styleClass: 'cc-wifi-pill',
            toggleMode: true,
            withSwitch: true,
            blur: false,
            rim: false,
            pressFeedback: false,
        });
        this._wifiToggle.connectObject('clicked', () => this._onToggleWifi(), this);
        this._menuContent.add_child(this._wifiToggle);

        this._connectionLabel = new St.Label({
            text: this._gettext('Not connected'),
            style_class: 'cc-wifi-connection',
            x_align: Clutter.ActorAlign.START,
            x_expand: true,
        });
        this._menuContent.add_child(this._connectionLabel);
        this._menuContent.add_child(new St.Widget({
            style_class: 'cc-wifi-separator',
            x_expand: true,
        }));

        // Nearby networks sit immediately below the divider. The list is
        // bounded so a crowded area can scroll without pushing the menu offscreen.
        this._networkList = this._createList();
        this._networkHint = this._createHint(this._gettext('Turn Wi-Fi on to see nearby networks'));
        this._networkList.add_child(this._networkHint);
        this._networkScroll = new St.ScrollView({
            style_class: 'cc-status-scroll cc-wifi-networks-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            child: this._networkList,
            x_expand: true,
        });
        this._menuContent.add_child(this._networkScroll);

        this._networkSettingsRow = this._createWifiSettingsRow(
            this._gettext('Network Settings…'), 'network');
        this._menuContent.add_child(this._networkSettingsRow);
        this._wifiSettingsRow = this._createWifiSettingsRow(
            this._gettext('Wi-Fi Settings…'), 'wifi');
        this._menuContent.add_child(this._wifiSettingsRow);

        this._syncMenuPill();
    }

    async _refreshMenu() {
        await this._syncConnectionInfo();
        await this._reloadNetworks(true, true);
    }

    _syncMenuPill() {
        if (!this._menuBuilt)
            return;

        this._wifiToggle.visible = this._hasAdapter;
        this._networkScroll.visible = this._hasAdapter;
        this._wifiSettingsRow.visible = this._hasAdapter;

        const enabled = this._nm?.get_cached_property('WirelessEnabled')?.unpack() ?? false;
        const connected = enabled && Boolean(this._accessPoint);

        this._wifiToggle.checked = enabled;

        const dark = this.menu.box.has_style_class_name('cc-status-theme-dark');
        setIcon(this._wifiToggle.icon, dark
            ? enabled ? 'ext:wifi-3' : 'ext:wifi-disabled'
            : enabled ? 'ext:wifi-3-black' : 'ext:wifi-disabled-black');

        if (connected)
            this._wifiToggle.add_style_class_name('cc-connected');
        else
            this._wifiToggle.remove_style_class_name('cc-connected');
    }

    async _refreshEthernetConnection() {
        const generation = ++this._ethernetGeneration;
        const name = await this._readActiveEthernetConnection();
        if (this._destroyed || generation !== this._ethernetGeneration)
            return;

        if (this._ethernetConnectionName !== name) {
            this._ethernetConnectionName = name;
            this._sync();
        }
    }

    _onToggleWifi() {
        setDBusProperty(this._nm, NM_IFACE, 'WirelessEnabled',
            new GLib.Variant('b', this._wifiToggle.checked));
        this._scheduleNetworks(true);
    }

    _syncStatusGlyphs() {
        this._syncMenuPill();
    }

    _createWifiSettingsRow(label, panel) {
        const button = new St.Button({
            style_class: 'cc-wifi-settings-row',
            can_focus: true,
            reactive: true,
            track_hover: true,
            accessible_name: label,
            x_expand: true,
        });
        button.set_child(new St.Label({
            text: label,
            x_align: Clutter.ActorAlign.START,
            x_expand: true,
        }));
        button.connectObject('clicked', () => {
            this.menu.close();
            if (!Util.trySpawn(['gnome-control-center', panel]))
                console.warn(`${LOG_PREFIX} could not launch gnome-control-center ${panel}`);
        }, this);
        return button;
    }

    async _syncConnectionInfo() {
        if (!this._connectionLabel || this._destroyed)
            return;

        const generation = ++this._connectionInfoGeneration;
        const ethernet = this._ethernetConnectionName ??
            await this._readActiveEthernetConnection();
        if (this._destroyed || generation !== this._connectionInfoGeneration)
            return;

        if (ethernet) {
            this._connectionLabel.text = `${this._gettext('Ethernet')}: ${ethernet}`;
            return;
        }

        const enabled = this._nm?.get_cached_property('WirelessEnabled')?.unpack() ?? false;
        if (enabled && this._accessPoint) {
            const ssidValue = this._accessPoint.get_cached_property('Ssid');
            const ssid = ssidValue ? decodeSsid(toBytes(unpackProperty(ssidValue))) : '';
            if (ssid) {
                this._connectionLabel.text = `${this._gettext('Wi-Fi')}: ${ssid}`;
                return;
            }
        }

        this._connectionLabel.text = this._gettext('Not connected');
    }

    async _readActiveEthernetConnection() {
        const activeConnections = this._nm?.get_cached_property('ActiveConnections')?.deepUnpack() ?? [];
        for (const path of activeConnections) {
            try {
                const reply = await Gio.DBus.system.call(
                    NM_NAME, path, DBUS_PROPERTIES_IFACE, 'GetAll',
                    new GLib.Variant('(s)', [NM_CONNECTION_IFACE]),
                    new GLib.VariantType('(a{sv})'), Gio.DBusCallFlags.NONE, -1, null);
                const [properties] = reply.deepUnpack();
                if (unpackProperty(properties.Type) !== '802-3-ethernet')
                    continue;

                return unpackProperty(properties.Id) || this._gettext('Ethernet');
            } catch {
                // An active connection can disappear while the menu is opening.
            }
        }
        return null;
    }

    /* --------------------------------------------------------- the network list */

    /** Debounced rescan of the list while the sheet is on screen. */
    _scheduleNetworks(requestScan = false) {
        if (!this.menu.isOpen)
            return;

        this._networkScanRequested ||= requestScan;
        this._debounceReload(() => {
            const shouldScan = this._networkScanRequested;
            this._networkScanRequested = false;
            this._reloadNetworks(shouldScan);
        });
    }

    async _reloadNetworks(requestScan = false, refreshConnections = false) {
        if (this._destroyed)
            return;

        const generation = ++this._networksGeneration;

        // Opening the menu or switching Wi-Fi on requests a fresh scan. Later
        // access-point signals only reread the updated cache, avoiding a loop.
        if (requestScan &&
            (this._nm?.get_cached_property('WirelessEnabled')?.unpack() ?? false))
            this._requestScan();

        await this._loadConnections(refreshConnections);
        const networks = await this._readNetworks();

        if (this._destroyed || generation !== this._networksGeneration)
            return;

        this._networks = networks;
        this._renderNetworks();
    }

    /**
     * Asks for a scan. NetworkManager rate-limits this, so a refusal is normal
     * and never reported.
     */
    _requestScan() {
        const device = this._device;
        if (!device)
            return;

        Gio.DBus.system.call(
            device.get_name(), device.get_object_path(), NM_WIRELESS_IFACE,
            'RequestScan', new GLib.Variant('(a{ss})', [{}]), null,
            Gio.DBusCallFlags.NONE, -1, null)
            .catch(() => {
                // "Scanning not allowed immediately following a previous scan".
            });
    }

    /**
     * Reads the SSIDs of the saved Wi-Fi connections, keyed by SSID.
     *
     * The list comes from the settings service rather than from NetworkManager:
     * `Connections` is a property of `org.freedesktop.NetworkManager.Settings`,
     * a different object on a different path.
     */
    async _loadConnections(force = false) {
        if (this._connectionsLoaded && !force)
            return;
        if (!this._nm)
            return;

        const connections = new Map();

        let paths = [];
        try {
            const reply = await Gio.DBus.system.call(
                NM_NAME, NM_SETTINGS_PATH, NM_SETTINGS_IFACE, 'ListConnections',
                null, new GLib.VariantType('(ao)'), Gio.DBusCallFlags.NONE, -1, null);
            [paths] = reply.deepUnpack();
        } catch (e) {
            console.warn(`${LOG_PREFIX} cannot list saved connections: ${e.message}`);
            return;
        }

        await Promise.all(paths.map(async path => {
            try {
                const reply = await Gio.DBus.system.call(
                    NM_NAME, path, NM_SETTINGS_CONNECTION_IFACE, 'GetSettings',
                    null, new GLib.VariantType('(a{sa{sv}})'),
                    Gio.DBusCallFlags.NONE, -1, null);
                const [settings] = reply.deepUnpack();

                // A saved connection that is not Wi-Fi has no SSID to match on.
                const wireless = settings['802-11-wireless'];
                const ssid = decodeSsid(toBytes(unpackProperty(wireless?.ssid)));
                if (ssid)
                    connections.set(ssid, path);
            } catch (e) {
                // A connection that vanished between listing and reading.
            }
        }));

        if (!this._destroyed) {
            this._connections = connections;
            this._connectionsLoaded = true;
        }
    }

    /** @returns {Promise<object[]>} the networks in range, strongest first */
    async _readNetworks() {
        const device = this._device;
        if (!device)
            return [];

        // Nothing is scanned while the radio is off, and the sheet says so.
        if (!(this._nm?.get_cached_property('WirelessEnabled')?.unpack() ?? false))
            return [];

        const active = device.get_cached_property('ActiveAccessPoint')?.deepUnpack() ?? '/';
        const paths = device.get_cached_property('AccessPoints')?.deepUnpack() ?? [];

        const read = await Promise.all(paths.map(path => this._readNetwork(path, active)));
        const bySsid = new Map();

        // One SSID is usually announced by several access points; the strongest
        // one (or the connected one) stands for the network.
        for (const network of read) {
            if (!network)
                continue;

            const seen = bySsid.get(network.ssid);
            if (!seen || network.connected || (!seen.connected && network.strength > seen.strength))
                bySsid.set(network.ssid, network);
        }

        return [...bySsid.values()].sort((a, b) => {
            if (a.connected !== b.connected)
                return a.connected ? -1 : 1;
            return b.strength - a.strength;
        });
    }

    /**
     * @param {string} path the access point
     * @param {string} activePath the access point that is associated
     * @returns {Promise<object|null>}
     */
    async _readNetwork(path, activePath) {
        try {
            const reply = await Gio.DBus.system.call(
                NM_NAME, path, DBUS_PROPERTIES_IFACE, 'GetAll',
                new GLib.Variant('(s)', [NM_ACCESS_POINT_IFACE]),
                new GLib.VariantType('(a{sv})'), Gio.DBusCallFlags.NONE, -1, null);
            const [props] = reply.deepUnpack();

            // Hotspot and ad-hoc entries are not networks to join.
            const mode = unpackProperty(props.Mode);
            if (mode !== undefined && mode !== NM_AP_MODE_INFRASTRUCTURE)
                return null;

            const bytes = toBytes(unpackProperty(props.Ssid));
            const ssid = decodeSsid(bytes);
            if (!ssid)
                return null;

            const flags = unpackProperty(props.Flags) ?? 0;
            const wpa = unpackProperty(props.WpaFlags) ?? 0;
            const rsn = unpackProperty(props.RsnFlags) ?? 0;

            return {
                path,
                bytes,
                ssid,
                strength: unpackProperty(props.Strength) ?? 0,
                secure: (flags & NM_AP_FLAG_PRIVACY) !== 0 || wpa !== 0 || rsn !== 0,
                connected: path === activePath,
            };
        } catch (e) {
            // An access point that disappeared between listing and reading.
            return null;
        }
    }

    _renderNetworks() {
        if (!this._menuBuilt || !this._networkList)
            return;

        const enabled = this._nm?.get_cached_property('WirelessEnabled')?.unpack() ?? false;

        this._syncMenuPill();

        this._networkList.remove_all_children();
        if (!enabled) {
            this._networkHint.text = this._gettext('Turn Wi-Fi on to see nearby networks');
            this._networkList.add_child(this._networkHint);
            return;
        }

        if (this._networks.length === 0) {
            this._networkHint.text = this._gettext('No nearby Wi-Fi networks');
            this._networkList.add_child(this._networkHint);
            return;
        }

        for (const network of this._networks)
            this._networkList.add_child(this._createNetworkRow(network));
    }

    /**
     * @param {object} network a record from _readNetworks()
     * @returns {CCGalleryRow}
     */
    _createNetworkRow(network) {
        const row = new CCGalleryRow({
            iconName: wifiSignalIcon(network.strength),
            title: network.ssid,
            // Only a secured network needs the hint: a lock next to the name.
            trailingIcon: network.secure ? 'channel-secure-symbolic' : null,
            // The network in use is shown as selected and does nothing when
            // clicked; joining it again would only interrupt the connection.
            toggleMode: !network.connected,
            flat: true,
        });
        row.checked = network.connected;

        if (!network.connected)
            row.connectObject('clicked', () => this._connectTo(network, row), this);

        return row;
    }

    /**
     * Joins a network: a saved one is activated (NetworkManager finds its
     * secrets), a new one is added and activated — for a secured network that
     * makes NetworkManager's own agent ask for the password.
     *
     * @param {object} network a record from _readNetworks()
     * @param {CCGalleryRow} row the row that was clicked
     */
    async _connectTo(network, row) {
        const device = this._device?.get_object_path();
        if (!device || this._destroyed)
            return;

        const connection = this._connections.get(network.ssid);

        row.subtitleLabel.text = this._gettext('Connecting…');
        row.subtitleLabel.visible = true;

        try {
            if (connection) {
                await Gio.DBus.system.call(
                    NM_NAME, NM_PATH, NM_IFACE, 'ActivateConnection',
                    new GLib.Variant('(ooo)', [connection, device, network.path]),
                    new GLib.VariantType('(o)'), Gio.DBusCallFlags.NONE, -1, null);
            } else {
                const reply = await Gio.DBus.system.call(
                    NM_NAME, NM_PATH, NM_IFACE, 'AddAndActivateConnection',
                    new GLib.Variant('(a{sa{sv}}oo)',
                        [this._connectionSettings(network), device, network.path]),
                    new GLib.VariantType('(oo)'), Gio.DBusCallFlags.NONE, -1, null);
                const [connectionPath] = reply.deepUnpack();
                this._connections.set(network.ssid, connectionPath);
            }
        } catch (e) {
            console.warn(`${LOG_PREFIX} cannot connect to ${network.ssid}: ${e.message}`);

            if (!this._destroyed) {
                row.checked = false;
                row.subtitleLabel.text = this._gettext('Could not connect');
                row.subtitleLabel.visible = true;
            }
        }
    }

    /**
     * The settings of a connection that does not exist yet. The SSID and the
     * mode are all NetworkManager needs to complete the rest from the access
     * point, including its security; the password then comes from the agent.
     *
     * @param {object} network a record from _readNetworks()
     * @returns {object} an `a{sa{sv}}`
     */
    _connectionSettings(network) {
        return {
            'connection': {
                'id': new GLib.Variant('s', network.ssid),
                'uuid': new GLib.Variant('s', newUuid()),
                'type': new GLib.Variant('s', '802-11-wireless'),
            },
            '802-11-wireless': {
                'ssid': new GLib.Variant('ay', network.bytes),
                'mode': new GLib.Variant('s', 'infrastructure'),
            },
        };
    }
}

/* ------------------------------------------------------------------------ */
/* Bluetooth                                                                */
/* ------------------------------------------------------------------------ */

/**
 * BlueZ on the system bus. The reference shows the Bluetooth glyph only while
 * the radio is on, so that is the availability rule: the adapter is powered.
 * BlueZ refuses to power an adapter off while it is discoverable, which is why
 * the switch below clears discoverability first — exactly like the panel does.
 */
export class BluetoothStatusIndicator extends CCStatusIndicator {
    static {
        GObject.registerClass(this);
    }

    /** @param {object} params see CCStatusIndicator */
    _init(params) {
        super._init({
            ...params,
            accessibleName: params.gettext('Bluetooth'),
            iconName: 'ext:bluetooth',
            blurOnly: true,
        });
        this.add_style_class_name('cc-bluetooth-indicator');

        this._adapter = null;
        this._adapterPath = null;
        // Device object path -> {proxy, row}, so a property change lands on the
        // row that already exists instead of rebuilding the list.
        this._devices = new Map();
        this._nearbyDevices = new Map();
        this._pairingDevices = new Set();
        this._deviceScroll = null;
        this._nearbyPollId = 0;
        this._discoveryActive = false;

        this.menu.connectObject('open-state-changed', (_menu, isOpen) => {
            if (!isOpen)
                this._stopNearbyDiscovery();
        }, this);

        this._start();
    }

    async _start() {
        this._watchOwner(BLUEZ_NAME, () => {
            this._teardown();
            this._start();
        });

        if (this._adapter)
            return;

        const path = await this._findAdapterPath();
        if (this._destroyed)
            return;

        if (!path) {
            this._adapter = null;
            this._adapterPath = null;
            this._sync();
            return;
        }

        // BlueZ lives on the SYSTEM bus too.
        const adapter = this._track(createProxy({
            bus: Gio.DBus.system,
            busName: BLUEZ_NAME,
            objectPath: path,
            interfaceName: BLUEZ_ADAPTER_IFACE,
            onPropertiesChanged: changed => {
                if (!changed.lookup_value('Powered', null) &&
                    !changed.lookup_value('Discoverable', null))
                    return;

                this._sync();
                // Devices come and go while the user is in the sheet.
                this._scheduleDevices();
            },
        }));

        if (!await initProxy(adapter) || this._destroyed) {
            this._forget(adapter);
            this._adapter = null;
            this._adapterPath = null;
            this._sync();
            return;
        }

        this._adapter = adapter;
        this._adapterPath = path;
        this._sync();
    }

    _teardown() {
        this._stopNearbyDiscovery();
        this._clearDevices();
        this._clearNearbyDevices();

        this._forget(this._adapter);
        this._adapter = null;
        this._adapterPath = null;

        this._sync();
    }

    /** @returns {Promise<string|null>} object path of the first BlueZ adapter */
    async _findAdapterPath() {
        const objects = await this._getManagedObjects();

        return Object.keys(objects)
            .find(path => BLUEZ_ADAPTER_IFACE in objects[path]) ?? null;
    }

    /** @returns {Promise<object>} BlueZ's managed objects, or an empty object */
    async _getManagedObjects() {
        try {
            const reply = await Gio.DBus.system.call(
                BLUEZ_NAME, BLUEZ_PATH, OBJECT_MANAGER_IFACE, 'GetManagedObjects',
                null, new GLib.VariantType('(a{oa{sa{sv}}})'),
                Gio.DBusCallFlags.NONE, -1, null);
            const [objects] = reply.deepUnpack();

            return objects ?? {};
        } catch (e) {
            console.warn(`${LOG_PREFIX} BlueZ unavailable: ${e.message}`);
            return {};
        }
    }

    _sync() {
        const powered = this._adapter?.get_cached_property('Powered')?.unpack() ?? false;

        // "When Bluetooth is enabled": no radio, no glyph.
        this._setGlyph('ext:bluetooth', powered);

        if (!this._menuBuilt)
            return;

        this._bluetoothToggle.checked = powered;
        this._bluetoothStatusLabel.text = `${this._gettext('Bluetooth')}: ${powered
            ? this._gettext('On')
            : this._gettext('Off')}`;

        // Keep Settings available while the radio is off, but hide both device
        // sections and stop scanning until Bluetooth is switched back on.
        this._deviceScroll.visible = powered;
        if (!powered)
            this._stopNearbyDiscovery();

        // The paired-device hints are meaningful only while the radio is on.
        this._devicesTitle.visible = powered;
        this._devicesList.visible = powered && this._devices.size > 0;
        this._devicesHint.visible = powered && this._devices.size === 0;
        this._nearbyTitle.visible = powered;
        this._nearbyList.visible = powered && this._nearbyDevices.size > 0;
        this._nearbyHint.visible = powered && this._nearbyDevices.size === 0;
        if (this._nearbyDevices.size === 0) {
            this._nearbyHint.text = this._discoveryActive
                ? this._gettext('Searching for nearby devices…')
                : this._gettext('No nearby devices found');
        }

        if (powered && this.menu.isOpen && !this._discoveryActive)
            this._startNearbyDiscovery();
    }

    /* ------------------------------------------------------------- the menu */

    _buildMenu() {
        this._bluetoothToggle = new CCPillButton({
            iconName: 'bluetooth-symbolic',
            title: this._gettext('Bluetooth'),
            styleClass: 'cc-bluetooth-pill',
            toggleMode: true,
            withSwitch: true,
            blur: false,
            rim: false,
            pressFeedback: false,
        });
        this._bluetoothToggle.connectObject('clicked', () => this._onToggleBluetooth(), this);
        this._menuContent.add_child(this._bluetoothToggle);

        this._bluetoothStatusLabel = new St.Label({
            text: `${this._gettext('Bluetooth')}: ${this._gettext('Off')}`,
            style_class: 'cc-wifi-connection',
            x_align: Clutter.ActorAlign.START,
            x_expand: true,
        });
        this._menuContent.add_child(this._bluetoothStatusLabel);
        this._menuContent.add_child(new St.Widget({
            style_class: 'cc-wifi-separator',
            x_expand: true,
        }));

        const {scroll, column} = this._createListColumn();
        this._deviceScroll = scroll;

        this._devicesTitle = this._createSectionTitle(this._gettext('My Devices'));
        this._devicesList = this._createList();
        this._devicesHint = this._createHint(this._gettext('No device is paired yet'));
        column.add_child(this._devicesTitle);
        column.add_child(this._devicesList);
        column.add_child(this._devicesHint);

        column.add_child(new St.Widget({
            style_class: 'cc-status-divider',
            x_expand: true,
        }));
        this._nearbyTitle = this._createSectionTitle(this._gettext('Nearby Devices'));
        this._nearbyList = this._createList();
        this._nearbyHint = this._createHint(this._gettext('No nearby devices found'));
        column.add_child(this._nearbyTitle);
        column.add_child(this._nearbyList);
        column.add_child(this._nearbyHint);

        this._menuContent.add_child(scroll);

        this._menuContent.add_child(new St.Widget({
            style_class: 'cc-status-divider',
            x_expand: true,
        }));
        const settings = new St.Button({
            style_class: 'cc-wifi-settings-row cc-bluetooth-settings-row',
            can_focus: true,
            reactive: true,
            track_hover: true,
            accessible_name: this._gettext('Bluetooth Settings…'),
            x_expand: true,
        });
        settings.set_child(new St.Label({
            text: this._gettext('Bluetooth Settings…'),
            x_align: Clutter.ActorAlign.START,
            x_expand: true,
        }));
        settings.connectObject('clicked', () => {
            this.menu.close();
            if (!Util.trySpawn(['gnome-control-center', 'bluetooth']))
                console.warn(`${LOG_PREFIX} could not launch gnome-control-center bluetooth`);
        }, this);
        this._menuContent.add_child(settings);

        this._sync();
    }

    async _refreshMenu() {
        this._sync();

        if (!this._adapter?.get_cached_property('Powered')?.unpack())
            return;

        await this._loadDevices();
        await this._startNearbyDiscovery();
    }

    /** Debounced reload of the device list while the sheet is on screen. */
    _scheduleDevices() {
        if (!this.menu.isOpen)
            return;

        this._debounceReload(() => {
            this._loadDevices();
            this._loadNearbyDevices();
        });
    }

    async _startNearbyDiscovery() {
        if (this._discoveryActive || this._destroyed || !this.menu.isOpen ||
            !this._adapterPath ||
            !this._adapter?.get_cached_property('Powered')?.unpack())
            return;

        this._discoveryActive = true;
        this._nearbyHint.text = this._gettext('Searching for nearby devices…');
        this._nearbyHint.show();

        try {
            await Gio.DBus.system.call(
                BLUEZ_NAME, this._adapterPath, BLUEZ_ADAPTER_IFACE, 'StartDiscovery',
                null, null, Gio.DBusCallFlags.NONE, -1, null);
        } catch (e) {
            this._discoveryActive = false;
            this._nearbyHint.text = this._gettext('Could not scan for nearby devices');
            console.warn(`${LOG_PREFIX} Bluetooth discovery failed: ${e.message}`);
            return;
        }

        // The menu could have closed while BlueZ was starting the scan.
        if (this._destroyed || !this.menu.isOpen ||
            !this._adapter?.get_cached_property('Powered')?.unpack()) {
            this._stopNearbyDiscovery();
            return;
        }

        await this._loadNearbyDevices();
        if (!this._nearbyPollId) {
            this._nearbyPollId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT, 2, () => {
                    if (this._destroyed || !this.menu.isOpen ||
                        !this._adapter?.get_cached_property('Powered')?.unpack()) {
                        this._nearbyPollId = 0;
                        this._stopNearbyDiscovery();
                        return GLib.SOURCE_REMOVE;
                    }

                    this._loadNearbyDevices();
                    return GLib.SOURCE_CONTINUE;
                });
        }
    }

    _stopNearbyDiscovery() {
        if (this._nearbyPollId) {
            GLib.source_remove(this._nearbyPollId);
            this._nearbyPollId = 0;
        }

        if (!this._discoveryActive)
            return;

        this._discoveryActive = false;
        if (!this._adapterPath)
            return;

        Gio.DBus.system.call(
            BLUEZ_NAME, this._adapterPath, BLUEZ_ADAPTER_IFACE, 'StopDiscovery',
            null, null, Gio.DBusCallFlags.NONE, -1, null)
            .catch(e => console.debug(`${LOG_PREFIX} Bluetooth scan stopped: ${e.message}`));
    }

    async _onToggleBluetooth() {
        const powered = this._bluetoothToggle.checked;

        // BlueZ refuses to power the adapter off while it is discoverable, so
        // the two writes have to be serialised.
        if (!powered) {
            await setDBusProperty(this._adapter, BLUEZ_ADAPTER_IFACE, 'Discoverable',
                new GLib.Variant('b', false));
        }

        await setDBusProperty(this._adapter, BLUEZ_ADAPTER_IFACE, 'Powered',
            new GLib.Variant('b', powered));

        if (powered && this.menu.isOpen)
            await this._startNearbyDiscovery();
    }

    destroy() {
        this._stopNearbyDiscovery();
        this._clearDevices();
        this._clearNearbyDevices();
        super.destroy();
    }

    /** Reads the paired devices and rebuilds the list, in place. */
    async _loadDevices() {
        if (this._destroyed)
            return;

        this._clearDevices();

        const objects = await this._getManagedObjects();
        if (this._destroyed)
            return;

        const devices = [];
        for (const [path, interfaces] of Object.entries(objects)) {
            const device = interfaces[BLUEZ_DEVICE_IFACE];
            if (!device || !unpackProperty(device.Paired))
                continue;
            // Another adapter's devices are not ours to offer.
            const adapter = unpackProperty(device.Adapter);
            if (adapter && adapter !== this._adapterPath)
                continue;

            devices.push({
                path,
                name: unpackProperty(device.Alias) || unpackProperty(device.Name) ||
                    unpackProperty(device.Address) || path,
                icon: unpackProperty(device.Icon) ?? null,
                connected: Boolean(unpackProperty(device.Connected)),
            });
        }

        devices.sort((a, b) =>
            (Number(b.connected) - Number(a.connected)) || a.name.localeCompare(b.name));

        for (const device of devices)
            this._devicesList.add_child(this._createDeviceRow(device));

        this._devicesTitle.visible = true;
        this._devicesList.visible = devices.length > 0;
        this._devicesHint.visible = devices.length === 0;
    }

    /** Reads discovered, unpaired devices while the Bluetooth menu is open. */
    async _loadNearbyDevices() {
        if (this._destroyed || !this.menu.isOpen || !this._nearbyList ||
            !this._adapter?.get_cached_property('Powered')?.unpack())
            return;

        const objects = await this._getManagedObjects();
        if (this._destroyed || !this.menu.isOpen)
            return;

        const devices = [];
        for (const [path, interfaces] of Object.entries(objects)) {
            const device = interfaces[BLUEZ_DEVICE_IFACE];
            if (!device || unpackProperty(device.Paired))
                continue;

            const adapter = unpackProperty(device.Adapter);
            if (adapter && adapter !== this._adapterPath)
                continue;

            const rssi = unpackProperty(device.RSSI);
            // BlueZ exposes RSSI for devices it has actually discovered.
            if (typeof rssi !== 'number')
                continue;

            devices.push({
                path,
                name: unpackProperty(device.Alias) || unpackProperty(device.Name) ||
                    unpackProperty(device.Address) || path,
                icon: unpackProperty(device.Icon) ?? null,
                rssi,
            });
        }

        devices.sort((a, b) => (b.rssi - a.rssi) || a.name.localeCompare(b.name));
        const found = new Set(devices.map(device => device.path));

        for (const [path, item] of this._nearbyDevices) {
            if (found.has(path))
                continue;

            this._forget(item.proxy);
            item.row.destroy();
            this._nearbyDevices.delete(path);
        }

        for (const device of devices) {
            const current = this._nearbyDevices.get(device.path);
            const subtitle = `${this._gettext('Nearby')} · ${device.rssi} dBm`;
            if (current) {
                current.name = device.name;
                current.rssi = device.rssi;
                current.row.titleLabel.text = device.name;
                current.row.subtitleLabel.text = subtitle;
                continue;
            }

            const row = new CCGalleryRow({
                iconName: /airpods/i.test(device.name)
                    ? 'ext:airpods'
                    : bluetoothDeviceIcon(device.icon),
                title: device.name,
                subtitle,
                flat: true,
            });
            const proxy = this._track(createProxy({
                bus: Gio.DBus.system,
                busName: BLUEZ_NAME,
                objectPath: device.path,
                interfaceName: BLUEZ_DEVICE_IFACE,
            }));
            this._nearbyDevices.set(device.path, {
                proxy, row, name: device.name, rssi: device.rssi,
            });
            initProxy(proxy);
            row.connectObject('clicked', () =>
                this._pairNearbyDevice(device.path, proxy, row), this);
            this._nearbyList.add_child(row);
        }

        this._nearbyHint.text = this._discoveryActive
            ? this._gettext('Searching for nearby devices…')
            : this._gettext('No nearby devices found');
        this._nearbyList.visible = devices.length > 0;
        this._nearbyHint.visible = devices.length === 0;
    }

    async _pairNearbyDevice(path, proxy, row) {
        if (this._pairingDevices.has(path) || this._destroyed)
            return;

        this._pairingDevices.add(path);
        row.reactive = false;
        row.subtitleLabel.text = this._gettext('Pairing…');
        row.subtitleLabel.show();

        try {
            try {
                await Gio.DBus.system.call(
                    BLUEZ_NAME, path, BLUEZ_DEVICE_IFACE, 'Pair', null, null,
                    Gio.DBusCallFlags.NONE, -1, null);
            } catch (e) {
                if (!e.message.includes('AlreadyExists'))
                    throw e;
            }

            if (!this._destroyed)
                await this._loadDevices();

            await Gio.DBus.system.call(
                BLUEZ_NAME, path, BLUEZ_DEVICE_IFACE, 'Connect', null, null,
                Gio.DBusCallFlags.NONE, -1, null);
            if (!this._destroyed) {
                await this._loadDevices();
                await this._loadNearbyDevices();
            }
        } catch (e) {
            console.warn(`${LOG_PREFIX} could not pair Bluetooth device: ${e.message}`);
            if (!this._destroyed && row.get_parent()) {
                row.reactive = true;
                row.subtitleLabel.text = this._gettext('Could not pair or connect');
                row.subtitleLabel.show();
            }
        } finally {
            this._pairingDevices.delete(path);
        }
    }

    _clearDevices() {
        for (const {proxy, row} of this._devices.values()) {
            this._forget(proxy);
            row.destroy();
        }

        this._devices.clear();
    }

    _clearNearbyDevices() {
        for (const {proxy, row} of this._nearbyDevices.values()) {
            this._forget(proxy);
            row.destroy();
        }

        this._nearbyDevices.clear();
        this._pairingDevices.clear();
    }

    /**
     * @param {object} device a record from _loadDevices()
     * @returns {CCGalleryRow}
     */
    _createDeviceRow(device) {
        const row = new CCGalleryRow({
            iconName: /airpods/i.test(device.name ?? '')
                ? 'ext:airpods'
                : bluetoothDeviceIcon(device.icon),
            title: device.name,
            subtitle: device.connected ? this._gettext('Connected') : this._gettext('Not connected'),
            flat: true,
        });
        row.checked = device.connected;

        const proxy = this._track(createProxy({
            bus: Gio.DBus.system,
            busName: BLUEZ_NAME,
            objectPath: device.path,
            interfaceName: BLUEZ_DEVICE_IFACE,
            onPropertiesChanged: changed => {
                if (changed.lookup_value('Connected', null))
                    this._syncDeviceRow(proxy, row);
            },
        }));

        // Fire and forget: the cached properties fill in as soon as BlueZ
        // answers, and Connect()/Disconnect() work with the proxy as it is.
        initProxy(proxy);

        this._devices.set(device.path, {proxy, row});

        row.connectObject('clicked', () => this._toggleDevice(proxy, row), this);
        return row;
    }

    _syncDeviceRow(proxy, row) {
        const connected = proxy.get_cached_property('Connected')?.unpack() ?? false;

        row.checked = connected;
        row.subtitleLabel.text = connected
            ? this._gettext('Connected')
            : this._gettext('Not connected');
        row.subtitleLabel.visible = true;
    }

    /**
     * @param {Gio.DBusProxy} proxy the device
     * @param {CCGalleryRow} row its row
     */
    _toggleDevice(proxy, row) {
        const connected = proxy.get_cached_property('Connected')?.unpack() ?? false;

        row.subtitleLabel.text = connected
            ? this._gettext('Disconnecting…')
            : this._gettext('Connecting…');
        row.subtitleLabel.visible = true;

        callDBusMethod(proxy, connected ? 'Disconnect' : 'Connect');
    }
}

/* ------------------------------------------------------------------------ */
/* Battery                                                                  */
/* ------------------------------------------------------------------------ */

/** Standard profile names shared by power-profiles-daemon and TLP's tlp-pd. */
const POWER_PROFILE_LABELS = {
    'power-saver': 'Power Saver',
    'balanced': 'Balanced',
    'performance': 'Performance',
};

const POWER_PROFILE_ICONS = {
    'power-saver': 'power-profile-power-saver-symbolic',
    'balanced': 'power-profile-balanced-symbolic',
    'performance': 'power-profile-performance-symbolic',
};

/**
 * UPower on the system bus, shown as a battery glyph. The display device is the
 * one the panel cares about, and UPower is asked for it by name because its
 * object path is not part of the API.
 *
 * Its dropdown is the battery menu: the level, what the battery is doing, and
 * the power mode when power-profiles-daemon is around to offer one.
 */
export class BatteryStatusIndicator extends CCStatusIndicator {
    static {
        GObject.registerClass(this);
    }

    /** @param {object} params see CCStatusIndicator */
    _init(params) {
        super._init({
            ...params,
            accessibleName: params.gettext('Battery'),
            iconName: 'battery-missing-symbolic',
            blurOnly: true,
        });

        // The battery is wider than it is tall, so its glyph gets more room.
        this._icon.add_style_class_name('cc-glyph-battery');
        this.add_style_class_name('cc-battery-indicator');

        this._upower = null;      // org.freedesktop.UPower
        this._device = null;      // its display device
        this._profiles = null;    // power-profiles-daemon or TLP's tlp-pd
        this._profilesInitPromise = null;
        this._generation = 0;

        this._start();
    }

    async _start() {
        this._watchOwner(UPOWER_NAME, () => {
            this._teardown();
            this._start();
        });

        if (this._upower)
            return;

        // UPower lives on the SYSTEM bus.
        this._upower = this._track(createProxy({
            bus: Gio.DBus.system,
            busName: UPOWER_NAME,
            objectPath: UPOWER_PATH,
            interfaceName: UPOWER_IFACE,
            onPropertiesChanged: changed => {
                if (changed.lookup_value('OnBattery', null))
                    this._syncHero();
            },
        }));

        if (!await initProxy(this._upower) || this._destroyed) {
            this._forget(this._upower);
            this._upower = null;
            this._sync();
            return;
        }

        await this._attachDisplayDevice();
    }

    _teardown() {
        this._generation++;

        this._forget(this._device);
        this._forget(this._upower);

        this._device = null;
        this._upower = null;

        this._sync();
    }

    async _attachDisplayDevice() {
        const generation = ++this._generation;

        this._forget(this._device);
        this._device = null;

        let path = null;
        try {
            const reply = await Gio.DBus.system.call(
                UPOWER_NAME, UPOWER_PATH, UPOWER_IFACE, 'GetDisplayDevice',
                null, new GLib.VariantType('(o)'), Gio.DBusCallFlags.NONE, -1, null);
            [path] = reply.deepUnpack();
        } catch (e) {
            console.warn(`${LOG_PREFIX} UPower display device unavailable: ${e.message}`);
        }

        if (this._destroyed || !path || path === '/' || generation !== this._generation) {
            this._sync();
            return;
        }

        const device = this._track(createProxy({
            bus: Gio.DBus.system,
            busName: UPOWER_NAME,
            objectPath: path,
            interfaceName: UPOWER_DEVICE_IFACE,
            onPropertiesChanged: () => this._sync(),
        }));

        if (!await initProxy(device) || this._destroyed || generation !== this._generation) {
            this._forget(device);
            return;
        }

        this._device = device;
        this._sync();
    }

    _sync() {
        const device = this._device;
        const available = Boolean(device) &&
            (device.get_cached_property('IsPresent')?.unpack() ?? false);

        const percentage = device?.get_cached_property('Percentage')?.unpack() ?? 0;
        const state = device?.get_cached_property('State')?.unpack() ?? 0;
        const chargeThresholdEnabled =
            device?.get_cached_property('ChargeThresholdEnabled')?.unpack() ?? false;

        this._setGlyph(batteryPanelIcon(percentage, state, chargeThresholdEnabled), available);
        this._syncHero();
    }

    /* ------------------------------------------------------------- the menu */

    _buildMenu() {
        const hero = new St.BoxLayout({
            style_class: 'cc-battery-header',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
        });

        this._heroName = new St.Label({
            text: this._gettext('Battery'),
            style_class: 'cc-battery-hero-name',
            x_align: Clutter.ActorAlign.START,
            x_expand: true,
        });

        this._heroPercent = new St.Label({
            text: '',
            style_class: 'cc-battery-hero-percent',
            x_align: Clutter.ActorAlign.END,
        });
        this._heroState = new St.Label({
            text: '',
            style_class: 'cc-battery-hero-state',
            x_align: Clutter.ActorAlign.START,
        });
        hero.add_child(this._heroName);
        hero.add_child(this._heroPercent);
        this._menuContent.add_child(hero);

        this._menuContent.add_child(this._heroState);
        this._menuContent.add_child(new St.Widget({style_class: 'cc-status-divider'}));

        this._powerTitle = this._createSectionTitle(this._gettext('Power Mode'));
        this._segment = new St.BoxLayout({
            style_class: 'cc-power-modes',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._menuContent.add_child(this._powerTitle);
        this._menuContent.add_child(this._segment);

        this._menuContent.add_child(new St.Widget({style_class: 'cc-status-divider'}));
        const settings = new St.Button({
            style_class: 'cc-wifi-settings-row cc-battery-settings-row',
            can_focus: true,
            reactive: true,
            track_hover: true,
            accessible_name: this._gettext('Battery Settings…'),
            x_expand: true,
        });
        settings.set_child(new St.Label({
            text: this._gettext('Battery Settings…'),
            x_align: Clutter.ActorAlign.START,
            x_expand: true,
        }));
        settings.connectObject('clicked', () => {
            this.menu.close();
            if (!Util.trySpawn(['gnome-control-center', 'power']))
                console.warn(`${LOG_PREFIX} could not launch gnome-control-center power`);
        }, this);
        this._menuContent.add_child(settings);

        this._syncHero();
    }

    async _refreshMenu() {
        this._syncHero();

        await this._initPowerProfiles();
        this._syncPowerMode();
    }

    /** The current charge and power source, from UPower. */
    _syncHero() {
        if (!this._menuBuilt)
            return;

        const device = this._device;
        const percentage = Math.round(device?.get_cached_property('Percentage')?.unpack() ?? 0);
        this._heroPercent.text = `${percentage}%`;
        const state = device?.get_cached_property('State')?.unpack() ?? 0;
        const onBattery = this._upower?.get_cached_property('OnBattery')?.unpack() ??
            state === UPOWER_STATE_DISCHARGING;
        const source = onBattery ? this._gettext('Battery') : this._gettext('Power adapter');
        this._heroState.text = `${this._gettext('Power Source')}: ${source}`;
    }

    /* ---------------------------------------------------------- power mode */

    async _initPowerProfiles() {
        if (this._profiles || this._destroyed)
            return;

        // GNOME's power-profiles-daemon and TLP's tlp-pd expose the same
        // PowerProfiles D-Bus API. Serialize attempts so a quick reopen does
        // not create duplicate proxies while either service is starting.
        if (this._profilesInitPromise)
            return this._profilesInitPromise;

        this._profilesInitPromise = this._connectPowerProfiles();
        try {
            await this._profilesInitPromise;
        } finally {
            this._profilesInitPromise = null;
        }
    }

    async _connectPowerProfiles() {

        const profiles = this._track(createProxy({
            bus: Gio.DBus.system,
            busName: POWER_PROFILES_NAME,
            objectPath: POWER_PROFILES_PATH,
            interfaceName: POWER_PROFILES_IFACE,
            onPropertiesChanged: changed => {
                if (changed.lookup_value('ActiveProfile', null) ||
                    changed.lookup_value('Profiles', null))
                    this._syncPowerMode();
            },
        }));

        // power-profiles-daemon is optional: without it the sheet simply does
        // not offer a power mode.
        if (!await initProxy(profiles) || this._destroyed) {
            this._forget(profiles);
            this._powerTitle.visible = false;
            this._segment.visible = false;
            return;
        }

        this._profiles = profiles;
    }

    _syncPowerMode() {
        if (!this._menuBuilt)
            return;

        const profiles = this._profiles?.get_cached_property('Profiles')?.deepUnpack() ?? [];
        const active = this._profiles?.get_cached_property('ActiveProfile')?.unpack() ?? '';

        this._segment.remove_all_children();

        for (const entry of profiles) {
            const name = unpackProperty(entry.Profile);
            if (!name)
                continue;

            const isActive = name === active;
            const button = this._createPowerProfileRow(name,
                this._gettext(POWER_PROFILE_LABELS[name] ?? name), isActive);
            button.connectObject('clicked', () => {
                // A selected mode is a choice, not a toggle that can be left
                // with no power profile selected.
                if (isActive && !button.checked)
                    button.checked = true;
                this._setPowerProfile(name);
            }, this);

            this._segment.add_child(button);
        }

        const available = this._segment.get_n_children() > 0;
        this._powerTitle.visible = available;
        this._segment.visible = available;
    }

    _createPowerProfileRow(name, label, active) {
        const button = new St.Button({
            style_class: 'cc-power-mode-row',
            can_focus: true,
            reactive: true,
            track_hover: true,
            toggle_mode: true,
            checked: active,
            x_expand: true,
            accessible_name: label,
        });
        const content = new St.BoxLayout({
            style_class: 'cc-power-mode-content',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
        });
        const badge = new St.Bin({
            style_class: 'cc-power-mode-icon-badge',
            child: new St.Icon({
                icon_name: POWER_PROFILE_ICONS[name] ?? 'battery-symbolic',
                style_class: 'cc-power-mode-icon',
            }),
        });
        const title = new St.Label({
            text: label,
            style_class: 'cc-power-mode-label',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        });
        const check = new St.Icon({
            icon_name: 'object-select-symbolic',
            style_class: 'cc-power-mode-check',
            visible: active,
        });
        button.connectObject('notify::checked', () => {
            check.visible = button.checked;
        }, this);
        content.add_child(badge);
        content.add_child(title);
        content.add_child(check);
        button.set_child(content);
        addPressFeedback(button);
        return button;
    }

    /** @param {string} name a power-profiles-daemon profile name */
    _setPowerProfile(name) {
        setDBusProperty(this._profiles, POWER_PROFILES_IFACE, 'ActiveProfile',
            new GLib.Variant('s', name));
    }

}
