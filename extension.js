import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Shell from 'gi://Shell';
import Meta from 'gi://Meta';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ModalDialog } from 'resource:///org/gnome/shell/ui/modalDialog.js';

const SpotlightSearchDialog = GObject.registerClass(
class SpotlightSearchDialog extends ModalDialog {
    _init(extension) {
        super._init({
            styleClass: 'spotlight-dialog',
            destroyOnClose: false,
        });

        this._extension = extension;

        // Create a main container that we can animate
        this._outerBox = new St.BoxLayout({
            vertical: true,
            style_class: 'spotlight-content',
            reactive: true,
        });
        this.contentLayout.add_child(this._outerBox);

        // Search Entry
        this._searchEntry = new St.Entry({
            style_class: 'spotlight-search-entry',
            hint_text: _('Search apps...'),
            can_focus: true,
            reactive: true,
        });
        this._outerBox.add_child(this._searchEntry);
        this.setInitialKeyFocus(this._searchEntry);

        // Results Container
        this._resultsContainer = new St.BoxLayout({
            vertical: true,
            style_class: 'spotlight-results',
        });
        this._outerBox.add_child(this._resultsContainer);

        // Connect entry signals
        this._searchEntry.clutter_text.connect('text-changed', () => {
            this._updateResults();
        });

        this._searchEntry.clutter_text.connect('key-press-event', (o, event) => {
            let symbol = event.get_key_symbol();
            if (symbol === Clutter.KEY_Escape) {
                this.close();
                return Clutter.EVENT_STOP;
            } else if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) {
                this._activateSelected();
                return Clutter.EVENT_STOP;
            } else if (symbol === Clutter.KEY_Down) {
                this._selectNext();
                return Clutter.EVENT_STOP;
            } else if (symbol === Clutter.KEY_Up) {
                this._selectPrev();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // Hide the background dimming for a "floating on desktop" feel
        this.backgroundStack.opacity = 0;
    }

    _updateResults() {
        let text = this._searchEntry.get_text().trim().toLowerCase();
        this._resultsContainer.remove_all_children();

        if (text.length === 0) {
            return;
        }

        let appSystem = Shell.AppSystem.get_default();
        let apps = appSystem.get_installed().filter(app => {
            let name = (app.get_name() || '').toLowerCase();
            let id = (app.get_id() || '').toLowerCase();
            return name.includes(text) || id.includes(text);
        });

        this._displayResults(apps);
    }

    _displayResults(apps) {
        if (apps.length === 0) {
            let noResult = new St.Label({
                text: _('No results found'),
                style_class: 'spotlight-no-results',
            });
            this._resultsContainer.add_child(noResult);
            return;
        }

        apps.slice(0, 6).forEach((app, index) => {
            let resultButton = new St.Button({
                style_class: 'spotlight-result-item',
                x_align: Clutter.ActorAlign.START,
                can_focus: true,
                reactive: true,
            });

            let layout = new St.BoxLayout({
                vertical: false,
                style_class: 'spotlight-result-layout',
                spacing: 10,
            });
            resultButton.set_child(layout);

            let icon = app.create_icon_texture(32);
            layout.add_child(icon);

            let label = new St.Label({
                text: app.get_name(),
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'spotlight-result-label',
            });
            layout.add_child(label);
            
            resultButton.connect('clicked', () => {
                app.activate();
                this.close();
            });
            
            this._resultsContainer.add_child(resultButton);
            if (index === 0) resultButton.add_style_pseudo_class('selected');
        });
    }

    _selectNext() {
        let children = this._resultsContainer.get_children();
        if (children.length === 0) return;

        let currentIndex = children.findIndex(c => c.has_style_pseudo_class('selected'));
        if (currentIndex < children.length - 1) {
            this._setSelected(children[currentIndex + 1]);
        }
    }

    _selectPrev() {
        let children = this._resultsContainer.get_children();
        if (children.length === 0) return;

        let currentIndex = children.findIndex(c => c.has_style_pseudo_class('selected'));
        if (currentIndex > 0) {
            this._setSelected(children[currentIndex - 1]);
        }
    }

    _setSelected(child) {
        this._resultsContainer.get_children().forEach(c => c.remove_style_pseudo_class('selected'));
        if (child) child.add_style_pseudo_class('selected');
    }

    _activateSelected() {
        let selected = this._resultsContainer.get_children().find(c => c.has_style_pseudo_class('selected'));
        if (selected) {
            selected.fake_release();
        }
    }

    open() {
        // Reset state
        this._searchEntry.set_text('');
        this._resultsContainer.remove_all_children();
        
        // Call super.open() which shows the dialog
        super.open(global.get_current_time());
        this._searchEntry.grab_key_focus();

        // Animation: Fade in and slide down
        this._outerBox.opacity = 0;
        this._outerBox.translation_y = -50;
        
        this._outerBox.ease({
            opacity: 255,
            translation_y: 0,
            duration: 250,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD
        });
    }

    close() {
        // Animation: Fade out and slide up
        this._outerBox.ease({
            opacity: 0,
            translation_y: -50,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                super.close();
            }
        });
    }
});

export default class SpotlightSearch extends Extension {
    enable() {
        this._dialog = null;
        this._settings = this.getSettings();
        this._systemSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.wm.keybindings' });
        
        // Handle system shortcut conflict with <Super>space
        this._oldBinding = null;
        let current = this._systemSettings.get_strv('switch-input-source');
        if (current.includes('<Super>space')) {
            this._oldBinding = current;
            let filtered = current.filter(s => s !== '<Super>space');
            this._systemSettings.set_strv('switch-input-source', filtered);
        }
        
        this._addKeybinding();
    }

    disable() {
        Main.wm.removeKeybinding('toggle-spotlight');

        // Restore system shortcut if we changed it
        if (this._oldBinding) {
            this._systemSettings.set_strv('switch-input-source', this._oldBinding);
            this._oldBinding = null;
        }
        this._systemSettings = null;

        if (this._dialog) {
            this._dialog.destroy();
            this._dialog = null;
        }
        
        this._settings = null;
    }

    _addKeybinding() {
        Main.wm.addKeybinding(
            'toggle-spotlight',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => {
                if (!this._dialog) {
                    this._dialog = new SpotlightSearchDialog(this);
                }
                
                if (this._dialog.visible) {
                    this._dialog.close();
                } else {
                    this._dialog.open();
                }
            }
        );
    }
}
