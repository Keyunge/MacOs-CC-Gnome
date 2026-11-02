// SPDX-License-Identifier: MIT
//
// Settings window: panel clock format and the look of the Liquid Glass surfaces.
// Glass sliders bind to the glass schema; clock choices update the panel live.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const GLASS_SCHEMA = 'org.gnome.shell.extensions.macos-control-center.glass';

export default class ControlCenterPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const _ = this.gettext.bind(this);

        // --- panel clock ---------------------------------------------------------
        const clockSettings = this.getSettings();
        const clockPage = new Adw.PreferencesPage({
            title: _('Panel Clock'),
            icon_name: 'preferences-system-time-symbolic',
        });
        const clockGroup = new Adw.PreferencesGroup({
            title: _('Date and time format'),
            description: _('Choose the language and 12-hour or 24-hour clock shown in the top panel.'),
        });

        const languageRow = new Adw.ComboRow({
            title: _('Language'),
            model: Gtk.StringList.new([_('English'), _('Spanish')]),
            selected: clockSettings.get_string('clock-language') === 'es' ? 1 : 0,
        });
        languageRow.connect('notify::selected', () => {
            clockSettings.set_string('clock-language', languageRow.selected === 1 ? 'es' : 'en');
        });
        clockSettings.connect('changed::clock-language', () => {
            languageRow.selected = clockSettings.get_string('clock-language') === 'es' ? 1 : 0;
        });
        clockGroup.add(languageRow);

        const timeFormatRow = new Adw.ComboRow({
            title: _('Time format'),
            model: Gtk.StringList.new([_('12-hour (AM/PM)'), _('24-hour')]),
            selected: clockSettings.get_string('clock-time-format') === '24h' ? 1 : 0,
        });
        timeFormatRow.connect('notify::selected', () => {
            clockSettings.set_string('clock-time-format', timeFormatRow.selected === 1 ? '24h' : '12h');
        });
        clockSettings.connect('changed::clock-time-format', () => {
            timeFormatRow.selected = clockSettings.get_string('clock-time-format') === '24h' ? 1 : 0;
        });
        clockGroup.add(timeFormatRow);
        clockPage.add(clockGroup);
        window.add(clockPage);
        window._clockSettings = clockSettings;

        // --- panel icon sizing and spacing -------------------------------------
        const panelPage = new Adw.PreferencesPage({
            title: _('Panel'),
            icon_name: 'view-grid-symbolic',
        });
        const panelGroup = new Adw.PreferencesGroup({
            title: _('Panel icons'),
            description: _('Set icon size and spacing together. Values scale automatically with the panel height.'),
        });
        const addPanelSpinRow = (key, title, subtitle, lower, upper) => {
            const adjustment = new Gtk.Adjustment({
                lower,
                upper,
                step_increment: 1,
                page_increment: 2,
                value: clockSettings.get_int(key),
            });
            const row = new Adw.SpinRow({title, subtitle, adjustment});
            row.connect('notify::value', () => clockSettings.set_int(key, Math.round(row.value)));
            clockSettings.connect(`changed::${key}`, () => {
                const value = clockSettings.get_int(key);
                if (Math.round(row.value) !== value)
                    row.value = value;
            });
            panelGroup.add(row);
        };
        addPanelSpinRow('panel-icon-size', _('Icon size'), _('Base size in logical pixels'), 14, 26);
        addPanelSpinRow('panel-icon-spacing', _('Icon spacing'), _('Space around each icon in logical pixels'), 3, 16);

        panelPage.add(panelGroup);
        window.add(panelPage);

        // --- global keyboard shortcuts ----------------------------------------
        const shortcutPage = new Adw.PreferencesPage({
            title: _('Shortcuts'),
            icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
        });
        const shortcutGroup = new Adw.PreferencesGroup({
            title: _('Keyboard shortcuts'),
            description: _('Click a shortcut field and press the key combination you want. These shortcuts work anywhere in GNOME.'),
        });

        const addShortcutRow = (key, title, subtitle) => {
            const row = new Adw.ActionRow({title, subtitle});
            const [initialValid, initialKeyval, initialModifiers] =
                Gtk.accelerator_parse(clockSettings.get_string(key));
            const entry = new Gtk.Entry({
                editable: false,
                can_focus: true,
                width_chars: 16,
                halign: Gtk.Align.END,
                valign: Gtk.Align.CENTER,
                placeholder_text: _('Click and press keys'),
                text: initialValid
                    ? Gtk.accelerator_get_label(initialKeyval, initialModifiers)
                    : '',
            });
            const controller = new Gtk.EventControllerKey();
            controller.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
            controller.connect('key-pressed', (_controller, keyval, _keycode, state) => {
                if (keyval === Gdk.KEY_Escape)
                    return true;

                if (keyval === Gdk.KEY_BackSpace || keyval === Gdk.KEY_Delete) {
                    clockSettings.set_string(key, '');
                    entry.text = '';
                    return true;
                }

                const modifiers = state & Gtk.accelerator_get_default_mod_mask();
                if (!Gtk.accelerator_valid(keyval, modifiers))
                    return true;

                const accelerator = Gtk.accelerator_name(keyval, modifiers);
                clockSettings.set_string(key, accelerator);
                entry.text = Gtk.accelerator_get_label(keyval, modifiers);
                return true;
            });
            entry.add_controller(controller);
            clockSettings.connect(`changed::${key}`, () => {
                const [valid, keyval, modifiers] =
                    Gtk.accelerator_parse(clockSettings.get_string(key));
                entry.text = valid ? Gtk.accelerator_get_label(keyval, modifiers) : '';
            });

            const clearButton = new Gtk.Button({
                icon_name: 'edit-clear-symbolic',
                tooltip_text: _('Disable shortcut'),
                valign: Gtk.Align.CENTER,
            });
            clearButton.connect('clicked', () => {
                clockSettings.set_string(key, '');
                entry.text = '';
            });
            row.add_suffix(entry);
            row.add_suffix(clearButton);
            row.activatable_widget = entry;
            shortcutGroup.add(row);
        };

        addShortcutRow('spotlight-shortcut', _('Open Spotlight'), _('Default: Alt + Space. Backspace clears the shortcut.'));
        addShortcutRow('control-center-shortcut', _('Open Control Center'), _('Default: Super + C. Backspace clears the shortcut.'));
        shortcutPage.add(shortcutGroup);
        window.add(shortcutPage);

        let settings;
        try {
            settings = this.getSettings(GLASS_SCHEMA);
        } catch (e) {
            // The schema is compiled by `make install`; without it there is nothing to bind.
            const page = new Adw.PreferencesPage({title: _('Liquid Glass')});
            const group = new Adw.PreferencesGroup({
                title: _('The glass settings are not installed'),
                description: _('Run "make install" in the extension\'s folder, which compiles the settings schema, then log out and back in.'),
            });
            page.add(group);
            window.add(page);
            return;
        }

        const page = new Adw.PreferencesPage({
            title: _('Liquid Glass'),
            icon_name: 'preferences-desktop-appearance-symbolic',
        });
        window.add(page);

        /**
         * @param {Adw.PreferencesGroup} group
         * @param {string} title
         * @param {string} subtitle
         * @param {string} key
         * @param {number} lower
         * @param {number} upper
         * @param {number} step
         * @param {number} digits
         */
        const addSlider = (group, title, subtitle, key, lower, upper, step, digits) => {
            const row = new Adw.ActionRow({title, subtitle});
            const scale = new Gtk.Scale({
                orientation: Gtk.Orientation.HORIZONTAL,
                adjustment: new Gtk.Adjustment({
                    lower,
                    upper,
                    step_increment: step,
                    page_increment: step * 5,
                }),
                digits,
                draw_value: true,
                value_pos: Gtk.PositionType.RIGHT,
                hexpand: true,
                width_request: 280,
                valign: Gtk.Align.CENTER,
            });
            settings.bind(key, scale.get_adjustment(), 'value', Gio.SettingsBindFlags.DEFAULT);

            row.add_suffix(scale);
            row.activatable_widget = scale;
            group.add(row);
        };

        // --- the control centre and its menus ----------------------------------
        const menus = new Adw.PreferencesGroup({
            title: _('Control Center and menus'),
            description: _('The glass behind the control centre and the Wi-Fi, Bluetooth and battery menus.'),
        });
        addSlider(menus, _('Blur'), _('How strongly the backdrop is blurred'),
            'menu-blur', 1, 40, 1, 0);
        addSlider(menus, _('Tint'), _('How much of the glass colour is mixed in'),
            'menu-tint', 0, 1, 0.01, 2);
        addSlider(menus, _('Brightness'), _('Below 1 darkens the backdrop, above 1 brightens it'),
            'menu-brightness', 0.5, 1.5, 0.01, 2);
        addSlider(menus, _('Saturation'), _('Above 1 makes the colours richer'),
            'menu-saturation', 0, 2.5, 0.05, 2);
        page.add(menus);

        // --- spotlight -----------------------------------------------------------
        const spotlight = new Adw.PreferencesGroup({
            title: _('Spotlight'),
            description: _('Spotlight uses dark text, so keep its glass fairly light.'),
        });
        addSlider(spotlight, _('Blur'), _('How strongly the backdrop is blurred'),
            'spot-blur', 1, 40, 1, 0);
        addSlider(spotlight, _('Tint'), _('How much white is mixed in'),
            'spot-tint', 0, 1, 0.01, 2);
        addSlider(spotlight, _('Brightness'), _('Below 1 darkens the backdrop, above 1 brightens it'),
            'spot-brightness', 0.5, 1.5, 0.01, 2);
        addSlider(spotlight, _('Saturation'), _('Above 1 makes the colours richer'),
            'spot-saturation', 0, 2.5, 0.05, 2);
        page.add(spotlight);

        // --- the dock -----------------------------------------------------------------
        const dock = new Adw.PreferencesGroup({
            title: _('Dock'),
            description: _('Glass behind Dash to Dock or the Ubuntu Dock. Without one of them these do nothing.'),
        });
        const dockSwitch = new Adw.SwitchRow({title: _('Glass on the dock')});
        settings.bind('dock-glass', dockSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        dock.add(dockSwitch);
        addSlider(dock, _('Blur'), _('How strongly the backdrop is blurred'),
            'dock-blur', 1, 40, 1, 0);
        addSlider(dock, _('Tint'), _('How much white is mixed in'),
            'dock-tint', 0, 1, 0.01, 2);
        addSlider(dock, _('Brightness'), _('Below 1 darkens the backdrop, above 1 brightens it'),
            'dock-brightness', 0.5, 1.5, 0.01, 2);
        addSlider(dock, _('Saturation'), _('Above 1 makes the colours richer'),
            'dock-saturation', 0, 2.5, 0.05, 2);
        addSlider(dock, _('Corner radius'), _('In pixels'),
            'dock-corner', 0, 60, 1, 0);
        page.add(dock);

        // --- shared ------------------------------------------------------------------
        const shape = new Adw.PreferencesGroup({title: _('Shape')});
        addSlider(shape, _('Corner smoothing'),
            _('0 is a plain circular corner; towards 1 the corner becomes a continuous curve, as on macOS'),
            'corner-smoothing', 0, 1, 0.01, 2);
        page.add(shape);

        // --- reset ---------------------------------------------------------------------
        const reset = new Adw.PreferencesGroup();
        const resetRow = new Adw.ActionRow({title: _('Restore the defaults')});
        const resetButton = new Gtk.Button({
            label: _('Reset'),
            valign: Gtk.Align.CENTER,
        });
        resetButton.add_css_class('destructive-action');
        resetButton.connect('clicked', () => {
            for (const key of settings.settings_schema.list_keys())
                settings.reset(key);
        });
        resetRow.add_suffix(resetButton);
        reset.add(resetRow);
        page.add(reset);

        // The window keeps the settings alive for as long as it is open.
        window._glassSettings = settings;
    }
}
