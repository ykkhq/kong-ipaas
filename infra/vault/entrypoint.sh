#!/bin/sh
# Starts Vault and makes it usable without manual steps (local development):
#   first start: init (1 key share), unseal, enable kv-v2 at ipaas/, write
#                policies, create periodic tokens for the API and db-access
#   every start: unseal with the stored key
# Unseal key + root token live in the vault-keys volume (only this container
# mounts it); service tokens go to the vault-tokens volume, which the API mounts
# read-only. Anyone with the keys volume can read every secret: fine for a
# laptop, not a production setup.
set -eu

KEYS=/vault/keys
TOKENS=/vault/tokens
export VAULT_ADDR=http://127.0.0.1:8200
mkdir -p "$KEYS" "$TOKENS" /vault/file
chmod 700 "$KEYS"

vault server -config=/vault/config/vault.hcl &
SERVER=$!
trap 'kill -TERM $SERVER; wait $SERVER' TERM INT

# `vault status` exits 0 (unsealed), 2 (sealed) or 1 (not reachable yet).
i=0
while :; do
  rc=0; vault status >/dev/null 2>&1 || rc=$?
  [ "$rc" -ne 1 ] && break
  i=$((i + 1)); [ $i -gt 60 ] && { echo "vault did not start" >&2; exit 1; }
  sleep 0.5
done

if ! vault status -format=json 2>/dev/null | grep -q '"initialized": true'; then
  echo "==> Initializing Vault"
  vault operator init -key-shares=1 -key-threshold=1 > "$KEYS/init.txt"
  awk '/Unseal Key 1:/ {print $4}' "$KEYS/init.txt" > "$KEYS/unseal-key"
  awk '/Initial Root Token:/ {print $4}' "$KEYS/init.txt" > "$KEYS/root-token"
  chmod 600 "$KEYS"/*
fi

if vault status -format=json 2>/dev/null | grep -q '"sealed": true'; then
  echo "==> Unsealing Vault"
  vault operator unseal "$(cat "$KEYS/unseal-key")" >/dev/null
fi

if [ ! -s "$TOKENS/api-token" ] || [ ! -s "$TOKENS/db-access-token" ]; then
  echo "==> Configuring secrets engine, policies and service tokens"
  export VAULT_TOKEN="$(cat "$KEYS/root-token")"
  vault secrets list -format=json | grep -q '"ipaas/"' || vault secrets enable -path=ipaas -version=2 kv
  vault policy write ipaas-api /vault/config/api-policy.hcl
  vault policy write ipaas-db-access /vault/config/db-access-policy.hcl
  # Periodic, orphan tokens: they never expire as long as they are renewed within the period.
  vault token create -policy=ipaas-api -period=768h -orphan -display-name=ipaas-api -field=token > "$TOKENS/api-token"
  vault token create -policy=ipaas-db-access -period=768h -orphan -display-name=ipaas-db-access -field=token > "$TOKENS/db-access-token"
  chmod 644 "$TOKENS/api-token" "$TOKENS/db-access-token"
  unset VAULT_TOKEN
fi

touch /tmp/ready
echo "==> Vault ready"
wait $SERVER
