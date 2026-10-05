#!/bin/sh
# JX interop B: edi-gateway JX client -> JAX-WS server generated from the official 2007 WSDL.
set -e
cd "$(dirname "$0")"
NET=${NET:-ipaas_default}
docker run --rm -v "$PWD":/w -v ipaas-m2:/root/.m2 -w /w maven:3.9-eclipse-temurin-17 \
  sh -c 'mvn -q package dependency:copy-dependencies -DoutputDirectory=target/lib' >/dev/null
docker rm -f jxserver >/dev/null 2>&1 || true
docker run -d --name jxserver --network $NET -v "$PWD":/w -w /w eclipse-temurin:17-jre \
  sh -c 'java -cp "target/jx-server-1.0.jar:target/lib/*" jx.JxServer' >/dev/null
for i in $(seq 1 30); do docker logs jxserver 2>&1 | grep -q 'JX server ready' && break; sleep 1; done
status=0
docker run --rm --network $NET -v "$PWD:/t" python:3.12-slim python /t/jx_server_test.py || status=$?
docker rm -f jxserver >/dev/null
exit $status
