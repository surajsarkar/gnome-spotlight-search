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
 *
 * Theme Strategy:
 *   - Light mode is the default CSS styling (no extra class).
 *   - Dark mode is activated by adding 'spotlight-dark' class to the overlay.
 *   - The user chooses 'light', 'dark', or 'system' via preferences.
 *   - 'system' tracks org.gnome.desktop.interface color-scheme in real time.
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
            x: 0,
            y: 0,
            width:  global.screen_width,
            height: global.screen_height,
            reactive: true,
            visible: false,
            opacity: 0,
        });

        this._extension = extension;
        this._grabHelper   = null;
        this._hasModalGrab  = false;
        this._selectedIndex = -1;
        this._results       = [];
        this._searchTimeout = null;

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

        this._card = new St.BoxLayout({
            style_class: 'spotlight-card',
            vertical: true,
            reactive: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            y_expand: false,
        });
        this._card.connect('button-press-event', () => Clutter.EVENT_STOP);
        this.add_child(this._card);

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

        this._divider = new St.Widget({
            style_class: 'spotlight-divider',
            visible: false,
            y_expand: false,
        });
        this._card.add_child(this._divider);

        this._resultsWrapper = new St.BoxLayout({
            style_class: 'spotlight-results-wrapper',
            vertical: true,
            visible: false,
            y_expand: false,
            height: 156,
        });

        this._resultsBox = new St.BoxLayout({
            style_class: 'spotlight-results-box',
            vertical: false,
            y_expand: false,
        });

        this._resultsScroll = new St.ScrollView({
            style_class: 'spotlight-results-scroll',
            hscrollbar_policy: St.PolicyType.AUTOMATIC,
            vscrollbar_policy: St.PolicyType.NEVER,
            visible: false,
            x_expand: true,
            y_expand: false,
            height: 140,
        });

        this._resultsScroll.overlay_scrollbars = false;

        this._resultsScroll.add_child(this._resultsBox);
        this._resultsWrapper.add_child(this._resultsScroll);
        this._card.add_child(this._resultsWrapper);

        this._searchEntry.clutter_text.connect('text-changed', () => {
            this._scheduleSearch();
        });

        this._searchEntry.clutter_text.connect('key-press-event', (_actor, event) => {
            const symbol = event.get_key_symbol();
            const modifiers = event.get_state();

            const isAltHeld = (modifiers & Clutter.ModifierType.MOD1_MASK) !== 0;
            const isNumberKey = symbol >= Clutter.KEY_1 && symbol <= Clutter.KEY_9;

            if (isAltHeld && isNumberKey) {
                const targetIndex = symbol - Clutter.KEY_1;
                const isValidTarget = targetIndex < this._results.length;
                if (isValidTarget) {
                    this._setSelectedIndex(targetIndex);
                    this._launchApp(this._results[targetIndex]);
                }
                return Clutter.EVENT_STOP;
            }

            switch (symbol) {
                case Clutter.KEY_Escape:
                    this.close();
                    return Clutter.EVENT_STOP;
                case Clutter.KEY_Return:
                case Clutter.KEY_KP_Enter:
                    this._activateSelected();
                    return Clutter.EVENT_STOP;
                case Clutter.KEY_Right:
                case Clutter.KEY_Down:
                case Clutter.KEY_Tab:
                    this._selectDelta(+1);
                    return Clutter.EVENT_STOP;
                case Clutter.KEY_Left:
                case Clutter.KEY_Up:
                case Clutter.KEY_ISO_Left_Tab:
                    this._selectDelta(-1);
                    return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

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

        if (!Main.pushModal(this)) {
            this.hide();
            return;
        }
        this._hasModalGrab = true;

        this._searchEntry.set_text('');
        this._clearResults();
        this._selectedIndex = -1;

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

        this._searchEntry.clutter_text.grab_key_focus();
    }

    close() {
        if (!this.visible) return;

        if (this._hasModalGrab) {
            try {
                Main.popModal(this);
            } catch (_error) {
                // already released
            }
            this._hasModalGrab = false;
        }

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
                const isSearchEntryFocused =
                    global.stage.get_key_focus() === this._searchEntry.clutter_text;
                if (isSearchEntryFocused) {
                    global.stage.set_key_focus(null);
                }
            },
        });
    }

    /* ── search logic ────────────────────────────────────────────────────────── */

    _scheduleSearch() {
        this._cancelSearchTimeout();
        this._searchTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
            this._searchTimeout = null;
            this._performSearch();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelSearchTimeout() {
        if (this._searchTimeout !== null) {
            GLib.source_remove(this._searchTimeout);
            this._searchTimeout = null;
        }
    }

    _performSearch() {
        const query = this._searchEntry.get_text().trim().toLowerCase();
        this._clearResults();

        if (query.length === 0) return;

        const matchingApps = Gio.AppInfo.get_all().filter(app => {
            if (!app.should_show()) return false;

            const appName       = (app.get_name() || '').toLowerCase();
            const appId         = (app.get_id()   || '').toLowerCase();
            const appExecutable = (app.get_executable() || '').toLowerCase();

            const matchesName       = appName.includes(query);
            const matchesId         = appId.includes(query);
            const matchesExecutable = appExecutable.includes(query);

            return matchesName || matchesId || matchesExecutable;
        });

        this._results = matchingApps;
        this._selectedIndex = this._results.length > 0 ? 0 : -1;
        this._renderResults();
    }

    _clearResults() {
        this._resultsBox.remove_all_children();
        this._resultsScroll.hide();
        this._divider.hide();
        this._resultsWrapper.hide();
        this._results = [];
    }

    _renderResults() {
        if (this._results.length === 0) {
            const emptyLabel = new St.Label({
                text: _('No results found'),
                style_class: 'spotlight-no-results',
            });
            this._resultsBox.add_child(emptyLabel);
            this._resultsWrapper.show();
            this._resultsScroll.show();
            this._divider.show();
            return;
        }

        this._divider.show();
        this._resultsWrapper.show();
        this._resultsScroll.show();

        this._results.forEach((app, index) => {
            const resultButton = this._buildResultButton(app, index);
            this._resultsBox.add_child(resultButton);
        });

        this._applySelection();
    }

    _buildResultButton(app, index) {
        const resultButton = new St.Button({
            style_class: 'spotlight-result-item',
            can_focus: false,
            reactive: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            x_expand: false,
            y_expand: false,
        });

        const innerLayout = new St.BoxLayout({
            vertical: true,
            style_class: 'spotlight-result-inner',
            x_align: Clutter.ActorAlign.CENTER,
        });
        resultButton.set_child(innerLayout);

        const iconTexture = this._createAppIcon(app);
        iconTexture.style_class = 'spotlight-result-icon';
        iconTexture.x_align = Clutter.ActorAlign.CENTER;
        innerLayout.add_child(iconTexture);

        const labelContainer = new St.BoxLayout({
            vertical: false,
            x_align: Clutter.ActorAlign.CENTER,
        });
        innerLayout.add_child(labelContainer);

        const nameLabel = new St.Label({
            text: app.get_name(),
            style_class: 'spotlight-result-label',
        });
        nameLabel.clutter_text.ellipsize = imports.gi.Pango.EllipsizeMode.END;
        labelContainer.add_child(nameLabel);

        const isWithinShortcutRange = index < 9;
        if (isWithinShortcutRange) {
            const shortcutLabel = new St.Label({
                text: `Alt + ${index + 1}`,
                style_class: 'spotlight-result-shortcut',
                x_align: Clutter.ActorAlign.CENTER,
            });
            innerLayout.add_child(shortcutLabel);
        }

        resultButton.connect('enter-event', () => {
            this._setSelectedIndex(index);
        });

        resultButton.connect('clicked', () => {
            this._launchApp(app);
        });

        return resultButton;
    }

    _createAppIcon(app) {
        if (app.create_icon_texture) {
            return app.create_icon_texture(64);
        }

        const gioIcon = app.get_icon();
        return new St.Icon({ gicon: gioIcon, icon_size: 64 });
    }

    /* ── keyboard navigation ─────────────────────────────────────────────────── */

    _selectDelta(delta) {
        if (this._results.length === 0) return;
        const nextIndex = Math.max(0, Math.min(this._results.length - 1, this._selectedIndex + delta));
        this._setSelectedIndex(nextIndex);
    }

    _setSelectedIndex(index) {
        this._selectedIndex = index;
        this._applySelection();
    }

    _applySelection() {
        const children = this._resultsBox.get_children();
        children.forEach((child, childIndex) => {
            const isSelected = childIndex === this._selectedIndex;
            if (isSelected) {
                child.add_style_pseudo_class('selected');
                this._scrollToChild(child);
            } else {
                child.remove_style_pseudo_class('selected');
            }
        });
    }

    _scrollToChild(child) {
        if (!this._resultsScroll) return;

        const adjustment = this._resultsScroll.hscroll.adjustment;
        if (!adjustment) return;

        const currentScrollPosition = adjustment.value;
        const viewportSize = adjustment.page_size;
        const childLeftEdge = child.allocation.x1;
        const childRightEdge = child.allocation.x2;

        const isChildLeftOfView = childLeftEdge < currentScrollPosition;
        const isChildRightOfView = childRightEdge > currentScrollPosition + viewportSize;

        if (isChildLeftOfView) {
            adjustment.value = childLeftEdge;
        } else if (isChildRightOfView) {
            adjustment.value = childRightEdge - viewportSize;
        }
    }

    _launchApp(app) {
        if (!app) return;

        this.hide();
        this.opacity = 0;
        this._card.opacity = 0;
        global.stage.set_key_focus(null);

        if (this._hasModalGrab) {
            try {
                Main.popModal(this);
            } catch (_error) {
                // already popped
            }
            this._hasModalGrab = false;
        }

        this._searchEntry.set_text('');
        this._clearResults();

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._executeAppLaunch(app);
            return GLib.SOURCE_REMOVE;
        });
    }

    _executeAppLaunch(app) {
        try {
            const shellApp = Shell.AppSystem.get_default().lookup_app(app.get_id());
            if (shellApp) {
                shellApp.activate();
                return;
            }

            const launchContext = global.create_app_launch_context(0, -1);
            if (app.open_new_window) {
                app.open_new_window(-1);
            } else if (app.activate) {
                app.activate();
            } else if (app.launch) {
                app.launch([], launchContext);
            } else if (app.get_app_info) {
                const appInfo = app.get_app_info();
                if (appInfo) appInfo.launch([], launchContext);
            }
        } catch (error) {
            console.error(`[SpotlightSearch] Failed to launch application: ${error.message}`);
        }
    }

    _activateSelected() {
        const isValidSelection =
            this._selectedIndex >= 0 && this._selectedIndex < this._results.length;
        if (!isValidSelection) return;

        this._launchApp(this._results[this._selectedIndex]);
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

        this._wmSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.wm.keybindings' });
        this._savedSwitchSource = this._wmSettings.get_strv('switch-input-source');
        if (this._savedSwitchSource.includes('<Super>space')) {
            const filtered = this._savedSwitchSource.filter(s => s !== '<Super>space');
            this._wmSettings.set_strv('switch-input-source', filtered);
        }

        this._overlay = new SpotlightOverlay(this);
        Main.uiGroup.add_child(this._overlay);

        this._interfaceSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.interface',
        });

        this._themeChangedId = this._settings.connect(
            'changed::theme-mode',
            () => this._applyTheme()
        );
        this._colorSchemeChangedId = this._interfaceSettings.connect(
            'changed::color-scheme',
            () => this._applyTheme()
        );

        this._applyTheme();

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

        if (this._savedSwitchSource !== null) {
            this._wmSettings.set_strv('switch-input-source', this._savedSwitchSource);
            this._savedSwitchSource = null;
        }
        this._wmSettings = null;

        if (this._themeChangedId) {
            this._settings.disconnect(this._themeChangedId);
            this._themeChangedId = null;
        }

        if (this._colorSchemeChangedId) {
            this._interfaceSettings.disconnect(this._colorSchemeChangedId);
            this._colorSchemeChangedId = null;
        }
        this._interfaceSettings = null;

        if (this._overlay) {
            this._overlay.destroy();
            this._overlay = null;
        }

        this._settings = null;
    }

    _toggle() {
        if (!this._overlay) return;

        if (this._overlay.visible) {
            this._overlay.close();
        } else {
            this._overlay.open();
        }
    }

    _applyTheme() {
        if (!this._overlay) return;

        const themePreference = this._settings.get_string('theme-mode');
        const shouldUseDark = this._resolveDarkMode(themePreference);

        if (shouldUseDark) {
            this._overlay.add_style_class_name('spotlight-dark');
        } else {
            this._overlay.remove_style_class_name('spotlight-dark');
        }
    }

    _resolveDarkMode(themePreference) {
        if (themePreference === 'dark') return true;
        if (themePreference === 'light') return false;

        const systemColorScheme = this._interfaceSettings.get_string('color-scheme');
        const isSystemDark = systemColorScheme === 'prefer-dark';
        return isSystemDark;
    }
}
