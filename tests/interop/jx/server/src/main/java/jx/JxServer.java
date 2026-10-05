package jx;

import com.sun.net.httpserver.HttpServer;
import jakarta.annotation.Resource;
import jakarta.jws.WebService;
import javax.xml.namespace.QName;
import jakarta.xml.soap.*;
import jakarta.xml.ws.Endpoint;
import jakarta.xml.ws.Holder;
import jakarta.xml.ws.WebServiceContext;
import jakarta.xml.ws.handler.MessageContext;
import jakarta.xml.ws.handler.soap.SOAPHandler;
import jakarta.xml.ws.handler.soap.SOAPMessageContext;
import jakarta.xml.ws.soap.SOAPFaultException;
import java.io.ByteArrayOutputStream;
import java.io.ByteArrayInputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.zip.*;
import jx.gen.JXMSTransferSoap;

/**
 * JX手順 server built from the official 2007 WSDL (JAX-WS RI stubs). Strict namespaces: a client
 * that gets them wrong produces nulls here. Port 8080: SOAP; port 8081: GET /state (JSON).
 */
@WebService(endpointInterface = "jx.gen.JXMSTransferSoap", serviceName = "JXMSTransfer", portName = "JXMSTransferSoap",
    targetNamespace = JxServer.NS)
public class JxServer implements JXMSTransferSoap {
  static final String NS = "http://www.dsri.jp/edi-bp/2004/jedicos-xml/client-server";
  static final String SERVER_ID = "BMS-SERVER", CLIENT_ID = "HUB0001", USER = "hub", PASSWORD = "hubpw";

  record Doc(String messageId, byte[] data, String senderId, String receiverId, String formatType, String documentType, String compressType) {}

  static final List<Map<String, Object>> received = new CopyOnWriteArrayList<>();
  static final List<String> confirmed = new CopyOnWriteArrayList<>();
  static final List<Map<String, String>> headers = new CopyOnWriteArrayList<>();
  static final List<Doc> outbox = new CopyOnWriteArrayList<>();
  static final ThreadLocal<Map<String, String>> currentHeader = new ThreadLocal<>();

  @Resource WebServiceContext ctx;

  void auth() {
    @SuppressWarnings("unchecked")
    Map<String, List<String>> h = (Map<String, List<String>>) ctx.getMessageContext().get(MessageContext.HTTP_REQUEST_HEADERS);
    String a = Optional.ofNullable(h.get("Authorization")).map(l -> l.get(0)).orElse("");
    String expected = "Basic " + Base64.getEncoder().encodeToString((USER + ":" + PASSWORD).getBytes(StandardCharsets.UTF_8));
    if (!expected.equals(a)) throw fault("Client", "authentication failed");
  }

  static SOAPFaultException fault(String code, String msg) {
    try {
      SOAPFault f = SOAPFactory.newInstance().createFault(msg, new QName("http://schemas.xmlsoap.org/soap/envelope/", code));
      return new SOAPFaultException(f);
    } catch (SOAPException e) { throw new RuntimeException(e); }
  }

  @Override
  public boolean putDocument(String messageId, byte[] data, String senderId, String receiverId, String formatType, String documentType, String compressType) {
    auth();
    if (messageId == null || senderId == null || receiverId == null || formatType == null || documentType == null || compressType == null) {
      throw fault("Client", "missing or wrongly namespaced PutDocument element");
    }
    if (!CLIENT_ID.equals(senderId) || !SERVER_ID.equals(receiverId)) throw fault("Client", "unknown sender/receiver " + senderId + "/" + receiverId);
    if (received.stream().anyMatch(r -> r.get("messageId").equals(messageId))) return false;
    String text;
    try { text = new String(decompress(compressType, data), StandardCharsets.UTF_8); }
    catch (Exception e) { throw fault("Client", "cannot decompress: " + e); }
    received.add(Map.of("messageId", messageId, "senderId", senderId, "receiverId", receiverId, "formatType", formatType,
        "documentType", documentType, "compressType", compressType, "text", text));
    return true;
  }

  @Override
  public void getDocument(Holder<String> receiverId, Holder<Boolean> result, Holder<String> messageId, Holder<byte[]> data,
      Holder<String> senderId, Holder<String> formatType, Holder<String> documentType, Holder<String> compressType) {
    auth();
    Map<String, String> h = Optional.ofNullable(currentHeader.get()).orElse(Map.of());
    String ft = h.get("OptionalFormatType"), dt = h.get("OptionalDocumentType");
    if ((ft == null) != (dt == null)) throw fault("Client", "OptionalFormatType and OptionalDocumentType must be given together");
    Optional<Doc> next = outbox.stream()
        .filter(d -> d.receiverId().equals(receiverId.value) && !confirmed.contains(d.messageId()))
        .filter(d -> ft == null || (d.formatType().equals(ft) && d.documentType().equals(dt)))
        .findFirst();
    result.value = next.isPresent();
    Doc d = next.orElse(new Doc("", new byte[0], "", receiverId.value, "", "", ""));
    messageId.value = d.messageId(); data.value = d.data(); senderId.value = d.senderId();
    formatType.value = d.formatType(); documentType.value = d.documentType(); compressType.value = d.compressType();
  }

  @Override
  public boolean confirmDocument(String messageId, String senderId, String receiverId) {
    auth();
    if (outbox.stream().noneMatch(d -> d.messageId().equals(messageId))) throw fault("Client", "unknown messageId " + messageId);
    if (confirmed.contains(messageId)) return false;
    confirmed.add(messageId);
    return true;
  }

