# ============================================================================
# macOS Control Center — build & install helpers
#
#   make            show this help
#   make install    copy the extension into your GNOME extensions dir
#   make check      validate JSON / ESM syntax / CSS before shipping
#   make zip        build dist/macos-control-center@keyunge.dev.zip (EGO ready)
#   make nested     run a throwaway nested Wayland shell to test changes
# ----------------------------------------------------------------------------

.DEFAULT_GOAL := help
.PHONY: help all install uninstall enable disable reload nested check zip pack \
        clean distclean info

# --- Project layout ---------------------------------------------------------

SRC_DIR    := $(CURDIR)
BUILD_DIR  := $(SRC_DIR)/build
FILES      := metadata.json extension.js prefs.js controlCenterPanel.js spotlight.js shortcuts.js appearance.js monitor.js logging.js blur.js glass.js glassSurface.js dockGlass.js icons.js stylesheet.css
JS_FILES   := $(filter %.js,$(FILES))
# Folders shipped whole: the menu-bar icon, the vendored Liquid Glass renderer (lg/)
# and its shaders. Each is copied when present.
ASSET_DIRS := icons lg shaders

# --- Derived values ---------------------------------------------------------

# Read the UUID straight out of metadata.json (no jq/python needed).
UUID       := $(shell sed -n 's/.*"uuid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' metadata.json)
VERSION    := $(shell sed -n 's/.*"version"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' metadata.json)
SCHEMA     := $(shell sed -n 's/.*"settings-schema"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' metadata.json)

DATA_HOME  := $(or $(XDG_DATA_HOME),$(HOME)/.local/share)
EXT_DIR    := $(DATA_HOME)/gnome-shell/extensions/$(UUID)
ZIP        := $(BUILD_DIR)/$(UUID).shell-extension.zip

NODE       := $(shell command -v node 2>/dev/null)
GSETTINGS  := $(shell command -v gnome-extensions 2>/dev/null)

# ============================================================================
# Help (default target)
# ============================================================================

help:
	@echo ""
	@echo "  macOS Control Center  ($(UUID), version $(VERSION))"
	@echo ""
	@echo "  Install / lifecycle"
	@echo "    make install      Install (or upgrade) into $(EXT_DIR)"
	@echo "    make uninstall    Disable and delete the installed copy"
	@echo "    make enable       Install, then enable the extension"
	@echo "    make disable      Disable the extension"
	@echo "    make reload       Disable + enable (after a fresh 'make install')"
	@echo "    make nested       Launch a nested gnome-shell to test without logout"
	@echo ""
	@echo "  Packaging / QA"
	@echo "    make check        Validate metadata.json, imports, ESM syntax and CSS"
	@echo "    make zip          Build the extensions.gnome.org upload archive"
	@echo "    make pack         Build it with 'gnome-extensions pack' instead"
	@echo "    make clean        Remove build artefacts"
	@echo "    make info         Show resolved variables"
	@echo ""
	@echo "  Note: on Wayland the running shell can only re-scan the extension"
	@echo "        directory after a session restart (log out / log back in)."
	@echo "        Use 'make nested' for quick iteration."
	@echo ""

# ============================================================================
# Installation
# ============================================================================

