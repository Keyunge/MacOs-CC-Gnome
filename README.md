# macOS Control Center for GNOME 45+

Repository: https://github.com/Designer-Style147/MacOs-CC-Gnome

Original project / base: https://github.com/Keyunge/MacOs-CC-Gnome

A modern, macOS-inspired control center for GNOME Shell, designed to bring a polished and immersive desktop experience to Linux users. This project recreates the feel of Apple-style quick settings, glassy surfaces, and compact system controls in a GNOME-friendly interface.

The extension is actively evolving, with new refinements and interface improvements being added continuously. It focuses on a lightweight, modular experience with a strong visual identity inspired by macOS, while remaining usable and adaptable in daily GNOME workflows.
## Other Extensions (its no mine) :
- liquid glass by ryohsuke1231: https://github.com/ryohsuke1231/liquid-glass
- Dash to Dock by ubuntu: https://github.com/ubuntu/dash-to-dock
- Just Perfection by  JustPerfection:  https://extensions.gnome.org/extension/3843/just-perfection/
- Appmenu By ChathurangaBW : https://github.com/ChathurangaBW/AppMenu/releases
- kiwi (no es apple) by Arnis K : https: https://extensions.gnome.org/extension/8276/kiwi-is-not-apple/
- kiwi Menu by Kem-a: https://github.com/kem-a/kiwi-menu
- Liquid Glass gnome Wigdets by Niwmua: https://github.com/Niwmua/liquidglass-gnome-widgets
- GlideDOck by Charleshere_25: https://github.com/bquangthien25-hub/GlideDock
- Grid -Desktop by pelach: https://github.com/pelach/grid-desktop
## Highlights

- macOS-like quick settings panel
- Glassmorphism-inspired interface
- Wi‑Fi, Bluetooth, and system status indicators
- Spotlight-style search integration
- Dock glass effects and polished visual layering
- Customizable date/time formatting support
- Modular structure for ongoing development
- Designed for GNOME 45+

## Original project attribution

This repository is based on the original work by @Keyunge/MacOs-CC-Gnome, adapted and expanded here for continued development and personal customization.

All credit for the original concept and foundation goes to the original project author and contributors.

## Examples and reference media

The gallery below is organized to match the actual flow of the interface: overview, search, app launcher, preferences, system/media controls, and final display/sound controls.

### Applications spotlight panel

<p align="center">
  <img src="./Captura desde 2026-11-01 16-01-41.png" alt="Applications spotlight panel" width="900" />
</p>

This first capture shows the default control center state, with the dark translucent panel, status indicators, and the polished macOS-inspired visual treatment.

### Settings and preferences panel

<p align="center">
  <img src="./Captura desde 2026-11-01 16-02-32.png" alt="Settings and preferences panel " width="900" />
</p>

This variation highlights the floating Spotlight-style search surface and its clean overlay composition, reinforcing the blend between GNOME and macOS design cues.

### EXamples with macos wallpaper

<p align="center">
  <img src="./Captura desde 2026-11-01 16-11-57.png" alt=" example " width="900" />
</p>

The applications view demonstrates the launcher layout with category-based organization, rounded panels, and a smooth glassmorphism aesthetic.

### macos wallpaper

<p align="center">
  <img src="./Captura desde 2026-11-01 16-12-10.png" alt=" main overview" width="900" />
</p>

This panel showcases the configuration interface, including language and time-format controls, proving that the project is designed to be adaptable and user-configurable.

### System control and media interaction

<p align="center">
  <img src="./Captura desde 2026-11-01 16-12-28.png" alt="System control and media interaction" width="900" />
</p>

This screenshot focuses on the quick-control behavior and media/status cards, including the floating system controls and the overall balance of the interface.

### Spotlight and search experiencee"

<p align="center">
  <img src="./Captura desde 2026-11-01 16-12-42.png" alt=" Spotlight and search experiencee" width="900" />
</p>

This final capture shows the deeper control panel with display, sound, and power utility sections, reinforcing the modularity and modern dashboard feel.

### Reference video

<p align="center">
  <video controls width="900">
    <source src="./Screencast from 2026-11-01 16-13-52.mp4" type="video/mp4" />
  </video>
</p>

This short reference video shows the interface in motion and helps communicate the real feel of the project, including transitions, layered effects, and the overall interaction style.

## Current development status

This project is in active development. The interface is already demonstrating a strong macOS-inspired direction, and more improvements are being applied regularly, including:

- visual polish and motion refinement
- better compatibility with GNOME Shell behaviors
- cleaner glass and blur layering
- improved control toggles and spacing
- further app integration and status panel enhancements

The goal is to continue refining the experience while preparing future improvements and a more complete GNOME Shell extension workflow.

## Planned GNOME Shell extension

A dedicated GNOME Shell extension version is planned for the future. This will focus on:

- better extension packaging and installation flow
- improved compatibility with GNOME Shell APIs
- simplified configuration and settings management
- broader support for recent GNOME versions
- continued feature growth and UI consistency

## Project focus

This project combines the visual language of macOS with the flexibility of GNOME, aiming to deliver a clean, modern, and functional desktop experience without sacrificing performance or usability.

## Repository overview

The repository includes the core JavaScript logic, CSS styling, shader-based visual effects, and GNOME Shell integration pieces needed to create the control center experience.

## Requirements

- GNOME Shell 45 or newer
- A compatible Linux desktop environment with GNOME Shell enabled
- JavaScript and CSS-based extension development environment

## Installation guide

This repository is a GNOME Shell extension, so the recommended way to install it is to place it inside the GNOME extensions directory and enable it.

### 1) Clone the repository

```bash
git clone https://github.com/Designer-Style147/MacOs-CC-Gnome.git
cd MacOs-CC-Gnome
```

### 2) Install in the GNOME extensions folder

```bash
mkdir -p ~/.local/share/gnome-shell/extensions/macos-control-center@keyunge.dev
cp -r . ~/.local/share/gnome-shell/extensions/macos-control-center@keyunge.dev/
```

If you prefer, you can also clone directly into the extension folder:

```bash
git clone https://github.com/Designer-Style147/MacOs-CC-Gnome.git ~/.local/share/gnome-shell/extensions/macos-control-center@keyunge.dev
```

### 3) Enable the extension

```bash
gnome-extensions enable macos-control-center@keyunge.dev
```

### 4) Reload GNOME Shell

You can reload the shell by logging out and back in, or by running:

```bash
Alt + F2
r
Enter
```

### 5) Verify the extension

Open GNOME Settings > Extensions and make sure the extension appears enabled.

You can also verify it with:

```bash
gnome-extensions list --enabled
```

## Contribution

Contributions, feedback, and feature ideas are welcome. This project is evolving quickly, and community input can help shape the next generation of the macOS-inspired GNOME experience.

## License

This project is distributed under the MIT license unless otherwise stated in the repository.

## Roadmap

- refine panel aesthetics and interaction details
- optimize performance and compatibility
- finalize upcoming GNOME Shell extension packaging
- expand customization and system integrations
- continue improving the overall user experience
- add more polished functions and extra quick controls

---

Built for users who want a cleaner, more premium GNOME desktop experience inspired by macOS.

More features and refinements are still being developed as the project continues to evolve.
