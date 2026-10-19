import {
	Asset,
	extractBaseAddress,
	type OperationRecord,
	type OperationType,
	StrKey,
	type Transaction,
} from '@stellar/stellar-sdk';

import { resourceFeeOf } from '../shared/fees';

// The signing policy: the limits that the Stellar Wallet API credential puts on what the node
// signs. This module doesn't depend on n8n. It reads the credential's fields and checks a decoded
// transaction against them.

// The names of the policy fields on the credential screen, for the error texts.
const LABELS = {
	allowedOperations: 'Allowed Operations',
	maxAmounts: 'Maximum Amounts',
	allowedAssets: 'Allowed Assets',
	allowedDestinations: 'Allowed Destinations',
	maxFee: 'Maximum Fee',
	allowMessageSigning: 'Allow Message Signing',
};

// The operation types, as the Stellar SDK names each operation of a decoded transaction. The type
// makes the build fail if an SDK update adds a type that isn't here.
const KNOWN_OPERATION_TYPES: Record<OperationType, true> = {
	createAccount: true,
	payment: true,
	pathPaymentStrictReceive: true,
	pathPaymentStrictSend: true,
	manageSellOffer: true,
	manageBuyOffer: true,
	createPassiveSellOffer: true,
	setOptions: true,
	changeTrust: true,
	allowTrust: true,
	accountMerge: true,
	inflation: true,
	manageData: true,
	bumpSequence: true,
	createClaimableBalance: true,
	claimClaimableBalance: true,
	beginSponsoringFutureReserves: true,
	endSponsoringFutureReserves: true,
	revokeAccountSponsorship: true,
	revokeTrustlineSponsorship: true,
	revokeOfferSponsorship: true,
	revokeDataSponsorship: true,
	revokeClaimableBalanceSponsorship: true,
	revokeLiquidityPoolSponsorship: true,
	revokeSignerSponsorship: true,
	clawback: true,
	clawbackClaimableBalance: true,
	setTrustLineFlags: true,
	liquidityPoolDeposit: true,
	liquidityPoolWithdraw: true,
	invokeHostFunction: true,
	extendFootprintTtl: true,
	restoreFootprint: true,
};
const OPERATION_TYPES = Object.keys(KNOWN_OPERATION_TYPES);

// The names of the operations that pay someone, for the error text. They are the ones outflowOf
// reads, and the only ones this node checks the limits on amounts, assets and destinations on.
const PAYMENT_TYPES = [
	'payment',
	'pathPaymentStrictSend',
	'pathPaymentStrictReceive',
	'createAccount',
];

const HOW_TO_WRITE_OPERATIONS =
	"Write one operation type per line, with the names the Stellar SDK uses, such as payment, createAccount or pathPaymentStrictSend. The full list is in the credential's documentation.";
const HOW_TO_WRITE_AMOUNTS =
	'Write one limit per line, as the asset, an equals sign and the amount: XLM=100 or native=100 for lumens, or CODE:ISSUER=100 for another asset, with up to 7 decimals.';
const HOW_TO_WRITE_ASSETS =
	'Write one asset per line: XLM or native for lumens, or CODE:ISSUER for another asset, with its code and the address of the account that issues it.';
const HOW_TO_WRITE_DESTINATIONS =
	'Write one account address per line: 56 characters starting with G, or a muxed address of 69 characters starting with M.';

const IN_CREDENTIAL = 'in the Stellar Wallet API credential';
const NOT_SIGNED = 'This item was not signed.';

// The credential's fee field is a number, and 0 is its default: no limit.
const NO_FEE_LIMIT = BigInt(0);

// What the credential lets the node sign. A limit that is undefined doesn't apply.
export interface Policy {
	// Operation types, as the SDK names them.
	allowedOperations?: string[];
	// The most that one operation may send of each asset, in stroops. The key is the asset as the
	// policy writes it: XLM or CODE:ISSUER. With any limit, an asset that has none isn't signed.
	maxAmounts?: Map<string, bigint>;
	// The assets a payment may use, written the same way.
	allowedAssets?: string[];
	// The addresses a payment may go to: G accounts and muxed (M) addresses.
	allowedDestinations?: string[];
	// The highest fee a transaction may carry, in stroops.
	maxFee?: bigint;
	// Signing messages is off unless the credential turns it on.
	allowMessageSigning: boolean;
}

