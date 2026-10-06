#!/usr/bin/env bash
# Removes everything this project configures, locally and in Konnect, then verifies it:
#   1. Konnect: the control plane if konnect-init created it (label app=ipaas);
#      otherwise only what the project put in it (entities tagged "ipaas", the
#      pinned DP certificate, the legacy "ipaas-db-connections" config store)
#   2. the db-access container started by the API (label ipaas.managed-by=api)
#   3. the compose stack: containers, network, volumes and built images
#   4. with --interop: containers, Maven cache and build output of tests/interop
# .env, secrets.env and the Konnect token are never touched.
set -euo pipefail
cd "$(dirname "$0")"

usage() {
  cat <<'USAGE'
Usage: ./cleanup.sh [options]
  -y, --yes       don't ask for confirmation
  --dry-run       show what would be deleted, delete nothing
  --verify        only check that nothing is left (exit 1 if something is)
  --keep-cp       never delete the Konnect control plane, only what is inside it
  --keep-images   keep the built ipaas-* images
  --local-only    skip Konnect
  --interop       also remove interop test containers, the ipaas-m2 volume and build output
USAGE
}

YES=0 DRY=0 VERIFY_ONLY=0 KEEP_CP=0 KEEP_IMAGES=0 LOCAL_ONLY=0 INTEROP=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes) YES=1 ;;
    --dry-run) DRY=1 ;;
    --verify) VERIFY_ONLY=1 ;;
    --keep-cp) KEEP_CP=1 ;;
    --keep-images) KEEP_IMAGES=1 ;;
    --local-only) LOCAL_ONLY=1 ;;
    --interop) INTEROP=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

PROJECT=ipaas
CP_STORE=ipaas-db-connections
INTEROP_CONTAINERS=(clockwork accord jxserver)
INTEROP_VOLUME=ipaas-m2
INTEROP_DIRS=(tests/interop/ebms-clockwork/dist tests/interop/ebms-clockwork/cpa
  tests/interop/oftp2-accord/lib tests/interop/oftp2-accord/target tests/interop/oftp2-accord/work
  tests/interop/jx/server/target)

# Reads one key from .env without sourcing it (the file may hold anything).
envval() { if [[ -f .env ]]; then sed -nE "s/^$1=[\"']?([^\"']*)[\"']?\$/\1/p" .env | tail -n1; fi; }
REGION="${KONNECT_REGION:-$(envval KONNECT_REGION)}"; REGION="${REGION:-us}"
CP_NAME="${KONNECT_CP_NAME:-$(envval KONNECT_CP_NAME)}"; CP_NAME="${CP_NAME:-ipaas-local}"
PAT_FILE="${KONNECT_PAT_FILE:-$(envval KONNECT_PAT_FILE)}"; PAT_FILE="${PAT_FILE:-$HOME/.kong/kpat}"
if [[ -z "${KONNECT_PAT:-}" && -f "$PAT_FILE" ]]; then
  KONNECT_PAT=$(tr -d '[:space:]' < "$PAT_FILE")
fi
API="https://${REGION}.api.konghq.com/v2"

