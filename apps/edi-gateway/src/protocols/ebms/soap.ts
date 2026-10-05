// ebXML Message Service 2.0 (OASIS) SOAP 1.1 envelopes: MessageHeader, Manifest,
// AckRequested, SyncReply, DuplicateElimination, Acknowledgment, ErrorList.
import { XMLParser } from 'fast-xml-parser';

export const NS = {
  soap: 'http://schemas.xmlsoap.org/soap/envelope/',
  eb: 'http://www.oasis-open.org/committees/ebxml-msg/schema/msg-header-2_0.xsd',
  xlink: 'http://www.w3.org/1999/xlink',
};
export const EBMS_SERVICE = 'urn:oasis:names:tc:ebxml-msg:service';
const TO_PARTY_MSH = 'urn:oasis:names:tc:ebxml-msg:actor:toPartyMSH';
const NEXT_MSH = 'http://schemas.xmlsoap.org/soap/actor/next';

export interface Party { id: string; type?: string; role?: string }

export interface Header {
  from: Party;
  to: Party;
  cpaId: string;
  conversationId: string;
  service: string;
  serviceType?: string;
  action: string;
  messageId: string;
  timestamp: string;
  refToMessageId?: string;
  duplicateElimination?: boolean;
}

export interface EbmsError { code: string; severity: 'Error' | 'Warning'; location?: string; description: string }

export interface Envelope {
  header: Header;
  ackRequested?: { signed: boolean };
  syncReply?: boolean;
  manifest?: { href: string }[];
  acknowledgment?: { refToMessageId: string; timestamp?: string };
  errors?: EbmsError[];
  /** Message Status Service (ebMS 2.0 section 7). */
  statusRequest?: { refToMessageId: string };
  statusResponse?: { refToMessageId: string; status: 'Received' | 'Processed' | 'Forwarded' | 'NotRecognized' | 'UnAuthorized'; timestamp?: string };
}

const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const party = (tag: 'From' | 'To', p: Party) =>
  `<eb:${tag}><eb:PartyId${p.type ? ` eb:type="${esc(p.type)}"` : ''}>${esc(p.id)}</eb:PartyId>${p.role ? `<eb:Role>${esc(p.role)}</eb:Role>` : ''}</eb:${tag}>`;

