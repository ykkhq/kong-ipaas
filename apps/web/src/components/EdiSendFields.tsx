import { useEffect, useState } from 'react';
import type { EdiSendData } from '@ipaas/flow-core';
import { api, type EdiPartner } from '../api';

const CONTENT_TYPES = ['application/edifact', 'application/edi-x12', 'application/edi-consent', 'application/xml', 'text/csv', 'text/plain', 'application/json', 'application/octet-stream'];

export function EdiSendFields({ data, inputs, onChange }: { data: EdiSendData; inputs: string[]; onChange: (p: Partial<EdiSendData>) => void }) {
  const [partners, setPartners] = useState<EdiPartner[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.edi.partners().then(setPartners).catch((e) => setErr(e.message));
  }, []);
  const selected = partners?.find((p) => p.name === data.partner);
  const hint = inputs[0] ? `.${inputs[0]}` : '.';

  return (
    <>
      <label className="field">
        <span>Trading partner</span>
        <select value={data.partner} onChange={(e) => onChange({ partner: e.target.value })} disabled={!partners}>
          {!selected && <option value={data.partner}>{data.partner ? `${data.partner} (not found)` : '(choose a partner)'}</option>}
          {partners?.map((p) => <option key={p.id} value={p.name}>{p.name} · {p.protocol.toUpperCase()}{p.enabled ? '' : ' (disabled)'}</option>)}
        </select>
        <small className={err ? 'warn' : 'muted'}>
          {err ?? (selected ? describe(selected) : 'Partners and protocols are set up on the EDI page.')} <a href="#/edi">EDI partners</a>
        </small>
      </label>
      <label className="field">
        <span>File name (jq)</span>
        <input className="mono" value={data.filename ?? ''} placeholder='"order-" + .req.query.id + ".edi"' onChange={(e) => onChange({ filename: e.target.value })} />
      </label>
      <label className="field">
        <span>Content (jq)</span>
        <textarea className="mono" rows={4} spellCheck={false} value={data.content} placeholder={`${hint}.document`} onChange={(e) => onChange({ content: e.target.value })} />
        <small className="muted">A string is sent as is. Anything else is sent as JSON. For binary data, produce base64 text and decode it in your partner mapping.</small>
      </label>
      <label className="field">
        <span>Content type</span>
        <input className="mono" list="edi-ctypes" value={data.contentType ?? ''} onChange={(e) => onChange({ contentType: e.target.value })} />
        <datalist id="edi-ctypes">{CONTENT_TYPES.map((t) => <option key={t} value={t} />)}</datalist>
      </label>
      <label className="field">
        <span>Status on send failure</span>
        <input type="number" value={data.errorStatus ?? 502} onChange={(e) => onChange({ errorStatus: Number(e.target.value) })} />
        <small className="muted">If delivery fails (connection, negative MDN, MIC mismatch, …), the flow stops and returns this status with the error.</small>
      </label>
      <p className="muted small">Downstream nodes get <code>.alias.message_id</code>, <code>.alias.status</code> (delivered / sent / awaiting-receipt) and <code>.alias.receipt</code>.</p>
    </>
  );
}

function describe(p: EdiPartner): string {
  const c = p.config;
  if (p.protocol === 'jx') return c.mode === 'client'
    ? `JX PutDocument to ${c.jxId} at ${c.url} (${c.formatType}/${c.documentType}${c.compressType ? `, ${c.compressType}` : ''}).`
    : `JX: queued on our server until ${c.jxId} fetches it with GetDocument (${c.formatType}/${c.documentType}).`;
  if (p.protocol === 'ebms') return `ebXML MS to ${c.partyId} at ${c.url}: ${c.service} / ${c.action}${c.ackRequested === false ? '' : `, ${c.syncReply === false ? 'async' : 'sync'} acknowledgment`}.`;
  if (p.protocol === 'oftp2') return c.mode === 'wait'
    ? `OFTP2: queued until ${c.odetteId} calls us.`
    : `OFTP2 session to ${c.odetteId} at ${c.host}:${c.port || (c.tls ? 6619 : 3305)}${c.tls ? ' (TLS)' : ''}${c.encrypt ? `, suite ${c.cipherSuite || '02'}` : ''}.`;
  if (p.protocol === 'as2') return `AS2 to ${c.as2Id} at ${c.url}${c.sign ? `, signed ${c.sign}` : ''}${c.encrypt ? `, encrypted ${c.encrypt}` : ''}, MDN ${c.mdn ?? 'sync'}.`;
  return c.mode === 'hosted' ? `SFTP: dropped in ${p.name}'s /outbox on our server.` : `SFTP upload to ${c.username}@${c.host}:${c.uploadDir || '.'}.`;
}
