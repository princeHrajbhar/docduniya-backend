import type { ClientSession, Types } from 'mongoose';
import type { z } from 'zod';
import type { CommandActor } from '../../shared/domain/healthcare.js';
import {
  actorRef,
  before,
  formatNumber,
  nextNumber,
  pageOf,
  type OperationActor,
} from '../../shared/application/scope.js';
import { authorizeOrganization } from '../access/access.service.js';
import { LedgerAccount, LedgerJournal } from './billing.model.js';
import type { journalQuery } from './billing.validation.js';

/** Minimal chart of accounts for the direct-merchant model. Export to a full ERP for statutory books. */
export const ACCOUNTS = {
  CASH: { code: '1000', name: 'Cash and bank', type: 'ASSET' },
  GATEWAY_CLEARING: { code: '1100', name: 'Payment gateway clearing', type: 'ASSET' },
  RECEIVABLE: { code: '1200', name: 'Patient receivables', type: 'ASSET' },
  ADVANCES: { code: '2100', name: 'Unapplied customer receipts', type: 'LIABILITY' },
  TAX: { code: '2200', name: 'Output tax payable', type: 'LIABILITY' },
  REVENUE: { code: '4000', name: 'Healthcare service revenue', type: 'REVENUE' },
} as const;
export type AccountKey = keyof typeof ACCOUNTS;

export interface Entry {
  account: AccountKey;
  debitMinor?: number;
  creditMinor?: number;
}

async function ensureAccounts(
  organizationId: string | Types.ObjectId,
  actor: OperationActor,
  session: ClientSession,
) {
  const who = actorRef(actor);
  for (const account of Object.values(ACCOUNTS))
    await LedgerAccount.updateOne(
      { organizationId, code: account.code, currency: 'INR' },
      { $setOnInsert: { ...account, createdBy: who, updatedBy: who } },
      { upsert: true, session },
    );
}

/**
 * Posts an immutable, balanced journal. The operation key makes posting idempotent: a retried
 * caller receives the original journal. Corrections are compensating journals, never edits.
 */
export async function postJournal(
  actor: OperationActor,
  organizationId: string | Types.ObjectId,
  source: { type: string; id: string },
  operationKey: string,
  memo: string,
  entries: Entry[],
  session: ClientSession,
) {
  const existing = await LedgerJournal.findOne({ organizationId, operationKey }).session(session);
  if (existing) return existing;
  const lines = entries
    .filter((entry) => (entry.debitMinor ?? 0) > 0 || (entry.creditMinor ?? 0) > 0)
    .map((entry) => ({
      accountCode: ACCOUNTS[entry.account].code,
      debitMinor: entry.debitMinor ?? 0,
      creditMinor: entry.creditMinor ?? 0,
    }));
  if (!lines.length) return undefined;
  await ensureAccounts(organizationId, actor, session);
  const number = formatNumber('JNL', await nextNumber(organizationId, 'JOURNAL', session), 10);
  const [journal] = await LedgerJournal.create(
    [
      {
        organizationId,
        number,
        source,
        operationKey,
        memo,
        postedAt: new Date(),
        entries: lines,
        createdBy: actorRef(actor),
      },
    ],
    { session },
  );
  return journal!;
}

export async function listJournals(
  actor: CommandActor,
  organizationId: string,
  query: z.infer<typeof journalQuery>,
) {
  await authorizeOrganization(actor, organizationId, 'ledger.read', { organizationWide: true });
  const rows = await LedgerJournal.find({
    organizationId,
    ...(query.sourceType ? { 'source.type': query.sourceType } : {}),
    ...before(query.before),
  })
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean();
  return pageOf(rows, query.limit, (row) => ({
    id: String(row._id),
    number: row.number,
    source: row.source,
    memo: row.memo,
    postedAt: row.postedAt,
    currency: row.currency,
    entries: row.entries,
  }));
}

/** Trial balance computed from immutable journals, never from a cached balance. */
export async function trialBalance(actor: CommandActor, organizationId: string) {
  const scope = await authorizeOrganization(actor, organizationId, 'ledger.read', {
    organizationWide: true,
  });
  const totals = await LedgerJournal.aggregate<{
    _id: string;
    debitMinor: number;
    creditMinor: number;
  }>([
    { $match: { organizationId: scope.organization._id } },
    { $unwind: '$entries' },
    {
      $group: {
        _id: '$entries.accountCode',
        debitMinor: { $sum: '$entries.debitMinor' },
        creditMinor: { $sum: '$entries.creditMinor' },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  const names = new Map<string, { name: string; type: string }>(
    Object.values(ACCOUNTS).map((account) => [account.code, account]),
  );
  return {
    currency: 'INR',
    accounts: totals.map((row) => ({
      code: row._id,
      name: names.get(row._id)?.name ?? row._id,
      type: names.get(row._id)?.type,
      debitMinor: row.debitMinor,
      creditMinor: row.creditMinor,
    })),
    balanced:
      totals.reduce((sum, row) => sum + row.debitMinor, 0) ===
      totals.reduce((sum, row) => sum + row.creditMinor, 0),
  };
}
