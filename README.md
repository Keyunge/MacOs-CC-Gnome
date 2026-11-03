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
-wifi:
<img width="355" height="475" alt="Captura desde 2026-11-02 19-04-12" src="https://github.com/user-attachments/assets/2af6826c-5242-43b3-9bdb-8407619dd95e" />
-battery:
<img width="351" height="352" alt="Captura desde 2026-11-02 19-05-46" src="https://github.com/user-attachments/assets/b8e58a6f-4bad-4443-9d22-7c23476f9155" />
-bluetooth:
<img width="351" height="352" alt="Captura desde 2026-11-02 19-06-32" src="https://github.com/user-attachments/assets/b5875e43-54ff-44a1-9e70-ac4841573338" />




### 2) Shortcuts configuration
<img width="730" height="666" alt="Captura desde 2026-11-02 19-02-22" src="https://github.com/user-attachments/assets/e23acd50-2d37-4557-a337-f51813921aba" />


### 3) Icon size and spacing configuration
<img width="730" height="666" alt="Captura desde 2026-11-02 19-03-03" src="https://github.com/user-attachments/assets/8640bd8c-fb77-47d3-b451-7318f1df0031" />


### 4) Extension preferences
<img width="730" height="666" alt="image" src="https://github.com/user-attachments/assets/5255f441-2526-414d-a0d0-eea40824548d" />


### 5) Desktop example
<img width="1366" height="768" alt="Captura desde 2026-11-01 20-51-31" src="https://github.com/user-attachments/assets/9fe56f4d-4d12-407f-9e52-f898ba834955" />

<img width="1366" height="768" alt="image" src="https://github.com/user-attachments/assets/e5778aa3-8621-4d72-8427-69748f9f5302" />

<img width="1366" height="768" alt="Captura desde 2026-11-02 20-22-43" src="https://github.com/user-attachments/assets/1ab31f9b-07b1-47cf-bca7-aedf795df125" />



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
