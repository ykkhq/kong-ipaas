"""AS2 interoperability test: edi-gateway <-> pyas2lib (independent Python AS2 implementation).

Run on the compose network (the stack must be up):

  docker run --rm --network ipaas_default --name pyas2 -v "$PWD/tests/interop:/t" \
    python:3.12-slim sh -c "pip install -q pyas2lib && python /t/as2_pyas2lib.py"

It configures our AS2 station (AS2 ID "IPAAS") and a partner "pyas2" (AS2 ID "PYAS2"),
then exercises both directions and removes the partner again.
"""
import datetime
import http.server
import json
import os
import sys
import threading
import time
import urllib.request

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from pyas2lib import Mdn, Message, Organization, Partner

ADMIN = os.environ.get("EDI_ADMIN", "http://edi-gateway:4100")
AS2_URL = os.environ.get("AS2_URL", "http://edi-gateway:4080/as2")
SELF_URL = "http://pyas2:8080/as2"
results = []


def api(method, path, body=None):
    req = urllib.request.Request(ADMIN + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"} if body is not None else {})
    try:
        with urllib.request.urlopen(req) as r:
            data = r.read()
            return json.loads(data) if data else None
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{method} {path} -> {e.code}: {e.read().decode()}")


def keypair(cn):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(days=1))
            .not_valid_after(now + datetime.timedelta(days=365)).sign(key, hashes.SHA256()))
    key_pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    return key_pem + cert.public_bytes(serialization.Encoding.PEM), cert.public_bytes(serialization.Encoding.PEM)


