import type { INode } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import {
	AccountRequiresMemoError,
	Horizon,
	NetworkError,
	NotFoundError,
	type Transaction,
	TransactionFailedError,
	xdr,
} from '@stellar/stellar-sdk';

import { resourceFeeOf } from '../shared/fees';
import { horizonUrlFor, type NetworkName } from '../shared/network';

// The SDK's own limit for the submission request, used for every request to Horizon.
const REQUEST_TIMEOUT_MS = 60000;

// Horizon names each of its errors with a type under this address.
const HORIZON_ERROR_TYPES = 'https://stellar.org/horizon-errors/';

// The errors Horizon answers before it passes a transaction to the network: the ones of its
// router and the ones its submission handler returns before it calls its submission system.
const NOT_SUBMITTED_TYPES = [
	'transaction_malformed',
	'transaction_submission_disabled',
	'unsupported_media_type',
	'bad_request',
	'not_found',
	'not_acceptable',
	'rate_limit_exceeded',
];

// Result codes of a transaction that was applied. They can't come with a rejection.
const SUCCESS_CODES = ['tx_success', 'tx_fee_bump_inner_success'];

// After an uncertain result the node looks the transaction up by its hash: at once, and then
// once per ledger, which takes about 5 seconds, for as long as Horizon itself waits for one.
const LOOKUP_INTERVAL_MS = 5000;
const LOOKUP_SECONDS = 30;

// What the look-up adds to the description of a result that stays uncertain.
const NOT_FOUND_IN_TIME = `The node looked for it on Horizon for ${LOOKUP_SECONDS} seconds and didn't find it.`;
const COULD_NOT_LOOK_UP = "The node couldn't look it up on Horizon.";

// The HTTP status of the last answer each client got. The SDK hands back only the body of a
// successful answer, and it takes any 2xx as a success.
const LAST_STATUS = new WeakMap<Horizon.Server, number>();

const ENTER_HORIZON_URL =
	"Enter the address of a Horizon server, for example https://horizon-testnet.stellar.org, or leave the field empty to use SDF's server for the network.";

// The hosts that are this same machine, as Stellar Lab lists them.
const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

// The Horizon client for the item's submission. A Horizon URL that can't be used fails the item
// here. A value without text, such as an expression that gives nothing, counts as empty. The
// address must be https. Plain http is accepted only for a server on this same machine, where
// nobody can sit between the node and Horizon. The address can't carry a user name or a password.
// No error here repeats the address, which can have a key in it.
export function horizonServerFor(
	node: INode,
	networkName: NetworkName,
	horizonUrl: unknown,
	itemIndex: number,
): Horizon.Server {
	const url = horizonUrlFor(networkName, String(horizonUrl ?? ''));
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		// The parser's own error repeats the address, so it isn't kept as the cause.
		throw new NodeOperationError(node, "'Horizon URL' isn't a valid URL", {
			itemIndex,
			description: ENTER_HORIZON_URL,
		});
	}
	const isLocalHttp = parsed.protocol === 'http:' && LOCAL_HOSTNAMES.includes(parsed.hostname);
	if (parsed.protocol !== 'https:' && !isLocalHttp) {
		throw new NodeOperationError(node, "'Horizon URL' must start with https://", {
			itemIndex,
			description:
				"This node submits to a Horizon server over https. Plain http is accepted only for localhost. Enter an https address, or leave the field empty to use SDF's server for the network.",
		});
	}
	// The SDK's client doesn't send a request to an address with a user name or a password, and
	// its error repeats the whole address.
	const hasCredentials = parsed.username !== '' || parsed.password !== '';
	if (hasCredentials) {
		throw new NodeOperationError(node, "'Horizon URL' can't have a user name or a password", {
			itemIndex,
			description:
				"The node can't send requests to an address with a user name or a password in it. Remove them from the address, or leave the field empty to use SDF's server for the network.",
		});
	}
	// The SDK accepts any scheme once allowHttp is on, so the scheme is checked above.
	const horizon = new Horizon.Server(url, { allowHttp: isLocalHttp });
	// The SDK sets no time limit on its other requests, such as the memo check's.
	horizon.httpClient.defaults.timeout = REQUEST_TIMEOUT_MS;
	// A redirect would send the signed transaction to another server.
	horizon.httpClient.defaults.maxRedirects = 0;
	horizon.httpClient.interceptors.response.use((response) => {
		LAST_STATUS.set(horizon, response.status);
		return response;
	});
	return horizon;
}

