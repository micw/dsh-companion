/** Durable last-known-good provider catalog payloads. */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { CompanionProviderId } from './types.js'

/** One provider payload committed only after provider-owned validation. */
export const providerCatalogRecord = z.object({
  identity: z.string().min(1),
  generation: z.number().int().nonnegative(),
  refreshedAt: z.number().int().nonnegative(),
  payload: z.json(),
})

/** Durable provider catalog record. */
export type ProviderCatalogRecord = z.infer<typeof providerCatalogRecord>

/** Disposable derived catalog cache; the external provider remains authoritative. */
export const providerCatalogDomainSpec = defineDomain({
  name: 'dsh_companion_provider_catalog',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    providers: domainTable<CompanionProviderId, ProviderCatalogRecord>(providerCatalogRecord),
  },
})
