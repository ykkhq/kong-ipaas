# JX手順 interop: jx_client (Ruby/Savon, official 2007 WSDL) as client against the edi-gateway JX server.
# Run by run.sh in a ruby container on the compose network.
# Savon 2.12 uses ActiveSupport's blank? (normally present in Rails apps).
require "active_support"
require "active_support/core_ext/object/blank"
require "jx_client"
require "json"
require "net/http"
require "securerandom"
require "zlib"

EDI = URI("http://edi-gateway:4100")
ENDPOINT = "http://edi-gateway:4095/jx"
$results = []

def check(name, ok, detail = nil)
  $results << ok
  puts "#{ok ? 'PASS' : 'FAIL'}  #{name}#{ok ? '' : "  -- #{detail.inspect[0, 400]}"}"
end

def edi(method, path, body = nil)
  req = Net::HTTP.const_get(method.capitalize).new(path, body ? { "Content-Type" => "application/json" } : {})
  req.body = JSON.dump(body) if body
  res = Net::HTTP.start(EDI.host, EDI.port) { |h| h.request(req) }
  res.body && !res.body.empty? ? JSON.parse(res.body) : nil
end

edi("put", "/station/jx", { jxId: "HUB0001", domain: "hub.example.jp" })
edi("get", "/partners").each { |p| edi("delete", "/partners/#{p['id']}") if p["name"] == "jx-interop-store" }
pid = edi("post", "/partners", { name: "jx-interop-store", protocol: "jx",
  config: { mode: "server", jxId: "STORE0001", username: "store0001", formatType: "SecondGenEDI", documentType: "Order", compressType: "application/zip" },
  secrets: { password: "pa55" } })["id"]

def client(password = "pa55")
  JxClient.new(jx_version: 2007, jx_message_id_generate: -> { "#{SecureRandom.hex}@store.example.jp" }, jx_timestamp_generate: true,
               jx_default_options: { from: "STORE0001", to: "HUB0001" }, endpoint: ENDPOINT, basic_auth: ["store0001", password],
               log: false, raise_errors: true)
end

# ---- PutDocument (client -> our server) ----
doc = "注文,1,ABC-123\n"
mid = "#{SecureRandom.hex}@store.example.jp"
put = client.put_document { |op| op.options(message_id: mid, data: doc, sender_id: "STORE0001", receiver_id: "HUB0001", format_type: "SecondGenEDI", document_type: "Order", compress_type: "").call }
check("PutDocument accepted (true)", put.response.result == true, put.response.body)
dup = client.put_document { |op| op.options(message_id: mid, data: doc, sender_id: "STORE0001", receiver_id: "HUB0001", format_type: "SecondGenEDI", document_type: "Order", compress_type: "").call }
check("PutDocument duplicate messageId returns false", dup.response.result == false, dup.response.body)
inbound = edi("get", "/messages?direction=in&limit=10").find { |m| m["message_id"] == mid }
check("document delivered once to edi-gateway", inbound && inbound["size"] == doc.bytesize, inbound)

# ---- GetDocument / ConfirmDocument (our server -> client) ----
edi("post", "/send", { partner: "jx-interop-store", filename: "出荷.csv", content: "出荷,9\n" })
cfg = { mode: "server", jxId: "STORE0001", username: "store0001", formatType: "SecondGenEDI", documentType: "Invoice", compressType: "application/gzip" }
edi("put", "/partners/#{pid}", { name: "jx-interop-store", config: cfg })
edi("post", "/send", { partner: "jx-interop-store", filename: "invoice.csv", content: "invoice,7\n" })

filtered = client.get_document { |op| op.options(receiver_id: "STORE0001", optional_format_type: "SecondGenEDI", optional_document_type: "Invoice").call }
r = filtered.response.result
check("GetDocument with 2007 type filter returns the Invoice", r.get_document_result == true && r.document_type == "Invoice", r.inspect)
# jx_client's result struct omits compressType; read it from the raw response.
ct = filtered.response.body[:get_document_response][:compress_type]
check("gzip compressType and data as sent", ct == "application/gzip" && Zlib.gunzip(r.decoded_data).force_encoding("UTF-8") == "invoice,7\n", [ct, r.data])
conf = client.confirm_document { |op| op.options(message_id: r.message_id, sender_id: r.sender_id, receiver_id: r.receiver_id).call }
check("ConfirmDocument true", conf.response.result == true, conf.response.body)
again = client.confirm_document { |op| op.options(message_id: r.message_id, sender_id: r.sender_id, receiver_id: r.receiver_id).call }
check("ConfirmDocument repeated returns false", again.response.result == false, again.response.body)

gop = client.get_document { |op| op.options(receiver_id: "STORE0001").call }
g = gop.response.result
check("GetDocument without filter returns the Order (zip)", g.get_document_result == true && g.document_type == "Order" && gop.response.body[:get_document_response][:compress_type] == "application/zip", g.inspect)
client.confirm_document { |op| op.options(message_id: g.message_id, sender_id: g.sender_id, receiver_id: g.receiver_id).call }
none = client.get_document { |op| op.options(receiver_id: "STORE0001").call }.response.result
check("GetDocument with nothing left returns false", none.get_document_result == false, none.inspect)
statuses = edi("get", "/messages?direction=out&partner=#{pid}&limit=10").map { |m| m["status"] }.uniq
check("our outbound documents are delivered after ConfirmDocument", statuses == ["delivered"], statuses)

# ---- errors ----
begin
  client("wrong").get_document { |op| op.options(receiver_id: "STORE0001").call }
  check("wrong password rejected", false, "no error")
rescue Savon::Error => e
  check("wrong password rejected", !!(e.message =~ /401|authentication/i), e.message)
end

edi("delete", "/partners/#{pid}")
puts "\n#{$results.count(true)}/#{$results.size} passed"
exit($results.all? ? 0 : 1)
