#!/usr/bin/env bash
#
# Stamps the app icon onto the built .dmg FILE itself.
#
# `tauri build` already sets the *volume* icon — bundle_dmg.sh writes
# .VolumeIcon.icns inside the image and flags the volume root — which is the icon
# you see once the DMG is mounted. The .dmg file's own Finder icon is separate
# metadata that Tauri never writes and exposes no config for (Tauri 2's
# bundle.macOS.dmg covers background and window/item positions only), so without
# this step Finder draws the generic disk-image icon for the file.
#
# The icon lives in the file's RESOURCE FORK, not in its bytes: an HTTP download,
# a plain `zip`, or most CI artifact uploads strip it and the generic icon comes
# back. It survives local copies, AirDrop, and `ditto --sequesterRsrc`. The
# mounted-volume icon above is the one that always reaches users.
#
# NSWorkspace's setIcon: is used rather than the DeRez/Rez/SetFile recipe because
# it needs no Xcode resource tools and leaves the data fork untouched (verified:
# sha256 of the image is unchanged and `hdiutil verify` still passes).
set -euo pipefail

cd "$(dirname "$0")/.."

ICON="src-tauri/icons/icon.icns"
[[ -f $ICON ]] || { echo "dmg-icon: missing $ICON" >&2; exit 1; }

# Newest .dmg from a host build or an explicit --target build. `rw.*` names are
# bundle_dmg.sh's intermediate read-write images, never the shipped artifact.
dmg=$(ls -t src-tauri/target/release/bundle/dmg/*.dmg \
         src-tauri/target/*/release/bundle/dmg/*.dmg 2>/dev/null \
      | grep -v '/rw\.' | head -1) || true
[[ -n ${dmg:-} ]] || { echo "dmg-icon: no .dmg found — run a bundle build first" >&2; exit 1; }

# setIcon: needs absolute paths; argv keeps them out of the AppleScript source,
# so a repo path containing spaces or quotes cannot break the script.
osascript - "$PWD/$ICON" "$PWD/$dmg" <<'OSA'
use framework "AppKit"
use scripting additions
on run argv
	set img to current application's NSImage's alloc()'s initWithContentsOfFile:(item 1 of argv)
	if img is missing value then error "unreadable icon: " & (item 1 of argv)
	set ok to current application's NSWorkspace's sharedWorkspace()'s setIcon:img forFile:(item 2 of argv) options:0
	if ok as boolean is false then error "setIcon failed: " & (item 2 of argv)
end run
OSA

# Finder renders the custom icon off the FinderInfo flag, so verify that rather
# than trusting setIcon:'s return value.
if command -v GetFileInfo >/dev/null; then
	[[ $(GetFileInfo -a "$dmg") == *C* ]] || { echo "dmg-icon: custom-icon flag not set on $dmg" >&2; exit 1; }
else
	xattr "$dmg" | grep -q com.apple.ResourceFork || { echo "dmg-icon: no resource fork on $dmg" >&2; exit 1; }
fi

echo "dmg-icon: stamped $(basename "$dmg")"
