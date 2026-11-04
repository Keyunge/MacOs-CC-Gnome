// SPDX-License-Identifier: MIT

import Gio from 'gi://Gio';

const INTERFACE_SCHEMA = 'org.gnome.desktop.interface';
const BACKGROUND_SCHEMA = 'org.gnome.desktop.background';
const USER_THEME_SCHEMA = 'org.gnome.shell.extensions.user-theme';

function optionalSettings(schemaId) {
    const source = Gio.SettingsSchemaSource.get_default();
    const schema = source?.lookup(schemaId, true);
    return schema ? new Gio.Settings({settings_schema: schema}) : null;
}

/** Applies the user's selected light/dark appearance alongside GNOME's scheme. */
export class AppearanceController {
    constructor(extension, onModeChanged) {
        this._settings = extension.getSettings();
        this._interface = optionalSettings(INTERFACE_SCHEMA);
        this._background = optionalSettings(BACKGROUND_SCHEMA);
        this._shellTheme = optionalSettings(USER_THEME_SCHEMA);
        this._baseline = {
            gtkTheme: this._interface?.settings_schema.has_key('gtk-theme')
                ? this._interface.get_string('gtk-theme') : '',
            iconTheme: this._interface?.settings_schema.has_key('icon-theme')
                ? this._interface.get_string('icon-theme') : '',
            cursorTheme: this._interface?.settings_schema.has_key('cursor-theme')
                ? this._interface.get_string('cursor-theme') : '',
            shellTheme: this._shellTheme?.settings_schema.has_key('name')
                ? this._shellTheme.get_string('name') : '',
            lightWallpaper: this._background?.settings_schema.has_key('picture-uri')
                ? this._background.get_string('picture-uri') : '',
            darkWallpaper: this._background?.settings_schema.has_key('picture-uri-dark')
                ? this._background.get_string('picture-uri-dark') : '',
        };
        this._onModeChanged = onModeChanged;
        this._signalIds = [];
        this._modeSignal = 0;
        this._destroyed = false;

        for (const key of [
            'light-shell-theme', 'dark-shell-theme',
            'light-gtk-theme', 'dark-gtk-theme',
            'light-icon-theme', 'dark-icon-theme',
            'light-cursor-theme', 'dark-cursor-theme',
            'light-wallpaper', 'dark-wallpaper',
        ]) {
            const id = this._settings.connect(`changed::${key}`, () => this._applyCurrent());
            this._signalIds.push(id);
        }

        if (this._interface?.settings_schema.has_key('color-scheme')) {
            this._modeSignal = this._interface.connect('changed::color-scheme',
                () => this._syncMode());
        }

        this._syncMode();
        this._applyCurrent();
    }

    get isDark() {
        return this._interface?.get_string('color-scheme') === 'prefer-dark';
    }

    setDark(dark) {
        if (!this._interface?.settings_schema.has_key('color-scheme')) {
            console.warn('[macos-control-center] GNOME color-scheme setting is unavailable');
            return;
        }

        this._interface.set_string('color-scheme', dark ? 'prefer-dark' : 'prefer-light');
        this._applyCurrent();
    }

    _syncMode() {
        if (this._destroyed)
            return;

        this._onModeChanged?.(this.isDark);
        this._applyCurrent();
    }

    _applyCurrent() {
        if (this._destroyed)
            return;

        const mode = this.isDark ? 'dark' : 'light';
        const applyString = (settings, schema, schemaKey, extensionKey, baseline) => {
            if (!settings?.settings_schema.has_key(schemaKey))
                return;
            const configured = this._settings.get_string(`${mode}-${extensionKey}`);
            const value = configured || baseline;
            if (value && settings.get_string(schemaKey) !== value)
                settings.set_string(schemaKey, value);
        };

        applyString(this._interface, INTERFACE_SCHEMA, 'gtk-theme', 'gtk-theme',
            this._baseline.gtkTheme);
        applyString(this._interface, INTERFACE_SCHEMA, 'icon-theme', 'icon-theme',
            this._baseline.iconTheme);
        applyString(this._interface, INTERFACE_SCHEMA, 'cursor-theme', 'cursor-theme',
            this._baseline.cursorTheme);
        applyString(this._shellTheme, USER_THEME_SCHEMA, 'name', 'shell-theme',
            this._baseline.shellTheme);

        for (const wallpaperMode of ['light', 'dark']) {
            const configured = this._settings.get_string(`${wallpaperMode}-wallpaper`);
            const uri = configured || this._baseline[`${wallpaperMode}Wallpaper`];
            const key = wallpaperMode === 'dark' ? 'picture-uri-dark' : 'picture-uri';
            if (uri && this._background?.settings_schema.has_key(key) &&
                this._background.get_string(key) !== uri)
                this._background.set_string(key, uri);
        }
    }

    destroy() {
        this._destroyed = true;
        for (const id of this._signalIds)
            this._settings.disconnect(id);
        this._signalIds = [];
        if (this._modeSignal && this._interface) {
            this._interface.disconnect(this._modeSignal);
            this._modeSignal = 0;
        }
        this._onModeChanged = null;
        this._settings = null;
        this._interface = null;
        this._background = null;
        this._shellTheme = null;
        this._baseline = null;
    }
}
