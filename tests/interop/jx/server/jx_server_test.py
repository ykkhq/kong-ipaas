"""JX手順 interop B: edi-gateway as JX client against a strict JAX-WS server generated from the official 2007 WSDL."""
import json, sys, urllib.request

EDI, STATE = "http://edi-gateway:4100", "http://jxserver:8081/state"
NS = "http://www.dsri.jp/edi-bp/2004/jedicos-xml/client-server"
results = []


def check(name, ok, detail=""):
    results.append(bool(ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name}{('  -- ' + str(detail)[:400]) if not ok else ''}", flush=True)


def edi(method, path, body=None):
    req = urllib.request.Request(EDI + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"} if body is not None else {})
    with urllib.request.urlopen(req) as r:
        d = r.read()
        return json.loads(d) if d else None


state = lambda: json.load(urllib.request.urlopen(STATE))
INVOICE_ID, ORDER_ID = state()["outbox"]  # fresh per server run

edi("PUT", "/station/jx", {"jxId": "HUB0001", "domain": "hub.example.jp"})
for p in edi("GET", "/partners"):
    if p["name"] == "jx-interop-server":
        edi("DELETE", f"/partners/{p['id']}")
base = {"mode": "client", "jxId": "BMS-SERVER", "url": "http://jxserver:8080/jx", "username": "hub",
        "formatType": "SecondGenEDI", "documentType": "Order", "compressType": "application/zip"}
pid = edi("POST", "/partners", {"name": "jx-interop-server", "protocol": "jx", "config": base, "secrets": {"password": "hubpw"}})["id"]

# PutDocument
r = edi("POST", "/send", {"partner": "jx-interop-server", "filename": "発注.csv", "content": "発注,42,ABC\n"})
check("PutDocument accepted by the WSDL-generated server", r.get("ok") and r.get("status") == "delivered" and not r["receipt"].get("duplicate"), r)
s = state()
got = s["received"][-1] if s["received"] else {}
check("server bound every PutDocument element (strict namespace)", got.get("senderId") == "HUB0001" and got.get("receiverId") == "BMS-SERVER"
      and got.get("formatType") == "SecondGenEDI" and got.get("documentType") == "Order" and got.get("compressType") == "application/zip", got)
check("server unzipped our document to the original text", got.get("text") == "発注,42,ABC\n", got.get("text"))
h = s["headers"][-1] if s["headers"] else {}
check("MessageHeader wrapper in the JX namespace with From/To/MessageId/Timestamp", h.get("wrapperFound") == "true"
      and h.get("From") == "HUB0001" and h.get("To") == "BMS-SERVER" and "@" in h.get("MessageId", "") and len(h.get("Timestamp", "")) == 19, h)
check("SOAPAction is the official PutDocument action", f"{NS}/PutDocument" in h.get("soapAction", ""), h.get("soapAction"))

# GetDocument with the 2007 type filter, then without
edi("PUT", f"/partners/{pid}", {"name": "jx-interop-server", "config": {**base, "getFormatType": "SecondGenEDI", "getDocumentType": "Invoice"}})
p1 = edi("POST", f"/partners/{pid}/poll")
check("filtered poll (Invoice only) received 1 document", p1 == {"ok": True, "received": 1, "duplicates": 0}, p1)
s = state()
check("server saw OptionalFormatType/OptionalDocumentType in the header", any(x.get("OptionalDocumentType") == "Invoice" for x in s["headers"]), s["headers"][-3:])
check("our ConfirmDocument reached the server", s["confirmed"] == [INVOICE_ID], s["confirmed"])
edi("PUT", f"/partners/{pid}", {"name": "jx-interop-server", "config": base})
p2 = edi("POST", f"/partners/{pid}/poll")
check("unfiltered poll received the remaining Order", p2 == {"ok": True, "received": 1, "duplicates": 0}, p2)
inbound = {m["message_id"]: m for m in edi("GET", "/messages?direction=in&limit=20") if m["message_id"] in (INVOICE_ID, ORDER_ID)}
check("gzip Invoice and zip Order stored with original names", inbound.get(INVOICE_ID, {}).get("receipt", {}).get("documentType") == "Invoice"
      and inbound.get(ORDER_ID, {}).get("filename") == "発注.csv", {k: (v["filename"], v["size"]) for k, v in inbound.items()})
p3 = edi("POST", f"/partners/{pid}/poll")
check("poll with nothing left receives 0", p3 == {"ok": True, "received": 0, "duplicates": 0}, p3)
check("server holds both our ConfirmDocuments", set(state()["confirmed"]) == {INVOICE_ID, ORDER_ID}, state()["confirmed"])

# Fault handling
edi("PUT", f"/partners/{pid}", {"name": "jx-interop-server", "config": base, "secrets": {"password": "wrong"}})
bad = edi("POST", "/send", {"partner": "jx-interop-server", "filename": "x.csv", "content": "x"})
check("SOAP Fault (authentication failed) surfaces as a send error", not bad.get("ok") and "authentication failed" in (bad.get("error") or ""), bad)

edi("DELETE", f"/partners/{pid}")
print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