export function buildEnvelope(e: Envelope): string {
  const h = e.header;
  const parts: string[] = [
    `<eb:MessageHeader SOAP:mustUnderstand="1" eb:version="2.0">`,
    party('From', h.from),
    party('To', h.to),
    `<eb:CPAId>${esc(h.cpaId)}</eb:CPAId>`,
    `<eb:ConversationId>${esc(h.conversationId)}</eb:ConversationId>`,
    `<eb:Service${h.serviceType ? ` eb:type="${esc(h.serviceType)}"` : ''}>${esc(h.service)}</eb:Service>`,
    `<eb:Action>${esc(h.action)}</eb:Action>`,
    `<eb:MessageData><eb:MessageId>${esc(h.messageId)}</eb:MessageId><eb:Timestamp>${esc(h.timestamp)}</eb:Timestamp>`
      + (h.refToMessageId ? `<eb:RefToMessageId>${esc(h.refToMessageId)}</eb:RefToMessageId>` : '') + `</eb:MessageData>`,
    h.duplicateElimination ? '<eb:DuplicateElimination/>' : '',
    `</eb:MessageHeader>`,
  ];
  if (e.ackRequested) parts.push(`<eb:AckRequested SOAP:mustUnderstand="1" eb:version="2.0" eb:signed="${e.ackRequested.signed}" SOAP:actor="${TO_PARTY_MSH}"/>`);
  if (e.syncReply) parts.push(`<eb:SyncReply SOAP:mustUnderstand="1" eb:version="2.0" SOAP:actor="${NEXT_MSH}"/>`);
  if (e.acknowledgment) {
    parts.push(`<eb:Acknowledgment SOAP:mustUnderstand="1" eb:version="2.0" SOAP:actor="${TO_PARTY_MSH}">`
      + `<eb:Timestamp>${esc(e.acknowledgment.timestamp ?? h.timestamp)}</eb:Timestamp><eb:RefToMessageId>${esc(e.acknowledgment.refToMessageId)}</eb:RefToMessageId>`
      + party('From', { id: h.from.id, type: h.from.type }) + `</eb:Acknowledgment>`);
  }
  if (e.errors?.length) {
    const highest = e.errors.some((x) => x.severity === 'Error') ? 'Error' : 'Warning';
    parts.push(`<eb:ErrorList SOAP:mustUnderstand="1" eb:version="2.0" eb:highestSeverity="${highest}">`
      + e.errors.map((x) => `<eb:Error eb:codeContext="urn:oasis:names:tc:ebxml-msg:service:errors" eb:errorCode="${esc(x.code)}" eb:severity="${x.severity}"`
        + `${x.location ? ` eb:location="${esc(x.location)}"` : ''}><eb:Description xml:lang="en-US">${esc(x.description)}</eb:Description></eb:Error>`).join('')
      + `</eb:ErrorList>`);
  }
  const bodyParts: string[] = [];
  if (e.manifest?.length) bodyParts.push(`<eb:Manifest eb:version="2.0">${e.manifest.map((m) => `<eb:Reference xlink:href="${esc(m.href)}" xlink:type="simple"/>`).join('')}</eb:Manifest>`);
  if (e.statusRequest) bodyParts.push(`<eb:StatusRequest eb:version="2.0"><eb:RefToMessageId>${esc(e.statusRequest.refToMessageId)}</eb:RefToMessageId></eb:StatusRequest>`);
  if (e.statusResponse) {
    bodyParts.push(`<eb:StatusResponse eb:version="2.0" eb:messageStatus="${e.statusResponse.status}"><eb:RefToMessageId>${esc(e.statusResponse.refToMessageId)}</eb:RefToMessageId>`
      + (e.statusResponse.timestamp && e.statusResponse.status !== 'NotRecognized' && e.statusResponse.status !== 'UnAuthorized' ? `<eb:Timestamp>${esc(e.statusResponse.timestamp)}</eb:Timestamp>` : '')
      + `</eb:StatusResponse>`);
  }
  const body = bodyParts.length ? `<SOAP:Body>${bodyParts.join('')}</SOAP:Body>` : '<SOAP:Body/>';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<SOAP:Envelope xmlns:SOAP="${NS.soap}" xmlns:eb="${NS.eb}" xmlns:xlink="${NS.xlink}">`
    + `<SOAP:Header>${parts.join('')}</SOAP:Header>${body}</SOAP:Envelope>`;
}

export class EnvelopeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const parser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true, textNodeName: '#text', parseTagValue: false, parseAttributeValue: false,
  isArray: (name) => ['Reference', 'Error', 'PartyId'].includes(name),
});

const text = (n: any): string => (n === undefined || n === null ? '' : typeof n === 'object' ? String(n['#text'] ?? '') : String(n)).trim();

function partyOf(n: any): Party {
  const p = n?.PartyId?.[0];
  return { id: text(p), type: p && typeof p === 'object' ? p['@type'] : undefined, role: text(n?.Role) || undefined };
}

/** Parses a SOAP envelope (any namespace prefixes). */
export function parseEnvelope(xml: string): Envelope {
  let doc: any;
  try {
    doc = parser.parse(xml);
  } catch (e) {
    throw new EnvelopeError('OtherXml', `SOAP part is not well-formed XML: ${(e as Error).message}`);
  }
  const env = doc.Envelope;
  if (!env) throw new EnvelopeError('OtherXml', 'no SOAP Envelope');
  const hdr = env.Header ?? {};
  const mh = hdr.MessageHeader;
  if (!mh) throw new EnvelopeError('ValueNotRecognized', 'no eb:MessageHeader');
  if (mh['@version'] && mh['@version'] !== '2.0') throw new EnvelopeError('NotSupported', `ebMS version ${mh['@version']}`);
  const md = mh.MessageData ?? {};
  const svc = mh.Service;
  const header: Header = {
    from: partyOf(mh.From), to: partyOf(mh.To), cpaId: text(mh.CPAId), conversationId: text(mh.ConversationId),
    service: text(svc), serviceType: svc && typeof svc === 'object' ? svc['@type'] : undefined, action: text(mh.Action),
    messageId: text(md.MessageId), timestamp: text(md.Timestamp), refToMessageId: text(md.RefToMessageId) || undefined,
    duplicateElimination: mh.DuplicateElimination !== undefined,
  };
  for (const [k, v] of Object.entries({ 'From/PartyId': header.from.id, 'To/PartyId': header.to.id, CPAId: header.cpaId, ConversationId: header.conversationId, Service: header.service, Action: header.action, MessageId: header.messageId })) {
    if (!v) throw new EnvelopeError('Inconsistent', `MessageHeader ${k} is missing`);
  }
  const out: Envelope = { header };
  if (hdr.AckRequested !== undefined) out.ackRequested = { signed: String(hdr.AckRequested?.['@signed'] ?? 'false') === 'true' };
  if (hdr.SyncReply !== undefined) out.syncReply = true;
  if (hdr.Acknowledgment) out.acknowledgment = { refToMessageId: text(hdr.Acknowledgment.RefToMessageId), timestamp: text(hdr.Acknowledgment.Timestamp) };
  if (hdr.ErrorList) {
    out.errors = (hdr.ErrorList.Error ?? []).map((x: any) => ({
      code: x['@errorCode'] ?? 'Unknown', severity: x['@severity'] === 'Warning' ? 'Warning' : 'Error', location: x['@location'], description: text(x.Description),
    }));
  }
  const refs = env.Body?.Manifest?.Reference;
  if (refs) out.manifest = refs.map((r: any) => ({ href: r['@href'] ?? '' }));
  if (env.Body?.StatusRequest) out.statusRequest = { refToMessageId: text(env.Body.StatusRequest.RefToMessageId) };
  if (env.Body?.StatusResponse) {
    out.statusResponse = { refToMessageId: text(env.Body.StatusResponse.RefToMessageId), status: env.Body.StatusResponse['@messageStatus'], timestamp: text(env.Body.StatusResponse.Timestamp) || undefined };
  }
  return out;
}

export function timestamp(d = new Date()): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