// A policy field that can't be read. It never repeats what was entered, only where it is: the
// field could hold a secret key pasted by mistake.
export interface PolicyProblem {
	// The field's name on the credential screen.
	field: string;
	// Completes "'Allowed Operations' …".
	problem: string;
	// How to fix it.
	fix: string;
}

export type PolicyReading = { policy: Policy } | { invalid: PolicyProblem };

// Reads the policy from the credential's fields. A field that can't be read makes the whole policy
// invalid: it never counts as "no limit".
export function readPolicy(credential: Record<string, unknown> | undefined): PolicyReading {
	// A switch that was never saved is off.
	const allowMessageSigning = credential?.allowMessageSigning ?? false;
	if (typeof allowMessageSigning !== 'boolean') {
		return {
			invalid: {
				field: LABELS.allowMessageSigning,
				problem: 'is not on or off',
				fix: 'Turn the switch on or off in the credential. If it comes from an expression, check that it gives true or false.',
			},
		};
	}
	const policy: Policy = { allowMessageSigning };

	const allowedOperations = readList(
		credential?.allowedOperations,
		LABELS.allowedOperations,
		'an operation type',
		HOW_TO_WRITE_OPERATIONS,
		// The list keeps the SDK's spelling, whatever the letter case of the line.
		(text) => OPERATION_TYPES.find((name) => name.toLowerCase() === text.toLowerCase()),
	);
	if (!Array.isArray(allowedOperations)) {
		return { invalid: allowedOperations };
	}
	if (allowedOperations.length > 0) {
		policy.allowedOperations = allowedOperations;
	}

	const maxAmounts = readMaxAmounts(credential?.maxAmounts);
	if (!(maxAmounts instanceof Map)) {
		return { invalid: maxAmounts };
	}
	if (maxAmounts.size > 0) {
		policy.maxAmounts = maxAmounts;
	}

	const allowedAssets = readList(
		credential?.allowedAssets,
		LABELS.allowedAssets,
		'an asset',
		HOW_TO_WRITE_ASSETS,
		readAsset,
	);
	if (!Array.isArray(allowedAssets)) {
		return { invalid: allowedAssets };
	}
	if (allowedAssets.length > 0) {
		policy.allowedAssets = allowedAssets;
	}

	const allowedDestinations = readList(
		credential?.allowedDestinations,
		LABELS.allowedDestinations,
		'a Stellar address',
		HOW_TO_WRITE_DESTINATIONS,
		// The SDK decides which addresses are valid.
		(text) =>
			StrKey.isValidEd25519PublicKey(text) || StrKey.isValidMed25519PublicKey(text)
				? text
				: undefined,
	);
	if (!Array.isArray(allowedDestinations)) {
		return { invalid: allowedDestinations };
	}
	if (allowedDestinations.length > 0) {
		policy.allowedDestinations = allowedDestinations;
	}

	const maxFee = readMaxFee(credential?.maxFee);
	if (typeof maxFee !== 'bigint') {
		return { invalid: maxFee };
	}
	if (maxFee > NO_FEE_LIMIT) {
		policy.maxFee = maxFee;
	}

	return { policy };
}

// Reads a field that has one entry per line. readEntry gives the entry of a line, or undefined
// when the line isn't one. An entry on two lines is kept once.
function readList(
	value: unknown,
	field: string,
	entryName: string,
	fix: string,
	readEntry: (text: string) => string | undefined,
): string[] | PolicyProblem {
	const lines = linesOf(value);
	if (lines === undefined) {
		return { field, problem: 'is not text', fix };
	}
	const entries: string[] = [];
	for (const { text, lineNumber } of lines) {
		const entry = readEntry(text);
		if (entry === undefined) {
			return { field, problem: `has a line that isn't ${entryName} (line ${lineNumber})`, fix };
		}
		if (!entries.includes(entry)) {
			entries.push(entry);
		}
	}
	return entries;
}