// Asks Horizon whether a destination of the transaction requires a memo (SEP-29). It runs before
// anything is signed, so a failure here means the item was neither signed nor sent. The SDK only
// asks for a payment, a path payment or an account merge to a G address, in a transaction
// without a memo.
export async function checkMemoRequired(
	node: INode,
	horizon: Horizon.Server,
	transaction: Transaction,
	itemIndex: number,
): Promise<void> {
	try {
		await horizon.checkMemoRequired(transaction);
	} catch (error) {
		// The address and the host go in the description: n8n replaces a message that happens to
		// contain one of Node's error codes, and an address can.
		if (error instanceof AccountRequiresMemoError) {
			throw new NodeOperationError(node, error, {
				itemIndex,
				message: 'The destination requires a memo',
				description: `Operation ${error.operationIndex + 1} pays ${error.accountId}, an account that asks for a memo (SEP-29). This item was not signed or sent. Build the transaction again with the memo that destination gives you.`,
			});
		}
		const host = horizon.serverURL.host;
		// For an answer with an error, the SDK's error carries the body and its message is the
		// server's own reason phrase. Horizon's body has the status, which is named here.
		const body = error instanceof NetworkError ? error.getResponse() : undefined;
		const status =
			isRecord(body) && typeof body.status === 'number' ? ` (${statusText(body.status)})` : '';
		throw new NodeOperationError(node, error, {
			itemIndex,
			message: "Couldn't check whether the destination requires a memo",
			description:
				error instanceof NetworkError
					? `Horizon at ${host} answered with an error${status}. This item was not signed or sent. Wait and run it again.`
					: `Horizon at ${host} didn't answer. This item was not signed or sent. Check 'Horizon URL' and the connection, then run it again.`,
		});
	}
}

// What a submission that Horizon didn't confirm means for the transaction.
// - rejected: Horizon answered with result codes: the network didn't take this submission. Some
//   codes still let the same signed transaction in later, and their texts say so.
// - not_submitted: Horizon answered before passing it to the network, or the node didn't send it.
// - uncertain: Horizon gave no verdict, or one that isn't final, so the transaction may still be
//   applied.
export type SubmissionOutcome = 'rejected' | 'not_submitted' | 'uncertain';

export interface SubmissionFailure {
	outcome: SubmissionOutcome;
	message: string;
	description: string;
	// The SDK's error, when there is one.
	cause?: unknown;
	// Where in the description the sentence about the look-up goes, for an uncertain result.
	lookupAt?: number;
}

export type SubmissionResult = { ledger: number } | { failure: SubmissionFailure };

// Submits a signed transaction once and says what happened, without throwing. The memo check ran
// before signing, so it is skipped here. When the answer gives no verdict, the node looks the
// transaction up by its hash before it says that the result is uncertain.
export async function submitTransaction(
	horizon: Horizon.Server,
	transaction: Transaction,
	txHash: string,
): Promise<SubmissionResult> {
	const result = await submitOnce(horizon, transaction, txHash);
	if ('failure' in result && result.failure.outcome === 'uncertain') {
		return await lookUp(horizon, txHash, result.failure);
	}
	return result;
}

