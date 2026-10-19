import type { Transaction } from '@stellar/stellar-sdk';

// The resource fee of a Soroban transaction (a contract call or a footprint operation), or
// undefined for a classic one. Its total fee is the resource fee plus the inclusion fee, and only
// the inclusion fee competes to get into a ledger.
export function resourceFeeOf(transaction: Transaction): bigint | undefined {
	const { ext } = transaction.tx;
	return ext.type === 'sorobanData' ? ext.sorobanData.resourceFee : undefined;
}
