# ============================================================================
# Linux-specific discovery and artifact functions (static, reviewed).
# Paths differ per distribution; missing sources are recorded, never guessed.
# ============================================================================
fmt_epoch() { date -u -d "@$1" "+%Y-%m-%d %H:%M:%S"; }
os_version_string() {
  local n; n="$(grep -m1 '^PRETTY_NAME=' /etc/os-release 2>/dev/null | cut -d= -f2- | tr -d '"')"   # parsed as data, never sourced
  printf '%s (kernel %s)' "${n:-unknown linux}" "$(uname -r)"
}
HAS_SYSTEMD=0; [ -d /run/systemd/system ] && HAS_SYSTEMD=1

# TEST HOOK (fixtures only): treat directories under EEC_TEST_USERS_ROOT as normal profiles.
discover_accounts() {
  PROFILE_NAMES=(); PROFILE_HOMES=(); PROFILE_KIND=()
  if [ -n "${EEC_TEST_USERS_ROOT:-}" ]; then
    local d; for d in "$EEC_TEST_USERS_ROOT"/*; do [ -d "$d" ] && add_profile "$(basename "$d")" "$d" normal; done; return
  fi
  local name pw uid gid gecos home shell kind
  while IFS=: read -r name pw uid gid gecos home shell; do
    [ -z "$name" ] && continue
    case "$home" in ""|/|/nonexistent|/dev/null|/var/empty) continue;; esac
    [ -d "$home" ] || continue
    kind=system
    case "$shell" in */nologin|*/false|"") ;; *) [ "$uid" -ge 1000 ] 2>/dev/null && [ "$name" != nobody ] && kind=normal;; esac
    add_profile "$name" "$home" "$kind"
  done < <(getent passwd 2>/dev/null || cat /etc/passwd)
}
discover_interactive() {
  INTERACTIVE_USERS=()
  local u; for u in $(who 2>/dev/null | awk '{print $1}' | sort -u); do INTERACTIVE_USERS+=("$u"); done
}

baseline_dump() { echo "# collected_utc: $(now_utc)"; cat /etc/os-release 2>/dev/null; uname -a; uptime; echo "# identity:"; id; hostname; }
net_dump() { if command -v ss >/dev/null 2>&1; then echo "# ss -anp"; ss -anp; elif command -v netstat >/dev/null 2>&1; then echo "# netstat -anp"; netstat -anp; else echo "neither ss nor netstat available" >&2; return 1; fi; }

art_lin_baseline_system() { cmd_to_file "$ART_CUR" "" baseline/system.txt snapshot "point-in-time" false -- baseline_dump; }
art_lin_volatile_processes() { cmd_to_file "$ART_CUR" "" volatile/processes.txt snapshot "point-in-time; no arguments" false -- ps -eo pid,ppid,user,lstart,comm; }
art_lin_volatile_processes_cmdline() { require_sensitive "$ART_CUR" process-command-lines && cmd_to_file "$ART_CUR" "" volatile/process-cmdlines.txt snapshot "SENSITIVE: arguments may contain secrets" false -- ps -eo pid,args; }
art_lin_volatile_network() { cmd_to_file "$ART_CUR" "" volatile/network.txt snapshot "point-in-time; process names need root" false -- net_dump; }

