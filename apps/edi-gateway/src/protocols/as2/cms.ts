import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// S/MIME via the OpenSSL CLI ("openssl cms"): proven AS2 interop, including
// RSA PKCS#1 v1.5 key transport that WebCrypto-based libraries lack.

export const MIC_ALGS: Record<string, string> = {
  md5: 'md5', sha1: 'sha1', 'sha-1': 'sha1', sha256: 'sha256', 'sha-256': 'sha256',
  sha384: 'sha384', 'sha-384': 'sha384', sha512: 'sha512', 'sha-512': 'sha512',
};
export const CIPHERS = ['aes-128-cbc', 'aes-192-cbc', 'aes-256-cbc', 'des-ede3-cbc'] as const;
export type Cipher = (typeof CIPHERS)[number];

/** AS2 micalg name ("sha-256") for an openssl digest ("sha256"). */
export const micalgName = (d: string) => (d === 'sha1' || d === 'md5' ? d : d.replace(/^sha/, 'sha-'));

export function mic(data: Buffer, alg: string): string {
  const d = MIC_ALGS[alg.toLowerCase()];
  if (!d) throw new Error(`unsupported MIC algorithm ${alg}`);
  return createHash(d).update(data).digest('base64');
}

async function withTemp<T>(files: Record<string, Buffer | string>, fn: (p: (name: string) => string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'as2-'));
  const p = (n: string) => path.join(dir, n);
  try {
    for (const [n, c] of Object.entries(files)) await writeFile(p(n), c, { mode: 0o600 });
    return await fn(p);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function openssl(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('openssl', args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(lastLine(stderr) || err.message));
      else resolve({ stdout, stderr });
    });
  });
}

const lastLine = (s: string) => s.trim().split('\n').filter((l) => l && !/^\s*$/.test(l)).slice(-2).join(' | ');

/** Detached CMS signature (DER) over the exact entity bytes. */
export function sign(entity: Buffer, certPem: string, keyPem: string, digest = 'sha256'): Promise<Buffer> {
  return withTemp({ data: entity, cert: certPem, key: keyPem }, async (p) => {
    await openssl(['cms', '-sign', '-binary', '-in', p('data'), '-signer', p('cert'), '-inkey', p('key'), '-md', digest, '-outform', 'DER', '-out', p('sig')]);
    return readFile(p('sig'));
  });
}

/** Verifies a detached signature, accepting only the given partner certificate as signer. */
export function verify(entity: Buffer, sigDer: Buffer, partnerCertPem: string): Promise<void> {
  return withTemp({ data: entity, sig: sigDer, cert: partnerCertPem }, async (p) => {
    await openssl(['cms', '-verify', '-binary', '-inform', 'DER', '-in', p('sig'), '-content', p('data'),
      '-certfile', p('cert'), '-nointern', '-noverify', '-out', p('out')]);
  });
}

export function encrypt(entity: Buffer, partnerCertPem: string, cipher: Cipher = 'aes-256-cbc'): Promise<Buffer> {
  if (!CIPHERS.includes(cipher)) throw new Error(`unsupported cipher ${cipher}`);
  return withTemp({ data: entity, cert: partnerCertPem }, async (p) => {
    await openssl(['cms', '-encrypt', '-binary', '-in', p('data'), `-${cipher}`, '-outform', 'DER', '-out', p('enc'), p('cert')]);
    return readFile(p('enc'));
  });
}

export function decrypt(der: Buffer, certPem: string, keyPem: string): Promise<Buffer> {
  return withTemp({ enc: der, cert: certPem, key: keyPem }, async (p) => {
    await openssl(['cms', '-decrypt', '-binary', '-inform', 'DER', '-in', p('enc'), '-recip', p('cert'), '-inkey', p('key'), '-out', p('out')]);
    return readFile(p('out'));
  });
}

/** Opaque (encapsulated) CMS SignedData, e.g. OFTP2 signed files and EERPs. */
export function signOpaque(data: Buffer, certPem: string, keyPem: string, digest = 'sha256'): Promise<Buffer> {
  return withTemp({ data, cert: certPem, key: keyPem }, async (p) => {
    await openssl(['cms', '-sign', '-binary', '-nodetach', '-nocerts', '-in', p('data'), '-signer', p('cert'), '-inkey', p('key'), '-md', digest, '-outform', 'DER', '-out', p('sig')]);
    return readFile(p('sig'));
  });
}

/** Verifies opaque SignedData against the partner certificate and returns the content. */
export function verifyOpaque(der: Buffer, partnerCertPem: string): Promise<Buffer> {
  return withTemp({ sig: der, cert: partnerCertPem }, async (p) => {
    await openssl(['cms', '-verify', '-binary', '-inform', 'DER', '-in', p('sig'), '-certfile', p('cert'), '-nointern', '-noverify', '-out', p('out')]);
    return readFile(p('out'));
  });
}

/** Self-signed RSA certificate for our AS2 station. */
export function selfSigned(commonName: string, days = 3650): Promise<{ certificate: string; privateKey: string }> {
  return withTemp({}, async (p) => {
    await openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', p('key'), '-out', p('cert'), '-days', String(days),
      '-subj', `/CN=${commonName.replace(/[/\\=+,]/g, '_')}`, '-addext', 'keyUsage=digitalSignature,keyEncipherment']);
    return { certificate: await readFile(p('cert'), 'utf8'), privateKey: await readFile(p('key'), 'utf8') };
  });
}

export function certInfo(pem: string): Promise<{ subject: string; notAfter: string; fingerprint: string }> {
  return withTemp({ cert: pem }, async (p) => {
    const { stdout } = await openssl(['x509', '-in', p('cert'), '-noout', '-subject', '-enddate', '-fingerprint', '-sha256']);
    const get = (k: string) => (stdout.match(new RegExp(`${k}=?(.*)`, 'i'))?.[1] ?? '').trim().replace(/^=/, '');
    return { subject: get('subject'), notAfter: get('notAfter'), fingerprint: get('sha256 Fingerprint') };
  });
}
