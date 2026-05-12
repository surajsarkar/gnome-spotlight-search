# Spotlight Search for GNOME

A GNOME Shell extension that transforms the default search interface into a centered, macOS-inspired "Spotlight" search bar.

![Spotlight Search Preview](https://via.placeholder.com/800x450.png?text=Spotlight+Search+for+GNOME+Preview) <!-- Replace with actual screenshot later -->

## Features

- **Centered Layout:** A sleek, centered search bar that floats over your desktop.
- **Smooth Animations:** Slide and fade transitions for a modern feel.
- **Backdrop Dimming:** Subtle backdrop that focuses attention on the search.
- **Seamless Shortcut:** Toggles with `Super + Space` (automatically handles GNOME's default input switcher conflict).
- **Fast & Lightweight:** Built using GNOME's native St and Clutter libraries for maximum performance.
- **GNOME 46+ Support:** Fully compatible with the latest GNOME Shell releases.

## Installation

### Manual Installation

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/yourusername/spotlight-gnome.git
    ```

2.  **Move to extensions directory:**
    ```bash
    mkdir -p ~/.local/share/gnome-shell/extensions/
    cp -r spotlight-gnome/spotlight-search@surajsarkar ~/.local/share/gnome-shell/extensions/
    ```
    *Note: Replace `spotlight-search@surajsarkar` with the actual folder name if you renamed it.*

3.  **Compile Schemas:**
    ```bash
    glib-compile-schemas ~/.local/share/gnome-shell/extensions/spotlight-search@surajsarkar/schemas/
    ```

4.  **Restart GNOME Shell:**
    - On X11: Press `Alt+F2`, type `r`, and hit `Enter`.
    - On Wayland: Log out and log back in.

5.  **Enable the extension:**
    Use **Extensions** or **Extension Manager** app to enable "Spotlight Search Style".

## Configuration

The extension uses `Super + Space` as the default shortcut. Upon activation, it will temporarily disable the default GNOME "Switch Input Source" shortcut to prevent conflicts, and restore it when the extension is disabled.

## Development

To contribute or modify the extension:

1.  Symlink the source folder to your local extensions directory.
2.  Use `journalctl -f -o cat /usr/bin/gnome-shell` to monitor logs.
3.  Ensure you have `glib2` (for `glib-compile-schemas`) installed.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Inspired by the macOS Spotlight search interface.
- Built for the GNOME community.
