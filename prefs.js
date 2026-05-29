import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

const THEME_OPTIONS = ['system', 'light', 'dark'];
const THEME_LABELS  = ['Follow System Theme', 'Light', 'Dark'];

export default class SpotlightSearchPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-desktop-appearance-symbolic',
        });

        const appearanceGroup = new Adw.PreferencesGroup({
            title: _('Appearance'),
            description: _('Control how the Spotlight search bar looks'),
        });
        page.add(appearanceGroup);

        const themeRow = this._buildThemeRow(settings);
        appearanceGroup.add(themeRow);

        window.add(page);
    }

    _buildThemeRow(settings) {
        const themeRow = new Adw.ComboRow({
            title: _('Theme'),
            subtitle: _('Choose light, dark, or follow system appearance'),
        });

        const model = Gtk.StringList.new(THEME_LABELS.map(label => _(label)));
        themeRow.set_model(model);

        const currentValue = settings.get_string('theme-mode');
        const initialIndex = Math.max(0, THEME_OPTIONS.indexOf(currentValue));
        themeRow.selected = initialIndex;

        themeRow.connect('notify::selected', () => {
            const selectedIndex = themeRow.selected;
            const isValidIndex = selectedIndex >= 0 && selectedIndex < THEME_OPTIONS.length;
            if (!isValidIndex) return;

            settings.set_string('theme-mode', THEME_OPTIONS[selectedIndex]);
        });

        const settingsHandlerId = settings.connect('changed::theme-mode', () => {
            const value = settings.get_string('theme-mode');
            const matchingIndex = THEME_OPTIONS.indexOf(value);
            const isKnownValue = matchingIndex !== -1;
            if (!isKnownValue) return;

            themeRow.selected = matchingIndex;
        });

        themeRow.connect('destroy', () => {
            settings.disconnect(settingsHandlerId);
        });

        return themeRow;
    }
}
