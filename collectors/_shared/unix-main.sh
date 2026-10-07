# ============================================================================
# Main flow (appended after the OS-specific artifact functions)
# ============================================================================

usage() {
  cat >&2 <<USAGE
Usage: /bin/bash collector.sh --run                 collect according to collection-plan.json
       /bin/bash collector.sh --preflight-only      run preflight checks and exit (no collection)
       /bin/bash collector.sh --cleanup <run-dir> --yes   delete a collector-owned run directory
Exit codes: 0 complete | 10 partial | 20 preflight failure | 30 interrupted/timeout | 40 packaging failure
USAGE
}

# ---- cleanup: only a validated, collector-owned run directory; never arbitrary paths ----
do_cleanup() {
  local dir="$1" yes="$2" base owner
  [ "$yes" = 1 ] || { say "refusing: --yes is required"; return 2; }
  [ -n "$dir" ] && [ -d "$dir" ] || { say "not a directory: $dir"; return 2; }
  [ -L "$dir" ] && { say "refusing: run directory is a symlink"; return 2; }
  dir="$(cd "$dir" && pwd -P)" || return 2
  base="$(basename "$dir")"
  case "$base" in run-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;; *) say "refusing: name does not look like a collector run directory"; return 2;; esac
  [ -f "$dir/.eec-run-owner" ] || { say "refusing: ownership marker missing"; return 2; }
  owner="$(cat "$dir/.eec-run-owner" 2>/dev/null)"
  [ "$owner" = "$base" ] || { say "refusing: ownership marker does not match directory name"; return 2; }
  rm -rf -- "$dir" && say "removed $dir (ordinary deletion; this is NOT secure erasure)"
}

# ---- user/profile discovery is OS-specific (see artifacts file) ----

# ---- packaging: independently readable tar.gz parts + external retrieval index ----
package_run() {
  STATE="packaging"; CURRENT=""; write_status
  local files="$WORK/files.txt" part_no=0 part_bytes=0 part_members=0 listf size f partname
  ( cd "$STAGE" && find . -type f | LC_ALL=C sort | sed 's#^\./##' ) > "$files"
  PARTS_JSON=""; FAILED_PARTS=(); PACK_OK=1
  local fk; fk="$(free_kb "$RUN_DIR")"
  if [ $((fk * 1024)) -lt $((COLLECTED_BYTES + CFG_RESERVE)) ]; then
    FAILED_PARTS+=("insufficient free space for packaging"); add_failure "packaging: insufficient free space"; PACK_OK=0; return 1
  fi
  [ "$(uname -s)" = Darwin ] && export COPYFILE_DISABLE=1
  listf=""
  flush_part() {
    [ -n "$listf" ] && [ "$part_members" -gt 0 ] || return 0
    partname="$(printf 'part-%03d.tar.gz' "$part_no")"
    if tar -czf "$RUN_DIR/$partname" -C "$STAGE" -T "$listf" 2>>"$WORK/tar.err"; then
      local pb ph; pb="$(file_size "$RUN_DIR/$partname")"; ph="$(sha256_of "$RUN_DIR/$partname")"
      PARTS_JSON="$PARTS_JSON${PARTS_JSON:+,}{\"name\":$(json_str "$partname"),\"bytes\":$pb,\"sha256\":\"$ph\",\"members\":$part_members}"
    else
      FAILED_PARTS+=("$partname"); PACK_OK=0; add_failure "packaging: $partname failed"
    fi
    rm -f "$listf"; listf=""; part_members=0; part_bytes=0
  }
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    size="$(file_size "$STAGE/$f")"
    if [ -n "$listf" ] && [ $((part_bytes + size)) -gt "$CFG_PART" ]; then flush_part; fi
    if [ -z "$listf" ]; then
      part_no=$((part_no+1))
      if [ "$part_no" -gt "$CFG_MAXPARTS" ]; then FAILED_PARTS+=("limit:max-archive-parts exceeded; remaining files not packaged"); PACK_OK=0; add_failure "packaging: max archive parts exceeded"; break; fi
      listf="$WORK/list-$part_no.txt"; : > "$listf"
    fi
    printf '%s\n' "$f" >> "$listf"; part_members=$((part_members+1)); part_bytes=$((part_bytes+size))
  done < "$files"
  flush_part
  [ "$PACK_OK" = 1 ]
}

