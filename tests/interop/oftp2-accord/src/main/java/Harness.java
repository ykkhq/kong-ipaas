import java.io.File;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.file.Files;
import java.util.Date;
import java.util.Queue;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import org.neociclo.odetteftp.OdetteFtpVersion;
import org.neociclo.odetteftp.TransferMode;
import org.neociclo.odetteftp.oftplet.AnswerReasonInfo;
import org.neociclo.odetteftp.oftplet.EndFileResponse;
import org.neociclo.odetteftp.oftplet.StartFileResponse;
import org.neociclo.odetteftp.protocol.DefaultEndFileResponse;
import org.neociclo.odetteftp.protocol.DefaultStartFileResponse;
import org.neociclo.odetteftp.protocol.DeliveryNotification;
import org.neociclo.odetteftp.protocol.OdetteFtpObject;
import org.neociclo.odetteftp.protocol.RecordFormat;
import org.neociclo.odetteftp.protocol.VirtualFile;
import org.neociclo.odetteftp.protocol.v20.CipherSuite;
import org.neociclo.odetteftp.protocol.v20.DefaultEnvelopedVirtualFile;
import org.neociclo.odetteftp.protocol.v20.FileCompression;
import org.neociclo.odetteftp.protocol.v20.FileEnveloping;
import org.neociclo.odetteftp.protocol.v20.SecurityLevel;
import org.neociclo.odetteftp.security.MappedCallbackHandler;
import org.neociclo.odetteftp.security.OneToOneHandler;
import org.neociclo.odetteftp.security.PasswordAuthenticationCallback;
import org.neociclo.odetteftp.security.PasswordCallback;
import org.neociclo.odetteftp.service.TcpClient;
import org.neociclo.odetteftp.service.TcpServer;
import org.neociclo.odetteftp.support.InOutSharedQueueOftpletFactory;
import org.neociclo.odetteftp.support.OdetteFtpConfiguration;
import org.neociclo.odetteftp.support.OftpletEventListenerAdapter;
import org.neociclo.odetteftp.support.PasswordAuthenticationHandler;
import org.neociclo.odetteftp.util.OdetteFtpSupport;
import org.neociclo.odetteftp.protocol.v20.EnvelopedVirtualFile;
import org.neociclo.odetteftp.protocol.v20.SignedDeliveryNotification;
import org.neociclo.odetteftp.security.AuthenticationChallengeCallback;
import org.neociclo.odetteftp.security.EncryptAuthenticationChallengeCallback;
import org.neociclo.odetteftp.security.PartnerCertificateCallback;
import org.neociclo.odetteftp.security.UserCertificateCallback;
import org.neociclo.odetteftp.security.UserPrivateKeyCallback;
import org.bouncycastle.cms.CMSEnvelopedData;
import org.bouncycastle.cms.CMSEnvelopedDataGenerator;
import org.bouncycastle.cms.CMSProcessableByteArray;
import org.bouncycastle.cms.CMSSignedDataGenerator;
import org.bouncycastle.cms.RecipientInformation;
import org.bouncycastle.cms.SignerInformation;
import org.bouncycastle.cms.CMSSignedData;
import org.bouncycastle.jce.provider.BouncyCastleProvider;
import org.bouncycastle.openssl.PEMReader;
import java.io.FileReader;
import java.security.KeyPair;
import java.security.PrivateKey;
import java.security.Security;
import java.security.cert.X509Certificate;
import java.text.SimpleDateFormat;
import java.util.TimeZone;

/**
 * OFTP2 interop peer built on Neociclo Accord (independent Java implementation).
 *
 *   java Harness server <port> <ourId> <ourPw> <peerId> <peerPw> [fileToSend]
 *   java Harness client <host:port> <ourId> <ourPw> <peerId> <peerPw> [fileToSend]
 *
 * Prints one "EVENT ..." line per protocol event. Received files are answered with an EERP.
 */
public class Harness {
  static final Queue<OdetteFtpObject> out = new ConcurrentLinkedQueue<>();
  static final Queue<OdetteFtpObject> sent = new ConcurrentLinkedQueue<>();
  static final Queue<OdetteFtpObject> in = new ConcurrentLinkedQueue<>();
  static final CountDownLatch sessionEnd = new CountDownLatch(1);
  static X509Certificate userCert, peerCert;
  static PrivateKey userKey;
  static CipherSuite suite = CipherSuite.NO_CIPHER_SUITE_SELECTION;

