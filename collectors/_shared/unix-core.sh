# ============================================================================
# Endpoint Evidence Collector - Unix core (macOS + Linux)
# Static, reviewed template. Plan values are read as DATA from collector.conf
# (tab-separated key/value lines). Nothing from the plan is ever eval'd,
# sourced, or interpolated into a command string.
# Compatible with bash 3.2 (the macOS /bin/bash). Invoke explicitly:
#     /bin/bash collector.sh --run
# ============================================================================
set -o pipefail   # (no 'set -u': bash 3.2 mishandles empty arrays under it; values are defaulted explicitly)
umask 077                      # every file/dir we create is owner-only
export LC_ALL=C
unset BASH_ENV ENV CDPATH IFS 2>/dev/null || true
PATH="/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin"; export PATH   # fixed PATH: no user-controlled lookup

EXIT_COMPLETE=0; EXIT_PARTIAL=10; EXIT_PREFLIGHT=20; EXIT_INTERRUPTED=30; EXIT_PACKAGING=40

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
CONF="$HERE/collector.conf"
PLAN_FILE="$HERE/collection-plan.json"

# ---------- counters / state (plain globals; never mutated in subshells) ----------
STATE="preflight"; CURRENT=""; STARTED_UTC=""; COLLECTED_BYTES=0
N_OK=0; N_PARTIAL=0; N_FAILED=0; N_SKIPPED=0; N_LIMIT_SKIPS=0
INTERRUPTED=0; TIMED_OUT=0
FAILURES=()                    # short failure summary lines (capped when written)
RUN_DIR=""; STAGE=""; WORK=""

# ---------- tiny helpers ----------
now_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { [ -n "$RUN_DIR" ] && [ -d "$RUN_DIR" ] && printf '%s %s\n' "$(now_utc)" "$*" >> "$RUN_DIR/run.log" 2>/dev/null; return 0; }
say() { printf '%s\n' "$*" >&2; }

# JSON string escaper. Drops control chars (except \t \n \r which are escaped) and invalid UTF-8 where iconv exists.
json_str() {
  local s="$1"
  s="$(printf '%sx' "$s" | tr -d '\000-\010\013\014\016-\037\177')"; s="${s%x}"
  if command -v iconv >/dev/null 2>&1; then s="$(printf '%sx' "$s" | iconv -f UTF-8 -t UTF-8 -c 2>/dev/null || printf '%sx' "$s")"; s="${s%x}"; fi
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\t'/\\t}"; s="${s//$'\n'/\\n}"; s="${s//$'\r'/\\r}"
  printf '"%s"' "$s"
}
json_or_null() { if [ -z "${1:-}" ]; then printf 'null'; else json_str "$1"; fi; }

if command -v shasum >/dev/null 2>&1; then HASH_CMD=(shasum -a 256)
elif command -v sha256sum >/dev/null 2>&1; then HASH_CMD=(sha256sum)
else HASH_CMD=(); fi
sha256_of() { "${HASH_CMD[@]}" < "$1" | cut -d' ' -f1; }   # via stdin: no filename parsing issues

# Replace anything outside a conservative set; used for destination path components.
safe_name() {
  local n="$1"
  n="$(printf '%s' "$n" | tr -c 'A-Za-z0-9._-' '_')"
  case "$n" in ""|"."|"..") n="_$n";; esac
  printf '%s' "${n:0:100}"
}

