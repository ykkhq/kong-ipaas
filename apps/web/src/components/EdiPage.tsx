import { useEffect, useMemo, useState } from 'react';
import { api, type EdiMessage, type EdiPartner, type EdiPartnerInput, type EdiProtocol, type EdiStation, type FlowRecord, type PlatformStatus } from '../api';
import { Nav, PlatformPill } from './FlowList';

type Tab = 'partners' | 'messages' | 'station';

export function EdiPage() {
  const [tab, setTab] = useState<Tab>(() => (window.location.hash.split('/')[2] as Tab) || 'partners');
  const [status, setStatus] = useState<PlatformStatus | null>(null);
  useEffect(() => {
    api.status().then(setStatus).catch(() => undefined);
  }, []);
  const go = (t: Tab) => {
    setTab(t);
    history.replaceState(null, '', `#/edi/${t}`);
  };
  return (
    <div className="page">
      <header className="topbar">
        <div className="brand"><img src="/favicon.svg" alt="" /> Flow Builder</div>
        <Nav active="edi" />
        <span className="spacer" />
        <PlatformPill status={status} />
      </header>
      <main className="list wide">
        <div className="list-head">
          <div>
            <h1>EDI</h1>
            <p className="muted">
              Trading partners and protocols. Flows send with the <b>EDI Send</b> node. Documents a partner sends are logged and posted to the partner's inbound flow.
            </p>
          </div>
        </div>
        <div className="subtabs">
          {(['partners', 'messages', 'station'] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'active' : ''} onClick={() => go(t)}>{t === 'station' ? 'Our station' : t[0].toUpperCase() + t.slice(1)}</button>
          ))}
        </div>
        {tab === 'partners' && <Partners />}
        {tab === 'messages' && <Messages />}
        {tab === 'station' && <Station />}
      </main>
    </div>
  );
}

// ---- partners ---------------------------------------------------------------

