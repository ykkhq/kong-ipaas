// JX手順 (2004 / 2007 WSDL): SOAP 1.1 document/literal, namespace below, one
// MessageHeader in the SOAP header and one operation element in the body.
import { XMLParser } from 'fast-xml-parser';

export const JX_NS = 'http://www.dsri.jp/edi-bp/2004/jedicos-xml/client-server';
export const SOAP_NS = 'http://schemas.xmlsoap.org/soap/envelope/';
export const soapAction = (op: Operation) => `${JX_NS}/${op}`;

export type Operation = 'PutDocument' | 'GetDocument' | 'ConfirmDocument';

export interface MessageHeader {
  From: string;
  To: string;
  MessageId: string;
  Timestamp: string;
  /** 2007 WSDL: both or neither, GetDocument only. */
  OptionalFormatType?: string;
  OptionalDocumentType?: string;
}

export interface Document {
  messageId: string;
  data: string; // base64
  senderId: string;
  receiverId: string;
  formatType: string;
  documentType: string;
  compressType: string;
}

/** Body elements per operation, in WSDL sequence order. */
export const BODY_FIELDS = {
  PutDocument: ['messageId', 'data', 'senderId', 'receiverId', 'formatType', 'documentType', 'compressType'],
  PutDocumentResponse: ['PutDocumentResult'],
  GetDocument: ['receiverId'],
  GetDocumentResponse: ['GetDocumentResult', 'messageId', 'data', 'senderId', 'receiverId', 'formatType', 'documentType', 'compressType'],
  ConfirmDocument: ['messageId', 'senderId', 'receiverId'],
  ConfirmDocumentResponse: ['ConfirmDocumentResult'],
} as const;
export type BodyName = keyof typeof BODY_FIELDS;

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function timestamp(d = new Date()): string {
  return d.toISOString().slice(0, 19); // YYYY-MM-DDThh:mm:ss (UTC)
}

export function buildEnvelope(header: MessageHeader, body: BodyName, values: Record<string, unknown>): string {
  const h = (['From', 'To', 'MessageId', 'Timestamp'] as const).map((k) => `<${k}>${esc(header[k])}</${k}>`).join('')
    + (header.OptionalFormatType !== undefined ? `<OptionalFormatType>${esc(header.OptionalFormatType)}</OptionalFormatType>` : '')
    + (header.OptionalDocumentType !== undefined ? `<OptionalDocumentType>${esc(header.OptionalDocumentType)}</OptionalDocumentType>` : '');
  const b = BODY_FIELDS[body].map((k) => `<${k}>${esc(typeof values[k] === 'boolean' ? String(values[k]) : values[k])}</${k}>`).join('');
  return `<?xml version="1.0" encoding="utf-8"?>\n<soap:Envelope xmlns:soap="${SOAP_NS}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">`
    + `<soap:Header><MessageHeader xmlns="${JX_NS}">${h}</MessageHeader></soap:Header>`
    + `<soap:Body><${body} xmlns="${JX_NS}">${b}</${body}></soap:Body></soap:Envelope>`;
}

export function buildFault(code: 'Client' | 'Server' | 'VersionMismatch' | 'MustUnderstand', message: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>\n<soap:Envelope xmlns:soap="${SOAP_NS}"><soap:Body><soap:Fault>`
    + `<faultcode>soap:${code}</faultcode><faultstring>${esc(message)}</faultstring></soap:Fault></soap:Body></soap:Envelope>`;
}

export class JxFault extends Error {
  constructor(readonly code: 'Client' | 'Server' | 'VersionMismatch' | 'MustUnderstand', message: string) {
    super(message);
  }
}

const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false, trimValues: true });
const str = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'object' ? '' : String(v));

export interface Parsed {
  header?: MessageHeader;
  body: BodyName;
  values: Record<string, string>;
}

/** Parses a JX request or response. SOAP Faults throw JxFault. */
export function parseEnvelope(xml: string): Parsed {
  let doc: any;
  try {
    doc = parser.parse(xml);
  } catch (e) {
    throw new JxFault('Client', `not well-formed XML: ${(e as Error).message}`);
  }
  const env = doc.Envelope;
  if (!env) throw new JxFault('VersionMismatch', 'not a SOAP 1.1 Envelope');
  const fault = env.Body?.Fault;
  if (fault) {
    const code = str(fault.faultcode).replace(/^.*:/, '');
    throw new JxFault((['Client', 'Server', 'VersionMismatch', 'MustUnderstand'].includes(code) ? code : 'Server') as JxFault['code'], str(fault.faultstring) || 'SOAP Fault');
  }
  // Per the WSDL the fields are wrapped in MessageHeader. Some clients (e.g. jx_client/Savon) put
  // them directly under soap:Header, so accept both. Namespaces are ignored for the same reason
  // (a widely copied 2007 WSDL lost the hyphen in "jedicos-xml").
  const mh = env.Header?.MessageHeader ?? (env.Header && 'From' in env.Header ? env.Header : undefined);
  const header = mh
    ? {
      From: str(mh.From), To: str(mh.To), MessageId: str(mh.MessageId), Timestamp: str(mh.Timestamp),
      ...(mh.OptionalFormatType !== undefined ? { OptionalFormatType: str(mh.OptionalFormatType) } : {}),
      ...(mh.OptionalDocumentType !== undefined ? { OptionalDocumentType: str(mh.OptionalDocumentType) } : {}),
    }
    : undefined;
  const body = Object.keys(env.Body ?? {}).find((k) => k in BODY_FIELDS) as BodyName | undefined;
  if (!body) throw new JxFault('Client', `unknown JX operation ${Object.keys(env.Body ?? {}).join(',') || '(empty body)'}`);
  const el = env.Body[body] ?? {};
  const values = Object.fromEntries(BODY_FIELDS[body].map((k) => [k, str(el[k])]));
  return { header, body, values };
}
