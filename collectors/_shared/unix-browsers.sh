# ============================================================================
# Browser helpers (shared by macOS and Linux). Only history/downloads and
# extension/preferences files are collected. Cookies, Login Data, Web Data,
# key4.db, logins.json, cookies.sqlite are NEVER referenced here.
# Uses P_NAME / P_HOME / P_SAFE set by for_each_profile.
# ============================================================================
SQLITE_NOTE="live copy of a SQLite database; -wal/-journal siblings copied when present; may be internally inconsistent if the browser was writing"

# Copy a SQLite file plus its -wal/-journal siblings under one destination stem.
copy_sqlite_set() { # art prof srcfile destrel
  local art="$1" prof="$2" src="$3" rel="$4" sfx
  [ -f "$src" ] || { skip "$art" "$prof" "$src" "source-not-present"; return; }
  copy_file "$art" "$prof" "$src" "$rel" "$SQLITE_NOTE"
  for sfx in -wal -journal; do [ -f "$src$sfx" ] && copy_file "$art" "$prof" "$src$sfx" "$rel$sfx" "$SQLITE_NOTE"; done
}

# Chromium family: ROOT contains "Default" and "Profile N" directories.
chromium_history_user() { # uses CH_ROOTREL CH_NAME
  local root="$P_HOME/$CH_ROOTREL" pdir pn found=0
  [ -d "$root" ] || return 0
  for pdir in "$root/Default" "$root"/Profile\ *; do
    [ -d "$pdir" ] || continue; found=1
    pn="$(safe_name "$(basename "$pdir")")"
    copy_sqlite_set "$ART_CUR" "$P_NAME/$CH_NAME/$(basename "$pdir")" "$pdir/History" "browser/$P_SAFE/$CH_NAME/$pn/History"
  done
  [ "$found" = 0 ] && skip "$ART_CUR" "$P_NAME/$CH_NAME" "$root" "no-profiles-found"
}
chromium_config_user() {
  local root="$P_HOME/$CH_ROOTREL" pdir pn
  [ -d "$root" ] || return 0
  for pdir in "$root/Default" "$root"/Profile\ *; do
    [ -d "$pdir" ] || continue
    pn="$(safe_name "$(basename "$pdir")")"
    copy_file "$ART_CUR" "$P_NAME/$CH_NAME/$(basename "$pdir")" "$pdir/Preferences" "browser/$P_SAFE/$CH_NAME/$pn/config/Preferences" ""
    copy_tree "$ART_CUR" "$P_NAME/$CH_NAME/$(basename "$pdir")" "$pdir/Extensions" "browser/$P_SAFE/$CH_NAME/$pn/config/Extensions" 3 "extension manifest only" "manifest.json"
  done
}
# $1 = artifact function kind (history|config), $2 = browser display name, $3 = root relative to home
chromium_for_all() {
  CH_NAME="$2"; CH_ROOTREL="$3"
  if [ "$1" = history ]; then for_each_profile chromium_history_user; else for_each_profile chromium_config_user; fi
}

# Firefox: PROFILES_DIR contains one directory per profile.
firefox_history_user() {
  local root="$P_HOME/$FF_ROOTREL" pdir pn found=0
  [ -d "$root" ] || return 0
  for pdir in "$root"/*; do
    [ -d "$pdir" ] || continue; [ -f "$pdir/places.sqlite" ] || continue; found=1
    pn="$(safe_name "$(basename "$pdir")")"
    copy_sqlite_set "$ART_CUR" "$P_NAME/firefox/$(basename "$pdir")" "$pdir/places.sqlite" "browser/$P_SAFE/firefox/$pn/places.sqlite"
  done
  [ "$found" = 0 ] && skip "$ART_CUR" "$P_NAME/firefox" "$root" "no-profiles-found"
}
firefox_config_user() {
  local root="$P_HOME/$FF_ROOTREL" pdir pn
  [ -d "$root" ] || return 0
  for pdir in "$root"/*; do
    [ -d "$pdir" ] || continue; [ -f "$pdir/places.sqlite" ] || [ -f "$pdir/prefs.js" ] || continue
    pn="$(safe_name "$(basename "$pdir")")"
    copy_file "$ART_CUR" "$P_NAME/firefox/$(basename "$pdir")" "$pdir/extensions.json" "browser/$P_SAFE/firefox/$pn/config/extensions.json" ""
    copy_file "$ART_CUR" "$P_NAME/firefox/$(basename "$pdir")" "$pdir/prefs.js" "browser/$P_SAFE/firefox/$pn/config/prefs.js" ""
  done
}
firefox_for_all() { FF_ROOTREL="$2"; if [ "$1" = history ]; then for_each_profile firefox_history_user; else for_each_profile firefox_config_user; fi; }

# A sensitive-option artifact is only honoured if the plan also carries the matching explicit selection.
require_sensitive() { # art selection-name
  has_sensitive "$2" && return 0
  skip "$1" "" "" "sensitive-selection-not-granted"; return 1
}