function Partners() {
  const [partners, setPartners] = useState<EdiPartner[] | null>(null);
  const [flows, setFlows] = useState<FlowRecord[]>([]);
  const [station, setStation] = useState<EdiStation | null>(null);
  const [editing, setEditing] = useState<EdiPartner | 'new' | null>(null);
  const [sending, setSending] = useState<EdiPartner | null>(null);
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = () => api.edi.partners().then(setPartners).catch((e) => setBanner({ ok: false, text: e.message }));
  useEffect(() => {
    refresh();
    api.list().then(setFlows).catch(() => undefined);
    api.edi.station().then(setStation).catch(() => undefined);
  }, []);

  const act = async (p: EdiPartner, what: 'test' | 'poll' | 'delete') => {
    setBanner(null);
    try {
      if (what === 'delete') {
        if (!confirm(`Delete partner "${p.name}"? Its credentials are removed from Vault.`)) return;
        await api.edi.deletePartner(p.id);
        refresh();
      } else if (what === 'test') {
        const r = await api.edi.testPartner(p.id);
        setBanner(r.ok
          ? { ok: true, text: `${p.name}: OK${r.hostKey ? `, host key ${r.hostKey}${p.config.hostKeySha256 ? '' : ' (not pinned yet; edit the partner to pin it)'}` : ''}${r.files ? `, ${r.files.length} file(s) listed` : ''}${r.httpStatus ? `, HTTP ${r.httpStatus}` : ''}` }
          : { ok: false, text: `${p.name}: ${r.error}` });
      } else {
        const r = await api.edi.pollPartner(p.id);
        const rr = r as { ok: boolean; received?: number; sent?: number; responses?: number; error?: string };
        setBanner(rr.ok
          ? { ok: true, text: `${p.name}: received ${rr.received ?? 0} file(s)${rr.sent !== undefined ? `, sent ${rr.sent}, ${rr.responses ?? 0} EERP/NERP` : ''}` }
          : { ok: false, text: `${p.name}: ${rr.error}` });
      }
    } catch (e) {
      setBanner({ ok: false, text: (e as Error).message });
    }
  };

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <span className="spacer" />
        <button className="primary" onClick={() => setEditing('new')}>New partner</button>
      </div>
      {banner && <div className={`banner ${banner.ok ? 'ok' : 'error'}`} onClick={() => setBanner(null)}>{banner.text}</div>}
      {editing && (
        <PartnerForm
          partner={editing === 'new' ? undefined : editing} flows={flows} station={station}
          onCancel={() => setEditing(null)}
          onSaved={(p) => {
            setEditing(null);
            setBanner({ ok: true, text: `${p.name} saved` });
            refresh();
          }}
        />
      )}
      {sending && <SendForm partner={sending} onClose={() => setSending(null)} />}
      {!partners ? <p className="muted">Loading…</p> : !partners.length ? <div className="empty">No trading partners yet.</div> : (
        <table className="flows">
          <thead><tr><th>Partner</th><th>Protocol</th><th>Connection</th><th>Inbound flow</th><th /></tr></thead>
          <tbody>
            {partners.map((p) => (
              <tr key={p.id} className={p.enabled ? '' : 'disabled'}>
                <td><b>{p.name}</b>{!p.enabled && <span className="muted small"> (disabled)</span>}</td>
                <td><span className={`proto ${p.protocol}`}>{p.protocol.toUpperCase()}</span></td>
                <td className="small"><code>{summary(p, station)}</code></td>
                <td className="small">{p.inbound_flow ? <code>/flows/{p.inbound_flow}</code> : <span className="muted">none (logged only)</span>}</td>
                <td className="actions">
                  <button onClick={() => setSending(p)}>Send…</button>
                  {(p.protocol === 'as2' || (p.protocol === 'sftp' && p.config.mode === 'remote')) && <button className="ghost" onClick={() => act(p, 'test')}>Test</button>}
                  {((p.protocol === 'sftp' && p.config.mode === 'remote' && p.config.pollDir) || (p.protocol === 'oftp2' && p.config.mode !== 'wait') || (p.protocol === 'jx' && p.config.mode === 'client')) && (
                    <button className="ghost" onClick={() => act(p, 'poll')}>{p.protocol === 'oftp2' ? 'Call now' : p.protocol === 'jx' ? 'GetDocument now' : 'Poll now'}</button>
                  )}
                  <button className="ghost" onClick={() => setEditing(p)}>Edit</button>
                  <button className="ghost danger" onClick={() => act(p, 'delete')}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function summary(p: EdiPartner, st: EdiStation | null): string {
  const c = p.config;
  if (p.protocol === 'jx') {
    return `${c.jxId} · ${c.mode === 'client' ? `we call ${c.url}${c.pollIntervalSec ? `, poll every ${c.pollIntervalSec}s` : ''}` : 'calls our JX server'} · ${c.formatType}/${c.documentType}${c.compressType ? ` · ${c.compressType.replace('application/', '')}` : ''}`;
  }
  if (p.protocol === 'ebms') {
    return `${c.partyId} · ${c.url} · ${c.service}/${c.action}${c.ackRequested === false ? ' · no ack' : ` · ${c.syncReply === false ? 'async' : 'sync'} ack, ${c.retries ?? 3} retries`}`;
  }
  if (p.protocol === 'oftp2') {
    const sec = [c.secureAuth && 'secure auth', c.sign && 'sign', c.compress && 'zlib', c.encrypt && `enc suite ${c.cipherSuite || '02'}`, c.signedEerp && 'signed EERP'].filter(Boolean).join(', ');
    return `${c.odetteId} · ${c.mode === 'wait' ? 'waits for partner call' : `calls ${c.host}:${c.port || (c.tls ? 6619 : 3305)}${c.tls ? ' TLS' : ''}`}${sec ? ` · ${sec}` : ''}`;
  }
  if (p.protocol === 'as2') return `${c.as2Id} → ${c.url ?? '(no URL)'} · ${[c.sign && `sign ${c.sign}`, c.encrypt && `enc ${c.encrypt}`, c.compress && 'zlib', `MDN ${c.mdn ?? 'sync'}`].filter(Boolean).join(', ')}`;
  if (c.mode === 'hosted') return `hosted: partner logs in as ${c.username} on port ${st?.sftp.port ?? 2222}`;
  return `remote: ${c.username}@${c.host}:${c.port || 22} up ${c.uploadDir || '.'}${c.pollDir ? `, poll ${c.pollDir}` : ''}${c.hostKeySha256 ? ', key pinned' : ''}`;
}

const AS2_DEFAULT = { as2Id: '', url: '', certificate: '', sign: 'sha-256', encrypt: 'aes-256-cbc', compress: false, mdn: 'sync', mdnSigned: true, requireSigned: true, requireEncrypted: false };
const OFTP_DEFAULT = {
  odetteId: '', mode: 'call', host: '', port: 3305, tls: false, sdeb: 4096, credit: 64, cipherSuite: '02',
  secureAuth: false, sign: false, compress: false, encrypt: false, signedEerp: false, requireSigned: false, requireEncrypted: false, certificate: '', pollIntervalSec: 0,
};
const JX_DEFAULT = {
  mode: 'server', jxId: '', url: '', formatType: 'SecondGenEDI', documentType: '', compressType: '', username: '', pollIntervalSec: 0, getFormatType: '', getDocumentType: '',
};
const EBMS_DEFAULT = {
  partyId: '', partyIdType: '', url: '', cpaId: '', service: '', serviceType: '', action: '', fromRole: '', toRole: '',
  ackRequested: true, syncReply: true, duplicateElimination: true, retries: 3, retryIntervalSec: 60,
};
const SFTP_DEFAULT = { mode: 'remote', host: '', port: 22, username: '', uploadDir: '/upload', pollDir: '', archiveDir: '', hostKeySha256: '' };

function PartnerForm({ partner, flows, station, onCancel, onSaved }: {
  partner?: EdiPartner; flows: FlowRecord[]; station: EdiStation | null; onCancel: () => void; onSaved: (p: EdiPartner) => void;
}) {
  const [name, setName] = useState(partner?.name ?? '');
  const [protocol, setProtocol] = useState<EdiProtocol>(partner?.protocol ?? 'as2');
  const [enabled, setEnabled] = useState(partner?.enabled ?? true);
  const [inbound, setInbound] = useState(partner?.inbound_flow ?? '');
  const [cfg, setCfg] = useState<Record<string, any>>(partner?.config ?? AS2_DEFAULT);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Record<string, any>) => setCfg({ ...cfg, ...patch });
  const has = (k: string) => partner?.secrets?.[k];

  const switchProtocol = (p: EdiProtocol) => {
    setProtocol(p);
    setCfg(p === 'as2' ? AS2_DEFAULT : p === 'oftp2' ? OFTP_DEFAULT : p === 'ebms' ? EBMS_DEFAULT : p === 'jx' ? JX_DEFAULT : SFTP_DEFAULT);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    const clean = Object.fromEntries(Object.entries(cfg).filter(([, v]) => v !== '' && v !== null && v !== undefined));
    for (const k of ['port', 'sdeb', 'credit', 'pollIntervalSec', 'retries', 'retryIntervalSec']) if (clean[k] !== undefined) clean[k] = Number(clean[k]);
    if (clean.odetteId) clean.odetteId = String(clean.odetteId).toUpperCase();
    const body: EdiPartnerInput = {
      name, protocol, enabled, config: clean, inbound_flow: inbound || null,
      secrets: Object.fromEntries(Object.entries(secrets).filter(([, v]) => v !== undefined)),
    };
    try {
      onSaved(partner ? await api.edi.updatePartner(partner.id, body) : await api.edi.createPartner(body));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const secretInput = (k: string, label: string, multiline = false) => (
    <label className="field">
      <span>{label} {has(k) && <span className="badge live">stored in Vault</span>}</span>
      {multiline ? (
        <textarea className="mono" rows={3} value={secrets[k] ?? ''} placeholder={has(k) ? '(unchanged; type to replace)' : ''} onChange={(e) => setSecrets({ ...secrets, [k]: e.target.value })} />
      ) : (
        <input type="password" autoComplete="new-password" value={secrets[k] ?? ''} placeholder={has(k) ? '(unchanged; type to replace)' : ''} onChange={(e) => setSecrets({ ...secrets, [k]: e.target.value })} />
      )}
      {has(k) && <button className="ghost danger small-btn" onClick={() => setSecrets({ ...secrets, [k]: '' })}>Clear on save</button>}
    </label>
  );
  const text = (k: string, label: string, placeholder = '', hint?: string) => (
    <label className="field"><span>{label}</span>
      <input className="mono" value={cfg[k] ?? ''} placeholder={placeholder} onChange={(e) => set({ [k]: e.target.value })} />
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
  const check = (k: string, label: string) => (
    <label className="check"><input type="checkbox" checked={Boolean(cfg[k])} onChange={(e) => set({ [k]: e.target.checked })} /> {label}</label>
  );

  return (
    <div className="card">
      <h3>{partner ? `Edit ${partner.name}` : 'New trading partner'}</h3>
      <div className="grid2">
        <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="acme" /></label>
        <label className="field"><span>Protocol</span>
          <select value={protocol} disabled={Boolean(partner)} onChange={(e) => switchProtocol(e.target.value as EdiProtocol)}>
            <option value="as2">EDIINT AS2</option>
            <option value="oftp2">OFTP2 (ODETTE FTP 2.0)</option>
            <option value="ebms">ebXML MS 2.0</option>
            <option value="jx">JX手順</option>
            <option value="sftp">SFTP</option>
          </select>
        </label>
        <label className="field"><span>Inbound flow (documents from this partner are POSTed here)</span>
          <select value={inbound} onChange={(e) => setInbound(e.target.value)}>
            <option value="">none (log only)</option>
            {flows.map((f) => <option key={f.id} value={f.slug}>{f.name} (/flows/{f.slug})</option>)}
          </select>
        </label>
        <label className="check" style={{ alignSelf: 'end', marginBottom: 14 }}><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled</label>
      </div>

      {protocol === 'as2' && (
        <>
          <div className="grid2">
            {text('as2Id', 'Partner AS2 ID', 'PARTNER-AS2')}
            {text('url', 'Partner AS2 URL', 'https://partner.example.com/as2')}
          </div>
          <label className="field"><span>Partner certificate (PEM): verifies their signatures and encrypts to them</span>
            <textarea className="mono" rows={4} value={cfg.certificate ?? ''} placeholder="-----BEGIN CERTIFICATE-----" onChange={(e) => set({ certificate: e.target.value })} />
          </label>
          <div className="grid3">
            <label className="field"><span>Sign outbound</span>
              <select value={cfg.sign ?? ''} onChange={(e) => set({ sign: e.target.value })}>
                <option value="">no</option><option>sha-256</option><option>sha-384</option><option>sha-512</option><option>sha1</option>
              </select>
            </label>
            <label className="field"><span>Encrypt outbound</span>
              <select value={cfg.encrypt ?? ''} onChange={(e) => set({ encrypt: e.target.value })}>
                <option value="">no</option><option>aes-256-cbc</option><option>aes-192-cbc</option><option>aes-128-cbc</option><option>des-ede3-cbc</option>
              </select>
            </label>
            <label className="field"><span>MDN</span>
              <select value={cfg.mdn ?? 'sync'} onChange={(e) => set({ mdn: e.target.value })}>
                <option value="sync">synchronous</option><option value="async">asynchronous</option><option value="none">none</option>
              </select>
            </label>
          </div>
          <div className="row wrap">
            {check('compress', 'Compress (zlib)')}
            {check('mdnSigned', 'Request signed MDN')}
            {check('requireSigned', 'Require signed inbound')}
            {check('requireEncrypted', 'Require encrypted inbound')}
          </div>
          <div className="grid2">
            {text('username', 'HTTP basic auth user (optional)')}
            {secretInput('password', 'HTTP basic auth password')}
          </div>
          <p className="muted small">Give the partner our AS2 ID <code>{station?.as2.as2Id ?? '(set on Our station)'}</code>, our certificate, and the URL <code>{station?.as2.publicUrl ?? 'http://<this host>:4080/as2'}</code>.</p>
        </>
      )}

      {protocol === 'jx' && (
        <>
          <div className="grid3">
            <label className="field"><span>Mode</span>
              <select value={cfg.mode ?? 'server'} onChange={(e) => set({ mode: e.target.value })}>
                <option value="server">Server: the partner is a JX client of our hub</option>
                <option value="client">Client: we call the partner's JX server</option>
              </select>
            </label>
            {text('jxId', 'Partner id (senderId / receiverId)', '4912345000019', 'Also used as MessageHeader From/To')}
            <label className="field"><span>Compression (compressType)</span>
              <select value={cfg.compressType ?? ''} onChange={(e) => set({ compressType: e.target.value })}>
                <option value="">none</option><option value="application/zip">ZIP (application/zip)</option><option value="application/gzip">GZIP (application/gzip)</option>
              </select>
            </label>
          </div>
          <div className="grid3">
            {text('formatType', 'formatType (outbound)', 'SecondGenEDI')}
            {text('documentType', 'documentType (outbound)', 'Order')}
            {text('username', cfg.mode === 'client' ? 'Basic auth user (ours)' : 'Basic auth user the partner logs in with')}
          </div>
          {secretInput('password', cfg.mode === 'client' ? 'Basic auth password (ours)' : 'Password the partner must send')}
          {cfg.mode === 'client' ? (
            <div className="grid3">
              {text('url', "Partner's JX server URL", 'https://jx.partner.example/JXMSTransfer')}
              {text('pollIntervalSec', 'GetDocument every N seconds (0 = manual)', '300')}
              <div className="row">
                {text('getFormatType', 'Only fetch formatType (2007)', '')}
                {text('getDocumentType', 'documentType', '')}
              </div>
            </div>
          ) : (
            <label className="field"><span>Accepted formatType/documentType (one per line, empty = any)</span>
              <textarea className="mono" rows={2} value={(cfg.acceptedTypes ?? []).join('\n')} placeholder="SecondGenEDI/Order"
                onChange={(e) => set({ acceptedTypes: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) })} />
            </label>
          )}
          <p className="muted small">
            {cfg.mode === 'client'
              ? 'Sends with PutDocument (a duplicate messageId counts as delivered) and receives with GetDocument followed by ConfirmDocument.'
              : <>The partner calls <code>http://&lt;this host&gt;:4095/jx</code> with HTTP Basic auth. Its PutDocument goes to the inbound flow. Our sends wait until it calls GetDocument, and become <b>delivered</b> on ConfirmDocument.</>}
          </p>
        </>
      )}

      {protocol === 'ebms' && (
        <>
          <div className="grid3">
            {text('partyId', 'Partner PartyId', '00000000000000000000')}
            {text('partyIdType', 'PartyId type (optional)', 'urn:osb:oin')}
            {text('url', 'Partner ebMS endpoint', 'https://partner.example/ebms')}
          </div>
          <div className="grid3">
            {text('cpaId', 'CPAId', 'cpa-partner')}
            {text('service', 'Service', 'urn:services:orders')}
            {text('serviceType', 'Service type (optional)')}
          </div>
          <div className="grid3">
            {text('action', 'Action', 'Order')}
            {text('fromRole', 'Our role (optional)', 'Seller')}
            {text('toRole', 'Partner role (optional)', 'Buyer')}
          </div>
          <div className="row wrap">
            {check('ackRequested', 'Request Acknowledgment (reliable messaging)')}
            {check('syncReply', 'Synchronous reply (SyncReply)')}
            {check('duplicateElimination', 'Duplicate elimination')}
          </div>
          <div className="grid3">
            {text('retries', 'Retries', '3')}
            {text('retryIntervalSec', 'Retry interval (s, async)', '60')}
            {text('username', 'HTTP basic auth user (optional)')}
          </div>
          {secretInput('password', 'HTTP basic auth password')}
          <p className="muted small">
            These values must match the CPA agreed with the partner. Partners send to <code>http://&lt;this host&gt;:4090/ebms</code> using our PartyId
            <code> {station?.ebms.partyId ?? '(set on Our station)'}</code>. Inbound messages are acknowledged as the sender requests (sync or async). Duplicates are acknowledged again but not delivered twice, and Ping/StatusRequest are answered.
          </p>
        </>
      )}

      {protocol === 'oftp2' && (
        <>
          <div className="grid3">
            {text('odetteId', 'Partner ODETTE ID (SSID code)', 'O0013000000000000PARTNER', 'Up to 25 of A-Z 0-9 / - . & ( )')}
            <label className="field"><span>Mode</span>
              <select value={cfg.mode ?? 'call'} onChange={(e) => set({ mode: e.target.value })}>
                <option value="call">Call: we connect to the partner</option>
                <option value="wait">Wait: the partner calls us (files queue until then)</option>
              </select>
            </label>
            <label className="field"><span>Cipher suite</span>
              <select value={cfg.cipherSuite ?? '02'} onChange={(e) => set({ cipherSuite: e.target.value })}>
                {Object.entries(station?.oftp2.cipherSuites ?? { '01': '3DES / RSA / SHA-1', '02': 'AES-256 / RSA / SHA-1' }).map(([k, v]) => <option key={k} value={k}>{k}: {v}</option>)}
              </select>
            </label>
          </div>
          {cfg.mode !== 'wait' && (
            <div className="grid3">
              {text('host', 'Host', 'oftp.partner.example')}
              {text('port', 'Port', '3305 (TLS: 6619)')}
              {text('pollIntervalSec', 'Call every N seconds (0 = only when sending)', '0')}
            </div>
          )}
          <div className="grid3">
            {text('sdeb', 'Exchange buffer size', '4096')}
            {text('credit', 'Credit window', '64')}
            {secretInput('sendPassword', 'Password we send (SSID)')}
          </div>
          <div className="grid3">
            {secretInput('receivePassword', 'Password the partner must send')}
          </div>
          <div className="row wrap">
            {cfg.mode !== 'wait' && check('tls', 'TLS (port 6619)')}
            {check('secureAuth', 'Secure authentication')}
            {check('sign', 'Sign files')}
            {check('compress', 'Compress files')}
            {check('encrypt', 'Encrypt files')}
            {check('signedEerp', 'Request signed EERP')}
          </div>
          <div className="row wrap">
            {check('requireSigned', 'Require signed inbound')}
            {check('requireEncrypted', 'Require encrypted inbound')}
            {check('requireSignedEerp', 'Require signed EERP')}
          </div>
          <label className="field"><span>Partner certificate (PEM): encryption, signature checks, secure authentication{cfg.tls ? ', TLS trust' : ''}</span>
            <textarea className="mono" rows={4} value={cfg.certificate ?? ''} placeholder="-----BEGIN CERTIFICATE-----" onChange={(e) => set({ certificate: e.target.value })} />
          </label>
          <p className="muted small">
            Give the partner our ODETTE ID <code>{station?.oftp2.odetteId ?? '(set on Our station)'}</code>, our certificate, and
            <code> &lt;this host&gt;:3305</code> (TLS <code>6619</code>). Files are acknowledged end-to-end with EERPs: a sent file is <b>delivered</b> once the partner's EERP arrives.
          </p>
        </>
      )}

      {protocol === 'sftp' && (
        <>
          <label className="field"><span>Mode</span>
            <select value={cfg.mode} onChange={(e) => set({ mode: e.target.value })}>
              <option value="remote">Remote: we connect to the partner's SFTP server</option>
              <option value="hosted">Hosted: the partner connects to our SFTP server</option>
            </select>
          </label>
          {cfg.mode === 'remote' ? (
            <>
              <div className="grid3">
                {text('host', 'Host', 'sftp.partner.example')}
                {text('port', 'Port', '22')}
                {text('username', 'Username')}
              </div>
              <div className="grid3">
                {text('uploadDir', 'Upload directory', '/upload', 'Sent files are written as .part, then renamed')}
                {text('pollDir', 'Poll directory (receive)', '/download', 'Leave empty to only send')}
                {text('archiveDir', 'Archive directory', '', 'Move received files here (else delete)')}
              </div>
              {text('hostKeySha256', 'Pinned host key', 'SHA256:…', 'Use Test to see the server key. Without a pin, any key is accepted.')}
              <div className="grid2">
                {secretInput('password', 'Password')}
                {secretInput('passphrase', 'Key passphrase')}
              </div>
              {secretInput('privateKey', 'Private key (OpenSSH/PEM)', true)}
            </>
          ) : (
            <>
              {text('username', 'Login name for the partner')}
              <label className="field"><span>Partner public key (OpenSSH, optional)</span>
                <textarea className="mono" rows={2} value={cfg.authorizedKey ?? ''} placeholder="ssh-ed25519 AAAA…" onChange={(e) => set({ authorizedKey: e.target.value })} />
              </label>
              {secretInput('password', 'Password (optional)')}
              <p className="muted small">
                The partner connects to <code>sftp://&lt;this host&gt;:{station?.sftp.port ?? 2222}</code> as <code>{cfg.username || 'username'}</code>, host key <code>{station?.sftp.hostKeyFingerprint}</code>.
                Uploads to <code>/inbox</code> are received. Our sends appear in <code>/outbox</code>.
              </p>
            </>
          )}
        </>
      )}
      {error && <div className="banner error">{error}</div>}
      <div className="row">
        <span className="spacer" />
        <button className="ghost" onClick={onCancel}>Cancel</button>
        <button className="primary" onClick={save} disabled={busy || !name}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}

function SendForm({ partner, onClose }: { partner: EdiPartner; onClose: () => void }) {
  const [filename, setFilename] = useState('test.edi');
  const [contentType, setContentType] = useState('application/edifact');
  const [content, setContent] = useState("UNB+UNOC:3+IPAAS+PARTNER+261005:1200+1'\nUNZ+0+1'\n");
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      const r = await api.edi.send({ partner: partner.name, filename, contentType, content });
      setResult(r.ok ? `✓ ${r.status} · ${r.messageId}` : `✗ ${r.error}`);
    } catch (e) {
      setResult(`✗ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card">
      <h3>Send a test document to {partner.name}</h3>
      <div className="grid2">
        <label className="field"><span>File name</span><input className="mono" value={filename} onChange={(e) => setFilename(e.target.value)} /></label>
        <label className="field"><span>Content type</span><input className="mono" value={contentType} onChange={(e) => setContentType(e.target.value)} /></label>
      </div>
      <label className="field"><span>Content</span><textarea className="mono" rows={4} value={content} onChange={(e) => setContent(e.target.value)} /></label>
      {result && <div className={`banner ${result.startsWith('✓') ? 'ok' : 'error'}`}>{result}</div>}
      <div className="row"><span className="spacer" /><button className="ghost" onClick={onClose}>Close</button><button className="primary" disabled={busy} onClick={send}>{busy ? 'Sending…' : 'Send'}</button></div>
    </div>
  );
}

// ---- messages ---------------------------------------------------------------

function Messages() {
  const [msgs, setMsgs] = useState<EdiMessage[] | null>(null);
  const [direction, setDirection] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const refresh = () => api.edi.messages({ direction, limit: 200 }).then(setMsgs).catch(() => undefined);
  useEffect(() => {
    refresh();
    if (!auto) return;
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [direction, auto]);

  const retry = async (m: EdiMessage) => {
    await api.edi.forward(m.id).catch(() => undefined);
    refresh();
  };

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <select value={direction} onChange={(e) => setDirection(e.target.value)} style={{ width: 180 }}>
          <option value="">All directions</option><option value="in">Inbound</option><option value="out">Outbound</option>
        </select>
        <label className="check"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto-refresh</label>
        <span className="spacer" />
        <button className="ghost" onClick={refresh}>Refresh</button>
      </div>
      {!msgs ? <p className="muted">Loading…</p> : !msgs.length ? <div className="empty">No messages yet.</div> : (
        <table className="flows msgs">
          <thead><tr><th>Time</th><th /><th>Partner</th><th>File</th><th>Status</th><th>Receipt</th><th>Flow</th><th /></tr></thead>
          <tbody>
            {msgs.map((m) => (
              <MessageRow key={m.id} m={m} open={open === m.id} onToggle={() => setOpen(open === m.id ? null : m.id)} onRetry={() => retry(m)} />
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function MessageRow({ m, open, onToggle, onRetry }: { m: EdiMessage; open: boolean; onToggle: () => void; onRetry: () => void }) {
  const receipt = useMemo(() => receiptSummary(m), [m]);
  return (
    <>
      <tr onClick={onToggle} className="clickable">
        <td className="small muted">{new Date(m.created_at).toLocaleString()}</td>
        <td title={m.direction === 'in' ? 'inbound' : 'outbound'}>{m.direction === 'in' ? '⬇' : '⬆'}</td>
        <td>{m.partner_name}<div className="muted small">{m.protocol.toUpperCase()}</div></td>
        <td className="small"><code>{m.filename}</code><div className="muted">{fmtSize(m.size)} · {m.content_type}</div></td>
        <td><span className={`badge ${statusClass(m.status)}`} title={m.error ?? ''}>{m.status}</span></td>
        <td className="small">{receipt}</td>
        <td className="small">{m.flow_slug ? <><code>{m.flow_slug}</code>{m.flow_status != null && <span className="muted"> → {m.flow_status}</span>}</> : <span className="muted">-</span>}</td>
        <td className="actions" onClick={(e) => e.stopPropagation()}>
          <a className="btn-link" href={`/api/edi/messages/${m.id}/payload`}>Download</a>
          {m.direction === 'in' && m.flow_slug && <button className="ghost" onClick={onRetry}>{m.status === 'forwarded' ? 'Resend to flow' : 'Retry'}</button>}
        </td>
      </tr>
      {open && (
        <tr className="detail">
          <td colSpan={8}>
            {m.error && <div className="banner error small">{m.error}</div>}
            <div className="small muted">Message ID: <code>{m.message_id}</code> · id <code>{m.id}</code></div>
            <pre className="code">{JSON.stringify(m.receipt, null, 2)}</pre>
          </td>
        </tr>
      )}
    </>
  );
}

function receiptSummary(m: EdiMessage): string {
  const r = m.receipt ?? {};
  if (m.protocol === 'as2') {
    const flags = [r.signed && 'signed', r.encrypted && 'encrypted', r.compressed && 'compressed'].filter(Boolean).join(', ');
    if (m.direction === 'out') {
      const mdn = r.mdn;
      if (mdn) return `MDN ${mdn.status}${mdn.modifier ? ` (${mdn.modifier})` : ''}${mdn.receivedMic ? (mdn.receivedMic === r.mic ? ', MIC ✓' : ', MIC ✗') : ''}${mdn.signed ? (mdn.verified ? ', signed ✓' : ', signature ✗') : ''}`;
      return r.mdnMode === 'async' ? 'waiting for async MDN' : flags;
    }
    return flags || 'plain';
  }
  if (m.protocol === 'sftp') return r.path ?? m.message_id ?? '';
  if (m.protocol === 'jx') {
    const t = `${r.formatType ?? ''}/${r.documentType ?? ''}${r.compressType ? ` · ${String(r.compressType).replace('application/', '')}` : ''}`;
    if (m.direction === 'out') {
      if (r.mode === 'client') return `PutDocument ${r.duplicate ? '(duplicate, already on server)' : 'accepted'} · ${t}`;
      return r.confirmedAt ? `ConfirmDocument received · ${t}` : r.fetchedAt ? `fetched ${r.fetches}×, waiting for ConfirmDocument` : `waiting for GetDocument · ${t}`;
    }
    return `${r.senderId ?? ''} → ${r.receiverId ?? ''} · ${t}`;
  }
  if (m.protocol === 'ebms') {
    if (m.direction === 'out') {
      if (r.errors?.length) return `ErrorList: ${r.errors.map((e: any) => e.code).join(', ')}`;
      if (r.acknowledgment) return `Acknowledgment from ${r.acknowledgment.from}${r.attempts > 1 ? ` (attempt ${r.attempts})` : ''}`;
      return r.ackRequested === false ? 'no acknowledgment requested' : `waiting for Acknowledgment (attempt ${r.attempts ?? 1})`;
    }
    return `${r.service ?? ''} / ${r.action ?? ''}${r.duplicates ? ` · ${r.duplicates} duplicate(s) eliminated` : ''}`;
  }
  if (m.protocol === 'oftp2') {
    const sec = { '00': 'plain', '01': 'encrypted', '02': 'signed', '03': 'signed+encrypted' }[r.security as string] ?? '';
    if (m.direction === 'out') {
      const resp = r.response;
      if (resp) return `${resp.type}${resp.signed ? (resp.verified ? ', signed ✓' : ', signature ✗') : ''}${resp.hashPresent ? (resp.hashMatch ? ', hash ✓' : ', hash ✗') : ''}`;
      return m.status === 'queued' ? 'waiting for partner call' : 'waiting for EERP';
    }
    return [r.dsn, sec, r.compressed && 'zlib', r.cipherSuite && r.cipherSuite !== '00' && `suite ${r.cipherSuite}`].filter(Boolean).join(', ');
  }
  return '';
}

const statusClass = (s: string) => (['delivered', 'forwarded', 'sent'].includes(s) ? 'live' : ['failed', 'forward-failed'].includes(s) ? 'error' : s === 'received' ? 'draft' : 'outdated');
const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

// ---- station ----------------------------------------------------------------

function Station() {
  const [st, setSt] = useState<EdiStation | null>(null);
  const [form, setForm] = useState({ as2Id: '', email: '', publicUrl: '' });
  const [upload, setUpload] = useState<{ certificate: string; privateKey: string } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = () => api.edi.station().then((s) => {
    setSt(s);
    setForm({ as2Id: s.as2.as2Id ?? '', email: s.as2.email ?? '', publicUrl: s.as2.publicUrl ?? '' });
  });
  useEffect(() => {
    load();
  }, []);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      setMsg({ ok: true, text: ok });
      setUpload(null);
      load();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };
  const downloadCert = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([st!.as2.certificate!], { type: 'application/x-pem-file' }));
    a.download = `${st!.as2.as2Id || 'as2'}.cer`;
    a.click();
  };
  if (!st) return <p className="muted">Loading…</p>;
  return (
    <>
      {msg && <div className={`banner ${msg.ok ? 'ok' : 'error'}`} onClick={() => setMsg(null)}>{msg.text}</div>}
      <div className="card">
        <h3>AS2 station</h3>
        <div className="grid3">
          <label className="field"><span>Our AS2 ID</span><input className="mono" value={form.as2Id} onChange={(e) => setForm({ ...form, as2Id: e.target.value })} /></label>
          <label className="field"><span>MDN e-mail (Disposition-Notification-To)</span><input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="optional" /></label>
          <label className="field"><span>Public AS2 URL (for partners and async MDN)</span><input className="mono" value={form.publicUrl} onChange={(e) => setForm({ ...form, publicUrl: e.target.value })} placeholder="https://edi.example.com/as2" /></label>
        </div>
        <div className="row"><span className="spacer" /><button onClick={() => run(() => api.edi.saveAs2Station(form), 'AS2 station saved')} disabled={!form.as2Id}>Save</button></div>
        <h3 style={{ marginTop: 16 }}>Certificate (signing and decryption)</h3>
        {st.as2.certInfo ? (
          <div className="small">
            <div>Subject: <code>{st.as2.certInfo.subject}</code></div>
            <div>Expires: <code>{st.as2.certInfo.notAfter}</code></div>
            <div>SHA-256: <code className="select">{st.as2.certInfo.fingerprint}</code></div>
          </div>
        ) : <p className="muted">No certificate yet.</p>}
        <p className="muted small">The private key is kept in Vault (<code>ipaas/edi/station/as2</code>). Share only the certificate with partners.</p>
        <div className="row wrap">
          {st.as2.certificate && <button onClick={downloadCert}>Download certificate</button>}
          <button onClick={() => confirm('Generate a new self-signed certificate? Partners must get the new certificate.') && run(() => api.edi.as2Certificate({ generate: true }), 'Certificate generated')} disabled={!st.as2.as2Id}>Generate self-signed</button>
          <button className="ghost" onClick={() => setUpload({ certificate: '', privateKey: '' })}>Upload certificate + key…</button>
        </div>
        {upload && (
          <div className="grid2" style={{ marginTop: 10 }}>
            <label className="field"><span>Certificate (PEM)</span><textarea className="mono" rows={5} value={upload.certificate} onChange={(e) => setUpload({ ...upload, certificate: e.target.value })} /></label>
            <label className="field"><span>Private key (PEM, unencrypted)</span><textarea className="mono" rows={5} value={upload.privateKey} onChange={(e) => setUpload({ ...upload, privateKey: e.target.value })} /></label>
            <div className="row"><button className="primary" onClick={() => run(() => api.edi.as2Certificate(upload), 'Certificate stored in Vault')}>Store</button><button className="ghost" onClick={() => setUpload(null)}>Cancel</button></div>
          </div>
        )}
      </div>
      <OftpStation st={st} run={run} />
      <EbmsStation st={st} run={run} />
      <JxStation st={st} run={run} />
      <div className="card">
        <h3>SFTP server (hosted partners)</h3>
        <div className="small">Port <code>{st.sftp.port}</code> · host key <code className="select">{st.sftp.hostKeyFingerprint}</code></div>
        <p className="muted small">Hosted partners log in with their own user. Each is confined to <code>/inbox</code> (uploads to us) and <code>/outbox</code> (documents from us).</p>
      </div>
    </>
  );
}

function OftpStation({ st, run }: { st: EdiStation; run: (fn: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const [odetteId, setOdetteId] = useState(st.oftp2.odetteId ?? '');
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([st.oftp2.certificate!], { type: 'application/x-pem-file' }));
    a.download = `${st.oftp2.odetteId || 'oftp2'}.cer`;
    a.click();
  };
  return (
    <div className="card">
      <h3>OFTP2 station</h3>
      <div className="row">
        <label className="field grow"><span>Our ODETTE ID</span><input className="mono" value={odetteId} onChange={(e) => setOdetteId(e.target.value.toUpperCase())} placeholder="O0013000000000000IPAAS" /></label>
        <button style={{ alignSelf: 'end', marginBottom: 10 }} onClick={() => run(() => api.edi.saveOftpStation({ odetteId }), 'OFTP2 station saved')} disabled={!odetteId}>Save</button>
      </div>
      {st.oftp2.certInfo ? (
        <div className="small">
          <div>Certificate: <code>{st.oftp2.certInfo.subject}</code>, expires <code>{st.oftp2.certInfo.notAfter}</code></div>
          <div>SHA-256: <code className="select">{st.oftp2.certInfo.fingerprint}</code></div>
        </div>
      ) : <p className="muted small">No certificate yet. It's needed for signing, encryption, secure authentication and the TLS listener (6619).</p>}
      <div className="row wrap">
        {st.oftp2.certificate && <button onClick={download}>Download certificate</button>}
        <button onClick={() => confirm('Generate a new self-signed OFTP2 certificate?') && run(() => api.edi.oftpCertificate({ generate: true }), 'Certificate generated')} disabled={!st.oftp2.odetteId}>Generate self-signed</button>
      </div>
      <p className="muted small">Listening on port <code>3305</code> and, once a certificate exists, TLS on <code>6619</code>. Private key in Vault (<code>ipaas/edi/station/oftp2</code>).</p>
    </div>
  );
}

function EbmsStation({ st, run }: { st: EdiStation; run: (fn: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const [partyId, setPartyId] = useState(st.ebms.partyId ?? '');
  const [partyIdType, setPartyIdType] = useState(st.ebms.partyIdType ?? '');
  return (
    <div className="card">
      <h3>ebXML MS station</h3>
      <div className="grid3">
        <label className="field"><span>Our PartyId</span><input className="mono" value={partyId} onChange={(e) => setPartyId(e.target.value)} /></label>
        <label className="field"><span>PartyId type (optional)</span><input className="mono" value={partyIdType} onChange={(e) => setPartyIdType(e.target.value)} placeholder="urn:osb:oin" /></label>
        <button style={{ alignSelf: 'end', marginBottom: 10 }} disabled={!partyId} onClick={() => run(() => api.edi.saveEbmsStation({ partyId, partyIdType }), 'ebMS station saved')}>Save</button>
      </div>
      <p className="muted small">Endpoint <code>http://&lt;this host&gt;:4090/ebms</code>. Put TLS in front of it for real partners.</p>
    </div>
  );
}

function JxStation({ st, run }: { st: EdiStation; run: (fn: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const [jxId, setJxId] = useState(st.jx.jxId ?? '');
  const [domain, setDomain] = useState(st.jx.domain ?? '');
  return (
    <div className="card">
      <h3>JX手順 station</h3>
      <div className="grid3">
        <label className="field"><span>Our id (senderId / receiverId)</span><input className="mono" value={jxId} onChange={(e) => setJxId(e.target.value)} placeholder="4912345000002" /></label>
        <label className="field"><span>Domain for messageIds (unique@domain)</span><input className="mono" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="edi.example.jp" /></label>
        <button style={{ alignSelf: 'end', marginBottom: 10 }} disabled={!jxId} onClick={() => run(() => api.edi.saveJxStation({ jxId, domain }), 'JX station saved')}>Save</button>
      </div>
      <p className="muted small">JX server endpoint <code>http://&lt;this host&gt;:4095/jx</code> (SOAP 1.1, 2004 and 2007 WSDL). Put HTTPS in front of it for real partners.</p>
    </div>
  );
}
