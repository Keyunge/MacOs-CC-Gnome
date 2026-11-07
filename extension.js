// SPDX-License-Identifier: MIT
//
// ESM entry point. Everything is injected in enable() and torn down in
// disable(); the panel and the three top-bar glyphs own their own resources
// (proxies, GSettings, Gvc mixer, MPRIS subscription) so that no object
// outlives the extension.
//
// Besides the control centre button this file places the Wi-Fi, Bluetooth and
// battery glyphs, adds a direct Spotlight launcher, and moves the clock to the
// far right. The status glyphs carry dropdowns; their panel-level order lives
// here rather than inside the control centre.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {
    BatteryStatusIndicator,
    BluetoothStatusIndicator,
    ControlCenterPanel,
    WifiStatusIndicator,
} from './controlCenterPanel.js';
import {DockWatcher} from './dockGlass.js';
import {setGlassSettings} from './glassSurface.js';
import {setIconsPath, setPanelIcon} from './icons.js';
import {GlobalShortcut} from './shortcuts.js';
import {Spotlight} from './spotlight.js';

const LIQUID_GLASS_UUID = 'liquid-glass@thinkingcoding1231.gmail.com';
const LIQUID_GLASS_SCHEMA = `org.gnome.shell.extensions.${LIQUID_GLASS_UUID}`;

