#!/usr/bin/env bash
# Idempotent Konnect bootstrap for the local data plane:
#   1. find (or create) the hybrid control plane named $KONNECT_CP_NAME
#   2. generate a DP client certificate once and pin it on the control plane
#   3. write cluster endpoints + certs to $OUT for the kong-dp container
set -euo pipefail

# Token: KONNECT_PAT env var, else the compose secret (KONNECT_PAT_FILE, default ~/.kong/kpat).
if [[ -z "${KONNECT_PAT:-}" && -f /run/secrets/konnect_pat ]]; then
  KONNECT_PAT=$(tr -d '[:space:]' < /run/secrets/konnect_pat)
fi
: "${KONNECT_PAT:?No Konnect token: put it in ~/.kong/kpat (or set KONNECT_PAT_FILE / KONNECT_PAT)}"
REGION="${KONNECT_REGION:-us}"
CP_NAME="${KONNECT_CP_NAME:-ipaas-local}"
OUT="${OUT:-/certs}"
API="https://${REGION}.api.konghq.com/v2"

konnect() {
  local method=$1 path=$2 body=${3:-}
  local args=(-sS -X "$method" -H "Authorization: Bearer ${KONNECT_PAT}" -H 'Content-Type: application/json' -w '\n%{http_code}')
  [[ -n "$body" ]] && args+=(--data "$body")
  local res code
  res=$(curl "${args[@]}" "${API}${path}")
  code=${res##*$'\n'}
  res=${res%$'\n'*}
  if [[ "$code" -ge 300 ]]; then
    echo "Konnect ${method} ${path} failed (${code}): ${res}" >&2
    return 1
  fi
  printf '%s' "$res"
}

echo "==> Looking up control plane '${CP_NAME}' in region ${REGION}"
cp=$(konnect GET "/control-planes?filter%5Bname%5D%5Beq%5D=$(jq -rn --arg n "$CP_NAME" '$n|@uri')" | jq '.data[0] // empty')
if [[ -z "$cp" ]]; then
  echo "==> Creating hybrid control plane '${CP_NAME}'"
  cp=$(konnect POST /control-planes "$(jq -n --arg n "$CP_NAME" '{name: $n, description: "iPaaS flow builder (local docker compose)", cluster_type: "CLUSTER_TYPE_CONTROL_PLANE", auth_type: "pinned_client_certs", labels: {app: "ipaas"}}')")
fi
CP_ID=$(jq -r .id <<<"$cp")
CP_EP=$(jq -r '.config.control_plane_endpoint' <<<"$cp" | sed -E 's#^https?://##')
TP_EP=$(jq -r '.config.telemetry_endpoint' <<<"$cp" | sed -E 's#^https?://##')
echo "    control plane id: ${CP_ID}"

mkdir -p "$OUT"
if [[ -f "$OUT/tls.crt" && -f "$OUT/cp_id" && "$(cat "$OUT/cp_id")" == "$CP_ID" ]]; then
  echo "==> Reusing existing DP certificate"
else
  echo "==> Generating DP client certificate"
  openssl req -new -x509 -nodes -newkey ec -pkeyopt ec_paramgen_curve:secp384r1 \
    -keyout "$OUT/tls.key" -out "$OUT/tls.crt" -days 1095 -subj "/CN=ipaas-kong-dp" 2>/dev/null
fi

# Pin the certificate unless Konnect already has it (e.g. after a re-run).
cert=$(cat "$OUT/tls.crt")
pinned=$(konnect GET "/control-planes/${CP_ID}/dp-client-certificates" | jq --arg c "$cert" '[.items[]?, .data[]? | select((.cert | gsub("\\s";"")) == ($c | gsub("\\s";"")))] | length')
if [[ "$pinned" == "0" ]]; then
  echo "==> Pinning DP certificate on the control plane"
  konnect POST "/control-planes/${CP_ID}/dp-client-certificates" "$(jq -n --arg c "$cert" '{cert: $c}')" >/dev/null
fi

printf '%s' "$CP_ID" > "$OUT/cp_id"
cat > "$OUT/cluster.env" <<ENV
export KONG_CLUSTER_CONTROL_PLANE=${CP_EP}:443
export KONG_CLUSTER_SERVER_NAME=${CP_EP}
export KONG_CLUSTER_TELEMETRY_ENDPOINT=${TP_EP}:443
export KONG_CLUSTER_TELEMETRY_SERVER_NAME=${TP_EP}
ENV
# kong runs as uid 1001 inside its image
chown -R 1001:1001 "$OUT" && chmod 600 "$OUT/tls.key"
echo "==> Bootstrap complete"
