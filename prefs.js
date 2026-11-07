// SPDX-License-Identifier: MIT
//
// Settings window: panel clock, appearance profiles and Liquid Glass surfaces.
// Appearance choices are read from the installed XDG theme directories.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const GLASS_SCHEMA = 'org.gnome.shell.extensions.macos-control-center.glass';
const USER_THEME_SCHEMA = 'org.gnome.shell.extensions.user-theme';

function hasDirectory(path) {
    return Gio.File.new_for_path(path).query_file_type(
        Gio.FileQueryInfoFlags.NONE, null) === Gio.FileType.DIRECTORY;
}

function themeLooksUsable(path, type) {
    switch (type) {
    case 'shell':
        return Gio.File.new_for_path(`${path}/gnome-shell/gnome-shell.css`).query_exists(null);
    case 'gtk':
        return Gio.File.new_for_path(`${path}/gtk-3.0/gtk.css`).query_exists(null) ||
            Gio.File.new_for_path(`${path}/gtk-4.0/gtk.css`).query_exists(null);
    case 'icons':
        return Gio.File.new_for_path(`${path}/index.theme`).query_exists(null);
    case 'cursor':
        return hasDirectory(`${path}/cursors`);
    default:
        return false;
    }
}

function installedThemes(type) {
    const home = GLib.get_home_dir();
    const folder = type === 'gtk' || type === 'shell' ? 'themes' : 'icons';
    const roots = new Set([
        ...GLib.get_system_data_dirs().map(path => `${path}/${folder}`),
        `${GLib.get_user_data_dir()}/${folder}`,
        ...(folder === 'themes' ? [`${home}/.themes`] : [`${home}/.icons`]),
    ]);

    const names = new Set();
    for (const root of roots) {
        const directory = Gio.File.new_for_path(root);
        let enumerator;
        try {
            enumerator = directory.enumerate_children('standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE, null);
        } catch {
            continue;
        }

        try {
            let info;
            while ((info = enumerator.next_file(null))) {
                if (info.get_file_type() !== Gio.FileType.DIRECTORY)
                    continue;
                const name = info.get_name();
                if (themeLooksUsable(`${root}/${name}`, type))
                    names.add(name);
            }
        } catch {
            // Ignore a theme folder that disappeared or became unreadable
            // while the preferences page was being populated.
        } finally {
            enumerator.close(null);
        }
    }
    return [...names].sort((a, b) => a.localeCompare(b));
}

function optionalSettings(schemaId) {
    const schema = Gio.SettingsSchemaSource.get_default()?.lookup(schemaId, true);
    return schema ? new Gio.Settings({settings_schema: schema}) : null;
}

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

        const panelItemsGroup = new Adw.PreferencesGroup({
            title: _('Panel items'),
            description: _('Choose which controls appear in the top panel. Battery is shown only when a battery is detected.'),
        });
        const addPanelSwitch = (key, title, subtitle) => {
            const row = new Adw.SwitchRow({
                title,
                subtitle,
                active: clockSettings.get_boolean(key),
            });
            row.connect('notify::active', () =>
                clockSettings.set_boolean(key, row.active));
            clockSettings.connect(`changed::${key}`, () => {
                row.active = clockSettings.get_boolean(key);
            });
            panelItemsGroup.add(row);
        };
        addPanelSwitch('show-panel-control-center', _('Control Center'), _('Open Control Center from the panel'));
        addPanelSwitch('show-panel-spotlight', _('Spotlight'), _('Open Spotlight search from the panel'));
        addPanelSwitch('show-panel-wifi', _('Wi-Fi'), _('Open Wi-Fi controls and nearby networks'));
        addPanelSwitch('show-panel-bluetooth', _('Bluetooth'), _('Open Bluetooth controls and nearby devices'));
        addPanelSwitch('show-panel-battery', _('Battery'), _('Open battery status and power modes'));
        panelPage.add(panelItemsGroup);
        window.add(panelPage);

        // --- light and dark appearance ---------------------------------------
        const appearancePage = new Adw.PreferencesPage({
            title: _('Appearance'),
            icon_name: 'preferences-desktop-theme-symbolic',
        });
        window.add(appearancePage);

        const shellSettings = optionalSettings(USER_THEME_SCHEMA);
        const shellThemeAvailable = Boolean(shellSettings?.settings_schema.has_key('name'));
        const themeLists = {
            shell: installedThemes('shell'),
            gtk: installedThemes('gtk'),
            icons: installedThemes('icons'),
            cursor: installedThemes('cursor'),
        };

        const addThemeChoice = (group, title, key, themes, available = true) => {
            const names = [...themes];
            const chosen = clockSettings.get_string(key);
            if (chosen && !names.includes(chosen))
                names.unshift(chosen);
            const values = ['', ...names];
            const row = new Adw.ComboRow({
                title,
                subtitle: available
                    ? _('Choose a theme installed on this computer')
                    : _('Enable the GNOME User Themes extension to select this'),
                model: Gtk.StringList.new([_('Keep system setting'), ...names]),
                selected: Math.max(0, values.indexOf(chosen)),
                sensitive: available,
            });
            row.connect('notify::selected', () => {
                clockSettings.set_string(key, values[row.selected] ?? '');
            });
            clockSettings.connect(`changed::${key}`, () => {
                const current = clockSettings.get_string(key);
                const selected = values.indexOf(current);
                if (selected >= 0 && row.selected !== selected)
                    row.selected = selected;
            });
            group.add(row);
        };

        const addWallpaperChoice = (group, mode, title) => {
            const key = `${mode}-wallpaper`;
            const row = new Adw.ActionRow({
                title,
                subtitle: _('Use the desktop wallpaper unless you choose an image'),
            });
            const updateSubtitle = () => {
                const uri = clockSettings.get_string(key);
                if (!uri) {
                    row.subtitle = _('Use the desktop wallpaper unless you choose an image');
                    return;
                }
                try {
                    row.subtitle = Gio.File.new_for_uri(uri).get_basename() ?? uri;
                } catch {
                    row.subtitle = uri;
                }
            };

            const choose = new Gtk.Button({
                label: _('Browse Files…'),
                valign: Gtk.Align.CENTER,
            });
            choose.connect('clicked', () => {
                const chooser = new Gtk.FileDialog({
                    title: mode === 'dark' ? _('Choose dark wallpaper') : _('Choose light wallpaper'),
                    accept_label: _('Select'),
                    modal: true,
                });
                const filter = new Gtk.FileFilter();
                filter.set_name(_('Images'));
                filter.add_mime_type('image/*');
                const filters = Gio.ListStore.new(Gtk.FileFilter);
                filters.append(filter);
                chooser.set_filters(filters);
                chooser.set_default_filter(filter);
                chooser.open(window, null, (dialog, result) => {
                    try {
                        const file = dialog.open_finish(result);
                        if (file)
                            clockSettings.set_string(key, file.get_uri());
                    } catch (error) {
                        // Dismissing the system file picker is a normal cancel.
                        if (error.code !== Gtk.DialogError.DISMISSED)
                            console.warn(`Could not choose wallpaper: ${error.message}`);
                    }
                });
            });

            const clear = new Gtk.Button({
                icon_name: 'edit-clear-symbolic',
                tooltip_text: _('Use current desktop wallpaper'),
                valign: Gtk.Align.CENTER,
            });
            clear.connect('clicked', () => clockSettings.set_string(key, ''));
            clockSettings.connect(`changed::${key}`, updateSubtitle);
            row.add_suffix(choose);
            row.add_suffix(clear);
            row.activatable_widget = choose;
            updateSubtitle();
            group.add(row);
        };

        const lightAppearance = new Adw.PreferencesGroup({
            title: _('Light mode'),
            description: _('Themes and wallpaper used when Dark Mode is off.'),
        });
        addThemeChoice(lightAppearance, _('GNOME Shell theme'), 'light-shell-theme',
            themeLists.shell, shellThemeAvailable);
        addThemeChoice(lightAppearance, _('Applications theme'), 'light-gtk-theme', themeLists.gtk);
        addThemeChoice(lightAppearance, _('Icon theme'), 'light-icon-theme', themeLists.icons);
        addThemeChoice(lightAppearance, _('Pointer theme'), 'light-cursor-theme', themeLists.cursor);
        addWallpaperChoice(lightAppearance, 'light', _('Wallpaper'));
        appearancePage.add(lightAppearance);

        const darkAppearance = new Adw.PreferencesGroup({
            title: _('Dark mode'),
            description: _('Themes and wallpaper used when Dark Mode is on.'),
        });
        addThemeChoice(darkAppearance, _('GNOME Shell theme'), 'dark-shell-theme',
            themeLists.shell, shellThemeAvailable);
        addThemeChoice(darkAppearance, _('Applications theme'), 'dark-gtk-theme', themeLists.gtk);
        addThemeChoice(darkAppearance, _('Icon theme'), 'dark-icon-theme', themeLists.icons);
        addThemeChoice(darkAppearance, _('Pointer theme'), 'dark-cursor-theme', themeLists.cursor);
        addWallpaperChoice(darkAppearance, 'dark', _('Wallpaper'));
        appearancePage.add(darkAppearance);

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
            description: _('Glass behind the dock. Dash to Dock, the Ubuntu Dock, Dash2Dock Animated and Glide Dock are recognised on their own; any other dock is picked up when it has a background actor. Without a dock these do nothing.'),
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