install: check
	@mkdir -p "$(EXT_DIR)"
	@cp -v $(FILES) "$(EXT_DIR)/"
	@for d in $(ASSET_DIRS); do \
		if [ -d "$$d" ]; then \
			echo "  copy   $$d/"; \
			mkdir -p "$(EXT_DIR)/$$d"; \
			cp -R "$$d/." "$(EXT_DIR)/$$d/"; \
		fi; \
	done
	@if [ -d schemas ]; then \
		echo "  schema  compiling GSettings schemas"; \
		mkdir -p "$(EXT_DIR)/schemas"; \
		cp schemas/*.xml "$(EXT_DIR)/schemas/" 2>/dev/null || true; \
		glib-compile-schemas "$(EXT_DIR)/schemas"; \
	fi
	@echo ""
	@echo "  Installed -> $(EXT_DIR)"
	@echo "  X11     : press Alt+F2, type 'r', Enter"
	@echo "  Wayland : log out and back in, then: $(GSETTINGS) enable $(UUID)"
	@echo ""

uninstall:
	@-$(GSETTINGS) disable $(UUID) 2>/dev/null || true
	@rm -rfv "$(EXT_DIR)"
	@echo "  Removed $(UUID)"

enable: install
	@-$(GSETTINGS) enable $(UUID) && echo "  Enabled $(UUID)"

disable:
	@-$(GSETTINGS) disable $(UUID) && echo "  Disabled $(UUID)"

reload:
	@-$(GSETTINGS) disable $(UUID) 2>/dev/null || true
	@-$(GSETTINGS) enable $(UUID) 2>/dev/null || true
	@echo "  Reloaded $(UUID)"
	@echo "  If nothing changed, the shell has not re-scanned the extension yet:"
	@echo "  Wayland needs a session restart; X11 needs Alt+F2 'r'."

# ============================================================================
# Nested session (fast iteration without touching your real session)
# ============================================================================

nested: install
	@echo "  Starting nested Wayland shell — press Ctrl+C to stop."
	dbus-run-session -- gnome-shell --nested --wayland

# ============================================================================
# Validation
# ============================================================================

check:
	@echo "  -- checking $(UUID) --"
	@test -n "$(UUID)" || { echo "  FAIL  could not read uuid from metadata.json"; exit 1; }
	@if command -v python3 >/dev/null 2>&1; then \
		python3 -c "import json;json.load(open('metadata.json'))" \
			&& echo "  ok    metadata.json is valid JSON"; \
	elif command -v jq >/dev/null 2>&1; then \
		jq -e . metadata.json >/dev/null \
			&& echo "  ok    metadata.json is valid JSON"; \
	elif [ -n "$(NODE)" ]; then \
		$(NODE) -e "JSON.parse(require('fs').readFileSync('metadata.json','utf8'))" \
			&& echo "  ok    metadata.json is valid JSON"; \
	else \
		echo "  skip  metadata.json JSON parse (no python3/jq/node)"; \
	fi
	@for f in $(FILES); do \
		[ -f "$$f" ] || { echo "  FAIL  $$f is listed in FILES but missing"; exit 1; }; \
	done; echo "  ok    every file in FILES exists"
	@for f in $(JS_FILES); do \
		if grep -q "from '\.\./" "$$f"; then \
			echo "  FAIL  $$f imports a path outside the extension"; exit 1; \
		fi; \
		for imp in $$(sed -n "s/.*from '\.\/\([^']*\)'.*/\1/p" "$$f"); do \
			[ -f "$$imp" ] || { echo "  FAIL  $$f imports ./$$imp, which does not exist"; exit 1; }; \
			case "$$imp" in \
				*/*) ;; \
				*) case " $(FILES) " in \
					*" $$imp "*) ;; \
					*) echo "  FAIL  $$f imports ./$$imp, which is not in FILES"; exit 1;; \
				   esac;; \
			esac; \
		done; \
	done; echo "  ok    every local import resolves and is shipped"
	@if [ -d lg ] && [ -f shaders/glass.frag ] && [ -f shaders/downsample.frag ] && [ -f shaders/upsample.frag ]; then \
		echo "  ok    the glass renderer (lg/, shaders/) is present"; \
	else \
		echo "  warn  lg/ or shaders/ is missing: the glass renderer will not load, plain blur is used"; \
	fi
	@grep -q '"51"' metadata.json \
		&& echo "  ok    shell-version lists 51" \
		|| { echo "  FAIL  shell-version does not list 51"; exit 1; }
	@awk 'BEGIN{d=0;bad=0} {d+=gsub(/\{/,"{"); d-=gsub(/\}/,"}"); if(d<0)bad=1} \
		END{ if (d!=0 || bad) exit 1 }' stylesheet.css \
		&& echo "  ok    stylesheet.css braces are balanced" \
		|| { echo "  FAIL  unbalanced braces in stylesheet.css"; exit 1; }
	@if [ -d schemas ] && command -v glib-compile-schemas >/dev/null 2>&1; then \
		glib-compile-schemas --strict --dry-run schemas \
			&& echo "  ok    schemas/ compiles"; \
	else \
		echo "  skip  GSettings schema check"; \
	fi
	@if [ -n "$(NODE)" ]; then \
		tmp=$$(mktemp -d) && trap 'rm -rf "$$tmp"' EXIT INT TERM; \
		for f in $(JS_FILES); do \
			cp "$$f" "$$tmp/$${f%.js}.mjs" || exit 1; \
			$(NODE) --check "$$tmp/$${f%.js}.mjs" \
				|| { echo "  FAIL  syntax error in $$f"; exit 1; }; \
			echo "  ok    $$f parses as an ES module"; \
		done; \
		rm -rf "$$tmp"; \
	else \
		echo "  skip  ESM syntax check (node not installed)"; \
	fi
	@echo "  -- all good --"