art_lin_logs_journal() {
  if [ "$HAS_SYSTEMD" != 1 ] || ! command -v journalctl >/dev/null 2>&1; then skip "$ART_CUR" "" "" "non-systemd-host"; return; fi
  if [ -z "$TW_START" ]; then skip "$ART_CUR" "" "" "requires-time-window"; return; fi
  cmd_to_file "$ART_CUR" "" logs/journal.export export "journalctl export format; native time filter" true -- journalctl --no-pager -o export --since "$TW_START UTC" --until "$TW_END UTC"
}
art_lin_logs_auth() {
  local f; for f in /var/log/auth.log /var/log/auth.log.1 /var/log/secure /var/log/secure-*; do [ -e "$f" ] && copy_file "$ART_CUR" "" "$f" "logs/auth/$(safe_name "$(basename "$f")")" "whole file copied; time window not applied"; done
  if [ ! -e /var/log/auth.log ] && [ ! -e /var/log/secure ]; then
    # Fallback: distributions that log authentication only to the journal.
    if [ "$HAS_SYSTEMD" = 1 ] && command -v journalctl >/dev/null 2>&1 && [ -n "$TW_START" ]; then
      cmd_to_file "$ART_CUR" "" logs/auth/journal-auth-fallback.txt export "FALLBACK: journal entries for sshd/sudo/su only; no auth log file on this host" true -- \
        journalctl --no-pager -t sshd -t sudo -t su --since "$TW_START UTC" --until "$TW_END UTC"
    else skip "$ART_CUR" "" "" "source-not-present"; fi
  fi
}
art_lin_logs_syslog() {
  local f; for f in /var/log/syslog /var/log/syslog.1 /var/log/messages; do [ -e "$f" ] && copy_file "$ART_CUR" "" "$f" "logs/syslog/$(safe_name "$(basename "$f")")" "whole file copied; time window not applied"; done
  [ -e /var/log/syslog ] || [ -e /var/log/messages ] || skip "$ART_CUR" "" "" "source-not-present"
}
art_lin_scheduled_cron() {
  copy_file "$ART_CUR" "" /etc/crontab scheduled/cron/crontab ""
  copy_tree "$ART_CUR" "" /etc/cron.d scheduled/cron/cron.d 1 ""
  local p; for p in hourly daily weekly monthly; do copy_tree "$ART_CUR" "" "/etc/cron.$p" "scheduled/cron/cron.$p" 1 ""; done
  copy_tree "$ART_CUR" "" /var/spool/cron scheduled/cron/spool 2 "per-user crontabs"
  [ "$ELEVATED" = true ] || crontab_fallback "$ART_CUR" scheduled/cron/own-crontab.txt
}
art_lin_scheduled_timers() {
  if [ "$HAS_SYSTEMD" != 1 ]; then skip "$ART_CUR" "" "" "non-systemd-host"; return; fi
  cmd_to_file "$ART_CUR" "" scheduled/timers.txt snapshot "systemctl list-timers" false -- systemctl list-timers --all --no-pager
  copy_tree "$ART_CUR" "" /etc/systemd/system scheduled/timer-units 2 "timer unit files only" "*.timer"
}
svc_user() {
  copy_tree "$ART_CUR" "$P_NAME" "$P_HOME/.config/systemd/user" "persistence/users/$P_SAFE/systemd-user" 2 ""
  copy_tree "$ART_CUR" "$P_NAME" "$P_HOME/.config/autostart" "persistence/users/$P_SAFE/autostart" 1 ""
}
art_lin_persistence_services() {
  if [ "$HAS_SYSTEMD" = 1 ]; then cmd_to_file "$ART_CUR" "" persistence/unit-files.txt snapshot "systemctl list-unit-files" false -- systemctl list-unit-files --no-pager
  else skip "$ART_CUR" "" "systemctl" "non-systemd-host"; fi
  cmd_to_file "$ART_CUR" "" persistence/init.d-listing.txt metadata "listing only" false -- ls -la /etc/init.d
  copy_file "$ART_CUR" "" /etc/rc.local persistence/rc.local ""
  for_each_profile svc_user
}
art_lin_browser_chromium_history() {
  chromium_for_all history Chrome ".config/google-chrome"
  chromium_for_all history Chromium ".config/chromium"
  chromium_for_all history Brave ".config/BraveSoftware/Brave-Browser"
}
art_lin_browser_firefox_history() { firefox_for_all history ".mozilla/firefox"; }
userlogs_lin() { copy_file "$ART_CUR" "$P_NAME" "$P_HOME/.xsession-errors" "userlogs/$P_SAFE/xsession-errors" ""; copy_tree "$ART_CUR" "$P_NAME" "$P_HOME/.local/state" "userlogs/$P_SAFE/local-state" 2 "existing files only" "*.log"; }
art_lin_userlogs_user() { for_each_profile userlogs_lin; }
