"""ebXML MS 2.0 interop: edi-gateway <-> Clockwork ebms-admin (independent Java implementation).

Run by run.sh inside a python container on the compose network.
Clockwork = DIGIPOORT (party 00000000000000000000), edi-gateway = OVERHEID (party 00000000000000000001),
CPA "ipaas-interop-sync": reliable messaging, ackRequested=always, syncReplyMode=signalsAndResponse.
"""
import base64, html, json, re, sys, time, urllib.request

EDI = "http://edi-gateway:4100"
CW = "http://clockwork:8080/service"
CPA_ID = "ipaas-interop-sync"
CW_PARTY, US_PARTY, OIN = "00000000000000000000", "00000000000000000001", "urn:osb:oin"
# Clockwork's MessageRequest service string (see its CPA service value)
SERVICE_IN = "urn:osb:services:osb:afleveren:1.1$1.0"  # Clockwork identifies services and parties as type:value
results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}{('  -- ' + str(detail)[:400]) if not ok else ''}", flush=True)


def edi(method, path, body=None):
    req = urllib.request.Request(EDI + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"} if body is not None else {})
    with urllib.request.urlopen(req) as r:
        d = r.read()
        return json.loads(d) if d else None


def soap(service, ns, op, inner):
    env = (f'<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns="{ns}">'
           f'<soapenv:Header/><soapenv:Body><ns:{op}>{inner}</ns:{op}></soapenv:Body></soapenv:Envelope>')
    req = urllib.request.Request(f"{CW}/{service}", data=env.encode(), headers={"Content-Type": "text/xml; charset=UTF-8", "SOAPAction": '""'})
    try:
        with urllib.request.urlopen(req) as r:
            return r.read().decode()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{op}: HTTP {e.code} {e.read().decode()[:600]}")


EBMS_NS = "http://www.ordina.nl/ebms/2.18"
tag = lambda xml, name: [html.unescape(x) for x in re.findall(rf"<(?:\w+:)?{name}>([^<]*)</(?:\w+:)?{name}>", xml)]

# ---- setup -----------------------------------------------------------------------------
cpa = open("/t/cpa/ipaas-interop-sync.xml").read()
soap("cpa", "http://www.ordina.nl/cpa/2.18", "insertCPA", f"<cpa><![CDATA[{cpa}]]></cpa><overwrite>true</overwrite>")
edi("PUT", "/station/ebms", {"partyId": US_PARTY, "partyIdType": OIN})
for p in edi("GET", "/partners"):
    if p["name"] == "clockwork-interop":
        edi("DELETE", f"/partners/{p['id']}")
pid = edi("POST", "/partners", {"name": "clockwork-interop", "protocol": "ebms", "config": {
    "partyId": CW_PARTY, "partyIdType": OIN, "url": "http://clockwork:8888/ebms", "cpaId": CPA_ID,
    "service": "osb:aanleveren:1.1$1.0", "serviceType": "urn:osb:services", "action": "aanleveren",
    "fromRole": "OVERHEID", "toRole": "DIGIPOORT", "ackRequested": True, "syncReply": True, "duplicateElimination": True}})["id"]

# ---- us -> Clockwork ----------------------------------------------------------------------
payload = "<Aanleverbericht><kenmerk>ipaas-1</kenmerk><tekst>日本語 ok</tekst></Aanleverbericht>"
r = edi("POST", "/send", {"partner": "clockwork-interop", "filename": "aanlever.xml", "contentType": "application/xml", "content": payload})
check("out: Clockwork returns a sync Acknowledgment (delivered)", r.get("ok") and r.get("status") == "delivered", r)
ids = tag(soap("ebms", EBMS_NS, "getUnprocessedMessageIds", f"<messageFilter><cpaId>{CPA_ID}</cpaId></messageFilter><maxNr>20</maxNr>"), "messageId")
mine = r.get("messageId")
check("out: Clockwork stored our message", mine in ids, ids)
if mine in ids:
    got = soap("ebms", EBMS_NS, "getMessage", f"<messageId>{mine}</messageId><process>true</process>")
    content = base64.b64decode(tag(got, "content")[0]).decode() if tag(got, "content") else ""
    check("out: Clockwork payload (UTF-8) and action intact", content == payload and tag(got, "action")[:1] == ["aanleveren"],
          {"content": content, "action": tag(got, "action")})

# ---- Clockwork -> us ----------------------------------------------------------------------
msg = "<Afleverbericht><kenmerk>cw-1</kenmerk></Afleverbericht>"
props = (f"<properties><cpaId>{CPA_ID}</cpaId><fromPartyId>{OIN}:{CW_PARTY}</fromPartyId><fromRole>DIGIPOORT</fromRole>"
         f"<toPartyId>{OIN}:{US_PARTY}</toPartyId><toRole>OVERHEID</toRole><service>{SERVICE_IN}</service><action>afleveren</action></properties>")
ds = f"<dataSource><name>afleverbericht.xml</name><contentType>application/xml</contentType><content>{base64.b64encode(msg.encode()).decode()}</content></dataSource>"
cw_id = tag(soap("ebms", EBMS_NS, "sendMessage", f"<message>{props}{ds}</message>"), "messageId")[0]
for _ in range(20):
    if any(m.get("message_id") == cw_id for m in edi("GET", "/messages?direction=in&limit=20")):
        break
    time.sleep(1)
# Reliable messaging: Clockwork resends every 10 s (CPA RetryInterval) until it accepts an Acknowledgment.
# No duplicates after 25 s means our synchronous Acknowledgment was accepted.
time.sleep(25)
rec = next((m for m in edi("GET", "/messages?direction=in&limit=20") if m.get("message_id") == cw_id), None)
check("in: Clockwork accepted our sync Acknowledgment (no retransmission in 25 s)", rec is not None and not (rec.get("receipt") or {}).get("duplicates"), rec and rec.get("receipt"))
# getMessageStatus makes Clockwork send an ebMS StatusRequest to us; our StatusResponse comes back as its status.
status = (tag(soap("ebms", EBMS_NS, "getMessageStatus", f"<messageId>{cw_id}</messageId>"), "status") or [None])[0]
check("status: StatusRequest answered (Clockwork sees RECEIVED)", status == "RECEIVED", status)
inbound = [m for m in edi("GET", "/messages?direction=in&limit=20") if m.get("message_id") == cw_id]
check("in: we received Clockwork's message with its payload", bool(inbound) and inbound[0]["filename"] == "afleverbericht.xml", inbound[:1])

# ---- Clockwork pings us ---------------------------------------------------------------------
try:
    pong = soap("ebms", EBMS_NS, "ping", f"<cpaId>{CPA_ID}</cpaId><fromPartyId>{OIN}:{CW_PARTY}</fromPartyId><toPartyId>{OIN}:{US_PARTY}</toPartyId>")
    check("ping: Clockwork ping answered with Pong", "Fault" not in pong, pong)
except Exception as e:
    check("ping: Clockwork ping answered with Pong", False, e)

edi("DELETE", f"/partners/{pid}")
print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