async function submitOnce(
	horizon: Horizon.Server,
	transaction: Transaction,
	txHash: string,
): Promise<SubmissionResult> {
	const host = horizon.serverURL.host;
	let response: unknown;
	LAST_STATUS.delete(horizon);
	try {
		response = await horizon.submitTransaction(transaction, { skipMemoRequiredCheck: true });
	} catch (error) {
		return { failure: failureFrom(error, transaction, txHash, host) };
	}
	// Horizon answers an applied transaction with a 200 and the transaction itself: its hash, the
	// ledger that included it, and successful. Nothing else proves that it was applied.
	const ledger = isRecord(response) ? positiveLedger(response.ledger) : undefined;
	if (
		LAST_STATUS.get(horizon) === 200 &&
		isRecord(response) &&
		response.hash === txHash &&
		ledger !== undefined &&
		response.successful === true
	) {
		return { ledger };
	}
	return {
		failure: uncertain(
			transaction,
			txHash,
			host,
			"the answer isn't a Horizon result for it",
			'foreign',
		),
	};
}

// Looks for the transaction on the same Horizon: at once, and then every 5 seconds for 30. A
// transaction that is there has a verdict. One that isn't there yet can still be applied, so the
// result stays uncertain, and the description says that the node looked.
async function lookUp(
	horizon: Horizon.Server,
	txHash: string,
	failure: SubmissionFailure,
): Promise<SubmissionResult> {
	for (let waited = 0; ; waited += LOOKUP_INTERVAL_MS) {
		const found = await findByHash(horizon, txHash);
		if (found === 'unreachable') {
			return { failure: withLookup(failure, COULD_NOT_LOOK_UP) };
		}
		if (found !== 'missing') {
			return found.successful
				? { ledger: found.ledger }
				: { failure: includedAsFailed(txHash, found.ledger) };
		}
		if (waited >= LOOKUP_SECONDS * 1000) {
			return { failure: withLookup(failure, NOT_FOUND_IN_TIME) };
		}
		await new Promise((resolve) => setTimeout(resolve, LOOKUP_INTERVAL_MS));
	}
}

// What Horizon has for the hash: the transaction with its ledger, nothing yet, or no usable
// answer. Only Horizon's own not_found says that it doesn't have the transaction.
async function findByHash(
	horizon: Horizon.Server,
	txHash: string,
): Promise<{ ledger: number; successful: boolean } | 'missing' | 'unreachable'> {
	let record: unknown;
	LAST_STATUS.delete(horizon);
	try {
		record = await horizon.transactions().transaction(txHash).call();
	} catch (error) {
		const body = error instanceof NotFoundError ? error.getResponse() : undefined;
		return horizonErrorType(body, 404) === 'not_found' ? 'missing' : 'unreachable';
	}
	if (LAST_STATUS.get(horizon) !== 200 || !isRecord(record) || record.hash !== txHash) {
		return 'unreachable';
	}
	// The SDK moves the ledger of a record it fetched to ledger_attr.
	const ledger = positiveLedger(
		typeof record.ledger === 'number' ? record.ledger : record.ledger_attr,
	);
	if (ledger === undefined || typeof record.successful !== 'boolean') {
		return 'unreachable';
	}
	return { ledger, successful: record.successful };
}

function withLookup(failure: SubmissionFailure, sentence: string): SubmissionFailure {
	const at = failure.lookupAt ?? 0;
	const { description } = failure;
	return {
		...failure,
		description: `${description.slice(0, at)}${sentence} ${description.slice(at)}`,
	};
}

// The look-up found the transaction in a ledger with its operations failed.
function includedAsFailed(txHash: string, ledger: number): SubmissionFailure {
	return {
		outcome: 'rejected',
		message: `Transaction ${txHash} is in ledger ${ledger} as failed`,
		description:
			'Horizon gave no final result when the node sent it, so the node looked it up: the network included it as failed. Its operations had no effect, its fee was charged and its sequence number was used. Build a new transaction for this payment.',
	};
}

// A ledger number that a ledger can have.
function positiveLedger(value: unknown): number | undefined {
	return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : undefined;
}

const RESULT_CODES_URL =
	'https://developers.stellar.org/docs/data/apis/horizon/api-reference/errors/result-codes';

// How a rejection that this same signed transaction can get past later ends its description, when
// the other way on is a new transaction.
const ONLY_ONE_OF_THE_TWO =
	'Do only one of the two: if this one and a new one are both applied, the payment is made twice.';