# ---------- config (data only) ----------
CFG_ARTIFACTS=(); CFG_USERS=(); CFG_CUSTOM=(); CFG_SENSITIVE=()
load_conf() {
  [ -r "$CONF" ] || return 1
  local k v
  while IFS=$'\t' read -r k v || [ -n "$k" ]; do
    case "$k" in
      schema) ;;
      plan_id) CFG_PLAN_ID="$v";;            plan_digest) CFG_PLAN_DIGEST="$v";;
      catalog_version) CFG_CATALOG="$v";;    generator_version) CFG_GENERATOR="$v";;
      target_os) CFG_OS="$v";;               output_root) CFG_OUTPUT_ROOT="$v";;
      user_scope) CFG_USER_SCOPE="$v";;      user_name) CFG_USERS+=("$v");;
      include_system_profiles) CFG_SYSPROF="$v";;
      time_mode) CFG_TIME_MODE="$v";;        time_days) CFG_TIME_DAYS="$v";;
      time_start) CFG_TIME_START="$v";;      time_end) CFG_TIME_END="$v";;
      per_file_bytes) CFG_PER_FILE="$v";;    total_bytes) CFG_TOTAL="$v";;
      archive_part_bytes) CFG_PART="$v";;    free_space_reserve_bytes) CFG_RESERVE="$v";;
      max_archive_parts) CFG_MAXPARTS="$v";; runtime_seconds) CFG_RUNTIME="$v";;
      artifact) CFG_ARTIFACTS+=("$v");;      custom_path) CFG_CUSTOM+=("$v");;
      sensitive) CFG_SENSITIVE+=("$v");;     execution_mode) CFG_EXEC_MODE="$v";;
      "") ;;
      *) say "unknown config key ignored: $k";;
    esac
  done < "$CONF"
  for req in CFG_PLAN_ID CFG_PLAN_DIGEST CFG_OS CFG_OUTPUT_ROOT CFG_USER_SCOPE CFG_TIME_MODE CFG_PER_FILE CFG_TOTAL CFG_PART CFG_RESERVE CFG_MAXPARTS CFG_RUNTIME; do
    [ -n "${!req:-}" ] || { say "config missing $req"; return 1; }   # indirect expansion of a fixed variable name from this script
  done
  case "$CFG_PER_FILE$CFG_TOTAL$CFG_PART$CFG_RESERVE$CFG_MAXPARTS$CFG_RUNTIME" in *[!0-9]*) say "non-numeric limit in config"; return 1;; esac
  return 0
}
selected() { local x; for x in "${CFG_ARTIFACTS[@]:-}"; do [ "$x" = "$1" ] && return 0; done; return 1; }
has_sensitive() { local x; for x in "${CFG_SENSITIVE[@]:-}"; do [ "$x" = "$1" ] && return 0; done; return 1; }

# ---------- status (atomic write: temp + mv) ----------
write_status() {
  [ -n "$RUN_DIR" ] || return 0
  local tmp="$RUN_DIR/.status.tmp.$$" i out="" n=0
  for i in "${FAILURES[@]:-}"; do [ -z "$i" ] && continue; n=$((n+1)); [ $n -gt 100 ] && break; out="$out${out:+,}$(json_str "${i:0:480}")"; done
  {
    printf '{"schemaVersion":1,"runId":%s,"planId":%s,"state":%s,"currentArtifact":%s,"startedUtc":%s,"updatedUtc":%s,"collectedBytes":%s,' \
      "$(json_str "$RUN_ID")" "$(json_str "$CFG_PLAN_ID")" "$(json_str "$STATE")" "$(json_or_null "$CURRENT")" "$(json_str "$STARTED_UTC")" "$(json_str "$(now_utc)")" "$COLLECTED_BYTES"
    printf '"counts":{"ok":%s,"partial":%s,"failed":%s,"skipped":%s},"failureSummary":[%s]}\n' "$N_OK" "$N_PARTIAL" "$N_FAILED" "$N_SKIPPED" "$out"
  } > "$tmp" 2>/dev/null && mv -f "$tmp" "$RUN_DIR/status.json"
}
add_failure() { FAILURES+=("$1"); }

# ---------- deadlines & signals ----------
COLLECT_DEADLINE=0
check_deadline() {
  [ "$INTERRUPTED" = 1 ] && return 1
  if [ "$SECONDS" -ge "$COLLECT_DEADLINE" ]; then TIMED_OUT=1; return 1; fi
  return 0
}
on_signal() { INTERRUPTED=1; log "signal received; finalizing what was collected"; }
trap on_signal INT TERM HUP