// The limit of each asset, from lines such as XLM=100. An asset on two lines is a mistake: the
// node can't tell which limit was meant.
function readMaxAmounts(value: unknown): Map<string, bigint> | PolicyProblem {
	const field = LABELS.maxAmounts;
	const lines = linesOf(value);
	if (lines === undefined) {
		return { field, problem: 'is not text', fix: HOW_TO_WRITE_AMOUNTS };
	}
	const limits = new Map<string, bigint>();
	for (const { text, lineNumber } of lines) {
		const parts = text.split('=');
		const asset = parts.length === 2 ? readAsset(parts[0].trim()) : undefined;
		const limit = parts.length === 2 ? readAmount(parts[1].trim()) : undefined;
		if (asset === undefined || limit === undefined) {
			return {
				field,
				problem: `has a line that isn't an asset and an amount (line ${lineNumber})`,
				fix: HOW_TO_WRITE_AMOUNTS,
			};
		}
		if (limits.has(asset)) {
			return {
				field,
				problem: `has the same asset on two lines (line ${lineNumber})`,
				fix: HOW_TO_WRITE_AMOUNTS,
			};
		}
		limits.set(asset, limit);
	}
	return limits;
}

// The highest fee, in stroops. An expression can give the number as text, so digits count too.
function readMaxFee(value: unknown): bigint | PolicyProblem {
	if (value === undefined || value === null) {
		return NO_FEE_LIMIT;
	}
	if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
		return BigInt(value);
	}
	if (typeof value === 'string') {
		const text = value.trim();
		if (text === '') {
			return NO_FEE_LIMIT;
		}
		if (/^\d+$/.test(text)) {
			return BigInt(text);
		}
	}
	return {
		field: LABELS.maxFee,
		problem: 'is not a whole number of stroops',
		fix: 'Enter the highest fee as a whole number of stroops, such as 1000, or 0 for no limit.',
	};
}

// What a transaction has that the policy doesn't allow. The message never carries text that comes
// from the transaction, such as an address or an asset code: n8n replaces a message that happens
// to contain one of Node's error codes. Those go in the description.
export interface PolicyViolation {
	message: string;
	description: string;
}

// A Soroban transaction's fee also carries the resource fee, which comes from its simulation, so
// building the transaction with a lower fee may not be enough.
function howToLowerTheFee(transaction: Transaction): string {
	const resourceFee = resourceFeeOf(transaction);
	if (resourceFee === undefined) {
		return 'Build the transaction with a lower fee, or raise the limit in the credential.';
	}
	return `It includes a resource fee of ${resourceFee} stroops, which comes from the Soroban transaction's simulation: raise the limit in the credential, or lower the inclusion fee if that is enough.`;
}

// Returns the first thing in the transaction that the policy doesn't allow. It checks every
// operation, whatever its source account: the key may sign as the transaction's source or as a
// signer of another operation's source account.
export function checkPolicy(policy: Policy, transaction: Transaction): PolicyViolation | undefined {
	const { maxFee } = policy;
	if (maxFee !== undefined) {
		// The SDK gives the fee as text: the total for all the operations, in stroops. A fee that
		// can't be read counts as over the limit.
		const fee = /^\d+$/.test(transaction.fee) ? BigInt(transaction.fee) : undefined;
		if (fee === undefined || fee > maxFee) {
			const field = LABELS.maxFee;
			return {
				message: `The transaction's fee is over '${field}'`,
				description: `The transaction's fee is ${transaction.fee} stroops. '${field}' ${IN_CREDENTIAL} allows up to ${maxFee}. ${NOT_SIGNED} ${howToLowerTheFee(transaction)}`,
			};
		}
	}

	for (let index = 0; index < transaction.operations.length; index++) {
		const violation = checkOperation(policy, transaction.operations[index], index + 1);
		if (violation !== undefined) {
			return violation;
		}
	}
	return undefined;
}

