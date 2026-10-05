# Interop tests

These tests check the EDI protocols against independent implementations, not just our own loopback.
Run them against a running stack (`docker compose up -d`).

## AS2: pyas2lib

```sh
docker run --rm --network ipaas_default --name pyas2 -v "$PWD/tests/interop:/t" \
  python:3.12-slim sh -c "pip install -q pyas2lib && python /t/as2_pyas2lib.py"
```

The script sets our station's AS2 ID to `IPAAS` (it generates a certificate if there is none) and points its public URL at `edi-gateway`.
It then creates a temporary partner `pyas2` and checks 11 cases:

- **Inbound** (pyas2lib sends, we reply with an MDN): signed+encrypted, +compressed, signed-only with SHA-1, encrypted-only with 3DES, and plain.
- **Outbound** (we send, pyas2lib verifies and replies with an MDN): the same combinations, an async MDN, and a negative case where the partner rejects an unsigned message.

## SFTP: OpenSSH

- **Hosted mode** (the partner connects to us). Create a hosted partner with an `authorizedKey`, then use the stock OpenSSH client:
  `sftp -i key -P 2222 user@localhost`.
  An upload to `/inbox` (direct, or a `.part` file followed by a rename) is received. Our sends appear in `/outbox`. Writing to `/outbox`, or reading anything outside the chroot, is rejected.
- **Remote mode** (we connect to the partner). Start a stock OpenSSH server:
  `docker run -d --name sftp-peer --network ipaas_default atmoz/sftp peer:secret:1001:1001:upload,download,archive`.
  Create a remote partner (`host: sftp-peer`, `uploadDir: /upload`, `pollDir: /download`, `archiveDir: /archive`).
  **Test** shows the host key to pin, **Send…** uploads, and **Poll now** downloads and archives.

## OFTP2: Neociclo Accord

```sh
tests/interop/oftp2-accord/run.sh
```

This builds a Java harness on Accord `oftp-core` 1.2.0.RC1 (with BouncyCastle 1.45) and generates throwaway keys.
It then runs 14 checks:

- **Plain session, we call Accord:** files cross in both directions, each acknowledged with an EERP.
- **Secure session, we call Accord:** mutual secure authentication, sign + zlib + AES-256 (suite 02) in both directions, and signed EERPs verified by both sides (signature and hash).
- **Accord calls us (wait mode):** our queued file is picked up, using 3DES (suite 01) and the same security checks.

## ebXML MS 2.0: Clockwork ebms-admin

```sh
tests/interop/ebms-clockwork/run.sh
```

This starts Clockwork `ebms-admin` 2.20.10 (embedded, in-memory H2) and inserts Clockwork's own CPA test fixture, with reliable messaging, HTTP, unsigned and sync.
It then runs 7 checks:

- **We send:** we get a sync Acknowledgment, and Clockwork stores the message with the payload and action intact.
- **Clockwork sends:** the message is received, and Clockwork accepts our Acknowledgment (no retransmission).
- **Status and ping:** a StatusRequest gets our StatusResponse, and a Ping gets our Pong.
