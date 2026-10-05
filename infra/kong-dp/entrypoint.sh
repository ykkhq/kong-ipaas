#!/bin/sh
# Loads the cluster endpoints written by konnect-init, then starts Kong.
set -e
. /certs/cluster.env
exec /entrypoint.sh kong docker-start
