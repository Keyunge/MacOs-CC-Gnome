// SPDX-License-Identifier: MIT
//
// Spotlight — a macOS 26 style search overlay.
//
// Behaviour (after the real thing)
//   Alt+Space      open / close
//   Alt (held)     reveals four round buttons beside the search capsule
//   Alt+1          Applications: a grid of every app, with category chips
//   Alt+2          Files: recent files
//   Alt+3          Actions: lock, suspend, dark style, ...
//   Alt+4          Clipboard: history since the session started
//   typing         searches (or filters, inside a view); the capsule grows into a
//                  panel as soon as there is something to show
//   Up / Down      move the selection        Enter  open it
//   Tab            next chip                 Backspace on an empty field leaves a view
//   Esc            clears the text, then the chip, then the view, then closes
//
// Where the results come from
// ---------------------------
// GNOME's own search, the one behind the Activities search field, used directly:
//   * applications: Shell.AppSystem.search(), ranked by Shell.AppUsage, exactly as
//     the Shell's application provider does;
//   * everything else (Settings, Files, Calculator, Terminal, Contacts, ...): the
//     D-Bus search providers installed apps ship, loaded by the Shell's own
//     loadRemoteSearchProviders() and filtered by Settings -> Search.
// Providers answer independently and the panel shows each answer as it arrives, so
// one slow provider never holds up the others.
//
// Layout tree (every node carries a style class for CSS targeting):
//
//   .cc-spot-backdrop                    full-monitor modal layer; a click on it closes
//   ├── (the glass surface)              under everything, when the renderer is there
//   └── .cc-spot-column                  everything, laid out top to bottom
//       └── .cc-spot-top                 one row
//           ├── .cc-spot-panel           the capsule; grows into the panel
//           │   ├── .cc-spot-header      glyph, chip token, field, hint, top hit
//           │   └── .cc-spot-body        chips, results or the application grid
//           └── .cc-spot-circle ×4       the views, shown while Alt is held

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {attachBlur, detachBlur} from './blur.js';
import {GlassRim} from './glass.js';
import {iconProps, setIcon} from './icons.js';
import {FrameLoop, glassAvailable, GlassSurface, screenRect} from './glassSurface.js';

const LOG_PREFIX = '[macos-control-center/spotlight]';

// A bright glass, under dark text.
const SPOTLIGHT_GLASS = {
    tint: [1, 1, 1],
    tintStrength: 0.55,
    cornerRadius: 28,
    blurRadius: 14,
    brightness: 1.12,
    saturation: 1.4,
};

// Corner radii of the glass: a capsule when only the field shows, a panel after.
const CAPSULE_RADIUS = 999;
const PANEL_RADIUS = 28;

// How long the glass keeps following after a layout change, ms.
const FOLLOW_MS = 220;

// Fallback blur (no glass renderer).
const BUBBLE_BLUR = {sigma: 26, brightness: 1.06, radius: 'full'};
const PANEL_BLUR = {sigma: 28, brightness: 1.04, radius: 30};

// How often the colour of the text is re-checked against what is behind it, ms.
const ADAPT_INTERVAL_MS = 350;

const SEARCH_DELAY_MS = 80;
const PROVIDER_TIMEOUT_MS = 4000;
const MAX_PER_PROVIDER = 5;
const MAX_RESULTS = 12;
const MAX_LOCAL_RESULTS = 60;
const ROW_ICON_SIZE = 36;
const GRID_ICON_SIZE = 52;
const GRID_COLUMNS = 5;
const RECENT_APPS = 5;

const MAX_RECENT_FILES = 80;

// The home-folder index behind Files: how deep it goes and how much it keeps.
const INDEX_MAX_DEPTH = 5;
const INDEX_MAX_ENTRIES = 40000;
const INDEX_SKIP = new Set(['node_modules', '__pycache__', 'snap', 'Trash', 'venv', 'target', 'build']);
const MAX_FILE_RESULTS = 60;
const MAX_CLIPBOARD_ENTRIES = 50;
const MAX_CLIPBOARD_CHARS = 8000;

const MODE_SEARCH = 'search';
const MODE_APPS = 'apps';
const MODE_FILES = 'files';
const MODE_ACTIONS = 'actions';
const MODE_CLIPBOARD = 'clipboard';

// The views, in the order of the round buttons. Alt+digit, by physical key
// (evdev code + 8), so it works on every layout including those where the digits
// need Shift.
const VIEWS = [
    {mode: MODE_APPS, icon: 'ext:apps-grid', keycode: 10, key: 'Alt+1'},
    {mode: MODE_FILES, icon: 'ext:folder', keycode: 11, key: 'Alt+2'},
    {mode: MODE_ACTIONS, icon: 'ext:shortcuts', keycode: 12, key: 'Alt+3'},
    {mode: MODE_CLIPBOARD, icon: 'ext:clipboard', keycode: 13, key: 'Alt+4'},
];

/**
 * The chips of the application view. An app belongs to the first group, in
 * PRIORITY order, that shares a freedesktop category with it. The chips are shown
 * in DISPLAY order.
 */
const APP_GROUPS = {
    utilities: {
        title: 'Utilities',
        categories: ['Utility', 'System', 'Settings', 'Accessibility', 'Monitor', 'Archiving',
            'FileManager', 'TerminalEmulator', 'TextEditor', 'Calculator', 'Security'],
    },
    productivity: {
        title: 'Productivity & Finance',
        categories: ['Office', 'Finance', 'ProjectManagement', 'Calendar', 'ContactManagement',
            'WordProcessor', 'Spreadsheet', 'Presentation', 'Database'],
    },
    creativity: {
        title: 'Creativity',
        categories: ['Graphics', 'Photography', '2DGraphics', '3DGraphics', 'VectorGraphics',
            'RasterGraphics', 'Publishing', 'AudioVideoEditing', 'Midi', 'Sequencer', 'Recorder'],
    },
    entertainment: {
        title: 'Entertainment',
        categories: ['Game', 'AudioVideo', 'Audio', 'Video', 'Player', 'Music', 'Amusement', 'TV'],
    },
    social: {
        title: 'Social',
        categories: ['Network', 'Chat', 'InstantMessaging', 'IRCClient', 'Email', 'VideoConference',
            'Feed', 'News', 'WebBrowser', 'Telephony', 'P2P'],
    },
    developer: {
        title: 'Developer Tools',
        categories: ['Development', 'IDE', 'Debugger', 'Building', 'GUIDesigner', 'RevisionControl',
            'WebDevelopment', 'Profiling', 'Translation'],
    },
    information: {
        title: 'Information',
        categories: ['Education', 'Science', 'Documentation', 'Reference', 'Maps', 'Dictionary',
            'Languages', 'Geography', 'Astronomy', 'Math', 'Literature'],
    },
};
const APP_GROUP_DISPLAY = ['utilities', 'productivity', 'creativity', 'entertainment', 'social',
    'developer', 'information'];
const APP_GROUP_PRIORITY = ['developer', 'creativity', 'productivity', 'social', 'entertainment',
    'information', 'utilities'];

/**
 * @param {Gio.DesktopAppInfo} info
 * @returns {string|null} the key of the app's group in APP_GROUPS
 */
function appGroupOf(info) {
    const categories = (info.get_categories?.() ?? '').split(';').filter(Boolean);

    for (const key of APP_GROUP_PRIORITY) {
        if (APP_GROUPS[key].categories.some(category => categories.includes(category)))
            return key;
    }
    return null;
}

/**
 * Scrolls a scroll view just far enough to show `actor`. The Shell's own helper
 * for this moved between releases, so it is done here, from positions on screen.
 *
 * @param {St.ScrollView} scrollView
 * @param {Clutter.Actor} actor something inside the scroll view
 */
function scrollIntoView(scrollView, actor) {
    const bar = scrollView.get_vscroll_bar?.();
    const adjustment = bar?.adjustment ?? bar?.get_adjustment?.() ?? scrollView.vadjustment;
    if (!adjustment)
        return;

    const [, actorY] = actor.get_transformed_position();
    const [, viewY] = scrollView.get_transformed_position();
    const top = actorY - viewY;
    const bottom = top + actor.height;

    // Only as far as needed: up to the item's top, or down to its bottom.
    if (top < 0)
        adjustment.value += top;
    else if (bottom > scrollView.height)
        adjustment.value += bottom - scrollView.height;
}

/**
 * One element rises into place: opacity and the transform ease with different
 * curves, because an overshooting curve would push the opacity out of range.
 *
 * @param {Clutter.Actor} actor
 * @param {number} index position in the sequence, which sets the delay
 */
function popIn(actor, index) {
    const delay = index * 24;

    actor.remove_all_transitions();
    actor.set({opacity: 0, translation_y: 10});
    actor.ease({
        opacity: 255,
        duration: 180,
        delay,
        mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
    });
    actor.ease({
        translation_y: 0,
        duration: 340,
        delay,
        mode: Clutter.AnimationMode.EASE_OUT_BACK,
    });
}

/**
 * The button gives a little under the pointer and springs back.
 *
 * @param {St.Button} button
 */
function addPressFeedback(button) {
    button.set_pivot_point(0.5, 0.5);
    button.connect('notify::pressed', () => {
        const down = button.pressed;
        button.ease({
            scale_x: down ? 0.93 : 1,
            scale_y: down ? 0.93 : 1,
            duration: down ? 80 : 300,
            mode: down
                ? Clutter.AnimationMode.EASE_OUT_QUAD
                : Clutter.AnimationMode.EASE_OUT_BACK,
        });
    });
}

/**
 * @param {Promise} promise
 * @param {number} ms
 * @returns {Promise} the promise, rejected if it takes longer than `ms`
 */
function withTimeout(promise, ms) {
    let id = 0;
    const timeout = new Promise((_resolve, reject) => {
        id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            id = 0;
            reject(new Error('timed out'));
            return GLib.SOURCE_REMOVE;
        });
    });

    return Promise.race([promise, timeout]).finally(() => {
        if (id)
            GLib.source_remove(id);
    });
}