write_manifest_and_index() {
  local fin_state="$1" mf="$RUN_DIR/manifest.json" entries first=1 line
  {
    printf '{"schemaVersion":1,"runId":%s,"planId":%s,"planDigest":%s,"catalogVersion":%s,"generatorVersion":%s,"targetOs":%s,' \
      "$(json_str "$RUN_ID")" "$(json_str "$CFG_PLAN_ID")" "$(json_str "$CFG_PLAN_DIGEST")" "$(json_str "$CFG_CATALOG")" "$(json_str "$CFG_GENERATOR")" "$(json_str "$CFG_OS")"
    printf '"host":{"name":%s,"osVersion":%s,"identity":%s,"elevated":%s},"startedUtc":%s,"finishedUtc":%s,"entries":[\n' \
      "$(json_str "$(hostname 2>/dev/null)")" "$(json_str "$OS_VERSION")" "$(json_str "$ID_USER")" "$ELEVATED" "$(json_str "$STARTED_UTC")" "$(json_str "$(now_utc)")"
    if [ -s "$WORK/entries.ndjson" ]; then sed '$!s/$/,/' "$WORK/entries.ndjson"; fi
    printf ']}\n'
  } > "$mf"
  local mh; mh="$(sha256_of "$mf")"
  local fp="" x; for x in "${FAILED_PARTS[@]:-}"; do [ -n "$x" ] && fp="$fp${fp:+,}$(json_str "$x")"; done
  printf '{"schemaVersion":1,"runId":%s,"planId":%s,"planDigest":%s,"finalizationState":%s,"manifestName":"manifest.json","manifestSha256":"%s","expectedParts":[%s],"failedParts":[%s]}\n' \
    "$(json_str "$RUN_ID")" "$(json_str "$CFG_PLAN_ID")" "$(json_str "$CFG_PLAN_DIGEST")" "$(json_str "$fin_state")" "$mh" "$PARTS_JSON" "$fp" > "$RUN_DIR/retrieval-index.json"
}

# ---- compute time window bounds (UTC, "YYYY-MM-DD HH:MM:SS") ----
compute_time_window() {
  TW_START=""; TW_END=""
  case "$CFG_TIME_MODE" in
    last-days) local now; now="$(date +%s)"; TW_END="$(fmt_epoch "$now")"; TW_START="$(fmt_epoch $((now - CFG_TIME_DAYS * 86400)))";;
    range) TW_START="${CFG_TIME_START%Z}"; TW_START="${TW_START/T/ }"; TW_START="${TW_START%.*}"
           TW_END="${CFG_TIME_END%Z}"; TW_END="${TW_END/T/ }"; TW_END="${TW_END%.*}";;
  esac
}

