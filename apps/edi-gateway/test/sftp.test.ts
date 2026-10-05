import { describe, expect, it } from 'vitest';
import { PartnerFs } from '../src/protocols/sftp/vfs';
import { sanitizeFilename, asText } from '../src/engine';

describe('PartnerFs', () => {
  it.each([
    ['/inbox/a.edi', '/inbox/a.edi'],
    ['inbox/../outbox/x', '/outbox/x'],
    ['', '/'],
    ['/../../etc/passwd', '/etc/passwd'],
  ])('normalizes %s', (p, v) => expect(PartnerFs.normalize(p)).toBe(v));

  it('only exposes inbox and outbox', () => {
    expect(PartnerFs.area('/inbox/a')).toBe('inbox');
    expect(PartnerFs.area('/outbox')).toBe('outbox');
    expect(PartnerFs.area('/')).toBe('root');
    expect(PartnerFs.area('/etc/passwd')).toBeNull();
    expect(PartnerFs.area('/.processed/x')).toBeNull();
  });

  it('treats dotfiles and .part/.tmp as in-progress uploads', () => {
    expect(PartnerFs.isTemp('.x')).toBe(true);
    expect(PartnerFs.isTemp('a.edi.part')).toBe(true);
    expect(PartnerFs.isTemp('a.edi')).toBe(false);
  });
});

describe('engine helpers', () => {
  it('sanitizes filenames', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('注文 2026.csv')).toBe('___2026.csv');
    expect(sanitizeFilename('...')).toBe('document.dat');
  });

  it('detects text payloads', () => {
    expect(asText(Buffer.from('日本語 EDI'))).toBe('日本語 EDI');
    expect(asText(Buffer.from([0xff, 0xfe, 0]))).toBeNull();
  });
});
