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

# Engine and policies are (re)applied on every start so new policies roll out;
# a service token is only created when its file is missing.
echo "==> Applying secrets engine and policies"
export VAULT_TOKEN="$(cat "$KEYS/root-token")"
vault secrets list -format=json | grep -q '"ipaas/"' || vault secrets enable -path=ipaas -version=2 kv
for svc in api db-access edi; do
  vault policy write "ipaas-$svc" "/vault/config/$svc-policy.hcl" >/dev/null
  if [ ! -s "$TOKENS/$svc-token" ]; then
    echo "==> Creating service token for $svc"
    # Periodic, orphan tokens: they never expire as long as they are renewed within the period.
    vault token create -policy="ipaas-$svc" -period=768h -orphan -display-name="ipaas-$svc" -field=token > "$TOKENS/$svc-token"
    chmod 644 "$TOKENS/$svc-token"
  fi
done
unset VAULT_TOKEN

touch /tmp/ready
echo "==> Vault ready"
wait $SERVER