# ---------- manifest entries (NDJSON, one object per line) ----------
record() { # art profile source dest method outcome bytes sha err skip note timefilter(true/false)
  local art="$1" prof="$2" src="$3" dest="$4" method="$5" outcome="$6" bytes="${7:-0}" sha="${8:-}" err="${9:-}" skip="${10:-}" note="${11:-}" tf="${12:-false}"
  printf '{"artifactId":%s,"profile":%s,"sourcePath":%s,"destination":%s,"method":%s,"outcome":%s,"acquiredUtc":%s,"bytes":%s,"sha256":%s,"error":%s,"skipReason":%s,"consistencyNote":%s,"timeFilterApplied":%s}\n' \
    "$(json_str "$art")" "$(json_or_null "$prof")" "$(json_or_null "$src")" "$(json_or_null "$dest")" "$(json_str "$method")" "$(json_str "$outcome")" \
    "$(json_str "$(now_utc)")" "$bytes" "$(json_or_null "$sha")" "$(json_or_null "$err")" "$(json_or_null "$skip")" "$(json_or_null "$note")" "$tf" >> "$WORK/entries.ndjson"
  case "$outcome" in
    collected) N_OK=$((N_OK+1));;
    partial) N_PARTIAL=$((N_PARTIAL+1)); add_failure "$art: partial${err:+ - $err}";;
    failed) N_FAILED=$((N_FAILED+1)); add_failure "$art: failed${err:+ - $err}";;
    skipped) N_SKIPPED=$((N_SKIPPED+1)); case "$skip" in limit:*|interactive-users:*|named-account-not-found) N_LIMIT_SKIPS=$((N_LIMIT_SKIPS+1)); add_failure "$art: skipped (${skip})";; esac;;
  esac
}
skip() { record "$1" "${2:-}" "${3:-}" "" metadata skipped 0 "" "" "$4" ""; }
fail() { record "$1" "${2:-}" "${3:-}" "" metadata failed 0 "" "$4" "" ""; }

file_size() { if [ "$(uname -s)" = Darwin ]; then stat -f%z "$1"; else stat -c%s "$1"; fi; }
free_kb() { df -Pk "$1" | awk 'NR==2{print $4}'; }