// The network usually rejects tx_bad_auth, tx_bad_auth_extra, tx_insufficient_balance and
// tx_bad_minseq_age_or_gap before a ledger, but it checks a transaction again when it applies it,
// after it took the fee, so a rare one is in a ledger as failed.
const IF_ON_HORIZON =
	"If it is on Horizon under its hash, the network included it as failed: it charged its fee and used its sequence number, so this same transaction can't be applied anymore.";
const USUALLY_NOT_INCLUDED = `Usually it wasn't included in the ledger. ${IF_ON_HORIZON}`;

// A fee bump wraps the signed transaction without signing it again and pays its fee from the
// account that signs the fee bump. The node doesn't sign fee bumps, so it is built outside.
const FEE_BUMP = 'wrap it in a fee bump transaction';

// The transaction asks for a minimum time or number of ledgers since its account's sequence number
// last changed, and it can get in once they pass.
function minimumWaitRejection(
	transaction: Transaction,
): Pick<SubmissionFailure, 'outcome' | 'description'> {
	return {
		outcome: 'rejected',
		description: `It can't be applied yet: it asks that ${minimumWait(transaction)} pass after its source account's sequence number last changed. ${USUALLY_NOT_INCLUDED} Send this same signed transaction again once that has passed, or build a new one without that condition. ${ONLY_ONE_OF_THE_TWO}`,
	};
}

// The transaction result codes that get an outcome or a description of their own. Any other code
// is a plain rejection. A Map, because the code comes from the server's answer.
const RESULT_CODES = new Map<
	string,
	(
		transaction: Transaction,
		feeCharged: bigint | undefined,
	) => Pick<SubmissionFailure, 'outcome' | 'description'>
