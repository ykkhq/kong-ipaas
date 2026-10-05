#!/bin/sh
# ebXML MS 2.0 interop: edi-gateway <-> Clockwork ebms-admin 2.20.10 (independent Java implementation).
# Needs the stack running (docker compose up -d). Downloads ebms-admin from GitHub releases on first run.
set -e
cd "$(dirname "$0")"
NET=${NET:-ipaas_default}
V=2.20.10
mkdir -p dist
for f in ebms-admin-$V.jar ebms-h2-db-plugin-$V.jar; do
  [ -f dist/$f ] || curl -sSL -o dist/$f "https://github.com/eluinstra/ebms-admin/releases/download/ebms-admin-$V/$f"
done
# The CPA is Clockwork's own test fixture (reliable messaging, HTTP, unsigned, sync) with endpoints pointed at the containers.
[ -f cpa/ipaas-interop-sync.xml ] || {
  mkdir -p cpa
  curl -sSL "https://raw.githubusercontent.com/eluinstra/ebms-core/ebms-core-$V/core/src/test/resources/nl/clockwork/ebms/cpas/cpaStubEBF.rm.http.unsigned.sync.xml" \
    | sed -e 's#http://localhost:8888/ebms#http://clockwork:8888/ebms#' -e 's#http://localhost:8088/ebms#http://edi-gateway:4090/ebms#' \
          -e 's#cpaid="cpaStubEBF.rm.http.unsigned.sync"#cpaid="ipaas-interop-sync"#' -e 's#<tns:RetryInterval>PT5M#<tns:RetryInterval>PT10S#' > cpa/ipaas-interop-sync.xml
}
docker rm -f clockwork >/dev/null 2>&1 || true
docker run -d --name clockwork --network $NET -v "$PWD/dist":/d -v "$PWD/conf":/conf -w /d eclipse-temurin:21-jre \
  sh -c "java -cp ebms-admin-$V.jar:ebms-h2-db-plugin-$V.jar nl.clockwork.ebms.admin.StartEmbedded -soap -headless -port 8080 -configDir /conf/" >/dev/null
echo "waiting for Clockwork..."
for i in $(seq 1 90); do
  docker logs clockwork 2>&1 | grep -q 'Server started' && break
  sleep 2
done
status=0
docker run --rm --network $NET -v "$PWD:/t" python:3.12-slim python /t/ebms_clockwork.py || status=$?
docker rm -f clockwork >/dev/null
exit $status