# ============================================================================
# Packaging
# ============================================================================

zip: check
	@mkdir -p "$(BUILD_DIR)"
	@rm -f "$(ZIP)"
	@rm -rf "$(BUILD_DIR)/stage"
	@mkdir -p "$(BUILD_DIR)/stage"
	@cp $(FILES) "$(BUILD_DIR)/stage/"
	@for d in $(ASSET_DIRS); do \
		if [ -d "$$d" ]; then \
			mkdir -p "$(BUILD_DIR)/stage/$$d"; \
			cp -R "$$d/." "$(BUILD_DIR)/stage/$$d/"; \
		fi; \
	done
	@if [ -d schemas ]; then \
		mkdir -p "$(BUILD_DIR)/stage/schemas"; \
		cp schemas/*.xml "$(BUILD_DIR)/stage/schemas/"; \
		glib-compile-schemas "$(BUILD_DIR)/stage/schemas"; \
	fi
	@(cd "$(BUILD_DIR)/stage" && zip -q -r "$(ZIP)" .)
	@echo "  Built $(ZIP)"
	@unzip -l "$(ZIP)" | sed -n '4,20p'

pack: check
	@mkdir -p "$(BUILD_DIR)"
	@rm -rf "$(BUILD_DIR)/$(UUID)"
	@mkdir -p "$(BUILD_DIR)/$(UUID)"
	@cp $(FILES) "$(BUILD_DIR)/$(UUID)/"
	@for d in $(ASSET_DIRS); do \
		if [ -d "$$d" ]; then \
			mkdir -p "$(BUILD_DIR)/$(UUID)/$$d"; \
			cp -R "$$d/." "$(BUILD_DIR)/$(UUID)/$$d/"; \
		fi; \
	done
	@if [ -d schemas ]; then \
		mkdir -p "$(BUILD_DIR)/$(UUID)/schemas"; \
		cp schemas/*.xml "$(BUILD_DIR)/$(UUID)/schemas/"; \
	fi
	@$(GSETTINGS) pack "$(BUILD_DIR)/$(UUID)" --force --out-dir "$(BUILD_DIR)"
	@mv "$(BUILD_DIR)/$(UUID).shell-extension.zip" "$(ZIP)" 2>/dev/null || true
	@echo "  Built $(ZIP)"

dist: zip

# ============================================================================
# Misc
# ============================================================================

info:
	@echo "UUID        = $(UUID)"
	@echo "VERSION     = $(VERSION)"
	@echo "SCHEMA      = $(SCHEMA)"
	@echo "EXT_DIR     = $(EXT_DIR)"
	@echo "BUILD_DIR   = $(BUILD_DIR)"
	@echo "ZIP         = $(ZIP)"
	@echo "FILES       = $(FILES)"
	@echo "ASSET_DIRS  = $(ASSET_DIRS)"
	@echo "node        = $(if $(NODE),$(NODE),<missing>)"
	@echo "gnome-ext   = $(if $(GSETTINGS),$(GSETTINGS),<missing>)"

clean:
	@rm -rfv "$(BUILD_DIR)"

distclean: clean
	@rm -rfv "$(EXT_DIR)"