/* ------------------------------------------------------------------------ *
 * Providers. Every one has the shape of a Shell search provider:
 *   getInitialResultSet(terms, cancellable) -> ids
 *   getResultMetas(ids, cancellable)        -> [{id, name, description, createIcon}]
 *   activateResult(id, terms)
 * The local ones (files, actions, clipboard) also have list(terms), which gives
 * the metas straight away.
 * ------------------------------------------------------------------------ */

/** GNOME's application search: Shell.AppSystem.search(), ranked by usage. */
class ApplicationsProvider {
    constructor(gettext) {
        this.id = 'applications';
        this.appInfo = null;
        this.title = gettext('Applications');
    }

    async getInitialResultSet(terms) {
        const system = Shell.AppSystem.get_default();
        const query = terms.join(' ');
        let groups = [];

        if (typeof Shell.AppSystem.search === 'function') {
            groups = Shell.AppSystem.search(query);
        } else {
            // Not expected on 45+, but a name match is better than no apps at all.
            const needles = terms.map(term => term.toLowerCase());
            groups = [system.get_installed()
                .filter(info => needles.every(n => info.get_name().toLowerCase().includes(n)))
                .map(info => info.get_id())];
        }

        let usage = null;
        try {
            usage = Shell.AppUsage.get_default();
        } catch {
            usage = null;
        }

        const results = [];
        for (const group of groups) {
            const shown = group.filter(id => Gio.DesktopAppInfo.new(id)?.should_show());

            // Ranking by usage is a nicety: if this Shell's AppUsage cannot compare,
            // the order the search gave still stands.
            if (usage) {
                try {
                    shown.sort((a, b) => usage.compare(a, b));
                } catch {
                    usage = null;
                }
            }
            results.push(...shown);
        }

        return results;
    }

    filterResults(ids, maxResults) {
        return ids.slice(0, maxResults);
    }

    async getResultMetas(ids) {
        const system = Shell.AppSystem.get_default();

        return ids.map(id => {
            const app = system.lookup_app(id);
            return {
                id,
                name: app?.get_name() ?? id,
                description: app?.get_description() ?? '',
                createIcon: size => app?.create_icon_texture(size) ?? null,
            };
        });
    }

    activateResult(id) {
        Shell.AppSystem.get_default().lookup_app(id)?.activate();
    }
}

/**
 * A background index of the home folder: names, paths and modification times,
 * built a few milliseconds at a time while the session is idle. It is what makes
 * typing in the Files view find files that were never "recent".
 */
class FileIndex {
    #entries = [];
    #queue = [];
    #idleId = 0;
    #started = false;
    #done = false;

    get done() {
        return this.#done;
    }

    get entries() {
        return this.#entries;
    }

    start() {
        if (this.#started)
            return;
        this.#started = true;

        this.#queue = [{file: Gio.File.new_for_path(GLib.get_home_dir()), depth: 0}];
        this.#idleId = GLib.idle_add(GLib.PRIORITY_LOW, () => this.#step());
    }

    /** Works through the folders for a few milliseconds, then yields to the Shell. */
    #step() {
        const began = GLib.get_monotonic_time();

        while (this.#queue.length > 0 && GLib.get_monotonic_time() - began < 6000) {
            const {file, depth} = this.#queue.shift();

            try {
                const children = file.enumerate_children(
                    'standard::name,standard::type,standard::is-hidden,standard::is-symlink,standard::content-type,time::modified',
                    Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);

                let info;
                while ((info = children.next_file(null)) !== null) {
                    if (info.get_is_hidden() || info.get_is_symlink())
                        continue;

                    const name = info.get_name();
                    const child = file.get_child(name);
                    const directory = info.get_file_type() === Gio.FileType.DIRECTORY;

                    if (directory && depth < INDEX_MAX_DEPTH && !INDEX_SKIP.has(name))
                        this.#queue.push({file: child, depth: depth + 1});

                    this.#entries.push({
                        name,
                        path: child.get_path(),
                        mime: directory ? 'inode/directory' : (info.get_content_type() ?? 'application/octet-stream'),
                        modified: info.get_attribute_uint64('time::modified'),
                    });
                }
                children.close(null);
            } catch {
                // A folder that cannot be read (permissions, gone meanwhile) is skipped.
            }

            if (this.#entries.length >= INDEX_MAX_ENTRIES) {
                this.#queue = [];
                break;
            }
        }

        if (this.#queue.length > 0)
            return GLib.SOURCE_CONTINUE;

        this.#done = true;
        this.#idleId = 0;
        return GLib.SOURCE_REMOVE;
    }

    destroy() {
        if (this.#idleId) {
            GLib.source_remove(this.#idleId);
            this.#idleId = 0;
        }
        this.#entries = [];
        this.#queue = [];
    }
}

/**
 * The Files view: with nothing typed, what was used recently (the desktop's own
 * recently-used.xbel); with text, matches in those and in the home-folder index.
 */
class RecentFilesProvider {
    #recent = [];
    #index = new FileIndex();

    constructor(gettext) {
        this.id = 'files';
        this.appInfo = null;
        this.title = gettext('Files');
    }

    /** True while the home folder is still being indexed. */
    get indexing() {
        return !this.#index.done;
    }

    /** Starts building the index; it runs in idle time, so this costs nothing now. */
    warmUp() {
        this.#index.start();
    }