>([
	// Not final. Horizon answers it for a number that is ahead of the account's, and that same
	// signed transaction is applied if it is sent again once the account gets there. Horizon
	// answers the same for a number that another transaction already used.
	[
		'tx_bad_seq',
		(transaction) => {
			const expiry = expiryOf(transaction);
			const when = expiry === undefined ? 'later, because it has no time limit' : untilText(expiry);
			return {
				outcome: 'uncertain',
				description: `The transaction's sequence number isn't the next one for its source account. If the number is ahead of the account's, this same transaction can still be applied ${when}, and sending it again is safe. If the account already used that number, this transaction can't be applied anymore, and the one that used it may be this same payment. To know which, compare the account's sequence number on Horizon with this transaction's, ${transaction.sequence}. Don't build a new one until you know.`,
			};
		},
	],
	// Final for this transaction. Horizon answers it up to some seconds before the time limit, so
	// the text doesn't say that the transaction expired.
	[
		'tx_too_late',
		(transaction) => ({
			outcome: 'rejected',
			description: `${limitName(expiryOf(transaction))} passed or is seconds away, so the network no longer takes it. Before you build a new one, check that this payment wasn't already made: by this same transaction, if it was sent before, or by another one.`,
		}),
	],
	// Rejections that this same signed transaction can get past later: when the network asks for
	// a lower fee, or when its start time comes. The network did not take it, so they stay
	// rejections, and the text gives the ways to go on and says not to take a new transaction
	// together with this one. For tx_insufficient_fee, a fee bump is one more way.
	[
		'tx_insufficient_fee',
		(transaction, feeCharged) => ({
			outcome: 'rejected',
			description: `${feeTooSmall(transaction)}${feeAskedFor(feeCharged)} It was not included in the ledger. Send this same signed transaction again later if the network was busy, or ${FEE_BUMP} with a higher fee, built and signed outside this node by the account that pays the fee, for example with the Stellar SDK. Neither can pay twice. Building a new transaction with a higher fee also works, but then don't send this one again: if both are applied, the payment is made twice.`,
		}),
	],
	[
		'tx_too_early',
		(transaction) => {
			const start = startOf(transaction);
			return {
				outcome: 'rejected',
				description: `${startName(start)} hasn't come yet, so it was not included in the ledger. Send this same signed transaction again after that${start?.ledger === undefined ? ' time' : ''}, or build a new one that can start now. ${ONLY_ONE_OF_THE_TWO}`,
			};
		},
	],
	// The account can't pay the fee without going below its minimum balance. XLM sent to the
	// account, or a fee bump paid by another account, gets this same signed transaction in.
	[
		'tx_insufficient_balance',
		(transaction) => ({
			outcome: 'rejected',
			description: `Its source account can't pay its fee, ${transaction.fee} stroops, without going below the account's minimum balance. ${USUALLY_NOT_INCLUDED} Send XLM to the account and send this same signed transaction again, or ${FEE_BUMP} paid by another account, built and signed outside this node, for example with the Stellar SDK. Neither can pay twice. Don't build a new transaction for this payment while this one can still be applied: if both are applied, the payment is made twice.`,
		}),
	],
	// txBAD_MIN_SEQ_AGE_OR_GAP. Horizon's code says tx_bad_minseq_age_or_gap, and the SDK's list of
	// codes says tx_bad_min_seq_age_or_gap, so both are read.
	['tx_bad_minseq_age_or_gap', minimumWaitRejection],
	['tx_bad_min_seq_age_or_gap', minimumWaitRejection],
	// Rejections for the signatures. tx_bad_auth also comes from too little signature weight, and
	// then this same signed transaction can still get in with another signer's signature. With
	// tx_bad_auth_extra it can't: signing the unsigned transaction again keeps its hash.
	[
		'tx_bad_auth',
		() => ({
			outcome: 'rejected',
			description: `Its signatures don't authorize it: they don't add up to the weight that an account of the transaction requires, a key isn't a signer of that account, or they were made for another network than this Horizon server's. Usually it wasn't included in the ledger, so no fee was charged and the account's sequence number didn't change. ${IF_ON_HORIZON} If an account needs more signatures, this same signed transaction can still be applied: pass the signedXdr output through a Stellar Signer with the credential of another signer of the account, and submit it. Otherwise, fix the cause and build a new transaction. ${ONLY_ONE_OF_THE_TWO}`,
		}),
	],
	[
		'tx_bad_auth_extra',
		() => ({
			outcome: 'rejected',
			description: `It carries a signature that the account doesn't use: a key signed it twice, a key that is no longer a signer of the account signed it, or it has more signatures than the account's threshold needs, even if they are all valid. ${USUALLY_NOT_INCLUDED} Sign the unsigned transaction again with only the keys the account needs: it keeps the same hash, so it can't pay twice.`,
		}),
	],
	// A rejection, but the transaction may be in a ledger: the network includes a transaction
	// whose operations fail, charges its fee and uses its sequence number.
	[
		'tx_failed',
		() => ({
			outcome: 'rejected',
			description: `Its operations had no effect. Look it up on Horizon by its hash: if it is there, the network included it as failed, so its fee was charged and its sequence number was used. Fix what the result codes say and build a new transaction. The codes are explained at ${RESULT_CODES_URL}`,
		}),
	],
]);