  static Object pem(String path) throws IOException {
    try (PEMReader r = new PEMReader(new FileReader(path))) { return r.readObject(); }
  }

  /** EERP signature: CMS SignedData over DSN(26) DATE TIME DEST(25) ORIG(25) HASH (RFC 5024 5.3.13). */
  static byte[] signEerp(String dsn, java.util.Date when, short ticker, String dest, String orig, byte[] hash) throws Exception {
    SimpleDateFormat d = new SimpleDateFormat("yyyyMMdd"), t = new SimpleDateFormat("HHmmss");
    d.setTimeZone(TimeZone.getTimeZone("UTC"));
    t.setTimeZone(TimeZone.getTimeZone("UTC"));
    String head = String.format("%-26s%s%s%04d%-25s%-25s", dsn, d.format(when), t.format(when), ticker, dest, orig);
    byte[] h = head.getBytes("ISO-8859-1");
    byte[] content = new byte[h.length + hash.length];
    System.arraycopy(h, 0, content, 0, h.length);
    System.arraycopy(hash, 0, content, h.length, hash.length);
    CMSSignedDataGenerator g = new CMSSignedDataGenerator();
    g.addSigner(userKey, userCert, CMSSignedDataGenerator.DIGEST_SHA1);
    return g.generate(new CMSProcessableByteArray(content), true, "BC").getEncoded();
  }

