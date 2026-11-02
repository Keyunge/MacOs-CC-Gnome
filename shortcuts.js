// SPDX-License-Identifier: MIT
// Small owner for a user-configurable Mutter global accelerator.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const WM_SCHEMA = 'org.gnome.desktop.wm.keybindings';
const WM_KEY = 'activate-window-menu';
const ALT_SPACE = '<Alt>space';

export class GlobalShortcut {
    #action = Meta.KeyBindingAction.NONE;
    #signalId = 0;
    #retryId = 0;
    #accelerator = '';
    #activate;
    #savedWindowMenu = null;

    constructor(accelerator, activate) {
        this.#activate = activate;
        this.setAccelerator(accelerator);
    }

    setAccelerator(accelerator) {
        const normalized = accelerator?.trim() ?? '';
        if (normalized === this.#accelerator)
            return;

        this.#release();
        this.#restoreWindowMenu();
        this.#accelerator = normalized;
        if (!normalized)
            return;

        if (normalized.toLowerCase() === ALT_SPACE.toLowerCase())
            this.#freeWindowMenu();
        this.#grab(0);
    }

    #freeWindowMenu() {
        try {
            const settings = new Gio.Settings({schema_id: WM_SCHEMA});
            const current = settings.get_strv(WM_KEY);
            const wanted = ALT_SPACE.toLowerCase();
            if (!current.some(value => value.toLowerCase() === wanted))
                return;

            this.#savedWindowMenu = {settings, original: settings.get_user_value(WM_KEY)};
            settings.set_strv(WM_KEY,
                current.filter(value => value.toLowerCase() !== wanted));
            Gio.Settings.sync();
        } catch (e) {
            console.warn(`[macos-control-center] could not free ${ALT_SPACE}: ${e.message}`);
        }
    }

    #restoreWindowMenu() {
        const saved = this.#savedWindowMenu;
        this.#savedWindowMenu = null;
        if (!saved)
            return;

        try {
            if (saved.original)
                saved.settings.set_value(WM_KEY, saved.original);
            else
                saved.settings.reset(WM_KEY);
            Gio.Settings.sync();
        } catch (e) {
            console.warn(`[macos-control-center] could not restore ${ALT_SPACE}: ${e.message}`);
        }
    }

    #grab(attempt) {
        try {
            const action = global.display.grab_accelerator(
                this.#accelerator, Meta.KeyBindingFlags.NONE);
            if (action === Meta.KeyBindingAction.NONE) {
                if (attempt < 12) {
                    this.#retryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                        this.#retryId = 0;
                        this.#grab(attempt + 1);
                        return GLib.SOURCE_REMOVE;
                    });
                } else {
                    console.warn(`[macos-control-center] ${this.#accelerator} is already in use; shortcut disabled`);
                }
                return;
            }

            this.#action = action;
            Main.wm.allowKeybinding(Meta.external_binding_name_for_action(action),
                Shell.ActionMode.ALL);
            this.#signalId = global.display.connect('accelerator-activated',
                (_display, activated) => {
                    if (activated === this.#action)
                        this.#activate?.();
                });
        } catch (e) {
            console.warn(`[macos-control-center] could not grab ${this.#accelerator}: ${e.message}`);
        }
    }

    #release() {
        if (this.#retryId) {
            GLib.source_remove(this.#retryId);
            this.#retryId = 0;
        }
        if (this.#signalId) {
            global.display.disconnect(this.#signalId);
            this.#signalId = 0;
        }
        if (this.#action !== Meta.KeyBindingAction.NONE) {
            try {
                global.display.ungrab_accelerator(this.#action);
                Main.wm.allowKeybinding(
                    Meta.external_binding_name_for_action(this.#action), Shell.ActionMode.NONE);
            } catch (e) {
                console.warn(`[macos-control-center] could not release ${this.#accelerator}: ${e.message}`);
            }
            this.#action = Meta.KeyBindingAction.NONE;
        }
    }

    destroy() {
        this.#release();
        this.#restoreWindowMenu();
        this.#activate = null;
        this.#accelerator = '';
    }
}