def check(name, ok, detail=""):
    results.append((name, ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name}{('  -- ' + detail) if detail and not ok else ''}", flush=True)


# ---- setup ----------------------------------------------------------------------------
# Async MDNs must come back to an address the peer container can reach.
api("PUT", "/station/as2", {"as2Id": "IPAAS", "publicUrl": AS2_URL})
if not api("GET", "/station")["as2"].get("certificate"):
    api("POST", "/station/as2/certificate", {"generate": True})
our_cert = api("GET", "/station")["as2"]["certificate"].encode()
peer_key_and_cert, peer_cert = keypair("PYAS2")
org = Organization(as2_name="PYAS2", sign_key=peer_key_and_cert, decrypt_key=peer_key_and_cert)

for p in api("GET", "/partners"):
    if p["name"] == "pyas2":
        api("DELETE", f"/partners/{p['id']}")
partner_cfg = {"as2Id": "PYAS2", "url": SELF_URL, "certificate": peer_cert.decode(), "sign": "sha-256",
               "encrypt": "aes-256-cbc", "compress": False, "mdn": "sync", "mdnSigned": True}
partner_id = api("POST", "/partners", {"name": "pyas2", "protocol": "as2", "config": partner_cfg})["id"]


def peer_partner(**kw):
    base = dict(as2_name="IPAAS", verify_cert=our_cert, encrypt_cert=our_cert, validate_certs=False,
                sign=True, digest_alg="sha256", encrypt=True, enc_alg="aes_256_cbc", mdn_mode="SYNC", mdn_digest_alg="sha256")
    base.update(kw)
    return Partner(**base)


# ---- inbound: pyas2lib -> edi-gateway -------------------------------------------------
INBOUND = [
    ("in: signed+encrypted, signed sync MDN", {}),
    ("in: signed+encrypted+compressed", {"compress": True}),
    ("in: signed only (sha1)", {"encrypt": False, "digest_alg": "sha1", "mdn_digest_alg": "sha1"}),
    ("in: encrypted only (3DES)", {"sign": False, "enc_alg": "tripledes_192_cbc"}),
    ("in: plain, unsigned MDN", {"sign": False, "encrypt": False, "mdn_digest_alg": None}),
]
for name, kw in INBOUND:
    try:
        partner = peer_partner(**kw)
        msg = Message(org, partner)
        payload = f"UNB+UNOC:3+PYAS2+IPAAS {name}\r\n".encode() + bytes(range(256))
        msg.build(payload, filename="inbound.edi", content_type="application/edifact")
        req = urllib.request.Request(AS2_URL, data=msg.content, method="POST", headers=msg.headers)
        with urllib.request.urlopen(req) as r:
            mdn_raw = b"".join(f"{k}: {v}\r\n".encode() for k, v in r.headers.items()) + b"\r\n" + r.read()
        mdn = Mdn()
        status, detail = mdn.parse(mdn_raw, lambda *a: msg)
        check(name, status == "processed", f"{status} {detail}")
    except Exception as e:  # noqa: BLE001
        check(name, False, repr(e))

# ---- outbound: edi-gateway -> pyas2lib --------------------------------------------------
received = {}
async_mdns = []


def find_org(*args):
    return org


def find_partner(*args):
    return received["partner"]


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        raw = b"".join(f"{k}: {v}\r\n".encode() for k, v in self.headers.items()) + b"\r\n" + body
        msg = Message()
        status, exc, mdn = msg.parse(raw, find_org_cb=find_org, find_partner_cb=find_partner)
        received["status"], received["exc"], received["payload"] = status, exc, msg.content
        if mdn and mdn.headers.get("receipt-delivery-option") is None and self.headers.get("Receipt-Delivery-Option"):
            async_mdns.append((self.headers["Receipt-Delivery-Option"], mdn))
            self.send_response(200)
            self.end_headers()
            return
        self.send_response(200)
        if mdn:
            for k, v in mdn.headers.items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(mdn.content)
        else:
            self.end_headers()


server = http.server.ThreadingHTTPServer(("0.0.0.0", 8080), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()

OUTBOUND = [
    ("out: signed+encrypted, sync signed MDN", {}, {}),
    ("out: signed+encrypted+compressed", {"compress": True}, {}),
    ("out: signed only (sha1)", {"encrypt": "", "sign": "sha1"}, {}),
    ("out: encrypted only (3DES)", {"sign": "", "encrypt": "des-ede3-cbc"}, {}),
    ("out: async MDN", {"mdn": "async"}, {}),
]
for name, cfg, _ in OUTBOUND + [("out: partner rejects unsigned (negative)", {"sign": ""}, {"expect_fail": True})]:
    try:
        api("PUT", f"/partners/{partner_id}", {"name": "pyas2", "config": {**partner_cfg, **cfg}})
        received.clear()
        # The peer's security policy mirrors what we send in this case.
        received["partner"] = peer_partner(sign=cfg.get("sign", "sha-256") != "", encrypt=cfg.get("encrypt", "aes-256-cbc") != "")
        content = f"ISA*00* {name}*".encode().decode() + "あ"
        r = api("POST", "/send", {"partner": "pyas2", "filename": "outbound.x12", "contentType": "application/edi-x12", "content": content})
        got = received.get("payload")
        ok_payload = got == content.encode()
        if cfg.get("mdn") == "async":
            for url, mdn in async_mdns:
                urllib.request.urlopen(urllib.request.Request(url, data=mdn.content, method="POST", headers=mdn.headers)).read()
            async_mdns.clear()
            time.sleep(1)
            final = api("GET", f"/messages/{r['id']}")
            check(name, r.get("ok") and r.get("status") == "awaiting-receipt" and final["status"] == "delivered" and ok_payload,
                  f"send={r} final={final['status']} err={final.get('error')} payload_ok={ok_payload} peer={received.get('status')} {received.get('exc')}")
        elif _.get("expect_fail"):
            received["partner"] = peer_partner()  # peer requires signing again
            r = api("POST", "/send", {"partner": "pyas2", "filename": "outbound.x12", "content": "x"})
            check(name, not r.get("ok") and "insufficient-message-security" in (r.get("error") or ""), f"send={r}")
        else:
            check(name, r.get("ok") and r.get("status") == "delivered" and ok_payload,
                  f"send={r.get('ok')} {r.get('error')} payload_ok={ok_payload} peer={received.get('status')} {received.get('exc')}")
    except Exception as e:  # noqa: BLE001
        check(name, False, repr(e))

api("DELETE", f"/partners/{partner_id}")
server.shutdown()
failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
