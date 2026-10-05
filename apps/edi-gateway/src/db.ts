import pg from 'pg';

export type Protocol = 'sftp' | 'as2' | 'oftp2' | 'ebms' | 'jx' | 'zengin';
export const PROTOCOLS: Protocol[] = ['sftp', 'as2'];

export interface PartnerRow {
  id: string;
  name: string;
  protocol: Protocol;
  enabled: boolean;
  /** Non-secret protocol settings; secrets live in Vault at edi/partners/<id>. */
  config: Record<string, any>;
  /** Flow slug that receives inbound documents from this partner. */
  inbound_flow: string | null;
  created_at: string;
  updated_at: string;
}

export type MessageStatus = 'sending' | 'sent' | 'awaiting-receipt' | 'delivered' | 'failed' | 'received' | 'forwarded' | 'forward-failed';

export interface MessageRow {
  id: string;
  direction: 'in' | 'out';
  protocol: Protocol;
  partner_id: string | null;
  partner_name: string | null;
  status: MessageStatus;
  /** Protocol message id (AS2 Message-ID, SFTP path, …). */
  message_id: string | null;
  filename: string | null;
  content_type: string | null;
  size: number;
  receipt: Record<string, any> | null;
  error: string | null;
  flow_slug: string | null;
  flow_status: number | null;
  created_at: string;
  updated_at: string;
}

export class Db {
  readonly pool: pg.Pool;
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url });
  }

  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS edi_partners (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL UNIQUE,
        protocol text NOT NULL,
        enabled boolean NOT NULL DEFAULT true,
        config jsonb NOT NULL DEFAULT '{}',
        inbound_flow text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS edi_station (
        protocol text PRIMARY KEY,
        config jsonb NOT NULL DEFAULT '{}',
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS edi_messages (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        direction text NOT NULL,
        protocol text NOT NULL,
        partner_id uuid REFERENCES edi_partners (id) ON DELETE SET NULL,
        partner_name text,
        status text NOT NULL,
        message_id text,
        filename text,
        content_type text,
        size integer NOT NULL DEFAULT 0,
        receipt jsonb,
        error text,
        flow_slug text,
        flow_status integer,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS edi_messages_created ON edi_messages (created_at DESC);
      CREATE INDEX IF NOT EXISTS edi_messages_msgid ON edi_messages (protocol, message_id);`);
  }

  // ---- partners ----
  async listPartners(): Promise<PartnerRow[]> {
    return (await this.pool.query<PartnerRow>('SELECT * FROM edi_partners ORDER BY name')).rows;
  }
  async getPartner(idOrName: string): Promise<PartnerRow | undefined> {
    const q = /^[0-9a-f-]{36}$/i.test(idOrName) ? 'SELECT * FROM edi_partners WHERE id = $1' : 'SELECT * FROM edi_partners WHERE name = $1';
    return (await this.pool.query<PartnerRow>(q, [idOrName])).rows[0];
  }
  async partnersByProtocol(protocol: Protocol): Promise<PartnerRow[]> {
    return (await this.pool.query<PartnerRow>('SELECT * FROM edi_partners WHERE protocol = $1 AND enabled ORDER BY name', [protocol])).rows;
  }
  async createPartner(p: Pick<PartnerRow, 'name' | 'protocol' | 'enabled' | 'config' | 'inbound_flow'>): Promise<PartnerRow> {
    const q = 'INSERT INTO edi_partners (name, protocol, enabled, config, inbound_flow) VALUES ($1, $2, $3, $4, $5) RETURNING *';
    return (await this.pool.query<PartnerRow>(q, [p.name, p.protocol, p.enabled, JSON.stringify(p.config), p.inbound_flow])).rows[0];
  }
  async updatePartner(id: string, p: Pick<PartnerRow, 'name' | 'enabled' | 'config' | 'inbound_flow'>): Promise<PartnerRow | undefined> {
    const q = 'UPDATE edi_partners SET name = $2, enabled = $3, config = $4, inbound_flow = $5, updated_at = now() WHERE id = $1 RETURNING *';
    return (await this.pool.query<PartnerRow>(q, [id, p.name, p.enabled, JSON.stringify(p.config), p.inbound_flow])).rows[0];
  }
  async deletePartner(id: string): Promise<void> {
    await this.pool.query('DELETE FROM edi_partners WHERE id = $1', [id]);
  }

  // ---- station (our own identity per protocol) ----
  async getStation(protocol: Protocol): Promise<Record<string, any>> {
    return (await this.pool.query<{ config: Record<string, any> }>('SELECT config FROM edi_station WHERE protocol = $1', [protocol])).rows[0]?.config ?? {};
  }
  async setStation(protocol: Protocol, config: Record<string, any>): Promise<void> {
    await this.pool.query(
      'INSERT INTO edi_station (protocol, config) VALUES ($1, $2) ON CONFLICT (protocol) DO UPDATE SET config = $2, updated_at = now()',
      [protocol, JSON.stringify(config)],
    );
  }

  // ---- messages ----
  async createMessage(m: Partial<MessageRow> & Pick<MessageRow, 'direction' | 'protocol' | 'status'>): Promise<MessageRow> {
    const cols = Object.keys(m);
    const vals = cols.map((c) => ((m as any)[c] !== null && typeof (m as any)[c] === 'object' ? JSON.stringify((m as any)[c]) : (m as any)[c]));
    const q = `INSERT INTO edi_messages (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`;
    return (await this.pool.query<MessageRow>(q, vals)).rows[0];
  }
  async updateMessage(id: string, m: Partial<MessageRow>): Promise<MessageRow> {
    const cols = Object.keys(m);
    const vals = cols.map((c) => ((m as any)[c] !== null && typeof (m as any)[c] === 'object' ? JSON.stringify((m as any)[c]) : (m as any)[c]));
    const q = `UPDATE edi_messages SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`;
    return (await this.pool.query<MessageRow>(q, [id, ...vals])).rows[0];
  }
  async getMessage(id: string): Promise<MessageRow | undefined> {
    return (await this.pool.query<MessageRow>('SELECT * FROM edi_messages WHERE id = $1', [id])).rows[0];
  }
  async findMessage(protocol: Protocol, messageId: string, direction: 'in' | 'out'): Promise<MessageRow | undefined> {
    const q = 'SELECT * FROM edi_messages WHERE protocol = $1 AND message_id = $2 AND direction = $3 ORDER BY created_at DESC LIMIT 1';
    return (await this.pool.query<MessageRow>(q, [protocol, messageId, direction])).rows[0];
  }
  async listMessages(f: { limit?: number; partner?: string; direction?: string } = {}): Promise<MessageRow[]> {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (f.partner) { vals.push(f.partner); where.push(`partner_id = $${vals.length}`); }
    if (f.direction) { vals.push(f.direction); where.push(`direction = $${vals.length}`); }
    vals.push(Math.min(f.limit ?? 100, 500));
    const q = `SELECT * FROM edi_messages ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT $${vals.length}`;
    return (await this.pool.query<MessageRow>(q, vals)).rows;
  }
}