# Same contract as infra/konnect-init/bootstrap.sh; a 404 on DELETE counts as done.
konnect() {
  local method=$1 path=$2 body=${3:-}
  local args=(-sS -X "$method" -H "Authorization: Bearer ${KONNECT_PAT}" -H 'Content-Type: application/json' -w '\n%{http_code}')
  [[ -n "$body" ]] && args+=(--data "$body")
  local res code
  res=$(curl "${args[@]}" "${API}${path}")
  code=${res##*$'\n'}
  res=${res%$'\n'*}
  if [[ "$method" == DELETE && "$code" == 404 ]]; then return 0; fi
  if [[ "$code" -ge 300 ]]; then
    echo "Konnect ${method} ${path} failed (${code}): ${res}" >&2
    return 1
  fi
  printf '%s' "$res"
}

run() {
  if [[ $DRY == 1 ]]; then echo "    would run: $*" >&2; else "$@"; fi
}

konnect_enabled() { [[ $LOCAL_ONLY == 0 && -n "${KONNECT_PAT:-}" ]]; }

cp_lookup() {
  konnect GET "/control-planes?filter%5Bname%5D%5Beq%5D=$(jq -rn --arg n "$CP_NAME" '$n|@uri')" | jq -c '.data[0] // empty'
}

# Tagged core entities of one type, as "id name" lines.
tagged() {
  konnect GET "/control-planes/$1/core-entities/$2?tags=ipaas&size=1000" | jq -r '.data[]? | "\(.id) \(.name // .prefix // "")"'
}

local_cert() {
  docker volume inspect "${PROJECT}_dp-certs" >/dev/null 2>&1 || return 0
  docker run --rm -v "${PROJECT}_dp-certs:/c:ro" alpine cat /c/tls.crt 2>/dev/null || true
}

# Pinned DP certificates this project created: the one matching our local certificate,
# or (when the volume is already gone) any with the subject CN=ipaas-kong-dp.
our_certs() {
  local cp=$1 cert=$2 list
  list=$(konnect GET "/control-planes/${cp}/dp-client-certificates")
  if [[ -n "$cert" ]]; then
    jq -r --arg c "$cert" '[.items[]?, .data[]?] | .[] | select((.cert | gsub("\\s";"")) == ($c | gsub("\\s";""))) | .id' <<<"$list"
  else
    local id pem
    for id in $(jq -r '[.items[]?, .data[]?] | .[].id' <<<"$list"); do
      pem=$(jq -r --arg id "$id" '[.items[]?, .data[]?] | .[] | select(.id == $id) | .cert' <<<"$list")
      if openssl x509 -noout -subject <<<"$pem" 2>/dev/null | grep -q 'CN *= *ipaas-kong-dp'; then echo "$id"; fi
    done
  fi
}

config_store_id() {
  konnect GET "/control-planes/$1/config-stores" | jq -r --arg n "$CP_STORE" '.data[]? | select(.name == $n) | .id'
}

cleanup_konnect() {
  if [[ $LOCAL_ONLY == 1 ]]; then echo "==> Konnect: skipped (--local-only)"; return; fi
  if [[ -z "${KONNECT_PAT:-}" ]]; then echo "!!  Konnect: no token (KONNECT_PAT or $PAT_FILE), skipped" >&2; return; fi
  echo "==> Konnect: control plane '${CP_NAME}' in region ${REGION}"
  local cp cp_id
  cp=$(cp_lookup)
  if [[ -z "$cp" ]]; then echo "    not found, nothing to do"; return; fi
  cp_id=$(jq -r .id <<<"$cp")

  if [[ $KEEP_CP == 0 && "$(jq -r '.labels.app // ""' <<<"$cp")" == ipaas ]]; then
    echo "    deleting control plane ${cp_id} (created by konnect-init: label app=ipaas)"
    [[ $DRY == 1 ]] || konnect DELETE "/control-planes/${cp_id}" >/dev/null
    return
  fi
  if [[ $KEEP_CP == 1 ]]; then
    echo "    keeping the control plane (--keep-cp)"
  else
    echo "    control plane has no label app=ipaas: keeping it, removing only ipaas entities"
  fi

  local kind id name
  # Children first, as in Deployer.undeploy: plugins -> routes -> services; then vaults.
  for kind in plugins routes services vaults; do
    while read -r id name; do
      [[ -z "$id" ]] && continue
      echo "    deleting ${kind%s} ${name:-$id}"
      [[ $DRY == 1 ]] || konnect DELETE "/control-planes/${cp_id}/core-entities/${kind}/${id}" >/dev/null
    done < <(tagged "$cp_id" "$kind")
  done

  local store key
  store=$(config_store_id "$cp_id")
  if [[ -n "$store" ]]; then
    echo "    deleting config store ${CP_STORE}"
    if [[ $DRY == 0 ]]; then
      # A store can only be deleted once it is empty.
      for key in $(konnect GET "/control-planes/${cp_id}/config-stores/${store}/secrets" | jq -r '.data[]?.key | @uri'); do
        konnect DELETE "/control-planes/${cp_id}/config-stores/${store}/secrets/${key}" >/dev/null
      done
      konnect DELETE "/control-planes/${cp_id}/config-stores/${store}" >/dev/null
    fi
  fi

  for id in $(our_certs "$cp_id" "$(local_cert)"); do
    echo "    unpinning DP certificate ${id}"
    [[ $DRY == 1 ]] || konnect DELETE "/control-planes/${cp_id}/dp-client-certificates/${id}" >/dev/null
  done
}

cleanup_local() {
  echo "==> Docker: containers started by the API"
  local ids
  ids=$(docker ps -aq --filter label=ipaas.managed-by=api)
  if [[ -n "$ids" ]]; then
    docker ps -a --filter label=ipaas.managed-by=api --format '{{.Names}}' | sed 's/^/    /'
    # shellcheck disable=SC2086
    run docker rm -f $ids >/dev/null
  fi

  echo "==> Docker: compose stack (containers, network, volumes$([[ $KEEP_IMAGES == 1 ]] || echo ', images'))"
  local down=(docker compose -p "$PROJECT" down -v --remove-orphans)
  [[ $KEEP_IMAGES == 1 ]] || down+=(--rmi local)
  run "${down[@]}"
  if [[ $KEEP_IMAGES == 0 ]]; then
    # Images with an explicit image: tag (db-access) are not covered by --rmi local.
    local img
    for img in $(docker images --filter "reference=${PROJECT}-*" --format '{{.Repository}}:{{.Tag}}'); do
      echo "    removing image ${img}"
      run docker rmi -f "$img" >/dev/null
    done
  fi

  if [[ $INTEROP == 1 ]]; then
    echo "==> Interop test leftovers"
    local c d
    for c in "${INTEROP_CONTAINERS[@]}"; do
      if docker container inspect "$c" >/dev/null 2>&1; then echo "    container $c"; run docker rm -f "$c" >/dev/null; fi
    done
    if docker volume inspect "$INTEROP_VOLUME" >/dev/null 2>&1; then echo "    volume $INTEROP_VOLUME"; run docker volume rm "$INTEROP_VOLUME" >/dev/null; fi
    for d in "${INTEROP_DIRS[@]}"; do
      if [[ -e "$d" ]]; then echo "    $d"; run rm -rf "$d"; fi
    done
  fi
}

FAILED=0
check() {
  local what=$1 leftover=$2
  if [[ -z "$leftover" ]]; then
    echo "    ✓ $what"
  else
    echo "    ✗ $what: $(tr '\n' ' ' <<<"$leftover")"
    FAILED=1
  fi
}

verify() {
  echo "==> Verify"
  check "no compose containers" "$(docker ps -a --filter "label=com.docker.compose.project=${PROJECT}" --format '{{.Names}}')"
  check "no API-managed containers" "$(docker ps -a --filter label=ipaas.managed-by=api --format '{{.Names}}')"
  check "no volumes" "$({ docker volume ls -q --filter "label=com.docker.compose.project=${PROJECT}"; docker volume ls -q | grep "^${PROJECT}_" || true; } | sort -u)"
  check "no network" "$(docker network ls --filter "label=com.docker.compose.project=${PROJECT}" --format '{{.Name}}')"
  if [[ $KEEP_IMAGES == 0 ]]; then
    check "no images" "$(docker images --filter "reference=${PROJECT}-*" --format '{{.Repository}}:{{.Tag}}')"
  fi
  if [[ $INTEROP == 1 ]]; then
    local c d left=""
    for c in "${INTEROP_CONTAINERS[@]}"; do
      if docker container inspect "$c" >/dev/null 2>&1; then left+="$c "; fi
    done
    if docker volume inspect "$INTEROP_VOLUME" >/dev/null 2>&1; then left+="$INTEROP_VOLUME "; fi
    for d in "${INTEROP_DIRS[@]}"; do if [[ -e "$d" ]]; then left+="$d "; fi; done
    check "no interop leftovers" "$left"
  fi

  if ! konnect_enabled; then
    echo "    - Konnect not checked ($([[ $LOCAL_ONLY == 1 ]] && echo --local-only || echo 'no token'))"
    return
  fi
  local cp cp_id kind
  cp=$(cp_lookup)
  if [[ -z "$cp" ]]; then
    check "Konnect control plane '${CP_NAME}' deleted" ""
    return
  fi
  cp_id=$(jq -r .id <<<"$cp")
  if [[ $KEEP_CP == 0 && "$(jq -r '.labels.app // ""' <<<"$cp")" == ipaas ]]; then
    check "Konnect control plane '${CP_NAME}' deleted" "still exists (${cp_id})"
    return
  fi
  for kind in plugins routes services vaults; do
    check "no Konnect ${kind} tagged ipaas" "$(tagged "$cp_id" "$kind")"
  done
  check "no config store ${CP_STORE}" "$(config_store_id "$cp_id")"
  # The local certificate volume is gone after a cleanup, so match by subject.
  check "no pinned ipaas DP certificate" "$(our_certs "$cp_id" "$(local_cert)")"
}

if [[ $VERIFY_ONLY == 1 ]]; then
  verify
  exit $FAILED
fi

if [[ $DRY == 0 && $YES == 0 ]]; then
  echo "This deletes the ${PROJECT} compose stack with all its data (flows, connections, Vault secrets, EDI messages),"
  echo "the db-access container$([[ $KEEP_IMAGES == 1 ]] || echo ', the built images')$([[ $INTEROP == 1 ]] && echo ', interop test leftovers'),"
  if konnect_enabled; then
    echo "and in Konnect ($REGION): control plane '${CP_NAME}' if konnect-init created it, else its ipaas entities and DP certificate."
  fi
  read -r -p "Continue? [y/N] " ans
  [[ "$ans" =~ ^[Yy]$ ]] || { echo "Aborted"; exit 1; }
fi

# Konnect first: the local DP certificate is still readable from its volume.
cleanup_konnect
cleanup_local
if [[ $DRY == 1 ]]; then
  echo "==> Dry run: nothing deleted"
  exit 0
fi
verify
exit $FAILED
