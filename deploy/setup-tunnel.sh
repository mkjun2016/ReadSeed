#!/bin/bash
# ReadSeed 공개 주소 연결(한 번만). 이 맥의 서버를 Cloudflare Tunnel로 도메인에 잇는다.
#   ./deploy/setup-tunnel.sh read.example.com
# 먼저 그 도메인이 Cloudflare 계정에 추가돼 있고 `cloudflared tunnel login`을 마쳐야 한다.
# 이 맥에 있는 다른 터널(~/.cloudflared/config.yml)은 건드리지 않는다.
set -euo pipefail
HOST="${1:?사용법: $0 <공개 주소, 예: read.example.com>}"
NAME="${TUNNEL_NAME:-readseed}"
PORT="${READSEED_PORT:-8787}"
HERE="$(cd "$(dirname "$0")" && pwd)"

if ! cloudflared tunnel list -o json 2>/dev/null | grep -q "\"name\":\"$NAME\""; then
  cloudflared tunnel create "$NAME"
fi
ID="$(cloudflared tunnel list -o json 2>/dev/null | python3 -c "import json,sys; print(next(t['id'] for t in json.load(sys.stdin) if t['name']=='$NAME'))")"

cat > "$HERE/cloudflared.yml" <<YAML
# setup-tunnel.sh가 만든 파일(커밋하지 않음). 비밀 값은 credentials-file 안에만 있다.
tunnel: $ID
credentials-file: $HOME/.cloudflared/$ID.json
ingress:
  - hostname: $HOST
    service: http://127.0.0.1:$PORT
  - service: http_status:404
YAML
echo "$HOST" > "$HERE/.public-host"

cloudflared tunnel route dns "$NAME" "$HOST"
echo "연결 준비 끝: https://$HOST/app/  →  ./deploy/serve.sh 로 켜세요."
