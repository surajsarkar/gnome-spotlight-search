/**
 * Spotlight Search — extension.js
 * GNOME 45/46+ ESM — floats a macOS-style search bar over the desktop.
 *
 * Architecture:
 *   - No ModalDialog (that caused the "overlay but no bar" bug).
 *   - SpotlightOverlay extends St.Widget and is added to Main.uiGroup.
 *   - A grab (Clutter global grab) captures keyboard input without dimming
 *     the entire screen or blocking the panel.
 *   - Super+Space toggles open/close with slide+fade animation.
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Shell from 'gi://Shell';
import Meta from 'gi://Meta';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/* ─────────────────────────────────────────────────────────────────────────────
   SpotlightOverlay — the floating search window
   ───────────────────────────────────────────────────────────────────────────── */
const SpotlightOverlay = GObject.registerClass(
class SpotlightOverlay extends St.Widget {
    _init(extension) {
        super._init({
            layout_manager: new Clutter.BinLayout(),
            // Fill the entire screen so we can centre the card
            x: 0,
            y: 0,
            width:  global.screen_width,
            height: global.screen_height,
            reactive: true,   // needed so clicks outside close the overlay
            visible: false,
            opacity: 0,
        });

        this._extension = extension;
        this._grabHelper   = null;
        this._selectedIndex = -1;
        this._results       = [];   // ShellApp[]
        this._searchTimeout = null;

        /* ── translucent backdrop (click-to-close) ── */
        this._backdrop = new St.Widget({
            style_class: 'spotlight-backdrop',
            x: 0,
            y: 0,
            width:  global.screen_width,
            height: global.screen_height,
            reactive: true,
        });
        this._backdrop.connect('button-press-event', () => {
            this.close();
            return Clutter.EVENT_STOP;
        });
        this.add_child(this._backdrop);

        /* ── centred card ── */
        this._card = new St.BoxLayout({
            style_class: 'spotlight-card',
            vertical: true,
            reactive: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,  // positioned via margin-top in CSS
        });
        // Stop backdrop click-through from the card
        this._card.connect('button-press-event', () => Clutter.EVENT_STOP);
        this.add_child(this._card);

        /* ── search row (icon + entry) ── */
        this._searchRow = new St.BoxLayout({
            style_class: 'spotlight-search-row',
            vertical: false,
        });
        this._card.add_child(this._searchRow);

        this._searchIcon = new St.Icon({
            icon_name: 'system-search-symbolic',
            icon_size: 22,
            style_class: 'spotlight-search-icon',
        });
        this._searchRow.add_child(this._searchIcon);

        this._searchEntry = new St.Entry({
            style_class: 'spotlight-search-entry',
            hint_text: _('Search apps, files…'),
            can_focus: true,
            reactive: true,
            x_expand: true,
        });
        this._searchRow.add_child(this._searchEntry);

        /* ── divider (hidden until results appear) ── */
        this._divider = new St.Widget({
            style_class: 'spotlight-divider',
            visible: false,
        });
        this._card.add_child(this._divider);

        /* ── results list ── */
        this._resultsBox = new St.BoxLayout({
            style_class: 'spotlight-results-box',
            vertical: true,
        });
        
        // Wrap results in a ScrollView to enable scrolling
        this._resultsScroll = new St.ScrollView({
            style_class: 'spotlight-results-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            visible: false,
            x_expand: true,
        });
        this._resultsScroll.add_child(this._resultsBox);
        this._card.add_child(this._resultsScroll);

        /* ── key handling on the ClutterText ── */
        this._searchEntry.clutter_text.connect('text-changed', () => {
            this._scheduleSearch();
        });

        this._searchEntry.clutter_text.connect('key-press-event', (_actor, event) => {
            const sym = event.get_key_symbol();
            switch (sym) {
                case Clutter.KEY_Escape:
                    this.close();
                    return Clutter.EVENT_STOP;
                case Clutter.KEY_Return:
                case Clutter.KEY_KP_Enter:
                    this._activateSelected();
                    return Clutter.EVENT_STOP;
                case Clutter.KEY_Down:
                case Clutter.KEY_Tab:
                    this._selectDelta(+1);
                    return Clutter.EVENT_STOP;
                case Clutter.KEY_Up:
                case Clutter.KEY_ISO_Left_Tab:
                    this._selectDelta(-1);
                    return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // Dismiss on global key (Escape) even when focus wanders
        this.connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    /* ── public API ──────────────────────────────────────────────────────────── */

    open() {
        if (this.visible) return;

        this.show();

        // Take a modal grab so Wayland/X11 routes keyboard events to us
        if (!Main.pushModal(this)) {
            this.hide();
            return;
        }

        // Reset state
        this._searchEntry.set_text('');
        this._clearResults();
        this._selectedIndex = -1;

        // Slide-down + fade-in animation
        this._card.translation_y = -30;
        this._card.opacity        = 0;
        this.opacity              = 0;

        this.ease({
            opacity:  255,
            duration: 200,
            mode:     Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._card.ease({
            opacity:       255,
            translation_y: 0,
            duration:      250,
            mode:          Clutter.AnimationMode.EASE_OUT_EXPO,
        });

        // Grab keyboard focus
        this._searchEntry.clutter_text.grab_key_focus();
    }

    close() {
        if (!this.visible) return;

        this._cancelSearchTimeout();

        this.ease({
            opacity:  0,
            duration: 180,
            mode:     Clutter.AnimationMode.EASE_IN_QUAD,
        });
        this._card.ease({
            opacity:       0,
            translation_y: -20,
            duration:      180,
            mode:          Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete:    () => {
                this.hide();
                // Return focus to the desktop
                global.stage.set_key_focus(null);
                Main.popModal(this);
            },
        });
    }

    /* ── search logic ────────────────────────────────────────────────────────── */

    _scheduleSearch() {
        this._cancelSearchTimeout();
        // Tiny debounce so we don't search on every keystroke
        this._searchTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
            this._searchTimeout = null;
            this._doSearch();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelSearchTimeout() {
        if (this._searchTimeout !== null) {
            GLib.source_remove(this._searchTimeout);
            this._searchTimeout = null;
        }
    }

    _doSearch() {
        const text = this._searchEntry.get_text().trim().toLowerCase();
        console.log(`[SpotlightSearch] _doSearch triggered with text: '${text}'`);
        this._clearResults();

        if (text.length === 0) return;

        // Use Gio.AppInfo to get all applications
        const apps = Gio.AppInfo.get_all().filter(app => {
            if (!app.should_show()) return false;
            const name = (app.get_name() || '').toLowerCase();
            const id   = (app.get_id()   || '').toLowerCase();
            const exec = (app.get_executable() || '').toLowerCase();
            return name.includes(text) || id.includes(text) || exec.includes(text);
        });

        console.log(`[SpotlightSearch] found ${apps.length} apps`);

        // Removed slice limit to populate the scrollbox with all matches
        this._results = apps;
        this._selectedIndex = this._results.length > 0 ? 0 : -1;
        this._renderResults();
    }

    _clearResults() {
        this._resultsBox.remove_all_children();
        this._resultsScroll.hide();
        this._divider.hide();
        this._results = [];
    }

    _renderResults() {
        if (this._results.length === 0) {
            const empty = new St.Label({
                text: _('No results found'),
                style_class: 'spotlight-no-results',
            });
            this._resultsBox.add_child(empty);
            this._resultsScroll.show();
            this._divider.show();
            return;
        }

        this._divider.show();
        this._resultsScroll.show();

        this._results.forEach((app, index) => {
            const row = new St.Button({
                style_class: 'spotlight-result-item',
                can_focus: false,   // keyboard nav via _selectedIndex
                reactive: true,
                x_align: Clutter.ActorAlign.FILL,
                x_expand: true,
            });

            const inner = new St.BoxLayout({
                vertical: false,
                style_class: 'spotlight-result-inner',
                x_expand: true,
            });
            row.set_child(inner);

            // App icon
            let iconTexture = null;
            if (app.create_icon_texture) {
                iconTexture = app.create_icon_texture(28);
            } else {
                const gioIcon = app.get_icon();
                iconTexture = new St.Icon({
                    gicon: gioIcon,
                    icon_size: 28,
                });
            }
            iconTexture.style_class = 'spotlight-result-icon';
            inner.add_child(iconTexture);

            // App name
            const label = new St.Label({
                text: app.get_name(),
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'spotlight-result-label',
                x_expand: true,
            });
            inner.add_child(label);

            // Hover: update keyboard selection to match mouse
            row.connect('enter-event', () => {
                this._setSelectedIndex(index);
            });

            row.connect('clicked', () => {
                if (app.activate) {
                    app.activate();
                } else if (app.launch) {
                    app.launch([], null);
                }
                this.close();
            });

            this._resultsBox.add_child(row);
        });

        // Highlight first result
        this._applySelection();
    }

    /* ── keyboard navigation ─────────────────────────────────────────────────── */

    _selectDelta(delta) {
        if (this._results.length === 0) return;
        const next = Math.max(0, Math.min(this._results.length - 1, this._selectedIndex + delta));
        this._setSelectedIndex(next);
    }

    _setSelectedIndex(index) {
        this._selectedIndex = index;
        this._applySelection();
    }

    _applySelection() {
        const children = this._resultsBox.get_children();
        children.forEach((child, i) => {
            if (i === this._selectedIndex) {
                child.add_style_pseudo_class('selected');
                // Ensure the selected item is visible in the scroll view
                if (this._resultsScroll) {
                    let adjustment = this._resultsScroll.vscroll.adjustment;
                    if (adjustment) {
                        let [val, lower, upper, step, page, size] = [
                            adjustment.value,
                            adjustment.lower,
                            adjustment.upper,
                            adjustment.step_increment,
                            adjustment.page_increment,
                            adjustment.page_size
                        ];
                        let offset = child.allocation.y1;
                        let bottom = child.allocation.y2;

                        if (offset < val) {
                            adjustment.value = offset;
                        } else if (bottom > val + size) {
                            adjustment.value = bottom - size;
                        }
                    }
                }
            } else {
                child.remove_style_pseudo_class('selected');
            }
        });
    }

    _activateSelected() {
        if (this._selectedIndex < 0 || this._selectedIndex >= this._results.length) return;
        const app = this._results[this._selectedIndex];
        if (app.activate) {
            app.activate();
        } else if (app.launch) {
            app.launch([], null);
        }
        this.close();
    }

    /* ── cleanup ─────────────────────────────────────────────────────────────── */

    destroy() {
        this._cancelSearchTimeout();
        super.destroy();
    }
});

/* ─────────────────────────────────────────────────────────────────────────────
   Extension entry-point
   ───────────────────────────────────────────────────────────────────────────── */
export default class SpotlightSearch extends Extension {
    enable() {
        this._overlay  = null;
        this._settings = this.getSettings();

        // Temporarily remove the system Super+Space binding (switch input source)
        // so our keybinding can take over.
        this._wmSettings  = new Gio.Settings({ schema_id: 'org.gnome.desktop.wm.keybindings' });
        this._savedSwitchSource = this._wmSettings.get_strv('switch-input-source');
        if (this._savedSwitchSource.includes('<Super>space')) {
            const filtered = this._savedSwitchSource.filter(s => s !== '<Super>space');
            this._wmSettings.set_strv('switch-input-source', filtered);
        }

        // Build the overlay (not yet shown)
        this._overlay = new SpotlightOverlay(this);
        Main.uiGroup.add_child(this._overlay);

        // Register keybinding
        Main.wm.addKeybinding(
            'toggle-spotlight',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._toggle()
        );
    }

    disable() {
        Main.wm.removeKeybinding('toggle-spotlight');

        // Restore system shortcut
        if (this._savedSwitchSource !== null) {
            this._wmSettings.set_strv('switch-input-source', this._savedSwitchSource);
            this._savedSwitchSource = null;
        }
        this._wmSettings = null;

        if (this._overlay) {
            this._overlay.destroy();
            this._overlay = null;
        }

        if (this._settings) {
            this._settings = null;
        }
    }

    _toggle() {
        if (!this._overlay) return;

        if (this._overlay.visible) {
            this._overlay.close();
        } else {
            this._overlay.open();
        }
    }
}