function failureFrom(
	error: unknown,
	transaction: Transaction,
	txHash: string,
	host: string,
): SubmissionFailure {
	const response = isRecord(error) && isRecord(error.response) ? error.response : undefined;
	const status = typeof response?.status === 'number' ? response.status : undefined;
	const type = status === undefined ? undefined : horizonErrorType(response?.data, status);

	// Horizon rejects a transaction with a 400 of its type transaction_failed that has result
	// codes.
	if (error instanceof TransactionFailedError && status === 400 && type === 'transaction_failed') {
		const codes = error.getResultCodes();
		if (typeof codes.transaction === 'string' && !SUCCESS_CODES.includes(codes.transaction)) {
			const operations = Array.isArray(codes.operations)
				? codes.operations.filter((code) => typeof code === 'string')
				: [];
			const known = RESULT_CODES.get(codes.transaction)?.(
				transaction,
				feeChargedIn(response?.data),
			);
			const named = `${codes.transaction}${operations.length === 0 ? '' : ` (${operations.join(', ')})`}`;
			return {
				outcome: known?.outcome ?? 'rejected',
				// Without Continue On Fail, the message is all that says which outcome it is.
				message:
					known?.outcome === 'uncertain'
						? `The result of transaction ${txHash} is uncertain: Horizon answered ${named}, which isn't final`
						: `Horizon rejected transaction ${txHash}: ${named}`,
				description:
					known?.description ??
					`The transaction didn't take effect. Fix what the result codes say and build a new transaction. The codes are explained at ${RESULT_CODES_URL}`,
				cause: error,
				lookupAt: 0,
			};
		}
	}

	if (status === undefined) {
		// Anything but the time limit is a connection that failed, before or after Horizon received
		// the transaction: the SDK can't tell.
		return uncertain(
			transaction,
			txHash,
			host,
			isTimeout(error)
				? `no answer in ${REQUEST_TIMEOUT_MS / 1000} seconds`
				: 'the connection failed',
			'none',
			error,
		);
	}

	// Only an error that Horizon answers before it passes the transaction to the network says
	// that the transaction was not submitted. The HTTP status alone doesn't: it is about the
	// request. A rate limit passes by waiting. The others come back until their cause is fixed.
	if (type !== undefined && NOT_SUBMITTED_TYPES.includes(type)) {
		const next =
			type === 'rate_limit_exceeded'
				? 'Wait and send this same signed transaction again: that is safe.'
				: "Sending this same signed transaction again is safe, but Horizon will answer the same until the cause is fixed: check 'Horizon URL' and the transaction.";
		return {
			outcome: 'not_submitted',
			message: `Horizon didn't accept transaction ${txHash}: ${statusText(status)}`,
			description: `Horizon answered "${horizonErrorTitle(response?.data)}" before passing it to the network, so it was not submitted. ${next}`,
			cause: error,
		};
	}

	return uncertain(
		transaction,
		txHash,
		host,
		`the server answered ${statusText(status)}`,
		type === undefined ? 'foreign' : 'horizon',
		error,
	);
}

// The SDK's client reports its time limit in one of three ways, depending on where the wait ended
// and on which of its two adapters handled the request.
function isTimeout(error: unknown): boolean {
	return (
		isRecord(error) &&
		(error.code === 'ECONNABORTED' ||
			error.name === 'TimeoutError' ||
			(typeof error.message === 'string' && /^timeout of \d+ms exceeded$/.test(error.message)))
	);
}

// A second item of the run with a transaction that an earlier item already sent.
export function sameTransactionFailure(firstItemIndex: number, txHash: string): SubmissionFailure {
	return {
		outcome: 'not_submitted',
		message: `This item has the same transaction as item ${firstItemIndex}`,
		description: `Transaction ${txHash} can be applied only once, so it pays once. Build a separate transaction for each payment.`,
	};
}

export interface AppliedTransaction {
	itemIndex: number;
	txHash: string;
	ledger: number;
}

// When an error stops the run, n8n drops the output of the items before it, but their
// transactions were applied. The error says how many and lists them, so nobody runs the workflow
// again from the start and pays them twice. n8n shows context.data as "Error data".
export function addAppliedTransactions(
	error: NodeOperationError,
	applied: AppliedTransaction[],
): void {
	const count =
		applied.length === 1
			? '1 earlier transaction in this run was applied'
			: `${applied.length} earlier transactions in this run were applied`;
	const list = applied.map(({ itemIndex, txHash }) => `item ${itemIndex} ${txHash}`).join(', ');
	error.message = `${error.message} (${count})`;
	error.description =
		`${error.description ?? ''} Already applied in this run: ${list}. Items after this one were not processed. Don't run the workflow from the start: that builds new transactions and pays the applied ones again.`.trim();
	error.context.data = { appliedTransactions: applied.map((transaction) => ({ ...transaction })) };
}

// What came back when Horizon gave no verdict: nothing, an error of Horizon's, or an answer that
// doesn't look like Horizon's, which usually means a wrong Horizon URL. The description starts by
// naming the server. Only the host: the path of a provider's address can carry a key.
const UNCERTAIN_ANSWERS = {
	none: (host: string) => `Horizon at ${host} didn't answer.`,
	horizon: (host: string) => `Horizon at ${host} answered with an error.`,
	foreign: (host: string) =>
		`The answer from ${host} doesn't look like Horizon's: check 'Horizon URL'.`,
};