// Operations are counted from 1 in the error texts.
function checkOperation(
	policy: Policy,
	operation: OperationRecord,
	operationNumber: number,
): PolicyViolation | undefined {
	const { type } = operation;
	const outflow = outflowOf(operation);
	const start = `Operation ${operationNumber} of the transaction`;

	const { allowedOperations } = policy;
	if (allowedOperations !== undefined) {
		if (!allowedOperations.includes(type)) {
			const field = LABELS.allowedOperations;
			return {
				message: `'${field}' doesn't include ${type}`,
				description: `${start} is ${type}. '${field}' ${IN_CREDENTIAL} lists ${allowedOperations.join(', ')}. ${NOT_SIGNED} Build the transaction without that operation, or add ${type} to '${field}'.`,
			};
		}
	} else if (limitsPayments(policy) && outflow === undefined) {
		// What can't be checked against the limits isn't signed, unless the credential names it.
		return {
			message: `This credential signs only payments, and operation ${operationNumber} is ${type}`,
			description: `The Stellar Wallet API credential has limits on amounts, destinations or assets, and this node checks them only on ${listOf(PAYMENT_TYPES)} operations. ${NOT_SIGNED} To sign ${type} with this credential, list it in '${LABELS.allowedOperations}' together with the payment types it should sign.`,
		};
	}

	if (outflow === undefined) {
		return undefined;
	}

	const { allowedDestinations } = policy;
	if (
		allowedDestinations !== undefined &&
		!isAllowedDestination(allowedDestinations, outflow.destination)
	) {
		const field = LABELS.allowedDestinations;
		return {
			message: `'${field}' doesn't include the destination of operation ${operationNumber}`,
			description: `${start} (${type}) pays ${outflow.destination}, which isn't in '${field}' ${IN_CREDENTIAL}. ${NOT_SIGNED} Check the destination, or add it to '${field}'.`,
		};
	}

	const { allowedAssets } = policy;
	if (allowedAssets !== undefined) {
		// A path payment changes asset on the way, so both ends have to be in the list.
		const ends: [Asset, string][] =
			outflow.delivered === undefined
				? [[outflow.asset, 'pays in']]
				: [
						[outflow.asset, 'sends'],
						[outflow.delivered, 'delivers'],
					];
		for (const [end, verb] of ends) {
			if (!allowedAssets.includes(assetKey(end))) {
				const field = LABELS.allowedAssets;
				return {
					message: `'${field}' doesn't include an asset of operation ${operationNumber}`,
					description: `${start} (${type}) ${verb} ${assetKey(end)}, which isn't in '${field}' ${IN_CREDENTIAL}. ${NOT_SIGNED} Use an asset of the list, or add that asset to '${field}'.`,
				};
			}
		}
	}

	const { maxAmounts } = policy;
	if (maxAmounts !== undefined) {
		const key = assetKey(outflow.asset);
		const limit = maxAmounts.get(key);
		const field = LABELS.maxAmounts;
		// An asset without a line isn't signed: a line with a mistake in the asset, such as its
		// code in another letter case, would leave the real asset without a limit.
		if (limit === undefined) {
			return {
				message: `'${field}' has no limit for the asset of operation ${operationNumber}`,
				description: `${start} (${type}) sends ${key}, which has no line in '${field}' ${IN_CREDENTIAL}. ${NOT_SIGNED} Use an asset that has a limit, or add a line for that asset to '${field}'.`,
			};
		}
		// An amount that can't be read counts as over the limit.
		const sent = readAmount(outflow.amount);
		if (sent === undefined || sent > limit) {
			const [sends, sendsInFull] = outflow.isCeiling
				? ['may send', 'may send up to']
				: ['sends', 'sends'];
			const amount = sent === undefined ? outflow.amount : writeAmount(sent);
			return {
				message: `Operation ${operationNumber} ${sends} more than '${field}' allows`,
				description: `${start} (${type}) ${sendsInFull} ${amount} ${key}. '${field}' ${IN_CREDENTIAL} allows up to ${writeAmount(limit)} ${key} per operation. ${NOT_SIGNED} Lower the amount, or raise the limit in the credential.`,
			};
		}
	}

	return undefined;
}

// Whether the policy has a limit that this node checks only on payment operations.
function limitsPayments(policy: Policy): boolean {
	return (
		policy.maxAmounts !== undefined ||
		policy.allowedAssets !== undefined ||
		policy.allowedDestinations !== undefined
	);
}

// What a payment operation sends from its source account, and where it goes.
interface Outflow {
	// As the SDK gives it: a decimal with 7 digits.
	amount: string;
	asset: Asset;
	// True when the amount is the most the operation may send, not exactly what it sends.
	isCeiling: boolean;
	// For a path payment, the asset that reaches the destination.
	delivered?: Asset;
	// A G account or a muxed (M) address.
	destination: string;
}