    /** Re-reads the recent list and makes sure the index is being built. */
    reload() {
        this.#index.start();

        const entries = [];

        try {
            const path = GLib.build_filenamev([GLib.get_user_data_dir(), 'recently-used.xbel']);
            const [ok, bytes] = Gio.File.new_for_path(path).load_contents(null);
            if (!ok)
                throw new Error('could not read recently-used.xbel');

            const xml = new TextDecoder().decode(bytes);
            const decode = text => text
                .replaceAll('&quot;', '"').replaceAll('&apos;', '\'')
                .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

            for (const chunk of xml.split('<bookmark ').slice(1)) {
                const href = /href="([^"]+)"/.exec(chunk)?.[1];
                if (!href)
                    continue;

                const uri = decode(href);
                if (!uri.startsWith('file://'))
                    continue;

                const file = Gio.File.new_for_uri(uri);
                const path2 = file.get_path();
                if (!path2 || !file.query_exists(null))
                    continue;

                entries.push({
                    name: file.get_basename() ?? uri,
                    path: path2,
                    mime: /<mime:mime-type type="([^"]+)"/.exec(chunk)?.[1] ?? 'application/octet-stream',
                    modified: Date.parse(/modified="([^"]+)"/.exec(chunk)?.[1] ?? '') / 1000 || 0,
                });
            }
        } catch (e) {
            console.warn(`${LOG_PREFIX} could not read the recent files: ${e.message}`);
        }

        entries.sort((a, b) => b.modified - a.modified);
        this.#recent = entries.slice(0, MAX_RECENT_FILES);
    }

    /** @param {string[]} terms lower-case words that must all be in the name or path */
    list(terms) {
        const home = GLib.get_home_dir();
        const matches = entry =>
            terms.every(term => `${entry.name} ${entry.path}`.toLowerCase().includes(term));

        let found;
        if (terms.length === 0) {
            // Nothing typed: what was used recently, or, with no history, what changed last.
            found = this.#recent.length > 0
                ? this.#recent
                : [...this.#index.entries].sort((a, b) => b.modified - a.modified).slice(0, MAX_RECENT_FILES);
        } else {
            const seen = new Set();
            found = [];
            for (const entry of [...this.#recent, ...this.#index.entries]) {
                if (seen.has(entry.path) || !matches(entry))
                    continue;
                seen.add(entry.path);
                found.push(entry);
            }

            // Names that start with the first word come first, then the newest.
            const first = terms[0];
            const startsWith = entry => Number(entry.name.toLowerCase().startsWith(first));
            found.sort((a, b) => startsWith(b) - startsWith(a) || b.modified - a.modified);
        }

        return found.slice(0, MAX_FILE_RESULTS).map(entry => {
            const folder = GLib.path_get_dirname(entry.path);
            return {
                id: entry.path,
                name: entry.name,
                description: folder.startsWith(home) ? `~${folder.slice(home.length)}` : folder,
                createIcon: size => new St.Icon({
                    gicon: Gio.content_type_get_icon(entry.mime),
                    icon_size: size,
                }),
            };
        });
    }

    async getInitialResultSet() {
        return [];
    }

    activateResult(path) {
        try {
            Gio.AppInfo.launch_default_for_uri(
                Gio.File.new_for_path(path).get_uri(), global.create_app_launch_context(0, -1));
        } catch (e) {
            console.warn(`${LOG_PREFIX} could not open ${path}: ${e.message}`);
        }
    }

    destroy() {
        this.#index.destroy();
        this.#recent = [];
    }
}

/**
 * Things to do rather than things to open: lock, suspend, switch the dark style.
 * Power actions go through the Shell's own SystemActions, which knows whether a
 * machine can suspend or switch user.
 */
class ActionsProvider {
    #actions = [];
    #system = null;

    constructor(gettext) {
        this.id = 'actions';
        this.appInfo = null;
        this.title = gettext('Actions');
        this._gettext = gettext;

        this.#loadSystemActions();
        this.#actions = this.#define();
    }

    async #loadSystemActions() {
        try {
            const module = await import('resource:///org/gnome/shell/misc/systemActions.js');
            this.#system = module.getDefault();
        } catch (e) {
            console.warn(`${LOG_PREFIX} the system actions are unavailable: ${e.message}`);
        }
    }

    /** @param {string} schemaId @returns {Gio.Settings|null} */
    #settings(schemaId) {
        const source = Gio.SettingsSchemaSource.get_default();
        return source?.lookup(schemaId, true) ? new Gio.Settings({schema_id: schemaId}) : null;
    }

    /** @param {string} id the SystemActions id */
    #power(id) {
        try {
            this.#system.activateAction(id);
        } catch (e) {
            console.warn(`${LOG_PREFIX} the action ${id} failed: ${e.message}`);
        }
    }

    #define() {
        const _ = this._gettext;
        const toggle = (schemaId, key, invert = false) => () => {
            const settings = this.#settings(schemaId);
            if (settings)
                settings.set_boolean(key, !settings.get_boolean(key));
            else if (invert)
                console.warn(`${LOG_PREFIX} ${schemaId} is not installed`);
        };

        return [
            {id: 'lock-screen', name: _('Lock Screen'), description: _('Power'),
                icon: 'system-lock-screen-symbolic', run: () => this.#power('lock-screen')},
            {id: 'suspend', name: _('Suspend'), description: _('Power'),
                icon: 'media-playback-pause-symbolic', run: () => this.#power('suspend')},
            {id: 'logout', name: _('Log Out…'), description: _('Power'),
                icon: 'system-log-out-symbolic', run: () => this.#power('logout')},
            {id: 'restart', name: _('Restart…'), description: _('Power'),
                icon: 'system-reboot-symbolic', run: () => this.#power('restart')},
            {id: 'power-off', name: _('Power Off…'), description: _('Power'),
                icon: 'system-shutdown-symbolic', run: () => this.#power('power-off')},
            {id: 'dark-style', name: _('Toggle Dark Style'), description: _('Appearance'),
                icon: 'weather-clear-night-symbolic', run: () => {
                    const settings = this.#settings('org.gnome.desktop.interface');
                    if (!settings)
                        return;
                    const dark = settings.get_string('color-scheme') === 'prefer-dark';
                    settings.set_string('color-scheme', dark ? 'default' : 'prefer-dark');
                }},
            {id: 'night-light', name: _('Toggle Night Light'), description: _('Display'),
                icon: 'night-light-symbolic',
                run: toggle('org.gnome.settings-daemon.plugins.color', 'night-light-enabled', true)},
            {id: 'dnd', name: _('Toggle Do Not Disturb'), description: _('Notifications'),
                icon: 'notifications-disabled-symbolic',
                run: toggle('org.gnome.desktop.notifications', 'show-banners', true)},
            {id: 'screenshot', name: _('Take a Screenshot'), description: _('Screenshot'),
                icon: 'applets-screenshooter-symbolic', run: () => Main.screenshotUI?.open()},
            {id: 'settings', name: _('Open Settings'), description: _('System'),
                icon: 'emblem-system-symbolic',
                run: () => Shell.AppSystem.get_default().lookup_app('org.gnome.Settings.desktop')?.activate()},
        ];
    }

    /** @param {string[]} terms lower-case words that must all be in the name */
    list(terms) {
        return this.#actions
            .filter(action => terms.every(term => action.name.toLowerCase().includes(term)))
            .map(action => ({
                id: action.id,
                name: action.name,
                description: action.description,
                createIcon: size => new St.Icon({icon_name: action.icon, icon_size: size}),
            }));
    }

    async getInitialResultSet() {
        return [];
    }

    activateResult(id) {
        try {
            this.#actions.find(action => action.id === id)?.run();
        } catch (e) {
            console.warn(`${LOG_PREFIX} the action ${id} failed: ${e.message}`);
        }
    }
}

/**
 * Clipboard history. GNOME keeps none, so this records what is copied from the
 * moment the extension is enabled. It lives in memory only: nothing is written
 * to disk, and it is gone when the session ends.
 */
class ClipboardProvider {
    #entries = [];
    #nextId = 1;
    #selection = null;
    #selectionSignalId = 0;

    constructor(gettext) {
        this.id = 'clipboard';
        this.appInfo = null;
        this.title = gettext('Clipboard');
        this._gettext = gettext;

        try {
            this.#selection = global.display.get_selection();
            this.#selectionSignalId = this.#selection.connect('owner-changed',
                (_selection, type) => {
                    if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                        this.#capture();
                });
        } catch (e) {
            console.warn(`${LOG_PREFIX} clipboard history is unavailable: ${e.message}`);
        }

        // What is on the clipboard right now is the first entry.
        this.#capture();
    }

    #capture() {
        St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_clipboard, text) => {
            if (!text || text.trim() === '')
                return;

            text = text.slice(0, MAX_CLIPBOARD_CHARS);

            // Copying something already in the history moves it to the top.
            this.#entries = this.#entries.filter(entry => entry.text !== text);
            this.#entries.unshift({id: String(this.#nextId++), text, time: new Date()});
            this.#entries.length = Math.min(this.#entries.length, MAX_CLIPBOARD_ENTRIES);
        });
    }

    /** @param {string[]} terms lower-case words that must all be in the text */
    list(terms) {
        const _ = this._gettext;

        return this.#entries
            .filter(entry => {
                const haystack = entry.text.toLowerCase();
                return terms.every(term => haystack.includes(term));
            })
            .map(entry => {
                const lines = entry.text.split('\n').map(line => line.trim()).filter(Boolean);
                const first = lines[0] ?? entry.text.trim();
                const when = entry.time.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});

                return {
                    id: entry.id,
                    name: first.length > 90 ? `${first.slice(0, 90)}…` : first,
                    description: `${_('Text')} · ${_('Copied')} ${when}`,
                    createIcon: size => new St.Icon({
                        ...iconProps('ext:clipboard'),
                        icon_size: size,
                    }),
                };
            });
    }

    /** @param {string} id */
    remove(id) {
        this.#entries = this.#entries.filter(entry => entry.id !== id);
    }

    async getInitialResultSet() {
        return [];
    }

    activateResult(id) {
        const entry = this.#entries.find(candidate => candidate.id === id);
        if (entry)
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, entry.text);
    }

    destroy() {
        if (this.#selection && this.#selectionSignalId)
            this.#selection.disconnect(this.#selectionSignalId);
        this.#selectionSignalId = 0;
        this.#selection = null;
        this.#entries = [];
    }
}

export class Spotlight {
    #gettext;
    #path;

    #applications;
    #files;
    #actions;
    #clipboard;
    #remote = [];
    #searchSettings = null;
    #searchSettingsIds = [];

    // glass
    #glass = null;
    #glassLoop = null;
    #glassActive = false;
    #follow = null;
    #monitor = null;

    // widgets
    #backdrop = null;
    #column = null;
    #top = null;
    #panel = null;
    #header = null;
    #lead = null;
    #leadIcon = null;
    #token = null;
    #entry = null;
    #ghost = null;
    #badge = null;
    #topHitIcon = null;
    #more = null;
    #body = null;
    #chipBox = null;
    #resultScroll = null;
    #resultList = null;
    #gridScroll = null;
    #gridColumn = null;
    #circles = new Map();
    #circleIcons = new Map();

    // state
    #grab = null;
    #isOpen = false;
    #mode = MODE_SEARCH;
    #expanded = false;
    #altHeld = false;
    #pointerOver = false;
    #previewMode = null;
    #token_group = null;
    #appsAsList = false;

    // adaptive text
    #adaptId = 0;
    #adapting = false;
    #lightText = new Map();

    // search state
    #localGroups = [];
    #groups = [];
    #filter = null;
    #items = [];
    #selected = -1;
    #terms = [];
    #searchDone = false;
    #searchError = null;
    #generation = 0;
    #cancellable = null;
    #searchTimeoutId = 0;

    // application view
    #apps = [];
    #tileCache = new Map();
    #gridTiles = [];
    #gridSelected = -1;
    #appResults = [];

    /** @param {import('resource:///org/gnome/shell/extensions/extension.js').Extension} extension */
    constructor(extension) {
        this.#gettext = extension.gettext.bind(extension);
        this.#path = extension.path;

        this.#applications = new ApplicationsProvider(this.#gettext);
        this.#files = new RecentFilesProvider(this.#gettext);
        this.#actions = new ActionsProvider(this.#gettext);
        this.#clipboard = new ClipboardProvider(this.#gettext);

        this.#files.warmUp();

        this.#build();
        this.#loadRemoteProviders();
    }

    /* ------------------------------------------------------------- building */