// Horizon didn't say whether the transaction was applied. Stellar's docs advise sending the same
// transaction again after a timeout, because the network may have dropped it from its queue.
function uncertain(
	transaction: Transaction,
	txHash: string,
	host: string,
	reason: string,
	answer: keyof typeof UNCERTAIN_ANSWERS,
	cause?: unknown,
): SubmissionFailure {
	const expiry = expiryOf(transaction);
	const until =
		expiry === undefined
			? 'It has no time limit, so it can still be applied later. Look it up on Horizon by its hash.'
			: `It can still be applied ${untilText(expiry)}. Look it up on Horizon by its hash. If it isn't there after that${expiry.ledger === undefined ? ' time' : ''}, look at the account's sequence number: if it is lower than ${transaction.sequence}, this transaction was not applied.`;
	const from = UNCERTAIN_ANSWERS[answer](host);
	return {
		outcome: 'uncertain',
		message: `The result of transaction ${txHash} is uncertain: ${reason}`,
		description: `${from} ${until} Send this same signed transaction again until Horizon gives a final result: the network may have dropped it, and it can be applied only once, so that is safe. Don't build a new one for this payment until you know.`,
		cause,
		lookupAt: from.length + 1,
	};
}

// A limit of the transaction: a time, from its time bounds, and a ledger number, from its ledger
// bounds. The network applies both.
interface Bound {
	time?: string;
	ledger?: number;
}

// When the transaction stops being valid, or undefined if it never does. The network takes it
// only before its maxLedger.
function expiryOf(transaction: Transaction): Bound | undefined {
	return boundOf(
		utcMinute(transaction.timeBounds?.maxTime),
		ledgerNumber(transaction.ledgerBounds?.maxLedger),
	);
}

// When the transaction starts being valid, or undefined if it has no start. Its minLedger is the
// first ledger that can take it.
function startOf(transaction: Transaction): Bound | undefined {
	return boundOf(
		utcMinute(transaction.timeBounds?.minTime),
		ledgerNumber(transaction.ledgerBounds?.minLedger),
	);
}

function boundOf(time: string | undefined, ledger: number | undefined): Bound | undefined {
	return time === undefined && ledger === undefined ? undefined : { time, ledger };
}

// "until <time>", "before ledger <n>", or both.
function untilText(expiry: Bound): string {
	const parts: string[] = [];
	if (expiry.time !== undefined) parts.push(`until ${expiry.time}`);
	if (expiry.ledger !== undefined) parts.push(`before ledger ${expiry.ledger}`);
	return parts.join(' and ');
}

// "Its time limit, <time>,", "Its ledger limit, ledger <n>,", or both.
function limitName(expiry: Bound | undefined): string {
	const names: string[] = [];
	if (expiry?.time !== undefined) names.push(`time limit, ${expiry.time},`);
	if (expiry?.ledger !== undefined) names.push(`ledger limit, ledger ${expiry.ledger},`);
	return names.length === 0 ? 'Its time limit' : `Its ${names.join(' or its ')}`;
}

// "Its start time, <time>,", "Its first ledger, <n>,", or both.
function startName(start: Bound | undefined): string {
	const names: string[] = [];
	if (start?.time !== undefined) names.push(`start time, ${start.time},`);
	if (start?.ledger !== undefined) names.push(`first ledger, ${start.ledger},`);
	return names.length === 0 ? 'Its start time' : `Its ${names.join(' or its ')}`;
}

// The opening of tx_insufficient_fee. For a Soroban transaction the total fee also carries the
// resource fee, and what competes to get in is the inclusion fee: the total minus the resource fee.
function feeTooSmall(transaction: Transaction): string {
	const tooSmall =
		"is too small: lower than the network's minimum, or lower than what other transactions are offering while the network is busy.";
	const resourceFee = resourceFeeOf(transaction);
	if (resourceFee === undefined) {
		return `Its fee, ${transaction.fee} stroops, ${tooSmall}`;
	}
	const inclusionFee = BigInt(transaction.fee) - resourceFee;
	return `Its inclusion fee, ${inclusionFee} stroops, ${tooSmall} Its total fee, ${transaction.fee} stroops, also carries a resource fee of ${resourceFee} stroops, which comes from the simulation and doesn't compete for inclusion.`;
}

