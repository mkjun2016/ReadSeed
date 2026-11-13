#!/bin/bash
# ReadSeed를 공개 주소로 켠다. 이 창을 닫거나 Ctrl+C를 누르면 서버와 터널이 함께 꺼진다.
# 켜져 있는 동안 맥이 잠들지 않게 한다(덮개를 닫으면 꺼지니 열어 둔다).
#   ./deploy/serve.sh
# 바꿀 수 있는 값(환경 변수): AI_DAILY_LIMIT(기본 100), RATE_LIMIT_PER_MINUTE(기본 240), READSEED_PORT(기본 8787)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HERE="$ROOT/deploy"
[ -f "$HERE/cloudflared.yml" ] || { echo "먼저 ./deploy/setup-tunnel.sh <주소> 를 실행하세요."; exit 1; }
HOST="$(cat "$HERE/.public-host")"
PORT="${READSEED_PORT:-8787}"

export PUBLIC_MODE=1
export ALLOWED_ORIGINS="https://$HOST"
export RATE_LIMIT_PER_MINUTE="${RATE_LIMIT_PER_MINUTE:-240}"
export AI_DAILY_LIMIT="${AI_DAILY_LIMIT:-100}"

cd "$ROOT/backend"
# 접속 기록에는 주소(경로)만 남고 보낸 글은 남지 않는다.
caffeinate -dims "$ROOT/.venv/bin/python" -m uvicorn api:app --host 127.0.0.1 --port "$PORT" --log-level warning &
SERVER=$!
cloudflared tunnel --no-autoupdate --config "$HERE/cloudflared.yml" run &
TUNNEL=$!
trap 'kill $SERVER $TUNNEL 2>/dev/null; wait' INT TERM EXIT

for _ in $(seq 1 60); do curl -fs "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 1; done
echo "ReadSeed 켜짐: https://$HOST/app/  (하루 AI 상한 $AI_DAILY_LIMIT회, 주소당 1분 $RATE_LIMIT_PER_MINUTE회)"
wait