    #build() {
        // Absolute: the column is placed by hand, and the glass surface fills it.
        this.#backdrop = new St.Widget({
            style_class: 'cc-spot-backdrop',
            reactive: true,
            visible: false,
        });
        this.#backdrop.connect('button-press-event', (_actor, event) => {
            return this.#dismissOutsideEvent(event);
        });
        this.#backdrop.connect('touch-event', (_actor, event) => {
            // Dismiss on the initial tap, without waiting for the touch to end.
            if (event.type() !== Clutter.EventType.TOUCH_BEGIN)
                return Clutter.EVENT_PROPAGATE;

            return this.#dismissOutsideEvent(event);
        });
        this.#backdrop.connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this.#column = new St.BoxLayout({
            style_class: 'cc-spot-column',
            orientation: Clutter.Orientation.VERTICAL,
        });

        // The top row holds the capsule/panel and, while Alt is held, the circles.
        this.#top = new St.BoxLayout({
            style_class: 'cc-spot-top',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            reactive: true,
            track_hover: true,
        });
        this.#top.connect('notify::hover', () => {
            this.#pointerOver = this.#top.hover;
            this.#updateCircles();
        });

        this.#top.add_child(this.#buildPanel());
        for (const view of VIEWS)
            this.#top.add_child(this.#buildCircle(view));

        this.#column.add_child(this.#top);

        if (glassAvailable) {
            this.#glass = new GlassSurface({
                path: this.#path,
                owner: 'spotlight',
                group: 'spotlight',
                material: SPOTLIGHT_GLASS,
            });
            this.#glassLoop = new FrameLoop(() => this.#syncGlass());
            this.#backdrop.add_child(this.#glass.actor);

            // The glass reads the layout before it is redone, so after a change
            // it keeps following for a moment: the ticker asks for the frames.
            this.#follow = new Clutter.Timeline({actor: this.#backdrop, duration: FOLLOW_MS});
            for (const actor of [this.#column, this.#panel])
                actor.connect('notify::allocation', () => this.#keepFollowing());
        }

        this.#backdrop.add_child(this.#column);
        Main.uiGroup.add_child(this.#backdrop);
    }

    /** @returns {St.Widget} the capsule that grows into the panel */
    #buildPanel() {
        this.#panel = new St.Widget({
            style_class: 'cc-spot-panel',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.START,
        });
        attachBlur(this.#panel, BUBBLE_BLUR);

        const content = new St.BoxLayout({
            style_class: 'cc-spot-panel-content',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        content.add_child(this.#buildHeader());

        // --- the body: chips, then results or the application grid -------------
        this.#body = new St.BoxLayout({
            style_class: 'cc-spot-body',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            visible: false,
        });

        this.#chipBox = new St.BoxLayout({
            style_class: 'cc-spot-chips',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            visible: false,
        });
        this.#body.add_child(this.#chipBox);

        this.#resultList = new St.BoxLayout({
            style_class: 'cc-spot-list',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this.#resultScroll = new St.ScrollView({
            style_class: 'cc-spot-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            visible: false,
            child: this.#resultList,
        });
        this.#body.add_child(this.#resultScroll);

        this.#gridScroll = new St.ScrollView({
            style_class: 'cc-spot-grid-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            visible: false,
        });
        this.#body.add_child(this.#gridScroll);

        content.add_child(this.#body);

        this.#panel.add_child(content);
        this.#panel.add_child(new GlassRim({radius: 'full'}));

        return this.#panel;
    }

    /** @returns {St.BoxLayout} the row with the glyph, the field and the hints */
    #buildHeader() {
        this.#header = new St.BoxLayout({
            style_class: 'cc-spot-header',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
        });

        // The glyph is the search icon, the icon of the view, or, with a chip
        // chosen, a way back.
        this.#leadIcon = new St.Icon({
            icon_name: 'system-search-symbolic',
            style_class: 'cc-spot-lead-icon',
        });
        this.#lead = new St.Button({
            style_class: 'cc-spot-lead',
            can_focus: false,
            reactive: false,
            y_align: Clutter.ActorAlign.CENTER,
            child: this.#leadIcon,
        });
        this.#lead.connect('clicked', () => this.#setToken(null));
        this.#header.add_child(this.#lead);

        this.#token = new St.Label({
            style_class: 'cc-spot-token',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this.#header.add_child(this.#token);

        // The field, with the grey "— Open" laid over it, just after the text.
        const input = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.#entry = new St.Entry({
            style_class: 'cc-spot-entry',
            hint_text: this.#gettext('Spotlight Search'),
            can_focus: true,
            x_expand: true,
        });
        this.#entry.clutter_text.connect('text-changed', () => this.#onTextChanged());
        this.#entry.clutter_text.connect('key-press-event',
            (_actor, event) => this.#onKeyPress(event));
        this.#entry.clutter_text.connect('key-release-event',
            (_actor, event) => this.#onKeyRelease(event));
        input.add_child(this.#entry);

        this.#ghost = new St.Label({
            style_class: 'cc-spot-ghost',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: false,
            visible: false,
        });
        input.add_child(this.#ghost);
        this.#header.add_child(input);

        this.#badge = new St.Label({
            style_class: 'cc-spot-badge',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this.#header.add_child(this.#badge);

        this.#topHitIcon = new St.Bin({
            style_class: 'cc-spot-tophit',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this.#header.add_child(this.#topHitIcon);

        // List or grid, in the application view.
        this.#more = new St.Button({
            style_class: 'cc-spot-more',
            can_focus: false,
            reactive: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
            child: new St.Icon({icon_name: 'view-list-symbolic', style_class: 'cc-spot-more-icon'}),
        });
        this.#more.connect('clicked', () => {
            this.#appsAsList = !this.#appsAsList;
            this.#more.child.icon_name = this.#appsAsList ? 'view-grid-symbolic' : 'view-list-symbolic';
            this.#guard('switching the view', () => this.#refreshLocal(true));
        });
        this.#header.add_child(this.#more);

        return this.#header;
    }

    /**
     * One of the round buttons beside the capsule.
     *
     * @param {{mode: string, icon: string, key: string}} view
     * @returns {St.Button}
     */
    #buildCircle(view) {
        const label = this.#viewLabel(view.mode);

        const button = new St.Button({
            style_class: 'cc-spot-circle',
            can_focus: false,
            reactive: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.START,
            accessible_name: `${label} (${view.key})`,
            visible: false,
        });

        const host = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        const icon = new St.Icon({
            ...iconProps(view.mode === MODE_APPS ? 'ext:apps-grid-black' : view.icon),
            style_class: 'cc-spot-circle-icon',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        host.add_child(icon);
        host.add_child(new GlassRim({radius: 'full'}));
        button.set_child(host);

        attachBlur(button, BUBBLE_BLUR);
        addPressFeedback(button);

        button.connect('clicked', () => this.#toggleMode(view.mode));
        // Pointing at a circle names it in the field, with its shortcut.
        button.connect('notify::hover', () => this.#preview(button.hover ? view : null));

        this.#circles.set(view.mode, button);
        this.#circleIcons.set(view.mode, icon);
        return button;
    }

    /** @param {string} mode @returns {string} */
    #viewLabel(mode) {
        switch (mode) {
        case MODE_APPS: return this.#gettext('Applications');
        case MODE_FILES: return this.#gettext('Files');
        case MODE_ACTIONS: return this.#gettext('Actions');
        case MODE_CLIPBOARD: return this.#gettext('Clipboard');
        default: return this.#gettext('Spotlight Search');
        }
    }

    /** @param {string} mode @returns {string} */
    #viewIcon(mode) {
        return VIEWS.find(view => view.mode === mode)?.icon ?? 'system-search-symbolic';
    }

    /* ------------------------------------------------------- search providers */

    /**
     * The D-Bus search providers installed apps ship, filtered and ordered by
     * Settings -> Search. Loaded by the Shell's own code, and again whenever that
     * configuration changes.
     */
    async #loadRemoteProviders() {
        try {
            const {loadRemoteSearchProviders} =
                await import('resource:///org/gnome/shell/ui/remoteSearch.js');

            if (!this.#searchSettings) {
                this.#searchSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.search-providers'});
                for (const key of ['disabled', 'enabled', 'sort-order', 'disable-external']) {
                    this.#searchSettingsIds.push(this.#searchSettings.connect(`changed::${key}`,
                        () => this.#loadRemoteProviders()));
                }
            }

            this.#remote = loadRemoteSearchProviders(this.#searchSettings);
        } catch (e) {
            console.warn(`${LOG_PREFIX} could not load the search providers, applications only: ${e.message}`);
            this.#remote = [];
        }
    }

    /** @returns {object[]} the providers of Settings -> Search, asked after the local answer */
    #providers() {
        return [...this.#remote];
    }

    /* ----------------------------------------------------------- glass sync */

    #keepFollowing() {
        if (!this.#follow)
            return;
        if (this.#follow.is_playing())
            this.#follow.rewind();
        else
            this.#follow.start();
    }

    /**
     * The glass draws the bubbles' material, so their own fill and rim give way
     * to it, but only while it is really drawing (its shaders are loaded).
     *
     * @param {boolean} active
     */
    #setGlassActive(active) {
        if (this.#glassActive === active)
            return;
        this.#glassActive = active;

        if (active) {
            this.#column.add_style_class_name('cc-glass-active');
        } else {
            this.#column.remove_style_class_name('cc-glass-active');
            this.#resetTextColors();
        }

        const setRims = actor => {
            for (const child of actor.get_children()) {
                if (child instanceof GlassRim)
                    child.visible = !active;
                else
                    setRims(child);
            }
        };
        setRims(this.#column);
    }

    /** Once per frame while shown: a piece of glass behind each bubble. */
    #syncGlass() {
        if (!this.#glass || !this.#monitor || !this.#backdrop.mapped) {
            this.#glass?.hide();
            return;
        }

        const rects = [];
        const add = (actor, radius) => {
            if (actor.visible && actor.mapped && actor.get_paint_opacity() >= 12)
                rects.push([...screenRect(actor), radius]);
        };

        add(this.#panel, this.#expanded ? PANEL_RADIUS : CAPSULE_RADIUS);
        for (const circle of this.#circles.values())
            add(circle, CAPSULE_RADIUS);

        this.#glass.setOpacity(this.#column.get_paint_opacity());
        // The glass sits in the backdrop, which already is at the monitor's origin.
        this.#glass.sync(rects, this.#monitor, [0, 0]);
        this.#setGlassActive(this.#glass.ready);
    }

    /* --------------------------------------------------------- adaptive text */

    /**
     * The colour of the text follows what is behind the glass. Every
     * ADAPT_INTERVAL_MS the brightness under the panel and under each circle is
     * measured (glassSurface.js) and the text is dark over a bright backdrop,
     * light over a dark one. Only while the glass is really drawing: the fallback
     * has a light fill of its own, which dark text suits.
     */
    #startAdapting() {
        if (this.#adaptId || !this.#glass)
            return;

        this.#adaptId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ADAPT_INTERVAL_MS, () => {
            this.#adapt().catch(e => console.warn(`${LOG_PREFIX} adapting the text failed: ${e.message}`));
            return GLib.SOURCE_CONTINUE;
        });
        this.#adapt().catch(() => {});
    }

    #stopAdapting() {
        if (this.#adaptId) {
            GLib.source_remove(this.#adaptId);
            this.#adaptId = 0;
        }
    }

    async #adapt() {
        if (this.#adapting || !this.#isOpen || !this.#glassActive || !this.#glass?.ready)
            return;

        this.#adapting = true;
        try {
            for (const actor of [this.#panel, ...this.#circles.values()]) {
                if (!this.#isOpen || !actor.visible || !actor.mapped)
                    continue;

                const luminance = await this.#glass?.sampleLuminance(screenRect(actor));
                if (luminance !== null && luminance !== undefined && this.#isOpen)
                    this.#followBackdrop(actor, luminance);
            }
        } finally {
            this.#adapting = false;
        }
    }

    /**
     * Picks the text colour for one bubble from the luminance behind it. The
     * other colour has to win by 20% before the text flips, so it does not flicker
     * on a backdrop that sits on the edge.
     *
     * @param {St.Widget} actor
     * @param {number} luminance 0 (black) to 1 (white)
     */
    #followBackdrop(actor, luminance) {
        const wasLight = this.#lightText.get(actor) ?? false;

        // WCAG contrast of near-black (#1a1a1a) and near-white (#f2f2f2) text.
        const darkContrast = (luminance + 0.05) / (0.0103 + 0.05);
        const lightContrast = (0.89 + 0.05) / (luminance + 0.05);

        const light = wasLight
            ? !(darkContrast > lightContrast * 1.2)
            : lightContrast > darkContrast * 1.2;
        if (light === wasLight)
            return;

        this.#lightText.set(actor, light);
        if (light)
            actor.add_style_class_name('cc-spot-light');
        else
            actor.remove_style_class_name('cc-spot-light');

        if (actor === this.#circles.get(MODE_APPS))
            setIcon(this.#circleIcons.get(MODE_APPS),
                light ? 'ext:apps-grid' : 'ext:apps-grid-black');

        if (actor === this.#panel && this.#mode === MODE_APPS)
            setIcon(this.#leadIcon,
                light ? 'ext:apps-grid' : 'ext:apps-grid-black');
    }

    /** Back to the dark text of the fallback fill. */
    #resetTextColors() {
        for (const actor of [this.#panel, ...this.#circles.values()])
            actor?.remove_style_class_name('cc-spot-light');
        this.#lightText.clear();
        const appsIcon = this.#circleIcons.get(MODE_APPS);
        if (appsIcon)
            setIcon(appsIcon, 'ext:apps-grid-black');
        if (this.#mode === MODE_APPS && this.#leadIcon)
            setIcon(this.#leadIcon, 'ext:apps-grid-black');
    }

    /* ----------------------------------------------------------- failures */

    /**
     * Runs `fn`. If it throws, the reason is logged with its stack and shown in
     * the panel: a search that fails must say so, not just stay empty.
     *
     * @param {string} context what was being done
     * @param {() => void} fn
     */
    #guard(context, fn) {
        try {
            fn();
        } catch (e) {
            console.error(`${LOG_PREFIX} ${context} failed: ${e.message}\n${e.stack}`);
            this.#showFailure(`${context}: ${e.message}`);
        }
    }

    /** @param {string} message */
    #showFailure(message) {
        try {
            this.#resultList.destroy_all_children();
            this.#resultList.add_child(new St.Label({
                text: this.#gettext('Something went wrong'),
                style_class: 'cc-spot-empty',
                x_align: Clutter.ActorAlign.CENTER,
            }));
            this.#resultList.add_child(new St.Label({
                text: message,
                style_class: 'cc-spot-error',
                x_align: Clutter.ActorAlign.CENTER,
            }));
            this.#resultScroll.show();
            this.#updateExpanded();
        } catch (e) {
            console.error(`${LOG_PREFIX} could not show the failure: ${e.message}`);
        }
    }

    /* ------------------------------------------------------------ open/close */

    toggle() {
        if (this.#isOpen)
            this.close();
        else
            this.open();
    }

    #dismissOutsideEvent(event) {
        if (!this.#isOpen)
            return Clutter.EVENT_PROPAGATE;

        // Keep clicks on the search panel and visible category buttons inside
        // Spotlight. Some Shell versions report the modal backdrop as the
        // event source even when a child actor was clicked, so also check the
        // pointer against those controls' transformed bounds.
        const source = event.get_source();
        for (let actor = source; actor; actor = actor.get_parent()) {
            if (actor === this.#column)
                return Clutter.EVENT_PROPAGATE;
        }

        try {
            const [x, y] = event.get_coords();
            const controls = [this.#panel, ...this.#circles.values()];
            for (const control of controls) {
                if (!control?.visible)
                    continue;

                const [left, top] = control.get_transformed_position();
                const [width, height] = control.get_transformed_size();
                if (x >= left && x <= left + width && y >= top && y <= top + height)
                    return Clutter.EVENT_PROPAGATE;
            }
        } catch (e) {
            // Fall back to dismissing if the event does not carry pointer
            // coordinates (for example, on an unusual input device).
        }

        this.close();
        return Clutter.EVENT_STOP;
    }

    open() {
        if (this.#isOpen || Main.sessionMode.isLocked)
            return;

        const monitor = Main.layoutManager.monitors[global.display.get_current_monitor()] ??
            Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        this.#monitor = monitor;
        this.#backdrop.set_position(monitor.x, monitor.y);
        this.#backdrop.set_size(monitor.width, monitor.height);

        // Centred, in the upper part of the screen, like macOS.
        const [, columnWidth] = this.#column.get_preferred_width(-1);
        this.#column.set_position(
            Math.round((monitor.width - columnWidth) / 2),
            Math.round(monitor.height * 0.16));

        this.#resetState();
        this.#backdrop.show();

        const grab = Main.pushModal(this.#backdrop, {actionMode: Shell.ActionMode.POPUP});
        if (!grab) {
            this.#backdrop.hide();
            return;
        }

        this.#grab = grab;
        this.#isOpen = true;

        this.#column.remove_all_transitions();
        // Drops in from slightly above and a touch small, overshoots, settles.
        this.#column.set({opacity: 0, scale_x: 0.94, scale_y: 0.94, translation_y: -14});
        this.#column.set_pivot_point(0.5, 0.0);
        this.#column.ease({
            opacity: 255,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
        this.#column.ease({
            scale_x: 1,
            scale_y: 1,
            translation_y: 0,
            duration: 440,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });

        this.#glassLoop?.start();
        this.#startAdapting();
        this.#entry.grab_key_focus();
    }

    close() {
        if (!this.#isOpen)
            return;

        this.#isOpen = false;
        this.#cancelSearch();

        if (this.#grab) {
            Main.popModal(this.#grab);
            this.#grab = null;
        }

        this.#column.remove_all_transitions();
        this.#column.ease({
            opacity: 0,
            scale_x: 0.97,
            scale_y: 0.97,
            translation_y: -8,
            duration: 110,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                if (this.#isOpen)
                    return;

                this.#glassLoop?.stop();
                this.#stopAdapting();
                this.#glass?.hide();
                this.#backdrop.hide();
            },
        });
    }

    #resetState() {
        this.#cancelSearch();
        this.#mode = MODE_SEARCH;
        this.#token_group = null;
        this.#appsAsList = false;
        this.#more.child.icon_name = 'view-list-symbolic';
        this.#altHeld = false;
        this.#pointerOver = false;
        this.#previewMode = null;
        this.#entry.set_text('');
        this.#groups = [];
        this.#filter = null;
        this.#items = [];
        this.#selected = -1;
        this.#terms = [];
        this.#searchDone = false;
        this.#searchError = null;
        this.#localGroups = [];

        // Read now, so that the first keystroke already has something to match.
        this.#guard('reading the applications', () => this.#loadApps());
        this.#guard('opening', () => this.#applyMode(false));
    }

    /* --------------------------------------------------------------- input */

    /**
     * @param {Clutter.Event} event
     * @returns {boolean} Clutter.EVENT_STOP when the key was used here
     */
    #onKeyPress(event) {
        const symbol = event.get_key_symbol();
        const keycode = event.get_key_code();
        const alt = (event.get_state() & Clutter.ModifierType.MOD1_MASK) !== 0;

        // Holding Alt shows the round buttons.
        if (symbol === Clutter.KEY_Alt_L || symbol === Clutter.KEY_Alt_R) {
            this.#altHeld = true;
            this.#updateCircles();
            return Clutter.EVENT_PROPAGATE;
        }

        // Alt+Space closes again (the global accelerator may not reach a modal).
        if (alt && symbol === Clutter.KEY_space) {
            this.close();
            return Clutter.EVENT_STOP;
        }

        // Alt+1 .. Alt+4: the views.
        if (alt) {
            const view = VIEWS.find(candidate => candidate.keycode === keycode);
            if (view) {
                this.#toggleMode(view.mode);
                return Clutter.EVENT_STOP;
            }
        }

        if (this.#mode === MODE_APPS && !this.#appsAsList && this.#onGridKey(symbol))
            return Clutter.EVENT_STOP;

        switch (symbol) {
        case Clutter.KEY_Escape:
            // First Esc clears the text, then the chip, then leaves the view, then closes.
            if (this.#entry.get_text() !== '')
                this.#entry.set_text('');
            else if (this.#token_group)
                this.#setToken(null);
            else if (this.#mode !== MODE_SEARCH)
                this.#setMode(MODE_SEARCH);
            else
                this.close();
            return Clutter.EVENT_STOP;

        case Clutter.KEY_BackSpace:
            // Backspace on an empty field takes the chip off, then leaves the view.
            if (this.#entry.get_text() === '') {
                if (this.#token_group)
                    this.#setToken(null);
                else if (this.#mode !== MODE_SEARCH)
                    this.#setMode(MODE_SEARCH);
                else
                    return Clutter.EVENT_PROPAGATE;
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;

        case Clutter.KEY_Down:
            this.#moveSelection(1);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Up:
            this.#moveSelection(-1);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Tab:
        case Clutter.KEY_ISO_Left_Tab:
            this.#cycleChip(symbol === Clutter.KEY_ISO_Left_Tab ? -1 : 1);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
            this.#activateSelected();
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Delete:
            // In the clipboard view, with nothing typed, Delete drops one entry.
            if (this.#mode === MODE_CLIPBOARD && this.#entry.get_text() === '') {
                this.#removeSelectedClipboardEntry();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;

        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    /** @param {Clutter.Event} event */
    #onKeyRelease(event) {
        const symbol = event.get_key_symbol();

        if (symbol === Clutter.KEY_Alt_L || symbol === Clutter.KEY_Alt_R) {
            this.#altHeld = false;
            this.#updateCircles();
        }

        return Clutter.EVENT_PROPAGATE;
    }

    #onTextChanged() {
        this.#guard('typing', () => this.#handleText());
    }

    #handleText() {
        const text = this.#entry.get_text();

        this.#preview(null);
        this.#cancelSearch();

        // Inside a view, typing filters that view; it never leaves it.
        if (this.#mode !== MODE_SEARCH) {
            this.#refreshLocal(false);
            return;
        }

        if (text.trim() === '') {
            this.#localGroups = [];
            this.#groups = [];
            this.#filter = null;
            this.#items = [];
            this.#selected = -1;
            this.#terms = [];
            this.#searchDone = false;
            this.#searchError = null;
            this.#renderChips();
            this.#renderResults();
            this.#updateHints();
            return;
        }

        // The applications and the actions need no waiting: they are matched
        // here, at once. The providers of Settings -> Search answer afterwards.
        const terms = text.trim().split(/\s+/).filter(Boolean);
        const appearing = this.#items.length === 0;

        this.#terms = terms;
        this.#localGroups = this.#localSearchGroups(terms);
        this.#groups = [...this.#localGroups];
        this.#filter = null;
        this.#searchError = null;
        this.#searchDone = this.#remote.length === 0;

        this.#rebuildItems();
        this.#renderChips(appearing);
        this.#renderResults(appearing);
        this.#updateHints();

        if (this.#remote.length === 0)
            return;

        // A burst of keystrokes is one search.
        this.#searchTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SEARCH_DELAY_MS, () => {
            this.#searchTimeoutId = 0;
            this.#search(text).catch(e => {
                console.error(`${LOG_PREFIX} search failed: ${e.message}\n${e.stack}`);
                this.#searchDone = true;
                this.#searchError = e.message;
                this.#guard('showing the result', () => this.#renderResults());
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * What can be answered without waiting: the applications that match, and the
     * actions.
     *
     * @param {string[]} terms
     * @returns {object[]} groups, in the shape the results list takes
     */
    #localSearchGroups(terms) {
        const needles = terms.map(term => term.toLowerCase());
        const first = needles[0];

        const apps = this.#apps
            .filter(entry => needles.every(needle => entry.haystack.includes(needle)))
            .sort((a, b) =>
                Number(b.name.toLowerCase().startsWith(first)) -
                Number(a.name.toLowerCase().startsWith(first)))
            .slice(0, MAX_PER_PROVIDER + 1)
            .map(entry => ({
                id: entry.id,
                name: entry.name,
                description: entry.group ? this.#gettext(APP_GROUPS[entry.group].title) : '',
                createIcon: size => entry.app.create_icon_texture(size),
            }));

        const actions = this.#actions.list(needles).slice(0, 3);

        const groups = [];
        if (apps.length > 0)
            groups.push({provider: this.#applications, metas: apps, order: -2});
        if (actions.length > 0)
            groups.push({provider: this.#actions, metas: actions, order: -1});
        return groups;
    }

    #cancelSearch() {
        if (this.#searchTimeoutId) {
            GLib.source_remove(this.#searchTimeoutId);
            this.#searchTimeoutId = 0;
        }

        this.#cancellable?.cancel();
        this.#cancellable = null;
        // Anything still in flight belongs to a search nobody wants any more.
        this.#generation++;
        this.#searchDone = false;
    }

    /* --------------------------------------------------------------- modes */

    /** @param {string} mode pressing a view's shortcut a second time leaves it */
    #toggleMode(mode) {
        this.#setMode(this.#mode === mode ? MODE_SEARCH : mode);
    }

    /** @param {string} mode */
    #setMode(mode) {
        if (this.#mode === mode)
            return;

        this.#mode = mode;
        this.#token_group = null;
        this.#cancelSearch();

        // Every view starts from an empty field.
        if (this.#entry.get_text() !== '')
            this.#entry.set_text('');

        this.#guard('opening the view', () => this.#applyMode(true));
    }

    /** Shows what the current mode asks for. @param {boolean} animate */
    #applyMode(animate) {
        this.#gridSelected = -1;

        this.#entry.hint_text = this.#viewLabel(this.#mode);
        const appIconName = this.#panel?.has_style_class_name('cc-spot-light')
            ? 'ext:apps-grid'
            : 'ext:apps-grid-black';
        setIcon(this.#leadIcon, this.#mode === MODE_APPS
            ? appIconName
            : this.#viewIcon(this.#mode));
        this.#more.visible = this.#mode === MODE_APPS;

        // The grid and the chip token belong to the application view.
        this.#token.hide();
        this.#lead.reactive = false;
        if (this.#mode !== MODE_APPS)
            this.#gridScroll.hide();

        switch (this.#mode) {
        case MODE_FILES:
            this.#files.reload();
            break;
        case MODE_APPS:
            this.#loadApps();
            break;
        default:
        }

        if (this.#mode === MODE_SEARCH) {
            this.#groups = [];
            this.#filter = null;
            this.#items = [];
            this.#selected = -1;
            this.#terms = [];
            this.#renderChips();
            this.#renderResults();
        } else {
            this.#refreshLocal(animate);
        }

        this.#updateHints();
        this.#updateCircles();
    }

    /** The chip chosen in the application view, shown in the field. @param {string|null} group */
    #setToken(group) {
        this.#token_group = group;
        this.#guard('filtering', () => this.#refreshLocal(true));
    }

    /* ----------------------------------------------------- the round buttons */

    /**
     * The circles show while Alt is held or the pointer is over the top row, and
     * only while the panel is a capsule: a view has its own header.
     */
    #updateCircles() {
        const show = (this.#altHeld || this.#pointerOver) && !this.#expanded &&
            this.#mode === MODE_SEARCH;

        let index = 0;
        for (const circle of this.#circles.values()) {
            if (show && !circle.visible) {
                circle.show();
                circle.set_pivot_point(0.5, 0.5);
                circle.set({opacity: 0, scale_x: 0.6, scale_y: 0.6});
                circle.ease({
                    opacity: 255,
                    duration: 160,
                    delay: index * 30,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
                circle.ease({
                    scale_x: 1,
                    scale_y: 1,
                    duration: 360,
                    delay: index * 30,
                    mode: Clutter.AnimationMode.EASE_OUT_BACK,
                });
            } else if (!show && circle.visible) {
                circle.remove_all_transitions();
                circle.hide();
            }
            index++;
        }

        if (!show)
            this.#preview(null);
    }

    /**
     * Pointing at a circle names its view in the field, with the shortcut.
     *
     * @param {{mode: string, key: string}|null} view
     */
    #preview(view) {
        // A chip in the field owns the hint: there is nothing to preview.
        if (this.#token_group)
            return;

        if (this.#mode !== MODE_SEARCH || this.#entry.get_text() !== '')
            view = null;

        this.#previewMode = view?.mode ?? null;
        this.#entry.hint_text = view ? this.#viewLabel(view.mode) : this.#viewLabel(this.#mode);
        this.#badge.text = view?.key ?? '';
        this.#badge.visible = view !== null;
    }

    /* --------------------------------------------------------------- hints */

    /** The grey "— Open" after the text and the icon of the top hit on the right. */
    #updateHints() {
        const text = this.#entry.get_text();
        const top = this.#topHit();

        if (!top || text === '' || this.#mode === MODE_ACTIONS || this.#mode === MODE_CLIPBOARD) {
            this.#ghost.hide();
            this.#topHitIcon.hide();
            this.#topHitIcon.child = null;
            return;
        }

        // The ghost starts where the typed text ends.
        const [textWidth] = this.#entry.clutter_text.get_layout().get_pixel_size();
        this.#ghost.text = `— ${this.#gettext('Open')}`;
        this.#ghost.translation_x = textWidth + 10;
        this.#ghost.show();

        let icon = null;
        try {
            icon = top.createIcon?.(28) ?? null;
        } catch {
            icon = null;
        }
        this.#topHitIcon.child = icon;
        this.#topHitIcon.visible = icon !== null;
    }

    /** @returns {{createIcon?: Function}|null} what Enter would open */
    #topHit() {
        if (this.#mode === MODE_APPS)
            return this.#appResults[0] ?? null;
        return this.#items[0]?.meta ?? null;
    }

    /* --------------------------------------------------------------- search */

    /** @param {string} text */
    async #search(text) {
        const generation = ++this.#generation;
        this.#cancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this.#cancellable = cancellable;

        const terms = text.trim().split(/\s+/).filter(Boolean);
        const providers = this.#providers();
        const groups = [...this.#localGroups];
        const errors = [];

        this.#terms = terms;
        this.#searchError = null;

        // Each provider's answer is shown as it arrives.
        const publish = () => {
            if (generation !== this.#generation || !this.#isOpen)
                return;

            // A list that was already showing results updates in place; only a list
            // appearing from nothing plays the entrance.
            const appearing = this.#items.length === 0;

            this.#groups = [...groups].sort((a, b) => a.order - b.order);
            if (this.#filter && !this.#groups.includes(this.#filter))
                this.#filter = null;

            this.#guard('showing the results', () => {
                this.#rebuildItems();
                this.#renderChips(appearing);
                this.#renderResults(appearing);
                this.#updateHints();
            });
        };

        await Promise.all(providers.map(async provider => {
            try {
                let ids = await withTimeout(
                    Promise.resolve(provider.getInitialResultSet(terms, cancellable)),
                    PROVIDER_TIMEOUT_MS);
                if (!ids || ids.length === 0)
                    return;

                ids = typeof provider.filterResults === 'function'
                    ? provider.filterResults(ids, MAX_PER_PROVIDER)
                    : ids.slice(0, MAX_PER_PROVIDER);

                const metas = await withTimeout(
                    Promise.resolve(provider.getResultMetas(ids, cancellable)),
                    PROVIDER_TIMEOUT_MS);

                if (metas && metas.length > 0) {
                    // The result of a search nobody wants any more is dropped.
                    if (generation !== this.#generation)
                        return;
                    groups.push({provider, metas, order: providers.indexOf(provider)});
                    publish();
                }
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                    errors.push(`${provider.id}: ${e.message}`);
                    console.warn(`${LOG_PREFIX} provider ${provider.id} failed: ${e.message}`);
                }
            }
        }));

        if (generation !== this.#generation || !this.#isOpen)
            return;

        this.#searchDone = true;
        // With nothing to show, say what went wrong rather than a bare "No Results".
        this.#searchError = groups.length === 0 && errors.length > 0 ? errors[0] : null;
        this.#guard('showing the result', () => this.#renderResults());
    }

    /** @param {{provider: object}} group @returns {string} */
    #groupName(group) {
        const {provider} = group;

        if (provider.appInfo)
            return provider.appInfo.get_name();

        return provider.title ?? provider.id;
    }

    /** Flattens the groups the chip filter lets through into one list of rows. */
    #rebuildItems() {
        const limit = this.#mode === MODE_SEARCH ? MAX_RESULTS : MAX_LOCAL_RESULTS;
        const items = [];

        for (const group of this.#groups) {
            if (this.#filter !== null && this.#filter !== group)
                continue;

            for (const meta of group.metas) {
                if (items.length >= limit)
                    break;
                items.push({group, meta});
            }
        }

        this.#items = items;
        this.#selected = items.length > 0 ? 0 : -1;
    }

    /* ----------------------------------------------------------- local views */

    /**
     * The views that are lists the extension has in hand (applications, files,
     * actions, clipboard): filtered by what is typed, at once.
     *
     * @param {boolean} animate
     */
    #refreshLocal(animate) {
        const terms = this.#entry.get_text().toLowerCase().split(/\s+/).filter(Boolean);
        this.#terms = terms;
        this.#searchDone = true;
        this.#searchError = null;

        if (this.#mode === MODE_APPS) {
            this.#refreshApps(terms, animate);
            return;
        }

        const provider = {
            [MODE_FILES]: this.#files,
            [MODE_ACTIONS]: this.#actions,
            [MODE_CLIPBOARD]: this.#clipboard,
        }[this.#mode];
        if (!provider)
            return;

        const metas = provider.list(terms);
        this.#groups = metas.length > 0 ? [{provider, metas, order: 0}] : [];
        this.#filter = null;
        this.#rebuildItems();
        this.#renderChips();
        this.#renderResults(animate);
        this.#updateHints();
    }

    #removeSelectedClipboardEntry() {
        const item = this.#items[this.#selected];
        if (!item)
            return;

        const keep = this.#selected;
        this.#clipboard.remove(item.meta.id);
        this.#refreshLocal(false);
        this.#selected = Math.min(keep, this.#items.length - 1);
        this.#applySelection();
    }

    /* ----------------------------------------------------- applications view */

    /** Reads the installed applications, with the chip group of each. */
    #loadApps() {
        const system = Shell.AppSystem.get_default();
        const apps = [];

        for (const info of system.get_installed()) {
            if (!info.should_show())
                continue;

            const app = system.lookup_app(info.get_id());
            if (!app)
                continue;

            const keywords = (info.get_keywords?.() ?? []).join(' ');
            apps.push({
                id: info.get_id(),
                app,
                name: app.get_name(),
                group: appGroupOf(info),
                haystack: `${app.get_name()} ${info.get_generic_name?.() ?? ''} ${keywords}`.toLowerCase(),
            });
        }

        apps.sort((a, b) => a.name.localeCompare(b.name));
        this.#apps = apps;
    }

    /**
     * @param {string[]} terms
     * @param {boolean} animate
     */
    #refreshApps(terms, animate) {
        let apps = this.#apps.filter(entry =>
            (!this.#token_group || entry.group === this.#token_group) &&
            terms.every(term => entry.haystack.includes(term)));

        // Names that start with what was typed come first.
        if (terms.length > 0) {
            const first = terms[0];
            apps = [...apps].sort((a, b) =>
                Number(b.name.toLowerCase().startsWith(first)) -
                Number(a.name.toLowerCase().startsWith(first)));
        }

        this.#appResults = apps.map(entry => ({
            id: entry.id,
            name: entry.name,
            description: entry.group ? this.#gettext(APP_GROUPS[entry.group].title) : '',
            createIcon: size => entry.app.create_icon_texture(size),
            app: entry.app,
        }));

        this.#updateToken();

        // The chips: one per group that has an app, until one is chosen.
        this.#renderAppChips(animate);

        if (this.#appsAsList) {
            this.#gridScroll.hide();
            const provider = this.#applications;
            this.#groups = this.#appResults.length > 0
                ? [{provider, metas: this.#appResults, order: 0}]
                : [];
            this.#filter = null;
            this.#rebuildItems();
            this.#renderResults(animate);
        } else {
            this.#items = [];
            this.#selected = -1;
            this.#resultScroll.hide();
            this.#renderAppGrid(apps, terms.length === 0 && !this.#token_group, animate);
            // Nothing matches: say so, in the list's place.
            if (this.#gridTiles.length === 0)
                this.#renderResultsCore(false);
            this.#updateExpanded();
        }

        this.#updateHints();
    }

    /** The chosen chip is a token in the field; the glyph becomes a way back. */
    #updateToken() {
        if (this.#token_group) {
            this.#token.text = this.#gettext(APP_GROUPS[this.#token_group].title);
            this.#token.show();
            setIcon(this.#leadIcon, 'go-previous-symbolic');
            this.#lead.reactive = true;
            this.#entry.hint_text = '';
        } else {
            this.#token.hide();
            const appIconName = this.#panel?.has_style_class_name('cc-spot-light')
                ? 'ext:apps-grid'
                : 'ext:apps-grid-black';
            setIcon(this.#leadIcon, this.#mode === MODE_APPS
                ? appIconName
                : this.#viewIcon(this.#mode));
            this.#lead.reactive = false;
            this.#entry.hint_text = this.#viewLabel(this.#mode);
        }
    }

    /** @param {boolean} animate */
    #renderAppChips(animate) {
        this.#chipBox.destroy_all_children();

        if (this.#token_group || this.#apps.length === 0) {
            this.#chipBox.hide();
            return;
        }

        const present = new Set(this.#apps.map(entry => entry.group));
        let index = 0;

        for (const key of APP_GROUP_DISPLAY) {
            if (!present.has(key))
                continue;

            const chip = new St.Button({
                style_class: 'cc-spot-chip',
                can_focus: false,
                reactive: true,
                track_hover: true,
                label: this.#gettext(APP_GROUPS[key].title),
            });
            chip.connect('clicked', () => this.#setToken(key));
            this.#chipBox.add_child(chip);

            if (animate) {
                chip.set_pivot_point(0.5, 0.5);
                chip.set({opacity: 0, scale_x: 0.7, scale_y: 0.7});
                chip.ease({opacity: 255, duration: 160, delay: index * 30,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
                chip.ease({scale_x: 1, scale_y: 1, duration: 360, delay: index * 30,
                    mode: Clutter.AnimationMode.EASE_OUT_BACK});
            }
            index++;
        }

        this.#chipBox.visible = index > 0;
    }

    /**
     * The grid: the apps used most on top, a divider, then everything in order.
     * With a chip or text only the matches show.
     *
     * @param {object[]} apps
     * @param {boolean} withRecents
     * @param {boolean} animate
     */
    #renderAppGrid(apps, withRecents, animate) {
        // Tiles are kept between renders: building a few hundred icons is slow.
        for (const row of this.#gridColumn?.get_children() ?? []) {
            row.remove_all_children();
            row.destroy();
        }

        if (!this.#gridColumn) {
            this.#gridColumn = new St.BoxLayout({
                style_class: 'cc-spot-grid',
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
            });
            this.#gridScroll.set_child(this.#gridColumn);
        }

        this.#gridTiles = [];

        const addRows = entries => {
            for (let start = 0; start < entries.length; start += GRID_COLUMNS) {
                const line = new St.BoxLayout({
                    style_class: 'cc-spot-grid-row',
                    orientation: Clutter.Orientation.HORIZONTAL,
                    x_expand: true,
                });
                for (const entry of entries.slice(start, start + GRID_COLUMNS)) {
                    const tile = this.#tileFor(entry);
                    tile.get_parent()?.remove_child(tile);
                    tile.remove_style_pseudo_class('selected');
                    line.add_child(tile);
                    this.#gridTiles.push(tile);
                }
                this.#gridColumn.add_child(line);
            }
        };

        if (withRecents) {
            let recents = [];
            try {
                const used = Shell.AppUsage.get_default().get_most_used() ?? [];
                const byId = new Map(this.#apps.map(entry => [entry.app.get_id(), entry]));
                recents = used.map(app => byId.get(app.get_id())).filter(Boolean).slice(0, RECENT_APPS);
            } catch {
                recents = [];
            }

            if (recents.length > 0) {
                addRows(recents);
                this.#gridColumn.add_child(new St.Widget({style_class: 'cc-spot-divider'}));
            }
        }
        addRows(apps);

        this.#gridSelected = this.#entry.get_text() !== '' && this.#gridTiles.length > 0 ? 0 : -1;
        if (this.#gridSelected === 0)
            this.#gridTiles[0].add_style_pseudo_class('selected');

        this.#gridScroll.visible = this.#gridTiles.length > 0;

        if (animate)
            this.#gridColumn.get_children().forEach((line, index) => popIn(line, index));
    }

    /** @param {{id: string, app: Shell.App, name: string}} entry @returns {St.Button} */
    #tileFor(entry) {
        const cached = this.#tileCache.get(entry.id);
        if (cached)
            return cached;

        const tile = new St.Button({
            style_class: 'cc-spot-app',
            can_focus: false,
            reactive: true,
            track_hover: true,
        });

        const box = new St.BoxLayout({
            style_class: 'cc-spot-app-content',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });

        const icon = entry.app.create_icon_texture(GRID_ICON_SIZE);
        icon.x_align = Clutter.ActorAlign.CENTER;
        box.add_child(icon);

        const label = new St.Label({
            text: entry.name,
            style_class: 'cc-spot-app-label',
            x_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(label);

        tile.set_child(box);
        tile.connect('clicked', () => {
            this.close();
            entry.app.activate();
        });

        this.#tileCache.set(entry.id, tile);
        return tile;
    }

    /**
     * Arrow keys in the application grid.
     *
     * @param {number} symbol
     * @returns {boolean} whether the key was used
     */
    #onGridKey(symbol) {
        const steps = {
            [Clutter.KEY_Right]: 1,
            [Clutter.KEY_Left]: -1,
            [Clutter.KEY_Down]: GRID_COLUMNS,
            [Clutter.KEY_Up]: -GRID_COLUMNS,
        };
        const step = steps[symbol];

        if (step === undefined || this.#gridTiles.length === 0)
            return false;

        const next = this.#gridSelected < 0
            ? 0
            : Math.max(0, Math.min(this.#gridTiles.length - 1, this.#gridSelected + step));

        this.#gridTiles[this.#gridSelected]?.remove_style_pseudo_class('selected');
        this.#gridSelected = next;

        const tile = this.#gridTiles[next];
        tile.add_style_pseudo_class('selected');
        scrollIntoView(this.#gridScroll, tile);

        return true;
    }

    /* -------------------------------------------------------------- results */

    /** Chips of the search view: one per provider that answered. @param {boolean} [animate] */
    #renderChips(animate = false) {
        if (this.#mode === MODE_APPS)
            return;

        this.#chipBox.destroy_all_children();

        if (this.#groups.length < 2) {
            this.#chipBox.hide();
            return;
        }

        let chipIndex = 0;
        const addChip = (label, group) => {
            const chip = new St.Button({
                style_class: 'cc-spot-chip',
                can_focus: false,
                reactive: true,
                track_hover: true,
                label,
            });
            if (this.#filter === group)
                chip.add_style_pseudo_class('selected');

            attachBlur(chip, {sigma: 10, brightness: 1.0, radius: 'full'});
            chip.connect('clicked', () => {
                this.#filter = group;
                this.#rebuildItems();
                this.#renderChips();
                this.#renderResults(true);
                this.#updateHints();
            });
            this.#chipBox.add_child(chip);

            if (animate) {
                chip.set_pivot_point(0.5, 0.5);
                chip.set({opacity: 0, scale_x: 0.7, scale_y: 0.7});
                chip.ease({opacity: 255, duration: 160, delay: chipIndex * 40,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
                chip.ease({scale_x: 1, scale_y: 1, duration: 360, delay: chipIndex * 40,
                    mode: Clutter.AnimationMode.EASE_OUT_BACK});
            }
            chipIndex++;
        };

        addChip(this.#gettext('All'), null);
        for (const group of this.#groups)
            addChip(this.#groupName(group), group);

        this.#chipBox.show();
    }

    /** The line shown when the list is empty, or null for nothing at all. */
    #emptyMessage() {
        const typed = this.#entry.get_text().trim() !== '';

        switch (this.#mode) {
        case MODE_FILES:
            if (typed && this.#files.indexing)
                return this.#gettext('Looking through your files…');
            return typed ? this.#gettext('No matching files') : this.#gettext('No recent files');
        case MODE_ACTIONS:
            return this.#gettext('No matching actions');
        case MODE_CLIPBOARD:
            return typed
                ? this.#gettext('Nothing matches')
                : this.#gettext('The clipboard history is empty');
        case MODE_APPS:
            return this.#gettext('No matching applications');
        default:
            return typed && this.#searchDone ? this.#gettext('No Results') : null;
        }
    }

    /** @param {boolean} [animate] whether the rows rise into place one after another */
    #renderResults(animate = false) {
        this.#renderResultsCore(animate);
        this.#updateExpanded();
    }

    /**
     * The capsule grows into a panel when there is anything to show in it (chips,
     * results, the application grid) and folds back when there is not.
     */
    #updateExpanded() {
        const wanted = this.#chipBox.visible || this.#resultScroll.visible || this.#gridScroll.visible ||
            this.#mode !== MODE_SEARCH;

        if (wanted === this.#expanded)
            return;
        this.#expanded = wanted;

        if (wanted)
            this.#panel.add_style_class_name('cc-spot-expanded');
        else
            this.#panel.remove_style_class_name('cc-spot-expanded');

        // Without the glass renderer the blur has to follow the shape too.
        detachBlur(this.#panel);
        attachBlur(this.#panel, wanted ? PANEL_BLUR : BUBBLE_BLUR);

        this.#body.visible = wanted;
        if (wanted) {
            this.#body.remove_all_transitions();
            this.#body.set({opacity: 0, translation_y: -8});
            this.#body.ease({opacity: 255, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
            this.#body.ease({translation_y: 0, duration: 360, mode: Clutter.AnimationMode.EASE_OUT_BACK});
        }

        this.#updateCircles();
    }

    /** @param {boolean} animate */
    #renderResultsCore(animate) {
        this.#resultList.destroy_all_children();

        if (this.#items.length === 0) {
            const message = this.#emptyMessage();

            if (message) {
                this.#resultList.add_child(new St.Label({
                    text: message,
                    style_class: 'cc-spot-empty',
                    x_align: Clutter.ActorAlign.CENTER,
                }));
                if (this.#searchError) {
                    this.#resultList.add_child(new St.Label({
                        text: this.#searchError,
                        style_class: 'cc-spot-error',
                        x_align: Clutter.ActorAlign.CENTER,
                    }));
                }
                this.#resultScroll.show();
            } else {
                this.#resultScroll.hide();
            }
            return;
        }

        this.#items.forEach((item, index) => {
            item.row = this.#createRow(item, index);
            this.#resultList.add_child(item.row);
            if (animate)
                popIn(item.row, index);
        });

        this.#resultScroll.show();
        this.#applySelection();
    }

    /**
     * @param {{group: object, meta: object}} item
     * @param {number} index
     * @returns {St.Button}
     */
    #createRow(item, index) {
        const {group, meta} = item;

        const row = new St.Button({
            style_class: 'cc-spot-row',
            can_focus: false,
            reactive: true,
            track_hover: true,
            x_expand: true,
        });

        const box = new St.BoxLayout({
            style_class: 'cc-spot-row-content',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
        });

        let icon = null;
        try {
            icon = typeof meta.createIcon === 'function' ? meta.createIcon(ROW_ICON_SIZE) : null;
        } catch (e) {
            console.warn(`${LOG_PREFIX} icon of ${meta.id} failed: ${e.message}`);
        }
        if (!icon) {
            icon = new St.Icon({
                icon_name: 'application-x-executable-symbolic',
                icon_size: ROW_ICON_SIZE,
            });
        }
        icon.y_align = Clutter.ActorAlign.CENTER;
        icon.add_style_class_name('cc-spot-row-icon');
        box.add_child(icon);

        const text = new St.BoxLayout({
            style_class: 'cc-spot-row-text',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const title = new St.Label({
            text: meta.name ?? '',
            style_class: 'cc-spot-row-title',
            x_align: Clutter.ActorAlign.START,
        });
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(title);

        const subtitle = new St.Label({
            text: meta.description || this.#groupName(group),
            style_class: 'cc-spot-row-subtitle',
            x_align: Clutter.ActorAlign.START,
        });
        subtitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(subtitle);

        box.add_child(text);
        row.set_child(box);

        row.connect('clicked', () => this.#activate(item));
        row.connect('notify::hover', () => {
            if (row.hover && this.#selected !== index) {
                this.#selected = index;
                this.#applySelection(false);
            }
        });

        return row;
    }

    /** @param {boolean} [scroll] whether to bring the selected row into view */
    #applySelection(scroll = true) {
        this.#items.forEach((item, index) => {
            if (!item.row)
                return;

            if (index === this.#selected) {
                item.row.add_style_pseudo_class('selected');
                attachBlur(item.row, {sigma: 10, brightness: 1.0, radius: 16});
            } else {
                item.row.remove_style_pseudo_class('selected');
                detachBlur(item.row);
            }
        });

        const row = this.#items[this.#selected]?.row;
        if (scroll && row)
            scrollIntoView(this.#resultScroll, row);
    }

    #moveSelection(step) {
        if (this.#mode === MODE_APPS && !this.#appsAsList) {
            this.#onGridKey(step > 0 ? Clutter.KEY_Down : Clutter.KEY_Up);
            return;
        }
        if (this.#items.length === 0)
            return;

        const count = this.#items.length;
        this.#selected = (this.#selected + step + count) % count;
        this.#applySelection();
    }

    /** Tab: the next chip of the search view, or of the application view. */
    #cycleChip(step) {
        if (this.#mode === MODE_APPS) {
            const keys = APP_GROUP_DISPLAY.filter(key => this.#apps.some(entry => entry.group === key));
            const options = [null, ...keys];
            const current = options.indexOf(this.#token_group);
            this.#setToken(options[(current + step + options.length) % options.length]);
            return;
        }

        if (this.#groups.length < 2)
            return;

        const options = [null, ...this.#groups];
        const current = options.indexOf(this.#filter);
        this.#filter = options[(current + step + options.length) % options.length];

        this.#rebuildItems();
        this.#renderChips();
        this.#renderResults(true);
        this.#updateHints();
    }

    #activateSelected() {
        if (this.#mode === MODE_APPS && !this.#appsAsList) {
            const tile = this.#gridTiles[Math.max(this.#gridSelected, 0)];
            tile?.emit('clicked', 0);
            return;
        }

        const item = this.#items[this.#selected];
        if (item)
            this.#activate(item);
    }

    /** @param {{group: object, meta: object}} item */
    #activate(item) {
        const terms = this.#terms;
        // Closing first hands the focus back before the result takes it.
        this.close();

        try {
            item.group.provider.activateResult(item.meta.id, terms);
        } catch (e) {
            console.warn(`${LOG_PREFIX} activating ${item.meta.id} failed: ${e.message}`);
        }
    }

    /* -------------------------------------------------------------- teardown */

    destroy() {
        this.#cancelSearch();

        if (this.#searchSettings) {
            for (const id of this.#searchSettingsIds)
                this.#searchSettings.disconnect(id);
            this.#searchSettingsIds = [];
            this.#searchSettings = null;
        }
        this.#remote = [];

        this.#stopAdapting();
        this.#files.destroy();
        this.#clipboard.destroy();

        if (this.#grab) {
            Main.popModal(this.#grab);
            this.#grab = null;
        }
        this.#isOpen = false;

        this.#column?.remove_all_transitions();

        this.#glassLoop?.stop();
        this.#glassLoop = null;
        this.#follow?.stop();
        this.#follow = null;
        this.#glass?.destroy();
        this.#glass = null;

        this.#tileCache.clear();
        this.#backdrop?.destroy();
        this.#backdrop = null;
        this.#column = null;
        this.#top = null;
        this.#panel = null;
        this.#circles.clear();
        this.#circleIcons.clear();
        this.#entry = null;
        this.#body = null;
        this.#chipBox = null;
        this.#resultScroll = null;
        this.#resultList = null;
        this.#gridScroll = null;
        this.#gridColumn = null;
        this.#gridTiles = [];
        this.#items = [];
        this.#groups = [];
    }
}