// For txINSUFFICIENT_FEE, stellar-core puts in the result's feeCharged the total fee the network
// asks for, resource fee included.
function feeAskedFor(feeCharged: bigint | undefined): string {
	return feeCharged === undefined
		? ''
		: ` Horizon's answer asks for a total fee of at least ${feeCharged} stroops.`;
}

// The wait that the transaction's minimum sequence age and ledger gap ask for.
function minimumWait(transaction: Transaction): string {
	const parts: string[] = [];
	const seconds = transaction.minAccountSequenceAge;
	if (seconds !== undefined && seconds > BigInt(0)) {
		parts.push(`${seconds} second${seconds === BigInt(1) ? '' : 's'}`);
	}
	const ledgers = transaction.minAccountSequenceLedgerGap ?? 0;
	if (ledgers > 0) {
		parts.push(`${ledgers} ledger${ledgers === 1 ? '' : 's'}`);
	}
	return parts.length === 0 ? 'a minimum time or number of ledgers' : parts.join(' and ');
}

// A ledger bound. Zero means the bound isn't set.
function ledgerNumber(value: number | undefined): number | undefined {
	return Number.isSafeInteger(value) && (value as number) > 0 ? value : undefined;
}

// A time bound, in seconds since 1970, as a date and time in UTC. Zero means the bound isn't set.
// The minute is rounded up: the network still takes a transaction until its maxTime, so a time
// limit shown earlier than it is would make the texts conclude too soon that it wasn't applied.
function utcMinute(timeBound: string | undefined): string | undefined {
	const seconds = Number(timeBound ?? 0);
	if (!Number.isFinite(seconds) || seconds <= 0) {
		return undefined;
	}
	const minutes = Math.ceil(seconds / 60);
	return `${new Date(minutes * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

// The feeCharged of the result_xdr that Horizon sends with a rejection, when it can be read and is
// above zero.
function feeChargedIn(body: unknown): bigint | undefined {
	const extras = isRecord(body) && isRecord(body.extras) ? body.extras : undefined;
	if (typeof extras?.result_xdr !== 'string') {
		return undefined;
	}
	try {
		const { feeCharged } = xdr.TransactionResult.fromXdr(extras.result_xdr, 'base64');
		return feeCharged > BigInt(0) ? feeCharged : undefined;
	} catch {
		return undefined;
	}
}

// The name of a Horizon error, such as transaction_malformed, or undefined if the body isn't one
// of Horizon's. Its errors always have a type under Horizon's address, a title and the HTTP
// status. Any gateway can answer with those three fields, so the type has to be Horizon's.
function horizonErrorType(body: unknown, status: number): string | undefined {
	if (
		isRecord(body) &&
		typeof body.type === 'string' &&
		body.type.startsWith(HORIZON_ERROR_TYPES) &&
		typeof body.title === 'string' &&
		body.status === status
	) {
		return body.type.slice(HORIZON_ERROR_TYPES.length);
	}
	return undefined;
}

function horizonErrorTitle(body: unknown): string {
	return isRecord(body) && typeof body.title === 'string' ? body.title : '';
}

// The status with its usual name. The server's own reason phrase isn't used: it can be anything.
const STATUS_NAMES: Record<number, string> = {
	301: 'Moved Permanently',
	302: 'Found',
	307: 'Temporary Redirect',
	308: 'Permanent Redirect',
	400: 'Bad Request',
	403: 'Forbidden',
	404: 'Not Found',
	429: 'Too Many Requests',
	500: 'Internal Server Error',
	502: 'Bad Gateway',
	503: 'Service Unavailable',
	504: 'Gateway Timeout',
};

function statusText(status: number): string {
	return STATUS_NAMES[status] === undefined ? `${status}` : `${status} ${STATUS_NAMES[status]}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