# Is $1 inside (or equal to) the run directory? Prevents collecting our own output.
inside_run_dir() { case "$1/" in "$RUN_DIR"/*) return 0;; esac; return 1; }

# Map a cp/read error to an operator-friendly message (macOS privacy controls are called out).
explain_error() {
  case "$1" in
    *"Operation not permitted"*) [ "$(uname -s)" = Darwin ] && printf 'Blocked by macOS privacy controls (TCC) or system protection; Full Disk Access must be granted by the organization to the executing process.' || printf 'Operation not permitted';;
    *"Permission denied"*) printf 'Permission denied (insufficient privilege)';;
    *) printf '%s' "${1:0:200}";;
  esac
}

# Copy one regular file into staging with all guard rails. Never follows symlinks, never truncates.
copy_file() { # art profile src destrel [note] [tf]
  local art="$1" prof="$2" src="$3" rel="$4" note="${5:-}" tf="${6:-false}" size dest err sha
  CURRENT="$art"
  check_deadline || { skip "$art" "$prof" "$src" "limit:runtime-budget"; return 1; }
  if [ -L "$src" ]; then skip "$art" "$prof" "$src" "symlink-not-followed"; return 1; fi
  if [ ! -e "$src" ]; then skip "$art" "$prof" "$src" "source-not-present"; return 1; fi
  if [ ! -f "$src" ]; then skip "$art" "$prof" "$src" "not-a-regular-file"; return 1; fi
  if inside_run_dir "$src"; then skip "$art" "$prof" "$src" "inside-output-directory"; return 1; fi
  # No access() pre-check: it hides the real cause (e.g. macOS TCC returns EPERM). The cp below reports the true error.
  size="$(file_size "$src" 2>/dev/null || echo 0)"
  if [ "$size" -gt "$CFG_PER_FILE" ]; then skip "$art" "$prof" "$src" "limit:per-file-bytes (${size} > ${CFG_PER_FILE})"; return 1; fi
  if [ $((COLLECTED_BYTES + size)) -gt "$CFG_TOTAL" ]; then skip "$art" "$prof" "$src" "limit:total-bytes"; return 1; fi
  if [ $(( $(free_kb "$RUN_DIR") * 1024 )) -lt $((CFG_RESERVE + size)) ]; then skip "$art" "$prof" "$src" "limit:free-space-reserve"; return 1; fi
  dest="$STAGE/$rel"
  local n=1; while [ -e "$dest" ]; do dest="$STAGE/$rel.$n"; n=$((n+1)); done      # never overwrite
  mkdir -p "$(dirname "$dest")" 2>/dev/null
  if ! err="$(cp -p -- "$src" "$dest" 2>&1)"; then fail "$art" "$prof" "$src" "$(explain_error "$err")"; rm -f -- "$dest"; return 1; fi
  sha="$(sha256_of "$dest")"
  COLLECTED_BYTES=$((COLLECTED_BYTES + size))
  record "$art" "$prof" "$src" "${dest#"$STAGE"/}" copy collected "$size" "$sha" "" "" "$note" "$tf"
  return 0
}

# Run a fixed command, capture stdout into staging, bounded in bytes and time. Output is labelled partial if truncated.
# Usage: cmd_to_file ART PROFILE DESTREL METHOD NOTE TIMEFILTER -- cmd args...
cmd_to_file() {
  local art="$1" prof="$2" rel="$3" method="$4" note="$5" tf="$6"; shift 7
  CURRENT="$art"
  check_deadline || { skip "$art" "$prof" "" "limit:runtime-budget"; return 1; }
  local dest="$STAGE/$rel" errf="$WORK/cmd.err" rem cap limit pid
  mkdir -p "$(dirname "$dest")" 2>/dev/null
  limit="$CFG_PER_FILE"; [ $((CFG_TOTAL - COLLECTED_BYTES)) -lt "$limit" ] && limit=$((CFG_TOTAL - COLLECTED_BYTES))
  if [ "$limit" -le 0 ]; then skip "$art" "$prof" "" "limit:total-bytes"; return 1; fi
  if ! command -v "$1" >/dev/null 2>&1; then fail "$art" "$prof" "$1" "required utility not found: $1"; return 1; fi
  rem=$((COLLECT_DEADLINE - SECONDS)); cap=300; [ "$rem" -lt "$cap" ] && cap="$rem"; [ "$cap" -lt 1 ] && cap=1
  ( "$@" 2>"$errf" | head -c $((limit + 1)) > "$dest" ) &
  pid=$!
  local waited=0
  while kill -0 "$pid" 2>/dev/null; do
    sleep 1; waited=$((waited+1))
    if [ "$waited" -ge "$cap" ] || [ "$INTERRUPTED" = 1 ]; then
      pkill -TERM -P "$pid" 2>/dev/null; kill -TERM "$pid" 2>/dev/null; TIMED_OUT=1; wait "$pid" 2>/dev/null
      local sz0; sz0="$(file_size "$dest" 2>/dev/null || echo 0)"
      record "$art" "$prof" "$1" "$rel" "$method" partial "$sz0" "$(sha256_of "$dest")" "command did not finish within its time allowance; output is incomplete" "" "$note" "$tf"
      COLLECTED_BYTES=$((COLLECTED_BYTES + sz0)); return 1
    fi
  done
  wait "$pid" 2>/dev/null
  local sz; sz="$(file_size "$dest" 2>/dev/null || echo 0)"
  local errtxt=""; [ -s "$errf" ] && errtxt="$(head -c 300 "$errf" | tr '\n' ' ')"
  if [ "$sz" -gt "$limit" ]; then
    head -c "$limit" "$dest" > "$dest.tmp" && mv -f "$dest.tmp" "$dest"; sz="$limit"
    COLLECTED_BYTES=$((COLLECTED_BYTES + sz))
    record "$art" "$prof" "$1" "$rel" "$method" partial "$sz" "$(sha256_of "$dest")" "output truncated at size limit" "" "$note" "$tf"; return 1
  fi
  if [ "$sz" -eq 0 ] && [ -n "$errtxt" ]; then
    rm -f "$dest"; fail "$art" "$prof" "$1" "$(explain_error "$errtxt")"; return 1
  fi
  COLLECTED_BYTES=$((COLLECTED_BYTES + sz))
  record "$art" "$prof" "$1" "$rel" "$method" collected "$sz" "$(sha256_of "$dest")" "${errtxt:+warnings: $errtxt}" "" "$note" "$tf"
  return 0
}

# Copy files of a directory (bounded depth), NUL-delimited so odd filenames are safe.
copy_tree() { # art profile srcdir destreldir maxdepth [note] [name-filter]
  local art="$1" prof="$2" dir="$3" reldir="$4" depth="$5" note="${6:-}" nameflt="${7:-}" f rel
  if [ -L "$dir" ]; then skip "$art" "$prof" "$dir" "symlink-not-followed"; return 0; fi
  if [ ! -d "$dir" ]; then skip "$art" "$prof" "$dir" "source-not-present"; return 0; fi
  if [ ! -r "$dir" ] || [ ! -x "$dir" ]; then fail "$art" "$prof" "$dir" "$(explain_error 'Permission denied')"; return 0; fi
  while IFS= read -r -d '' f; do
    check_deadline || { skip "$art" "$prof" "$dir" "limit:runtime-budget"; break; }
    rel="${f#"$dir"/}"
    rel="$(printf '%s' "$rel" | tr -c 'A-Za-z0-9._/-' '_')"          # sanitize every component
    rel="$(printf '%s' "$rel" | sed -e 's#\.\./#_/#g' -e 's#^/*##')"
    copy_file "$art" "$prof" "$f" "$reldir/$rel" "$note"
  done < <(if [ -n "$nameflt" ]; then find -P "$dir" -maxdepth "$depth" -type f -name "$nameflt" -print0 2>/dev/null; else find -P "$dir" -maxdepth "$depth" -type f -print0 2>/dev/null; fi)
  return 0
}

# Fallback: the calling identity's own crontab, used when system crontabs are unreadable. Normal, permitted `crontab -l`; no bypass.
FALLBACK_NOTE="FALLBACK: partial information only (current identity's own crontab), because system crontabs need elevation"
crontab_fallback() { # art destrel
  command -v crontab >/dev/null 2>&1 || { skip "$1" "" "crontab" "fallback-unavailable:no-crontab-utility"; return; }
  if crontab -l >/dev/null 2>&1; then cmd_to_file "$1" "$ID_USER" "$2" snapshot "$FALLBACK_NOTE" false -- crontab -l
  else skip "$1" "$ID_USER" "crontab -l" "fallback-no-crontab-for-identity"; fi
}

# ---------- identity & profile discovery ----------
PROFILE_NAMES=(); PROFILE_HOMES=(); PROFILE_KIND=()
INTERACTIVE_NOTE=""
# discover_accounts is defined per-OS (needs dscl vs /etc/passwd). It must call add_profile NAME HOME KIND(normal|system).
add_profile() { PROFILE_NAMES+=("$1"); PROFILE_HOMES+=("$2"); PROFILE_KIND+=("$3"); }

select_profiles() { # filters discovered accounts into SEL_NAMES/SEL_HOMES according to plan scope
  SEL_NAMES=(); SEL_HOMES=()
  local i n u match
  for i in "${!PROFILE_NAMES[@]}"; do
    n="${PROFILE_NAMES[$i]}"
    case "$CFG_USER_SCOPE" in
      all-normal)
        if [ "${PROFILE_KIND[$i]}" = normal ] || [ "$CFG_SYSPROF" = 1 ]; then SEL_NAMES+=("$n"); SEL_HOMES+=("${PROFILE_HOMES[$i]}"); fi;;
      named)
        match=0; for u in "${CFG_USERS[@]:-}"; do [ "$u" = "$n" ] && match=1; done
        [ "$match" = 1 ] && { SEL_NAMES+=("$n"); SEL_HOMES+=("${PROFILE_HOMES[$i]}"); };;
      interactive)
        for u in "${INTERACTIVE_USERS[@]:-}"; do [ -n "$u" ] && [ "$u" = "$n" ] && { SEL_NAMES+=("$n"); SEL_HOMES+=("${PROFILE_HOMES[$i]}"); }; done;;
    esac
  done
  if [ "$CFG_USER_SCOPE" = named ]; then       # report requested names that do not exist
    for u in "${CFG_USERS[@]:-}"; do
      [ -z "$u" ] && continue
      match=0; for n in "${PROFILE_NAMES[@]:-}"; do [ "$n" = "$u" ] && match=1; done
      [ "$match" = 0 ] && { skip "user-discovery" "$u" "" "named-account-not-found"; }
    done
  fi
  if [ "$CFG_USER_SCOPE" = interactive ] && [ "${#SEL_NAMES[@]}" -ne 1 ]; then
    local ni=0 iu; for iu in "${INTERACTIVE_USERS[@]:-}"; do [ -n "$iu" ] && ni=$((ni+1)); done
    INTERACTIVE_NOTE="interactive-user discovery found $ni interactive account(s); per-user artifacts were NOT collected. Use 'named' scope."
    SEL_NAMES=(); SEL_HOMES=()
    record "user-discovery" "" "" "" metadata skipped 0 "" "" "interactive-users:$ni (expected exactly 1)" ""
    add_failure "$INTERACTIVE_NOTE"
  fi
}

# Run $1 (a function name defined in this script) for each selected profile with NAME/HOME globals set.
# (Function name comes from this script's own code, never from plan data.)
for_each_profile() {
  local i
  for i in "${!SEL_NAMES[@]}"; do
    check_deadline || return 0
    P_NAME="${SEL_NAMES[$i]}"; P_HOME="${SEL_HOMES[$i]}"; P_SAFE="$(safe_name "$P_NAME")"
    if [ ! -d "$P_HOME" ]; then skip "$ART_CUR" "$P_NAME" "$P_HOME" "profile-home-missing"; continue; fi
    "$1"
  done
}

# ---------- artifact dispatch (static function-name allowlist) ----------
run_artifact() {
  local id="$1" fn
  fn="art_$(printf '%s' "$id" | tr '.-' '__')"
  case "$fn" in *[!a-z0-9_]*) fail "$id" "" "" "invalid artifact id"; return;; esac
  if [ "$(type -t "$fn")" = function ]; then ART_CUR="$id"; CURRENT="$id"; write_status; "$fn"
  else skip "$id" "" "" "collector-not-implemented-for-this-os"; fi
}

run_custom_paths() {
  local p i=0
  for p in "${CFG_CUSTOM[@]:-}"; do
    [ -z "$p" ] && continue
    i=$((i+1))
    check_deadline || break
    # literal path only; refuse anything containing glob metacharacters even though the schema already forbids them
    case "$p" in *'*'*|*'?'*|*'['*) skip "custom" "" "$p" "glob-not-supported"; continue;; esac
    copy_file "custom" "" "$p" "custom/$(printf '%03d' "$i")_$(safe_name "$(basename "$p")")" "operator-supplied path"
  done
}

# ---------- preflight ----------
PRE_FAIL=()
pre_fail() { PRE_FAIL+=("$1"); }
preflight() {
  [ "${#HASH_CMD[@]}" -gt 0 ] || pre_fail "no SHA-256 utility (shasum/sha256sum)"
  for t in tar gzip awk df find sed tr cut head cp mv stat date od; do command -v "$t" >/dev/null 2>&1 || pre_fail "missing required utility: $t"; done
  EXPECT_OS=Linux; [ "$CFG_OS" = macos ] && EXPECT_OS=Darwin
  [ "$(uname -s)" = "$EXPECT_OS" ] || pre_fail "plan targets $CFG_OS but host is $(uname -s)"
  if [ -r "$PLAN_FILE" ] && [ "${#HASH_CMD[@]}" -gt 0 ]; then
    [ "$(sha256_of "$PLAN_FILE")" = "$CFG_PLAN_DIGEST" ] || pre_fail "collection-plan.json digest does not match collector.conf (package altered?)"
  else pre_fail "collection-plan.json missing"; fi
  ID_USER="$(id -un 2>/dev/null)"; ID_UID="$(id -u 2>/dev/null)"; ELEVATED=false; [ "$ID_UID" = 0 ] && ELEVATED=true
  case "$CFG_OUTPUT_ROOT" in /*) ;; *) pre_fail "output root must be absolute";; esac
  [ -L "$CFG_OUTPUT_ROOT" ] && pre_fail "output root is a symlink"
  if [ ! -d "$CFG_OUTPUT_ROOT" ]; then mkdir -p "$CFG_OUTPUT_ROOT" 2>/dev/null || pre_fail "cannot create output root"; chmod 700 "$CFG_OUTPUT_ROOT" 2>/dev/null; fi
  [ -d "$CFG_OUTPUT_ROOT" ] && [ -w "$CFG_OUTPUT_ROOT" ] || pre_fail "output root not writable"
  if [ -d "$CFG_OUTPUT_ROOT" ]; then
    local perms; perms="$(ls -ld "$CFG_OUTPUT_ROOT" | cut -c5-10)"       # group/other bits
    [ "$perms" = "------" ] || { chmod 700 "$CFG_OUTPUT_ROOT" 2>/dev/null; perms="$(ls -ld "$CFG_OUTPUT_ROOT" | cut -c5-10)"; [ "$perms" = "------" ] || pre_fail "cannot restrict output root permissions (needed for selected data)"; }
    local fk; fk="$(free_kb "$CFG_OUTPUT_ROOT" 2>/dev/null || echo 0)"
    [ $((fk * 1024)) -ge "$CFG_RESERVE" ] || pre_fail "free space below configured reserve"
  fi
  # catalog items that need elevation: warn but do not fail (recorded per-artifact at collection time)
}