// Undefined for an operation that isn't a payment.
function outflowOf(operation: OperationRecord): Outflow | undefined {
	switch (operation.type) {
		case 'payment':
			return {
				amount: operation.amount,
				asset: operation.asset,
				isCeiling: false,
				destination: operation.destination,
			};
		case 'pathPaymentStrictSend':
			return {
				amount: operation.sendAmount,
				asset: operation.sendAsset,
				isCeiling: false,
				delivered: operation.destAsset,
				destination: operation.destination,
			};
		case 'pathPaymentStrictReceive':
			return {
				amount: operation.sendMax,
				asset: operation.sendAsset,
				isCeiling: true,
				delivered: operation.destAsset,
				destination: operation.destination,
			};
		case 'createAccount':
			return {
				amount: operation.startingBalance,
				asset: Asset.native(),
				isCeiling: false,
				destination: operation.destination,
			};
		default:
			return undefined;
	}
}

// A G entry allows that account and any muxed (M) address of it. An M entry allows only itself.
function isAllowedDestination(allowed: string[], destination: string): boolean {
	if (allowed.includes(destination)) {
		return true;
	}
	return (
		StrKey.isValidMed25519PublicKey(destination) &&
		allowed.includes(extractBaseAddress(destination))
	);
}

// Says why the credential doesn't let the node sign a message, or nothing if it does.
export function checkMessageSigning(policy: Policy): PolicyViolation | undefined {
	if (policy.allowMessageSigning) {
		return undefined;
	}
	const field = LABELS.allowMessageSigning;
	return {
		message: `'${field}' is off ${IN_CREDENTIAL}`,
		description: `Sign Message signs any text it receives with this wallet's key, and a signed text can prove control of the key to another service. Turn on '${field}' in the credential only if this workflow should do that. ${NOT_SIGNED}`,
	};
}

// An asset as the policy writes it: XLM for the native asset and CODE:ISSUER for any other. An
// issued asset whose code is XLM is not the native one.
function assetKey(asset: Asset): string {
	return asset.isNative() ? 'XLM' : `${asset.getCode()}:${asset.getIssuer()}`;
}

// Reads XLM or CODE:ISSUER. The native asset can also be written native, as the Stellar SDK and
// CLI write it. The SDK decides which codes and issuers are valid. Undefined if the text is none
// of them.
function readAsset(text: string): string | undefined {
	if (text.toUpperCase() === 'XLM' || text.toLowerCase() === 'native') {
		return 'XLM';
	}
	// Without an issuer, the SDK would take the code XLM as the native asset.
	const parts = text.split(':');
	if (parts.length !== 2 || parts[1] === '') {
		return undefined;
	}
	try {
		return assetKey(new Asset(parts[0], parts[1]));
	} catch {
		return undefined;
	}
}

// Stellar amounts have 7 decimals and fit in 64 bits as stroops. They are handled as whole
// stroops, never as JS numbers, which lose digits.
const STROOPS_PER_UNIT = BigInt(10000000);
const MAX_STROOPS = BigInt('9223372036854775807');

// Reads an amount such as 100 or 50.5 as stroops. Undefined if the text isn't an amount.
function readAmount(text: string): bigint | undefined {
	const match = /^(\d+)(?:\.(\d{1,7}))?$/.exec(text);
	if (match === null) {
		return undefined;
	}
	const stroops = BigInt(match[1]) * STROOPS_PER_UNIT + BigInt((match[2] ?? '').padEnd(7, '0'));
	return stroops > MAX_STROOPS ? undefined : stroops;
}

// Writes stroops as an amount without trailing zeros: 100, 50.5.
function writeAmount(stroops: bigint): string {
	const decimals = (stroops % STROOPS_PER_UNIT).toString().padStart(7, '0').replace(/0+$/, '');
	const units = (stroops / STROOPS_PER_UNIT).toString();
	return decimals === '' ? units : `${units}.${decimals}`;
}

// "a, b, c and d".
function listOf(names: string[]): string {
	return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// The lines of a text field that have something, each with its number in the field. A field that
// was never saved counts as empty. Undefined when the value isn't text.
function linesOf(value: unknown): { text: string; lineNumber: number }[] | undefined {
	if (value === undefined || value === null) {
		return [];
	}
	if (typeof value !== 'string') {
		return undefined;
	}
	// trim also removes the \r of a Windows line break.
	return value
		.split('\n')
		.map((line, index) => ({ text: line.trim(), lineNumber: index + 1 }))
		.filter(({ text }) => text !== '');
}