  public static void main(String[] a) throws Exception {
    String mode = a[0], addr = a[1], ourId = a[2], ourPw = a[3], peerId = a[4], peerPw = a[5];
    File dir = Files.createTempDirectory("oftp").toFile();
    // Optional: SECURE=<ourKey.pem>,<ourCert.pem>,<peerCert.pem>,<suite 1|2>,<signedEerp Y|N>
    String sec = System.getenv("SECURE");
    boolean secure = sec != null && !sec.isEmpty();
    boolean wantSignedEerp = false;
    if (secure) {
      Security.addProvider(new BouncyCastleProvider());
      String[] p = sec.split(",");
      Object k = pem(p[0]);
      userKey = k instanceof KeyPair ? ((KeyPair) k).getPrivate() : (PrivateKey) k;
      userCert = (X509Certificate) pem(p[1]);
      peerCert = (X509Certificate) pem(p[2]);
      suite = "1".equals(p[3]) ? CipherSuite.TRIPLEDES_RSA_SHA1 : CipherSuite.AES_RSA_SHA1;
      wantSignedEerp = "Y".equals(p[4]);
    }
    final boolean signedEerp = wantSignedEerp;

    OdetteFtpConfiguration cfg = new OdetteFtpConfiguration();
    cfg.setVersion(OdetteFtpVersion.OFTP_V20);
    cfg.setTransferMode(TransferMode.BOTH);
    cfg.setDataExchangeBufferSize(4096);
    cfg.setWindowSize(64);
    cfg.setUseSecureAuthentication(secure);
    cfg.setCipherSuiteSelection(suite);

    MappedCallbackHandler cb = new MappedCallbackHandler();
    cb.addHandler(PasswordCallback.class, new OneToOneHandler<PasswordCallback>() {
      public void handle(PasswordCallback c) { c.setUsername(ourId); c.setPassword(ourPw); }
    });
    cb.addHandler(PasswordAuthenticationCallback.class, new PasswordAuthenticationHandler() {
      public PasswordAuthenticationCallback.AuthenticationResult authenticate(String user, String pw) {
        System.out.println("EVENT auth user=" + user.trim() + " pw=" + pw.trim());
        if (!peerId.equals(user.trim())) return PasswordAuthenticationCallback.AuthenticationResult.UNKNOWN_USER;
        return peerPw.equals(pw.trim()) ? PasswordAuthenticationCallback.AuthenticationResult.SUCCESS : PasswordAuthenticationCallback.AuthenticationResult.INVALID_PASSWORD;
      }
    });

    if (secure) {
      cb.addHandler(UserCertificateCallback.class, new OneToOneHandler<UserCertificateCallback>() { public void handle(UserCertificateCallback c) { c.setCertificate(userCert); } });
      cb.addHandler(UserPrivateKeyCallback.class, new OneToOneHandler<UserPrivateKeyCallback>() { public void handle(UserPrivateKeyCallback c) { c.setKey(userKey); } });
      cb.addHandler(PartnerCertificateCallback.class, new OneToOneHandler<PartnerCertificateCallback>() { public void handle(PartnerCertificateCallback c) { c.setCertificate(peerCert); } });
      cb.addHandler(AuthenticationChallengeCallback.class, new OneToOneHandler<AuthenticationChallengeCallback>() {
        public void handle(AuthenticationChallengeCallback c) throws IOException {
          try {
            RecipientInformation ri = (RecipientInformation) new CMSEnvelopedData(c.getEncodedChallenge()).getRecipientInfos().getRecipients().iterator().next();
            c.setChallenge(ri.getContent(userKey, "BC"));
            System.out.println("EVENT challenge-decrypted len=" + c.getChallenge().length);
          } catch (Exception e) { throw new IOException(e); }
        }
      });
      cb.addHandler(EncryptAuthenticationChallengeCallback.class, new OneToOneHandler<EncryptAuthenticationChallengeCallback>() {
        public void handle(EncryptAuthenticationChallengeCallback c) throws IOException {
          try {
            CMSEnvelopedDataGenerator g = new CMSEnvelopedDataGenerator();
            g.addKeyTransRecipient(peerCert);
            c.setEncodedChallenge(g.generate(new CMSProcessableByteArray(c.getChallenge()), CMSEnvelopedDataGenerator.AES256_CBC, "BC").getEncoded());
            System.out.println("EVENT challenge-encrypted");
          } catch (Exception e) { throw new IOException(e); }
        }
      });
    }

    if (a.length > 6) {
      File f = new File(a[6]);
      DefaultEnvelopedVirtualFile vf = new DefaultEnvelopedVirtualFile();
      vf.setFile(f);
      vf.setSize(f.length());
      vf.setOriginalFileSize(f.length());
      vf.setDatasetName(f.getName().toUpperCase());
      vf.setOriginator(ourId);
      vf.setDestination(peerId);
      vf.setRecordFormat(RecordFormat.UNSTRUCTURED);
      vf.setDateTime(new Date());
      vf.setTicker((short) 1);
      vf.setSecurityLevel(secure ? SecurityLevel.ENCRYPTED_AND_SIGNED : SecurityLevel.NO_SECURITY_SERVICES);
      vf.setCipherSuite(suite);
      vf.setCompressionAlgorithm(secure ? FileCompression.ZLIB : FileCompression.NO_COMPRESSION);
      vf.setEnvelopingFormat(secure ? FileEnveloping.CMS : FileEnveloping.NO_ENVELOPE);
      vf.setSignedNotificationRequest(signedEerp);
      vf.setFileDescription(f.getName());
      if (secure) {
        File env = new File(dir, f.getName() + ".p7");
        OdetteFtpSupport.createEnvelopedFile(f, env, vf, userCert, userKey, peerCert);
        vf.setFile(env);
        vf.setSize(env.length());
        System.out.println("EVENT enveloped " + f.length() + " -> " + env.length() + " octets suite=" + suite);
      }
      out.offer(vf);
    }

    InOutSharedQueueOftpletFactory factory = new InOutSharedQueueOftpletFactory(cfg, cb, out, sent, in);
    factory.setEventListener(new OftpletEventListenerAdapter() {
      public void onSessionStart() { System.out.println("EVENT session-start"); }
      public void onSessionEnd() { System.out.println("EVENT session-end"); sessionEnd.countDown(); }
      public void onExceptionCaught(Throwable t) { System.out.println("EVENT error " + t); }
      public void onSendFileEnd(VirtualFile vf) { System.out.println("EVENT sent " + vf.getDatasetName()); }
      public void onSendFileError(VirtualFile vf, AnswerReasonInfo r, boolean retry) { System.out.println("EVENT send-error " + vf.getDatasetName() + " " + r); }
      public StartFileResponse acceptStartFile(VirtualFile vf) {
        System.out.println("EVENT accept dsn=" + vf.getDatasetName());
        return DefaultStartFileResponse.positiveStartFileAnswer(new File(dir, vf.getDatasetName().replace('/', '_') + "." + System.nanoTime()));
      }
      public void onReceiveFileStart(VirtualFile vf, long off) {
        System.out.println("EVENT receive-start dsn=" + vf.getDatasetName() + " orig=" + vf.getOriginator() + " dest=" + vf.getDestination());
      }
      public EndFileResponse onReceiveFileEnd(VirtualFile vf, long records, long units) {
        try {
          String body = new String(Files.readAllBytes(vf.getFile().toPath()), "UTF-8");
          String desc = vf instanceof DefaultEnvelopedVirtualFile ? ((DefaultEnvelopedVirtualFile) vf).getFileDescription() : "";
          System.out.println("EVENT received dsn=" + vf.getDatasetName() + " units=" + units + " desc=" + desc + " body=" + body.replace("\n", "\\n"));
        } catch (IOException e) {
          System.out.println("EVENT received-unreadable " + e);
        }
        DeliveryNotification eerp = OdetteFtpSupport.getReplyDeliveryNotification(vf);
        if (vf instanceof EnvelopedVirtualFile) {
          EnvelopedVirtualFile ev = (EnvelopedVirtualFile) vf;
          try {
            if (ev.getSecurityLevel() != SecurityLevel.NO_SECURITY_SERVICES || ev.getCompressionAlgorithm() != FileCompression.NO_COMPRESSION) {
              File plain = new File(dir, "plain." + System.nanoTime());
              OdetteFtpSupport.parseEnvelopedFile(vf.getFile(), plain, ev, userCert, userKey, peerCert);
              System.out.println("EVENT unwrapped security=" + ev.getSecurityLevel() + " suite=" + ev.getCipherSuite() + " compression=" + ev.getCompressionAlgorithm()
                  + " body=" + new String(Files.readAllBytes(plain.toPath()), "UTF-8").replace("\n", "\\n"));
            }
            if (ev.isSignedNotificationRequest() && secure) {
              byte[] hash = org.neociclo.odetteftp.util.SecurityUtil.computeFileHash(vf.getFile(), "SHA1");
              byte[] sig = signEerp(vf.getDatasetName(), vf.getDateTime(), vf.getTicker(), vf.getOriginator(), vf.getDestination(), hash);
              eerp = OdetteFtpSupport.getReplySignedDeliveryNotification(ev, vf.getDestination(), null, null, hash, sig);
              System.out.println("EVENT signed-eerp hash=" + hash.length + " sig=" + sig.length);
            }
          } catch (Exception e) {
            System.out.println("EVENT unwrap-error " + e);
          }
        }
        out.offer(eerp); // goes out on our next speaker turn
        return DefaultEndFileResponse.positiveEndFileAnswer();
      }
      public void onNotificationReceived(DeliveryNotification n) {
        if (n instanceof SignedDeliveryNotification) {
          SignedDeliveryNotification s = (SignedDeliveryNotification) n;
          String verdict = "unsigned";
          if (s.getNotificationSignature() != null && s.getNotificationSignature().length > 0) {
            try {
              CMSSignedData sd = new CMSSignedData(s.getNotificationSignature());
              SignerInformation si = (SignerInformation) sd.getSignerInfos().getSigners().iterator().next();
              verdict = si.verify(peerCert, "BC") ? "signature-valid" : "signature-INVALID";
            } catch (Exception e) { verdict = "signature-error " + e; }
          }
          System.out.println("EVENT signed-notification " + verdict + " hashLen=" + (s.getVirtualFileHash() == null ? 0 : s.getVirtualFileHash().length));
        }
        System.out.println("EVENT notification type=" + n.getType() + " dsn=" + ((org.neociclo.odetteftp.protocol.DefaultDeliveryNotification) n).getDatasetName()
            + " creator=" + n.getCreator() + " reason=" + n.getReason());
      }
      public void onNotificationSent(DeliveryNotification n) { System.out.println("EVENT notification-sent " + n.getType()); }
    });

    if (mode.equals("server")) {
      TcpServer server = new TcpServer(new InetSocketAddress(Integer.parseInt(addr)), factory);
      server.start();
      System.out.println("EVENT listening " + addr);
      sessionEnd.await(120, TimeUnit.SECONDS);
      Thread.sleep(500);
      server.stop();
    } else {
      String[] hp = addr.split(":");
      TcpClient client = new TcpClient(hp[0], Integer.parseInt(hp[1]), factory);
      client.connect(true);
      client.awaitDisconnect();
    }
    System.out.println("EVENT done in=" + in.size());
    System.exit(0);
  }
}
