import { createHash } from 'node:crypto';
import { compress, isCompressedData, uncompress } from '../as2/ber';
import { decrypt, encrypt, signOpaque, verifyOpaque, type Cipher } from '../as2/cms';

/**
 * OFTP2 cipher suites (RFC 5024 10.2 + ODETTE extended list).
 * 01/02 are mandatory; 03-06 are the common SHA-2 extensions.
 */
export const CIPHER_SUITES: Record<string, { cipher: Cipher; digest: string; label: string }> = {
  '01': { cipher: 'des-ede3-cbc', digest: 'sha1', label: '3DES / RSA / SHA-1' },
  '02': { cipher: 'aes-256-cbc', digest: 'sha1', label: 'AES-256 / RSA / SHA-1' },
  '03': { cipher: 'des-ede3-cbc', digest: 'sha256', label: '3DES / RSA / SHA-256' },
  '04': { cipher: 'aes-256-cbc', digest: 'sha256', label: 'AES-256 / RSA / SHA-256' },
  '05': { cipher: 'des-ede3-cbc', digest: 'sha512', label: '3DES / RSA / SHA-512' },
  '06': { cipher: 'aes-256-cbc', digest: 'sha512', label: 'AES-256 / RSA / SHA-512' },
};

export interface Keys { certificate: string; privateKey: string }

export interface FileServices { sign: boolean; compress: boolean; encrypt: boolean; suite: string }

/** SFID security level: 00 none, 01 encrypted, 02 signed, 03 both. */
export const securityLevel = (s: FileServices) => (s.encrypt ? (s.sign ? '03' : '01') : s.sign ? '02' : '00');

/** Applies file services in the RFC 5024 6.1 order: sign, compress, encrypt. */
export async function wrapFile(content: Buffer, s: FileServices, own: Keys | null, partnerCert: string | undefined): Promise<Buffer> {
  const suite = CIPHER_SUITES[s.suite];
  let data = content;
  if (s.sign) {
    if (!own) throw new Error('our OFTP2 certificate is required to sign');
    data = await signOpaque(data, own.certificate, own.privateKey, suite.digest);
  }
  if (s.compress) data = compress(data);
  if (s.encrypt) {
    if (!partnerCert) throw new Error('partner certificate is required to encrypt');
    data = await encrypt(data, partnerCert, suite.cipher);
  }
  return data;
}

export class FileServiceError extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
  }
}

/** Reverses file services according to the SFID flags. Throws FileServiceError with an EFNA reason. */
export async function unwrapFile(
  data: Buffer, sfid: { security: string; compression: string; envelope: string; cipher: string }, own: Keys | null, partnerCert: string | undefined,
): Promise<Buffer> {
  if (sfid.envelope !== '1') return data;
  if (sfid.security === '01' || sfid.security === '03') {
    if (!own) throw new FileServiceError('22', 'no OFTP2 certificate to decrypt with');
    try {
      data = await decrypt(data, own.certificate, own.privateKey);
    } catch (e) {
      throw new FileServiceError('22', `decryption failed: ${(e as Error).message}`);
    }
  }
  if (sfid.compression === '1' || isCompressedData(data)) {
    try {
      data = uncompress(data);
    } catch (e) {
      throw new FileServiceError('23', `decompression failed: ${(e as Error).message}`);
    }
  }
  if (sfid.security === '02' || sfid.security === '03') {
    if (!partnerCert) throw new FileServiceError('21', 'no partner certificate to verify the signature');
    try {
      data = await verifyOpaque(data, partnerCert);
    } catch (e) {
      throw new FileServiceError('21', `signature invalid: ${(e as Error).message}`);
    }
  }
  return data;
}

/** EERPHSH: hash of the transmitted virtual file with the suite's digest. */
export function fileHash(transmitted: Buffer, suite: string): Buffer {
  return createHash(CIPHER_SUITES[suite]?.digest ?? 'sha1').update(transmitted).digest();
}
