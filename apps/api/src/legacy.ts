import type { Konnect } from './konnect';
import { uuidv5 } from './uuid';

/**
 * v0.2.0 kept connection strings in a Konnect Config Store with a "konnect"
 * vault and a token-guarded system route. Connections now live in the local
 * Vault, so remove those Konnect entities if they are still there.
 */
export async function removeKonnectVaultSetup(konnect: Konnect, storeName = 'ipaas-db-connections'): Promise<string[]> {
  const removed: string[] = [];
  const entities: [Parameters<Konnect['remove']>[0], string][] = [
    ['plugins', uuidv5('ipaas:system:plugin')],
    ['routes', uuidv5('ipaas:system:route')],
    ['services', uuidv5('ipaas:system:service')],
    ['vaults', uuidv5('ipaas:db-vault')],
  ];
  for (const [kind, id] of entities) {
    if (await konnect.removeIfExists(kind, id)) removed.push(kind.slice(0, -1));
  }
  if (await konnect.deleteConfigStoreByName(storeName)) removed.push(`config store ${storeName}`);
  return removed;
}
