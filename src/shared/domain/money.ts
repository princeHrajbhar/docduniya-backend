import { z } from 'zod';
export const minorUnits = z.number().int().min(0).max(1_000_000_000);
export const moneyInput = z.strictObject({
  amountMinor: minorUnits,
  currency: z.literal('INR').default('INR'),
});
export function taxMinor(amount: number, basisPoints: number): number {
  return Number((BigInt(amount) * BigInt(basisPoints) + 5000n) / 10000n);
}
export function assertSafeMoney(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000_000)
    throw new Error('Money must be a nonnegative safe integer within the ledger limit');
}
