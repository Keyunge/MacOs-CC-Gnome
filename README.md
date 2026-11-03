# macOS Control Center for GNOME

A GNOME Shell extension that recreates the macOS-style Control Center with a modern glassmorphism aesthetic, rounded controls, and a compact system panel inspired by Apple’s desktop experience.

This extension is designed for GNOME 45+ and adds a polished macOS-inspired control surface with quick actions, panel customization, global shortcuts, and fluid glass styling.

## Quick overview

- macOS-inspired Control Center layout
- Wi‑Fi, Bluetooth, battery, Spotlight, and panel controls
- Configurable global keyboard shortcuts
- Adjustable icon size and spacing in the top panel
- macOS 27-inspired visual styling
- Liquid Glass customization for menus and dock
- Quick Settings integration and modular control layout

## Screenshots

> Add your own screenshots to `docs/screenshots/` and keep the names below as placeholders.

### 1) Control Center in macOS 27 style

![Control Center in macOS 27 style](docs/screenshots/control-center-macos-27.png)

### 2) Shortcuts configuration

![Keyboard shortcuts](docs/screenshots/shortcuts.png)

### 3) Icon size and spacing configuration

![Panel icon size and spacing](docs/screenshots/icon-size-spacing.png)

### 4) Extension preferences

![Preferences panel](docs/screenshots/preferences.png)

### 5) Desktop example

![GNOME desktop with the extension enabled](docs/screenshots/desktop-example.png)

## Features

### 1) macOS-inspired Control Center
The extension adds a Control Center panel designed to resemble the macOS experience, with a modular grid of controls, rounded tiles, cards, and a clean system-focused layout.

Included controls may include:
- Wi‑Fi
- Bluetooth
- AirDrop
- Focus mode
- Volume and display controls
- Night Light
- Screen recording
- Screenshot actions
- Screen mirroring
- Media playback controls

### 2) Keyboard shortcuts
The extension supports global shortcuts for:
- Opening Spotlight
- Opening the Control Center

These can be customized from the preferences dialog or cleared with `Backspace` or `Delete`.

### 3) Icon size and spacing configuration
From the panel preferences you can adjust:
- icon size
- spacing between icons
- automatic scaling according to panel height

This helps the top bar adapt to different display sizes and visual themes.

### 4) macOS 27 visual style
The interface aims to recreate the visual language of macOS 27 with:
- rounded controls and soft corners
- translucent glass-like surfaces
- clean icon proportions
- subtle motion and polished layering
- a lightweight, high-contrast system aesthetic

### 5) Liquid Glass styling
The extension includes configuration for:
- blur strength
- tint
- brightness
- saturation
- corner smoothing

These settings can be applied to the Control Center, Spotlight, and dock when available.

### 6) Dynamic panel customization
You can also:
- change the clock language
- switch between 12h and 24h formats
- hide or reorder controls
- add controls from GNOME and third-party extensions

## Installation

### Manual installation

1. Clone the repository:

```bash
git clone https://github.com/Designer-Style147/MacOs-CC-Gnome.git
```

2. Copy the extension into the GNOME extensions directory:

```bash
mkdir -p ~/.local/share/gnome-shell/extensions/macos-control-center@keyunge.dev
cp -a MacOs-CC-Gnome/. ~/.local/share/gnome-shell/extensions/macos-control-center@keyunge.dev/
```

3. Compile the schema files:

```bash
glib-compile-schemas ~/.local/share/gnome-shell/extensions/macos-control-center@keyunge.dev/schemas/
```

4. Enable the extension:

```bash
gnome-extensions enable macos-control-center@keyunge.dev
```

5. Log out and back in or restart GNOME Shell to load the extension.

### Open preferences

```bash
gnome-extensions prefs macos-control-center@keyunge.dev
```

## Configuration

The extension includes a settings window with sections for:

- Panel Clock: time format and language
- Panel: icon size and spacing
- Shortcuts: global keyboard actions
- Liquid Glass: blur, brightness, saturation, and corner styling

## Requirements

- GNOME Shell 45+
- A working GNOME desktop environment
- Related system services depending on the features in use (Wi‑Fi, Bluetooth, battery, screen recording, etc.)

## Notes

- Some features depend on system availability and hardware support.
- Dock glass effects require Dash to Dock or Ubuntu Dock to be installed.
- External tools such as UXPlay or scrcpy may be needed for some screen-mirroring features if they are not already installed.

## License

See `lg/LICENSE` for licensing details of the included Liquid Glass components and third-party assets used in this project.