  static byte[] decompress(String type, byte[] data) throws Exception {
    if (type.isEmpty()) return data;
    if (type.equals("application/gzip")) return new GZIPInputStream(new ByteArrayInputStream(data)).readAllBytes();
    if (type.equals("application/zip")) {
      try (ZipInputStream z = new ZipInputStream(new ByteArrayInputStream(data), StandardCharsets.UTF_8)) { z.getNextEntry(); return z.readAllBytes(); }
    }
    throw new IllegalArgumentException(type);
  }

  static byte[] gzip(String s) throws Exception {
    ByteArrayOutputStream b = new ByteArrayOutputStream();
    try (GZIPOutputStream g = new GZIPOutputStream(b)) { g.write(s.getBytes(StandardCharsets.UTF_8)); }
    return b.toByteArray();
  }

  static byte[] zip(String name, String s) throws Exception {
    ByteArrayOutputStream b = new ByteArrayOutputStream();
    try (ZipOutputStream z = new ZipOutputStream(b, StandardCharsets.UTF_8)) {
      z.putNextEntry(new ZipEntry(name)); z.write(s.getBytes(StandardCharsets.UTF_8)); z.closeEntry();
    }
    return b.toByteArray();
  }

  /** Reads and checks MessageHeader (exact namespace) on requests; adds one to responses. */
  public static class HeaderHandler implements SOAPHandler<SOAPMessageContext> {
    public Set<QName> getHeaders() { return Set.of(new QName(NS, "MessageHeader")); }
    public boolean handleMessage(SOAPMessageContext c) {
      try {
        SOAPEnvelope env = c.getMessage().getSOAPPart().getEnvelope();
        SOAPHeader hdr = env.getHeader() != null ? env.getHeader() : env.addHeader();
        if ((Boolean) c.get(MessageContext.MESSAGE_OUTBOUND_PROPERTY)) {
          SOAPElement mh = hdr.addChildElement(new QName(NS, "MessageHeader"));
          mh.addChildElement(new QName(NS, "From")).addTextNode(SERVER_ID);
          mh.addChildElement(new QName(NS, "To")).addTextNode(CLIENT_ID);
          mh.addChildElement(new QName(NS, "MessageId")).addTextNode(UUID.randomUUID() + "@bms.example.jp");
          mh.addChildElement(new QName(NS, "Timestamp")).addTextNode(java.time.LocalDateTime.now(java.time.ZoneOffset.UTC).withNano(0).toString());
        } else {
          Map<String, String> h = new LinkedHashMap<>();
          Iterator<?> it = hdr.getChildElements(new QName(NS, "MessageHeader"));
          h.put("wrapperFound", String.valueOf(it.hasNext()));
          if (it.hasNext()) {
            SOAPElement mh = (SOAPElement) it.next();
            for (Iterator<?> f = mh.getChildElements(); f.hasNext();) {
              Object o = f.next();
              if (o instanceof SOAPElement e && NS.equals(e.getNamespaceURI())) h.put(e.getLocalName(), e.getValue());
            }
          }
          h.put("soapAction", String.valueOf(((Map<?, ?>) c.get(MessageContext.HTTP_REQUEST_HEADERS)).get("Soapaction")));
          headers.add(h);
          currentHeader.set(h);
        }
      } catch (SOAPException e) { throw new RuntimeException(e); }
      return true;
    }
    public boolean handleFault(SOAPMessageContext c) { return true; }
    public void close(MessageContext c) {}
  }

  public static void main(String[] args) throws Exception {
    // Fresh messageIds per run: a client that already received a document must treat it as a duplicate.
    String run = UUID.randomUUID().toString().substring(0, 8);
    outbox.add(new Doc("srv-1-" + run + "@bms.example.jp", gzip("請求,100\n"), SERVER_ID, CLIENT_ID, "SecondGenEDI", "Invoice", "application/gzip"));
    outbox.add(new Doc("srv-2-" + run + "@bms.example.jp", zip("発注.csv", "発注,5\n"), SERVER_ID, CLIENT_ID, "SecondGenEDI", "Order", "application/zip"));
    Endpoint ep = Endpoint.create(new JxServer());
    @SuppressWarnings("rawtypes") List<jakarta.xml.ws.handler.Handler> chain = new ArrayList<>(List.of(new HeaderHandler()));
    ep.getBinding().setHandlerChain(chain);
    ep.publish("http://0.0.0.0:8080/jx");
    HttpServer state = HttpServer.create(new InetSocketAddress(8081), 0);
    state.createContext("/state", x -> {
      byte[] body = toJson(Map.of("received", received, "confirmed", confirmed, "headers", headers, "outbox", outbox.stream().map(Doc::messageId).toList())).getBytes(StandardCharsets.UTF_8);
      x.getResponseHeaders().add("Content-Type", "application/json");
      x.sendResponseHeaders(200, body.length);
      x.getResponseBody().write(body);
      x.close();
    });
    state.start();
    System.out.println("JX server ready on :8080/jx");
  }

  static String toJson(Object o) {
    if (o instanceof Map<?, ?> m) {
      StringJoiner j = new StringJoiner(",", "{", "}");
      m.forEach((k, v) -> j.add(toJson(String.valueOf(k)) + ":" + toJson(v)));
      return j.toString();
    }
    if (o instanceof Collection<?> c) {
      StringJoiner j = new StringJoiner(",", "[", "]");
      c.forEach(v -> j.add(toJson(v)));
      return j.toString();
    }
    if (o == null) return "null";
    String s = o.toString().replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n");
    return "\"" + s + "\"";
  }
}
