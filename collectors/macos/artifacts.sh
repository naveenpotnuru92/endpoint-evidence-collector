# ============================================================================
# macOS-specific discovery and artifact functions (static, reviewed).
# Never grants Full Disk Access, never edits privacy databases, never elevates.
# ============================================================================
fmt_epoch() { date -u -r "$1" "+%Y-%m-%d %H:%M:%S"; }
os_version_string() { printf '%s %s (%s)' "$(sw_vers -productName 2>/dev/null)" "$(sw_vers -productVersion 2>/dev/null)" "$(sw_vers -buildVersion 2>/dev/null)"; }

# TEST HOOK: EEC_TEST_USERS_ROOT makes discovery treat each directory in that folder as a normal profile
# (used by automated fixture tests only; not reachable from plan data).
discover_accounts() {
  PROFILE_NAMES=(); PROFILE_HOMES=(); PROFILE_KIND=()
  if [ -n "${EEC_TEST_USERS_ROOT:-}" ]; then
    local d; for d in "$EEC_TEST_USERS_ROOT"/*; do [ -d "$d" ] && add_profile "$(basename "$d")" "$d" normal; done; return
  fi
  local name uid home kind
  while read -r name uid; do
    [ -z "$name" ] && continue
    home="$(dscl . -read "/Users/$name" NFSHomeDirectory 2>/dev/null | sed -e '1s/^NFSHomeDirectory: *//' | head -n1)"
    case "$home" in ""|/var/empty|/dev/null|/var/empty/*) continue;; esac
    [ -d "$home" ] || continue
    kind=system
    case "$name" in _*) kind=system;; *) [ "$uid" -ge 500 ] 2>/dev/null && case "$home" in /Users/*) kind=normal;; esac;; esac
    add_profile "$name" "$home" "$kind"
  done < <(dscl . -list /Users UniqueID 2>/dev/null)
}
discover_interactive() {
  INTERACTIVE_USERS=()
  local u; u="$(stat -f%Su /dev/console 2>/dev/null)"
  case "$u" in ""|root) ;; *) INTERACTIVE_USERS+=("$u");; esac
}

baseline_dump() { echo "# collected_utc: $(now_utc)"; sw_vers; uname -a; uptime; echo "# identity:"; id; hostname; }
net_dump() { echo "# netstat -anv"; netstat -anv; echo "# lsof -nP -i (visible to this identity)"; lsof -nP -i; }

art_mac_baseline_system() { cmd_to_file "$ART_CUR" "" baseline/system.txt snapshot "point-in-time" false -- baseline_dump; }
art_mac_volatile_processes() { cmd_to_file "$ART_CUR" "" volatile/processes.txt snapshot "point-in-time; no arguments" false -- ps -axo pid,ppid,user,lstart,comm; }
art_mac_volatile_processes_cmdline() { require_sensitive "$ART_CUR" process-command-lines && cmd_to_file "$ART_CUR" "" volatile/process-cmdlines.txt snapshot "SENSITIVE: arguments may contain secrets" false -- ps -axo pid,args; }
art_mac_volatile_network() { cmd_to_file "$ART_CUR" "" volatile/network.txt snapshot "point-in-time; non-root sees limited sockets" false -- net_dump; }

art_mac_logs_unified() {
  if [ -z "$TW_START" ]; then skip "$ART_CUR" "" "" "requires-time-window"; return; fi
  if [ "$ELEVATED" != true ]; then fail "$ART_CUR" "" "log show" "requires root"; return; fi
  cmd_to_file "$ART_CUR" "" logs/unified.ndjson export "bounded log show; fixed predicate; not a logarchive" true -- \
    env TZ=UTC /usr/bin/log show --style ndjson --start "$TW_START" --end "$TW_END" \
    --predicate 'process == "sudo" OR process == "sshd" OR process == "su" OR process == "login" OR process == "loginwindow" OR process == "authd" OR process == "launchd"'
}
art_mac_logs_system() { copy_file "$ART_CUR" "" /var/log/install.log logs/var-log/install.log ""; copy_file "$ART_CUR" "" /var/log/system.log logs/var-log/system.log ""; }

art_mac_scheduled_cron() {
  copy_file "$ART_CUR" "" /etc/crontab scheduled/cron/crontab ""
  copy_tree "$ART_CUR" "" /usr/lib/cron/tabs scheduled/cron/tabs 1 "per-user crontabs"
  copy_tree "$ART_CUR" "" /private/var/at/jobs scheduled/cron/at-jobs 1 "at jobs"
  [ "$ELEVATED" = true ] || crontab_fallback "$ART_CUR" scheduled/cron/own-crontab.txt
}
launchd_user() { copy_tree "$ART_CUR" "$P_NAME" "$P_HOME/Library/LaunchAgents" "scheduled/launchd/users/$P_SAFE/LaunchAgents" 1 "plist copied as-is, not parsed or loaded"; }
art_mac_scheduled_launchd() {
  local failed_before=$N_FAILED
  copy_tree "$ART_CUR" "" /Library/LaunchAgents scheduled/launchd/Library-LaunchAgents 1 "plist copied as-is"
  copy_tree "$ART_CUR" "" /Library/LaunchDaemons scheduled/launchd/Library-LaunchDaemons 1 "plist copied as-is"
  cmd_to_file "$ART_CUR" "" scheduled/launchd/system-launch-dirs-listing.txt metadata "listing only; /System is sealed" false -- ls -laO /System/Library/LaunchAgents /System/Library/LaunchDaemons
  for_each_profile launchd_user
  # Fallback when some plists could not be read: job labels/status only (what launchd reports to this identity), clearly labelled.
  if [ "$N_FAILED" -gt "$failed_before" ]; then
    cmd_to_file "$ART_CUR" "" scheduled/launchd/launchctl-list-fallback.txt snapshot "FALLBACK: job labels and status only; some plist files were unreadable" false -- launchctl list
  fi
}
art_mac_persistence_launchd() {
  cmd_to_file "$ART_CUR" "" persistence/launchctl-list.txt snapshot "launchctl list for this identity's domain" false -- launchctl list
  cmd_to_file "$ART_CUR" "" persistence/startupitems-listing.txt metadata "legacy StartupItems listing; background-task database not copied" false -- ls -laO /Library/StartupItems
}

art_mac_browser_safari_history() { for_each_profile safari_user; }
safari_user() {
  copy_sqlite_set "$ART_CUR" "$P_NAME/safari" "$P_HOME/Library/Safari/History.db" "browser/$P_SAFE/safari/History.db"
  copy_file "$ART_CUR" "$P_NAME/safari" "$P_HOME/Library/Safari/Downloads.plist" "browser/$P_SAFE/safari/Downloads.plist" ""
}
chromium_all_mac() { # $1 history|config
  chromium_for_all "$1" Chrome "Library/Application Support/Google/Chrome"
  chromium_for_all "$1" Edge "Library/Application Support/Microsoft Edge"
  chromium_for_all "$1" Brave "Library/Application Support/BraveSoftware/Brave-Browser"
}
art_mac_browser_chromium_history() { chromium_all_mac history; }
art_mac_browser_chromium_config() { chromium_all_mac config; }
art_mac_browser_firefox_history() { firefox_for_all history "Library/Application Support/Firefox/Profiles"; }
art_mac_browser_firefox_config() { firefox_for_all config "Library/Application Support/Firefox/Profiles"; }

userlogs_mac() { copy_tree "$ART_CUR" "$P_NAME" "$P_HOME/Library/Logs" "userlogs/$P_SAFE" 2 "existing files only"; }
art_mac_userlogs_user() { for_each_profile userlogs_mac; }