main() {
  local mode="" cleanup_dir="" yes=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --run) mode=run;; --preflight-only) mode=pre;;
      --cleanup) mode=cleanup; shift; cleanup_dir="${1:-}";; --yes) yes=1;;
      -h|--help) usage; exit 0;; *) usage; exit 2;;
    esac; shift
  done
  [ -n "$mode" ] || { usage; exit 2; }
  if [ "$mode" = cleanup ]; then do_cleanup "$cleanup_dir" "$yes"; exit $?; fi

  load_conf || { say "PREFLIGHT FAILED: configuration unreadable or incomplete"; exit $EXIT_PREFLIGHT; }
  OS_VERSION="$(os_version_string)"
  preflight
  if [ "${#PRE_FAIL[@]}" -gt 0 ]; then
    say "PREFLIGHT FAILED:"; local m; for m in "${PRE_FAIL[@]}"; do say "  - $m"; done
    exit $EXIT_PREFLIGHT
  fi
  say "Preflight OK: os=$OS_VERSION identity=$ID_USER elevated=$ELEVATED output_root=$CFG_OUTPUT_ROOT"
  [ "$mode" = pre ] && exit $EXIT_COMPLETE

  # ---- new run directory: never reuse, never overwrite ----
  STARTED_UTC="$(now_utc)"
  RUN_ID="run-$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
  RUN_DIR="$CFG_OUTPUT_ROOT/$RUN_ID"
  mkdir "$RUN_DIR" 2>/dev/null || { say "cannot create run directory (already exists or not writable)"; exit $EXIT_PREFLIGHT; }
  chmod 700 "$RUN_DIR"; RUN_DIR="$(cd "$RUN_DIR" && pwd -P)"
  printf '%s' "$RUN_ID" > "$RUN_DIR/.eec-run-owner"
  STAGE="$RUN_DIR/.staging"; WORK="$RUN_DIR/.work"; mkdir "$STAGE" "$WORK"; : > "$WORK/entries.ndjson"
  log "run started id=$RUN_ID plan=$CFG_PLAN_ID mode=$CFG_EXEC_MODE"
  # Receipt that a launcher/EDR can read immediately (status path + run id).
  printf '{"runId":%s,"runDirectory":%s,"statusPath":%s}\n' "$(json_str "$RUN_ID")" "$(json_str "$RUN_DIR")" "$(json_str "$RUN_DIR/status.json")" > "$RUN_DIR/launch-receipt.json"
  # Stable per-plan pointer so a background launch can be located without guessing the run id.
  cp -f "$RUN_DIR/launch-receipt.json" "$CFG_OUTPUT_ROOT/latest-$CFG_PLAN_ID.json" 2>/dev/null
  say "RUN_ID=$RUN_ID"; say "RUN_DIR=$RUN_DIR"; say "STATUS=$RUN_DIR/status.json"
  write_status

  # budget: leave time at the end for packaging / finalization
  local reserve=$((CFG_RUNTIME / 10)); [ "$reserve" -lt 15 ] && reserve=15; [ "$reserve" -ge "$CFG_RUNTIME" ] && reserve=$((CFG_RUNTIME / 2))
  COLLECT_DEADLINE=$((SECONDS + CFG_RUNTIME - reserve))

  STATE="collecting"; write_status
  compute_time_window
  discover_accounts
  INTERACTIVE_USERS=(); discover_interactive
  select_profiles

  # volatile first (timestamped in their manifest entries), then durable sources
  local id
  for id in "${CFG_ARTIFACTS[@]:-}"; do case "$id" in *.volatile.*) [ -n "$id" ] && { check_deadline && run_artifact "$id"; };; esac; done
  for id in "${CFG_ARTIFACTS[@]:-}"; do case "$id" in *.volatile.*|"") ;; *) check_deadline && run_artifact "$id";; esac; done
  check_deadline && run_custom_paths
  if [ "$INTERRUPTED" = 1 ]; then add_failure "run interrupted by signal; collection stopped early"; fi
  if [ "$TIMED_OUT" = 1 ]; then add_failure "runtime budget exhausted; collection stopped early"; fi

  # ---- packaging ----
  local pk=0; package_run || pk=1
  local final
  if [ "$pk" = 1 ]; then final="failed"
  elif [ "$INTERRUPTED" = 1 ]; then final="cancelled"
  elif [ "$TIMED_OUT" = 1 ] || [ "$N_PARTIAL" -gt 0 ] || [ "$N_FAILED" -gt 0 ] || [ "$N_LIMIT_SKIPS" -gt 0 ]; then final="partial"
  else final="complete"; fi
  write_manifest_and_index "$final"

  # remove plaintext staging only when every part was written; otherwise keep it for the operator
  if [ "$pk" = 0 ]; then rm -rf -- "$STAGE"; fi
  rm -rf -- "$WORK"
  STATE="$final"; CURRENT=""; write_status
  # completion marker only after successful finalization (manifest + index + parts written)
  if [ "$pk" = 0 ]; then printf '%s\n' "$final" > "$RUN_DIR/FINALIZED"; fi
  log "run finished state=$final"
  say "FINISHED state=$final bytes=$COLLECTED_BYTES ok=$N_OK partial=$N_PARTIAL failed=$N_FAILED skipped=$N_SKIPPED"
  say "Pull: $RUN_DIR/retrieval-index.json, manifest.json, status.json, part-*.tar.gz"
  if [ "$pk" = 1 ]; then exit $EXIT_PACKAGING; fi
  if [ "$INTERRUPTED" = 1 ] || [ "$TIMED_OUT" = 1 ]; then exit $EXIT_INTERRUPTED; fi
  [ "$final" = complete ] && exit $EXIT_COMPLETE
  exit $EXIT_PARTIAL
}
main "$@"
