#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$ROOT_DIR/test/tmp/integration"
LOG_DIR="$TMP_DIR/logs"
SERVER_IN="$TMP_DIR/server.in"
SERVER_LOG="$LOG_DIR/server.log"
CLIENT1_LOG="$LOG_DIR/client1.log"
CLIENT2_LOG="$LOG_DIR/client2.log"
FILE_TO_SEND="$TMP_DIR/sample.txt"
PORT=19000
UDP_PORT=19001

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}

trap cleanup EXIT

rm -rf "$TMP_DIR" "$ROOT_DIR/data" "$ROOT_DIR/downloads"
mkdir -p "$LOG_DIR"
printf 'integration file payload\n' > "$FILE_TO_SEND"
mkfifo "$SERVER_IN"

"$ROOT_DIR/server_app" "$PORT" "$UDP_PORT" < "$SERVER_IN" > "$SERVER_LOG" 2>&1 &
SERVER_PID=$!
exec 9>"$SERVER_IN"
sleep 1

{
  printf '1\nuser2\npw2\n'
  printf '2\nuser2\npw2\n'
  printf '1\n'
  sleep 6
  printf '6\n'
} | "$ROOT_DIR/client_app" 127.0.0.1 "$PORT" "$UDP_PORT" > "$CLIENT2_LOG" 2>&1 &
CLIENT2_PID=$!
sleep 1

cat > "$TMP_DIR/client1.in" <<EOF_CLIENT1
1
user1
pw1
2
user1
pw1
1
2
user2
hello-private
3
hello-group
4
user2
$FILE_TO_SEND
6
EOF_CLIENT1

"$ROOT_DIR/client_app" 127.0.0.1 "$PORT" "$UDP_PORT" < "$TMP_DIR/client1.in" > "$CLIENT1_LOG" 2>&1 &
CLIENT1_PID=$!

sleep 2
printf '/broadcast integration-broadcast\n' >&9

wait "$CLIENT1_PID"
wait "$CLIENT2_PID"

printf '/quit\n' >&9
exec 9>&-
wait "$SERVER_PID"
SERVER_PID=""

grep -q "注册成功" "$CLIENT1_LOG"
grep -q "登录成功" "$CLIENT1_LOG"
grep -q "user2" "$CLIENT1_LOG"
grep -q "hello-private" "$CLIENT2_LOG"
grep -q "hello-group" "$CLIENT2_LOG"
grep -q "integration-broadcast" "$CLIENT1_LOG"
grep -q "integration-broadcast" "$CLIENT2_LOG"
grep -q "integration file payload" "$ROOT_DIR/downloads/user1_sample.txt"

echo "integration tests passed"
