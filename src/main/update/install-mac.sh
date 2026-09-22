#!/bin/sh
# All paths are positional arguments from the main process. Never eval user data.
set -u
umask 077
parent_pid=$1
current_app=$2
staged_app=$3
previous_app=$4
result_file=$5
health_file=$6
update_token=$7
lock_dir="${current_app}.update-lock"
write_result() { printf '%s\n' "$1" > "${result_file}.tmp" && /bin/mv -f "${result_file}.tmp" "$result_file"; }
# Handshake: the parent exits only after this helper is alive and holds the lock.
if ! /bin/mkdir "$lock_dir"; then write_result 'failed-lock'; exit 1; fi
trap 'exit 1' HUP INT TERM
trap '/bin/rmdir "$lock_dir" 2>/dev/null || true' EXIT
write_result 'ready'
count=0
while /bin/kill -0 "$parent_pid" 2>/dev/null; do
  count=$((count + 1))
  if [ "$count" -ge 90 ]; then write_result 'failed-still-running'; exit 1; fi
  /bin/sleep 1
done
if [ ! -d "$current_app" ] || [ ! -d "$staged_app" ] || [ -e "$previous_app" ]; then
  write_result 'failed-paths'; exit 1
fi
if ! /bin/mv "$current_app" "$previous_app"; then write_result 'failed-backup'; exit 1; fi
if ! /bin/mv "$staged_app" "$current_app"; then
  if /bin/mv "$previous_app" "$current_app"; then
    write_result 'rolled-back'; /usr/bin/open -n "$current_app" || true
  else write_result 'failed-rollback'; fi
  exit 1
fi
write_result 'installed'
if ! /usr/bin/open -n "$current_app" --args "--lithium-update-token=$update_token"; then
  # The new app could not be launched. Move it aside before restoring the old app.
  if /bin/mv "$current_app" "$staged_app" && /bin/mv "$previous_app" "$current_app"; then
    write_result 'rolled-back'; /usr/bin/open -n "$current_app" || true
  else write_result 'failed-rollback'; fi
  exit 1
fi
count=0
while [ ! -f "$health_file" ]; do
  count=$((count + 1))
  # No forced rollback after launch: the new app may already have migrated its DB.
  if [ "$count" -ge 90 ]; then write_result 'installed-unconfirmed'; exit 0; fi
  /bin/sleep 1
done
write_result 'succeeded'