const SpotlightPanelButton = GObject.registerClass(
class SpotlightPanelButton extends PanelMenu.Button {
    _init({gettext, onActivate}) {
        super._init(0.0, gettext('Spotlight Search'));

        this._onActivate = onActivate;
        // GNOME 50 uses this gesture to open PanelMenu.Button's popup. This
        // button is a direct action, so let our event handler own left-clicks.
        this._clickGesture?.set_enabled(false);

        this.add_style_class_name('cc-panel-button');
        this.add_style_class_name('cc-spotlight-panel-button');
        this._panelIcon = new St.Icon({
            icon_name: 'system-search-symbolic',
            style_class: 'system-status-icon cc-panel-icon cc-spotlight-panel-icon',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._panelIcon);
        this._syncPanelIconTone();
        this._panelStyleSignal = Main.panel.connect('style-changed',
            () => this._syncPanelIconTone());
    }

    _syncPanelIconTone() {
        if (!this._panelIcon)
            return;

        const darkText = Main.panel.has_style_class_name('kiwi-panel-dark-text');
        setPanelIcon(this._panelIcon, 'ext:spotlight-panel', darkText);
    }

    destroy() {
        if (this._panelStyleSignal) {
            Main.panel.disconnect(this._panelStyleSignal);
            this._panelStyleSignal = 0;
        }
        this._panelIcon = null;
        super.destroy();
    }

    vfunc_event(event) {
        const type = event.type();
        if ((type === Clutter.EventType.BUTTON_PRESS &&
             event.get_button() === Clutter.BUTTON_PRIMARY) ||
            type === Clutter.EventType.TOUCH_BEGIN) {
            this._onActivate?.();
            return Clutter.EVENT_STOP;
        }

        // St.Widget has no event vfunc to chain to in recent GNOME Shell.
        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_key_press_event(event) {
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter ||
            key === Clutter.KEY_space) {
            this._onActivate?.();
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }
});

export default class ControlCenterExtension extends Extension {
    #panel = null;
    #indicators = [];
    #clockHome = null;
    #clockDisplay = null;
    #clockObject = null;
    #clockSignalId = 0;
    #clockTimer = 0;
    #clockOriginalText = null;
    #clockSettings = null;
    #clockSettingsSignalIds = [];
    #spotlight = null;
    #shortcutSettings = null;
    #shortcutSettingsSignalIds = [];
    #spotlightShortcut = null;
    #controlCenterShortcut = null;
    #panelItems = new Map();
    #panelSizingIdle = 0;
    #panelSettings = null;
    #docks = null;

    enable() {
        const gettext = this.gettext.bind(this);

        // Where the extension's own icons are, before anything asks for one.
        setIconsPath(this.path);

        // The look of the glass, set in the preferences. Read before any surface is
        // made; a missing schema (not compiled yet) just leaves the defaults.
        try {
            setGlassSettings(this.getSettings('org.gnome.shell.extensions.macos-control-center.glass'));
        } catch (e) {
            console.warn(`macos-control-center: the glass settings are not available: ${e.message}`);
        }

        this.#panel = new ControlCenterPanel(this);

        // Match the reference order while keeping Bluetooth available:
        // battery, Bluetooth, Wi-Fi, Spotlight, Control Center.
        const params = {gettext, path: this.path};
        const glyphs = [
            ['battery', new BatteryStatusIndicator(params)],
            ['bluetooth', new BluetoothStatusIndicator(params)],
            ['wifi', new WifiStatusIndicator(params)],
            ['spotlight', new SpotlightPanelButton({
                gettext,
                onActivate: () => this.#spotlight?.toggle(),
            })],
        ];

        // A stale indicator of an earlier enable would still hold the role, and
        // addToStatusArea() throws on a taken role: hand its place over.
        Main.panel.statusArea[this.uuid]?.destroy();
        Main.panel.addToStatusArea(this.uuid, this.#panel, 0, 'right');
        for (const [name, indicator] of glyphs) {
            // Roles are namespaced by the UUID, so the only realistic holder of
            // one of these names is a stale indicator of an earlier enable that
            // never got its disable().
            const role = `${this.uuid}-${name}`;
            Main.panel.statusArea[role]?.destroy();

            Main.panel.addToStatusArea(role, indicator, 0, 'right');
            this.#indicators.push(indicator);
        }

        const spotlightButton = glyphs.find(([name]) => name === 'spotlight')?.[1];
        this.#panelItems = new Map([
            ['control-center', {button: this.#panel, icon: this.#panel._panelIcon,
                settingKey: 'show-panel-control-center'}],
            ['spotlight', {button: spotlightButton, icon: spotlightButton?._panelIcon,
                settingKey: 'show-panel-spotlight'}],
            ['wifi', {button: glyphs.find(([name]) => name === 'wifi')?.[1],
                icon: glyphs.find(([name]) => name === 'wifi')?.[1]?._icon,
                settingKey: 'show-panel-wifi'}],
            ['bluetooth', {button: glyphs.find(([name]) => name === 'bluetooth')?.[1],
                icon: glyphs.find(([name]) => name === 'bluetooth')?.[1]?._icon,
                settingKey: 'show-panel-bluetooth'}],
            ['battery', {button: glyphs.find(([name]) => name === 'battery')?.[1],
                icon: glyphs.find(([name]) => name === 'battery')?.[1]?._icon,
                settingKey: 'show-panel-battery'}],
        ]);
        this.#setupAdaptivePanelSizing();

        this.#excludeBlurOnlyMenusFromLiquidGlass();
        this.#arrangeStatusArea();
        this.#setupClockFormat();

        // Spotlight is independent of the bar: if it cannot start, the control
        // centre and the glyphs above are unaffected.
        try {
            this.#spotlight = new Spotlight(this);
        } catch (e) {
            console.error(`macos-control-center: Spotlight failed to start: ${e.message}`);
            this.#spotlight = null;
        }

        this.#setupShortcuts();

        // Glass for whatever dock is running, if there is one. Independent of
        // everything above, and silent when there is no dock to find.
        try {
            this.#docks = new DockWatcher(this.path);
            this.#docks.start();
        } catch (e) {
            console.error(`macos-control-center: dock glass failed to start: ${e.message}`);
            this.#docks = null;
        }

        // The Shell moves the clock back to the centre box on every session
        // mode change (lock, unlock, login screen), so the arrangement has to
        // be re-applied. #arrangeStatusArea() itself ignores those modes.
        Main.sessionMode.connectObject('updated',
            () => this.#arrangeStatusArea(),
            this);
    }

    disable() {
        Main.sessionMode.disconnectObject(this);

        this.#docks?.stop();
        this.#docks = null;

        this.#spotlight?.destroy();
        this.#spotlight = null;

        this.#clearShortcuts();
        this.#clearAdaptivePanelSizing();

        this.#removeClockFormat();
        this.#restoreClock();

        for (const indicator of this.#indicators)
            indicator.destroy();
        this.#indicators = [];

        // PanelMenu.Button.destroy() destroys the button and its container,
        // which is what removes it from the status area.
        this.#panel?.destroy();
        this.#panel = null;

        // Last: every surface above has let go of the settings by now.
        setGlassSettings(null);
        setIconsPath(null);
    }

    #setupShortcuts() {
        try {
            this.#shortcutSettings = this.getSettings();
            this.#spotlightShortcut = new GlobalShortcut(
                this.#shortcutSettings.get_string('spotlight-shortcut'),
                () => this.#spotlight?.toggle());
            this.#controlCenterShortcut = new GlobalShortcut(
                this.#shortcutSettings.get_string('control-center-shortcut'),
                () => {
                    const menu = this.#panel?.menu;
                    if (menu)
                        menu.toggle();
                    else
                        console.warn('macos-control-center: shortcut fired before the control center menu was ready');
                });

            this.#shortcutSettingsSignalIds = [
                this.#shortcutSettings.connect('changed::spotlight-shortcut', () =>
                    this.#spotlightShortcut?.setAccelerator(
                        this.#shortcutSettings.get_string('spotlight-shortcut'))),
                this.#shortcutSettings.connect('changed::control-center-shortcut', () =>
                    this.#controlCenterShortcut?.setAccelerator(
                        this.#shortcutSettings.get_string('control-center-shortcut'))),
            ];
        } catch (e) {
            console.warn(`macos-control-center: configurable shortcuts are unavailable: ${e.message}`);
            this.#clearShortcuts();
        }
    }

    #clearShortcuts() {
        if (this.#shortcutSettings) {
            for (const id of this.#shortcutSettingsSignalIds)
                this.#shortcutSettings.disconnect(id);
        }
        this.#shortcutSettingsSignalIds = [];
        this.#spotlightShortcut?.destroy();
        this.#spotlightShortcut = null;
        this.#controlCenterShortcut?.destroy();
        this.#controlCenterShortcut = null;
        this.#shortcutSettings = null;
    }

    #setupAdaptivePanelSizing() {
        this.#panelSettings = this.getSettings();
        this.#panelSettings.connectObject('changed::panel-icon-size',
            () => this.#scheduleAdaptivePanelSizing(), this);
        this.#panelSettings.connectObject('changed::panel-icon-spacing',
            () => this.#scheduleAdaptivePanelSizing(), this);
        for (const key of [
            'show-panel-control-center', 'show-panel-spotlight', 'show-panel-wifi',
            'show-panel-bluetooth', 'show-panel-battery',
        ]) {
            this.#panelSettings.connectObject(`changed::${key}`,
                () => this.#scheduleAdaptivePanelSizing(), this);
        }
        Main.panel.connectObject('notify::height',
            () => this.#scheduleAdaptivePanelSizing(), this);
        Main.panel.connectObject('style-changed',
            () => this.#scheduleAdaptivePanelSizing(), this);
        Main.layoutManager.connectObject('monitors-changed',
            () => this.#scheduleAdaptivePanelSizing(), this);
        this.#scheduleAdaptivePanelSizing();
    }

    #scheduleAdaptivePanelSizing() {
        if (this.#panelSizingIdle)
            return;

        this.#panelSizingIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this.#panelSizingIdle = 0;
            this.#applyAdaptivePanelSizing();
            return GLib.SOURCE_REMOVE;
        });
    }

    #applyAdaptivePanelSizing() {
        // Use GNOME's logical panel height, so the icons follow panel themes,
        // monitor scale factors and screen-size changes without per-device values.
        const panelHeight = Main.panel.height || Main.panel.get_height() || 40;
        const scale = Math.max(0.75, Math.min(1.4, panelHeight / 32));
        const iconSize = Math.max(16, Math.min(26,
            Math.round(this.#panelSettings.get_int('panel-icon-size') * scale)));
        // Spotlight and Control Center are the two primary actions in the bar.
        // Keep them matched and slightly larger than the connectivity glyphs.
        const primaryIconSize = Math.min(32, Math.round(iconSize * 1.2),
            Math.max(iconSize, Math.round(panelHeight * 0.84)));
        const spotlightSize = Math.max(iconSize,
            Math.round(primaryIconSize * 0.9));
        // Keep the battery's visible artwork close to macOS proportions: a
        // 22–23px-wide body, about 12px tall, centered in its own panel slot.
        const batterySize = Math.max(23, Math.min(24, Math.round(iconSize * 1.4)));
        // Keep St.Icon's image canvas square and un-clipped; the PNG artwork
        // itself has a horizontal silhouette that renders about 22–23×12px.
        const batteryHeight = batterySize;
        // The preference is the gap between icons; PanelMenu.Button applies
        // padding on both sides, so divide it across the two adjacent buttons.
        const horizontalPadding = Math.max(3, Math.min(8,
            Math.round(this.#panelSettings.get_int('panel-icon-spacing') / 2)));
        // Give the horizontal battery glyph a wider menu-bar slot. Its icon
        // canvas remains square so the artwork stays crisp and unclipped.
        const batteryPadding = Math.max(horizontalPadding,
            Math.min(12, Math.round(10 * scale)));
        const batterySeparator = Math.max(10, Math.min(23, Math.round(16 * scale)));

        for (const [id, {button, icon, settingKey}] of this.#panelItems) {
            if (!button || !icon)
                continue;

            const enabled = this.#panelSettings.get_boolean(settingKey);
            if (typeof button.setPanelEnabled === 'function')
                button.setPanelEnabled(enabled);
            else
                button.container.visible = enabled;

            const size = id === 'battery' ? batterySize
                : id === 'control-center' ? primaryIconSize
                    : id === 'spotlight' ? spotlightSize : iconSize;
            // Bluetooth's mark is narrower and lighter than Wi-Fi. A modest
            // optical correction and the extension's slightly heavier glyph
            // keep it legible while following the panel's adaptive size.
            const glyphSize = id === 'bluetooth'
                ? Math.min(30, Math.round(size * 1.20)) : size;
            const height = id === 'battery' ? batteryHeight : glyphSize;
            const leftMargin = id === 'battery' ? batterySeparator : 0;
            const itemPadding = id === 'battery' ? batteryPadding : horizontalPadding;
            icon.set_style(`width: ${glyphSize}px; height: ${height}px; icon-size: ${glyphSize}px; padding: 0; margin: 0;`);
            button.set_style(`-natural-hpadding: ${itemPadding}px; -minimum-hpadding: ${itemPadding}px; padding: 0; margin-left: ${leftMargin}px;`);
        }
    }

    #clearAdaptivePanelSizing() {
        Main.panel.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this.#panelSettings?.disconnectObject(this);
        this.#panelSettings = null;
        if (this.#panelSizingIdle) {
            GLib.source_remove(this.#panelSizingIdle);
            this.#panelSizingIdle = 0;
        }
        this.#panelItems.clear();
    }

    /**
     * Liquid Glass also discovers every panel dropdown. Keep our conventional
     * blurred status menus out of its list so those three popovers retain one
     * lightweight blur sheet instead of being layered with the glass renderer.
     */
    #excludeBlurOnlyMenusFromLiquidGlass() {
        try {
            const extensionPaths = [GLib.get_user_data_dir(), ...GLib.get_system_data_dirs()]
                .map(dataDir => GLib.build_filenamev([
                    dataDir, 'gnome-shell', 'extensions', LIQUID_GLASS_UUID,
                ]));
            let schema = null;

            for (const extensionPath of extensionPaths) {
                const schemaDir = GLib.build_filenamev([extensionPath, 'schemas']);
                if (!Gio.File.new_for_path(schemaDir).query_exists(null))
                    continue;

                const schemaSource = Gio.SettingsSchemaSource.new_from_directory(
                    schemaDir, Gio.SettingsSchemaSource.get_default(), false);
                schema = schemaSource.lookup(LIQUID_GLASS_SCHEMA, false);
                if (schema)
                    break;
            }

            if (!schema?.has_key('disabled-extra-menus'))
                return;

            const settings = new Gio.Settings({settings_schema: schema});
            const disabled = new Set(settings.get_strv('disabled-extra-menus'));
            const names = [
                `${this.uuid}-wifi`,
                `${this.uuid}-battery`,
                `${this.uuid}-bluetooth`,
            ];
            for (const name of names)
                disabled.add(name);

            settings.set_strv('disabled-extra-menus', [...disabled].sort());
        } catch (e) {
            console.warn(`macos-control-center: could not opt Wi-Fi and battery menus out of Liquid Glass: ${e.message}`);
        }
    }

    /**
     * The status area lays its items out in insertion order, so the arrangement
     * of the reference is a matter of appending: battery, Bluetooth, Wi-Fi,
     * Spotlight, control centre, then the clock at the far right.
     *
     * Only the normal session is arranged. The lock screen and the login screen
     * have their own panel layout (and no glyphs of ours), and the Shell
     * rebuilds theirs on every mode change anyway.
     */
    #arrangeStatusArea() {
        if (!Main.sessionMode?.isPrimary)
            return;

        const rightBox = Main.panel._rightBox;
        const clock = Main.panel.statusArea.dateMenu?.container ?? null;

        if (!rightBox)
            return;

        // Where the clock came from, so disable() can hand it back. Clutter has
        // no index getter, so the index comes from the parent's children.
        if (clock && !this.#clockHome) {
            const home = clock.get_parent();
            if (home)
                this.#clockHome = [home, home.get_children().indexOf(clock)];
        }

        const group = [
            ...this.#indicators.map(indicator => indicator.container),
            this.#panel?.container,
            clock,
        ];

        for (const actor of group) {
            if (!actor)
                continue;

            // A reparent has to go through remove_child(), and appending in this
            // order is what establishes the arrangement.
            actor.get_parent()?.remove_child(actor);
            rightBox.add_child(actor);
        }
    }

    /** Gives the clock back to the box it was in before the first arrange. */
    #restoreClock() {
        const clock = Main.panel.statusArea.dateMenu?.container;
        const home = this.#clockHome;
        this.#clockHome = null;

        if (!clock || !home)
            return;

        const [box, index] = home;
        if (clock.get_parent() === box)
            return;

        clock.get_parent()?.remove_child(clock);
        box.insert_child_at_index(clock, index);
    }

    /** Apply the selected language and time format to GNOME's existing panel clock. */
    #updateClockFormat() {
        if (!this.#clockDisplay)
            return;

        const now = new Date();
        const language = this.#clockSettings?.get_string('clock-language') ?? 'en';
        const isSpanish = language === 'es';
        const weekdays = isSpanish
            ? ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb']
            : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const months = isSpanish
            ? ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun',
                'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic']
            : ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const hours24 = now.getHours();
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const timeFormat = this.#clockSettings?.get_string('clock-time-format') ?? '12h';
        let time;
        if (timeFormat === '24h') {
            time = `${String(hours24).padStart(2, '0')}:${minutes}`;
        } else {
            const hours12 = hours24 % 12 || 12;
            const period = hours24 < 12 ? 'AM' : 'PM';
            time = `${hours12}:${minutes} ${period}`;
        }

        this.#clockDisplay.text =
            `${weekdays[now.getDay()]} ${months[now.getMonth()]} ${now.getDate()} ${time}`;
    }

    /** Keep GNOME's native date menu and clock actor, changing only its label. */
    #setupClockFormat() {
        const dateMenu = Main.panel.statusArea.dateMenu;
        this.#clockDisplay = dateMenu?._clockDisplay ?? null;

        if (!this.#clockDisplay) {
            console.warn('macos-control-center: could not find GNOME panel clock label');
            return;
        }

        this.#clockOriginalText = this.#clockDisplay.text;
        this.#clockSettings = this.getSettings();
        for (const key of ['clock-language', 'clock-time-format']) {
            const id = this.#clockSettings.connect(`changed::${key}`,
                () => this.#updateClockFormat());
            this.#clockSettingsSignalIds.push(id);
        }

        this.#clockObject = dateMenu?._clock ?? null;
        if (this.#clockObject?.connect) {
            this.#clockSignalId = this.#clockObject.connect('notify::clock',
                () => this.#updateClockFormat());
        }

        this.#updateClockFormat();
        this.#clockTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
            this.#updateClockFormat();
            return GLib.SOURCE_CONTINUE;
        });
    }

    /** Disconnect and let GNOME redraw its normal locale-based clock on disable. */
    #removeClockFormat() {
        if (this.#clockTimer) {
            GLib.Source.remove(this.#clockTimer);
            this.#clockTimer = 0;
        }

        if (this.#clockObject && this.#clockSignalId) {
            this.#clockObject.disconnect(this.#clockSignalId);
            this.#clockSignalId = 0;
        }

        if (this.#clockSettings) {
            for (const id of this.#clockSettingsSignalIds)
                this.#clockSettings.disconnect(id);
            this.#clockSettingsSignalIds = [];
        }

        const dateMenu = Main.panel.statusArea.dateMenu;
        if (this.#clockObject?.notify)
            this.#clockObject.notify('clock');
        else if (this.#clockDisplay && this.#clockOriginalText !== null)
            this.#clockDisplay.text = this.#clockOriginalText;

        this.#clockDisplay = null;
        this.#clockObject = null;
        this.#clockOriginalText = null;
        this.#clockSettings = null;
    }
}
