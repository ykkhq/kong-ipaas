#!/bin/sh
# OFTP2 interop: edi-gateway <-> Neociclo Accord oftp-core (independent Java implementation).
# Needs the stack running (docker compose up -d). Creates a temporary partner "accord-interop".
set -e
cd "$(dirname "$0")"
API=${API:-http://localhost:3000/api/edi}
NET=${NET:-ipaas_default}
W=work; rm -rf $W; mkdir -p $W
pass=0; fail=0
check() { if eval "$2"; then echo "PASS  $1"; pass=$((pass+1)); else echo "FAIL  $1"; fail=$((fail+1)); fi; }

echo "== build harness"
docker run --rm -v "$PWD":/w -v ipaas-m2:/root/.m2 -w /w maven:3.9-eclipse-temurin-11 \
  sh -c 'mvn -q compile dependency:copy-dependencies -DoutputDirectory=lib' >/dev/null

echo "== keys + configuration"
openssl req -x509 -newkey rsa:2048 -nodes -keyout $W/k.pem -out $W/accord-cert.pem -days 30 -subj "/CN=O0099ACCORD" 2>/dev/null
openssl rsa -in $W/k.pem -traditional -out $W/accord-key.pem 2>/dev/null   # BouncyCastle 1.45 reads PKCS#1 only
curl -sf -X PUT $API/station/oftp2 -H 'content-type: application/json' -d '{"odetteId":"O0099IPAAS"}' >/dev/null
curl -sf $API/station | python3 -c "import json,sys; c=json.load(sys.stdin)['oftp2'].get('certificate'); sys.exit(0 if c else 1)" \
  || curl -sf -X POST $API/station/oftp2/certificate -H 'content-type: application/json' -d '{"generate":true}' >/dev/null
curl -sf $API/station | python3 -c "import json,sys; open('$W/ipaas-cert.pem','w').write(json.load(sys.stdin)['oftp2']['certificate'])"
printf 'UNB+UNOC:3+ACCORD+IPAAS\nfrom accord\n' > $W/from-accord.edi

partner() { # $1 = JSON config overrides
  python3 - "$API" "$1" "$W" <<'PY'
import json, sys, urllib.request
api, extra, w = sys.argv[1], json.loads(sys.argv[2]), sys.argv[3]
cfg = {"odetteId": "O0099ACCORD", "mode": "call", "host": "accord", "port": 3305, "certificate": open(f"{w}/accord-cert.pem").read(), **extra}
body = {"name": "accord-interop", "protocol": "oftp2", "config": cfg, "secrets": {"sendPassword": "IPAASPW", "receivePassword": "ACCORDPW"}}
ps = json.load(urllib.request.urlopen(f"{api}/partners"))
pid = next((p["id"] for p in ps if p["name"] == "accord-interop"), None)
req = urllib.request.Request(f"{api}/partners/{pid}" if pid else f"{api}/partners", method="PUT" if pid else "POST",
                             data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
urllib.request.urlopen(req).read()
PY
}
accord() { # $1 = server|client, $2 = SECURE value or ""
  if [ "$1" = server ]; then
    docker rm -f accord >/dev/null 2>&1
    docker run -d --name accord --network $NET -e SECURE="$2" -v "$PWD":/w -w /w eclipse-temurin:11-jre \
      sh -c 'java -cp "target/classes:lib/*" Harness server 3305 O0099ACCORD ACCORDPW O0099IPAAS IPAASPW /w/work/from-accord.edi' >/dev/null
    sleep 3
  else
    docker run --rm --network $NET -e SECURE="$2" -v "$PWD":/w -w /w eclipse-temurin:11-jre \
      sh -c 'java -cp "target/classes:lib/*" Harness client edi-gateway:3305 O0099ACCORD ACCORDPW O0099IPAAS IPAASPW /w/work/from-accord.edi' 2>&1 | tr -cd '\11\12\15\40-\176' > $W/accord.log || true
  fi
}
send() { curl -s -X POST $API/send -H 'content-type: application/json' -d "{\"partner\":\"accord-interop\",\"filename\":\"$1\",\"content\":\"UNB+UNOC:3+IPAAS+ACCORD\\n$1\\n\"}"; }
last_in() { curl -s "$API/messages?direction=in&limit=1" | python3 -c "import json,sys; m=json.load(sys.stdin)[0]; print(m['filename'], m['status'], (m.get('receipt') or {}).get('security'))"; }
SEC="/w/work/accord-key.pem,/w/work/accord-cert.pem,/w/work/ipaas-cert.pem"

echo "== A: we call Accord (plain)"
partner '{}'
accord server ""
R=$(send plain-a.edi); docker logs accord 2>&1 | tr -cd '\11\12\15\40-\176' > $W/accord.log; docker rm -f accord >/dev/null
check "A plain: our file delivered with Accord's EERP" "echo '$R' | grep -q '\"status\":\"delivered\"'"
check "A plain: Accord received our file intact" "grep -F 'received dsn=PLAIN-A.EDI' $W/accord.log | grep -qF 'body=UNB+UNOC:3+IPAAS+ACCORD'"
check "A plain: Accord's file received by us" "last_in | grep -q '^from-accord.edi received'"
check "A plain: Accord got our EERP" "grep -q 'type=END_TO_END_RESPONSE dsn=FROM-ACCORD.EDI' $W/accord.log"

echo "== A: we call Accord (secure auth, sign+zlib+AES-256 suite 02, signed EERPs)"
partner '{"secureAuth":true,"sign":true,"compress":true,"encrypt":true,"cipherSuite":"02","signedEerp":true,"requireSigned":true,"requireEncrypted":true,"requireSignedEerp":true}'
accord server "$SEC,2,Y"
R=$(send secure-a.edi); docker logs accord 2>&1 | tr -cd '\11\12\15\40-\176' > $W/accord.log; docker rm -f accord >/dev/null
check "A secure: mutual secure authentication" "grep -q 'challenge-decrypted len=20' $W/accord.log && grep -q challenge-encrypted $W/accord.log"
check "A secure: Accord unwrapped our signed+compressed+encrypted file" "grep -q 'unwrapped security=ENCRYPTED_AND_SIGNED suite=AES_RSA_SHA1 compression=ZLIB body=UNB+UNOC:3+IPAAS+ACCORD' $W/accord.log"
check "A secure: Accord's signed EERP verified (signature + hash)" "echo '$R' | grep -q '\"verified\":true,\"hashMatch\":true'"
check "A secure: we unwrapped Accord's secure file" "last_in | grep -q '^from-accord.edi received 03'"
check "A secure: Accord verified our signed EERP" "grep -q 'signed-notification signature-valid' $W/accord.log"

echo "== B: Accord calls us (secure, 3DES suite 01, we are responder; queued file picked up)"
partner '{"mode":"wait","secureAuth":true,"sign":true,"compress":true,"encrypt":true,"cipherSuite":"01","signedEerp":true,"requireSigned":true,"requireEncrypted":true,"requireSignedEerp":true}'
Q=$(send queued-b.edi)
check "B: send in wait mode queues" "echo '$Q' | grep -q '\"status\":\"queued\"'"
accord client "$SEC,1,Y"
check "B: Accord picked up our queued 3DES file" "grep -q 'unwrapped security=ENCRYPTED_AND_SIGNED suite=TRIPLEDES_RSA_SHA1' $W/accord.log"
check "B: our queued file delivered (signed EERP verified)" "curl -s '$API/messages?direction=out&limit=1' | grep -q '\"status\":\"delivered\"'"
check "B: Accord's file received by us" "last_in | grep -q '^from-accord.edi received 03'"
check "B: Accord verified our signed EERP" "grep -q 'signed-notification signature-valid' $W/accord.log"

PID=$(curl -s $API/partners | python3 -c "import json,sys; print(next(p['id'] for p in json.load(sys.stdin) if p['name']=='accord-interop'))")
curl -s -X DELETE $API/partners/$PID >/dev/null
echo; echo "$pass passed, $fail failed"
[ $fail -eq 0 ]
