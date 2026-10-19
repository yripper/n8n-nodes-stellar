import type {
	ICredentialsDecrypted,
	ICredentialTestFunctions,
	IExecuteFunctions,
	INode,
	INodeCredentialTestResult,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { type Horizon, Keypair, Transaction, xdr } from '@stellar/stellar-sdk';

import { isNetworkName, NETWORK_PASSPHRASES, type NetworkName } from '../shared/network';
import { checkMessageSigning, checkPolicy, type Policy, readPolicy } from './policy';
import {
	addAppliedTransactions,
	type AppliedTransaction,
	checkMemoRequired,
	horizonServerFor,
	sameTransactionFailure,
	type SubmissionResult,
	submitTransaction,
} from './submission';

const ENTER_SECRET_KEY = "Enter the account's secret key: 56 characters, starting with S.";
const ENTER_TRANSACTION_XDR = 'Enter the base64 XDR of the transaction to sign.';
const ENTER_MESSAGE = 'Enter the text to sign.';

export class StellarSigner implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Stellar Signer',
		name: 'stellarSigner',
		icon: { light: 'file:stellarLogo.svg', dark: 'file:stellarLogo.dark.svg' },
		group: ['transform'],
		version: 1,
		// For a transaction, the saved Network value: the same as the networkName output field, except
		// for the 0.1.1 value mainnet, which shows as it was saved while the node signs for public.
		subtitle:
			'={{ $parameter["operation"] === "signMessage" ? "sign message" : $parameter["network"] }}',
		description: 'Sign Stellar transactions and messages using a wallet secret key',
		defaults: {
			name: 'Stellar Signer',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		// n8n-workflow 2.x types this as true or an object; n8n treats false like a missing property.
		usableAsTool: false as unknown as true,
		credentials: [
			{
				name: 'stellarWalletApi',
				required: true,
				testedBy: 'stellarWalletApiTest',
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Sign Message',
						value: 'signMessage',
						description: "Sign a text with the wallet's key, following SEP-53",
						action: 'Sign message',
					},
					{
						name: 'Sign Transaction',
						value: 'signTransaction',
						description: 'Sign a transaction and optionally submit it to the network',
						action: 'Sign transaction',
					},
				],
				default: 'signTransaction',
			},
			{
				displayName: 'Transaction XDR',
				name: 'xdr',
				type: 'string',
				default: '',
				placeholder: 'AAAAAgAAAAC...',
				displayOptions: {
					show: {
						operation: ['signTransaction'],
					},
				},
				description:
					"The transaction XDR to sign, in base64. It can already carry other signers' signatures, to co-sign it.",
			},
			{
				displayName: 'Network',
				name: 'network',
				type: 'options',
				options: [
					{
						name: 'Public',
						value: 'public',
					},
					{
						name: 'Testnet',
						value: 'testnet',
					},
				],
				default: 'public',
				displayOptions: {
					show: {
						operation: ['signTransaction'],
					},
				},
				description:
					"The Stellar network to sign for. Each input item must have the same value in its 'networkName' field.",
			},
			{
				displayName: 'Submit to Horizon',
				name: 'submit',
				type: 'boolean',
				default: false,
				validateType: 'boolean',
				displayOptions: {
					show: {
						operation: ['signTransaction'],
					},
				},
				description:
					"Whether to submit the signed transaction to the network through Horizon, using SDF's server for the chosen network unless 'Horizon URL' has another. On the public network, this moves real funds.",
			},
			{
				displayName: 'Horizon URL',
				name: 'horizonUrl',
				type: 'string',
				default: '',
				placeholder: 'e.g. https://horizon.example.com',
				displayOptions: {
					show: {
						operation: ['signTransaction'],
						submit: [true],
					},
				},
				description:
					"The Horizon server to submit to, as an https address. Plain http works only for localhost, and the address can't have a user name or a password. Leave empty to use SDF's server for the network: horizon-testnet.stellar.org for testnet and horizon.stellar.org for public. Stellar's Horizon page names SDF's testnet server but not the public one, so enter your provider's address if it stops answering.",
			},
			{
				displayName: 'Message',
				name: 'message',
				type: 'string',
				// The editor marks it as missing. An expression that gives nothing still fails in the node.
				required: true,
				typeOptions: {
					rows: 4,
				},
				default: '',
				displayOptions: {
					show: {
						operation: ['signMessage'],
					},
				},
				description:
					"The text to sign, exactly as entered. The signature follows SEP-53 and proves that this wallet's key signed this exact text. The node returns it as base64 in the signature field.",
			},
		],
	};

	methods = {
		credentialTest: {
			// Reads the secret key offline: the credential doesn't know the network, so the
			// account isn't looked up.
			async stellarWalletApiTest(
				this: ICredentialTestFunctions,
				credential: ICredentialsDecrypted,
			): Promise<INodeCredentialTestResult> {
				const secretKey = credential.data?.secretKey;
				let keypair: Keypair;
				try {
					// The SDK decides first, also when the value isn't text.
					keypair = Keypair.fromSecret(secretKey as string);
				} catch (error) {
					const { problem, fix } = explainInvalidSecretKey(secretKey, error);
					return { status: 'Error', message: `'Secret Key' ${problem}. ${fix}` };
				}
				// A policy that can't be read signs nothing in any run, so saving the credential warns.
				const reading = readPolicy(credential.data);
				if ('invalid' in reading) {
					const { field, problem, fix } = reading.invalid;
					return { status: 'Error', message: `'${field}' ${problem}. ${fix}` };
				}
				return {
					status: 'OK',
					message: `Valid secret key for public key ${keypair.publicKey()}`,
				};
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		// The node that goes into every error: a copy with the Horizon URL hidden.
		const node = nodeForErrors(this.getNode());

		// What the whole run needs is read before the items. With On Error on Stop Workflow, a
		// failure here fails the run, and the error goes out as it came. With one of the Continue
		// options the node can't throw: n8n would pass the input items on as they came, unsigned.
		// So every item fails instead, with this same error and no item index.
		let credential: SignerCredential;
		if (this.continueOnFail()) {
			try {
				credential = await readCredential(this, node);
			} catch (error) {
				// A NodeOperationError, such as n8n's own or this node's, comes back as the same error.
				const runError = new NodeOperationError(
					node,
					error instanceof Error ? error : String(error),
				);
				// n8n's own error has the node as n8n keeps it, so it gets the copy. TypeScript marks
				// node as read-only, and it is a plain property.
				Object.assign(runError, { node });
				return [
					items.map((item, itemIndex) => ({
						json: item.json,
						error: runError,
						pairedItem: itemIndex,
					})),
				];
			}
		} else {
			credential = await readCredential(this, node);
		}
		const { secretKey, policy } = credential;

		const returnData: INodeExecutionData[] = [];
		// With Submit to Horizon on: the transactions Horizon applied in this run, and the item that
		// first sent each transaction.
		const applied: AppliedTransaction[] = [];
		const firstItemWith = new Map<string, number>();

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const item = items[itemIndex];
				const operation = this.getNodeParameter('operation', itemIndex, 'signTransaction');
				if (operation === 'signMessage') {
					returnData.push(
						signMessageItem(
							node,
							item,
							this.getNodeParameter('message', itemIndex, ''),
							secretKey,
							policy,
							itemIndex,
						),
					);
					continue;
				}
				if (operation !== 'signTransaction') {
					throw new NodeOperationError(node, "'Operation' must be signTransaction or signMessage", {
						itemIndex,
						description: 'Choose Sign Transaction or Sign Message in the Operation parameter.',
					});
				}

				const transactionXdr = this.getNodeParameter('xdr', itemIndex, '');
				const networkName = networkNameFrom(
					node,
					normalizeNetworkName(this.getNodeParameter('network', itemIndex, 'public')),
					itemIndex,
				);
				const networkPassphrase = NETWORK_PASSPHRASES[networkName];
				// Checked after the Network parameter and before the XDR and the item's secret key
				// check. An empty secret key was already rejected before the items. n8n doesn't
				// check that an item has json, so it is read with ?. here.
				checkItemNetwork(node, item.json?.networkName, networkName, itemIndex);

				// With Submit to Horizon on, the server is set up before the transaction is read or
				// signed, so a wrong setting fails the item unsigned. horizonUrl is only read then:
				// n8n doesn't hand over a parameter that is hidden.
				let horizon: Horizon.Server | undefined;
				if (this.getNodeParameter('submit', itemIndex, false) === true) {
					horizon = horizonServerFor(
						node,
						networkName,
						this.getNodeParameter('horizonUrl', itemIndex, ''),
						itemIndex,
					);
				}

				// An empty XDR fails before the secret key is read. The SDK rejects it too, so
				// parseTransaction throws here.
				if (isBlank(transactionXdr)) {
					parseTransaction(node, transactionXdr, networkPassphrase, itemIndex);
				}

				const keypair = keypairFromSecret(node, secretKey, itemIndex);
				const transaction = parseTransaction(node, transactionXdr, networkPassphrase, itemIndex);
				checkNotSignedByKey(node, transaction, keypair, itemIndex);
				// The credential's policy is checked on the decoded transaction, before it is
				// signed and before any request to the network.
				const violation = checkPolicy(policy, transaction);
				if (violation !== undefined) {
					throw new NodeOperationError(node, violation.message, {
						itemIndex,
						description: violation.description,
					});
				}
				// The last check before signing, and the only one that needs the network.
				if (horizon !== undefined) {
					await checkMemoRequired(node, horizon, transaction, itemIndex);
				}
				transaction.sign(keypair);

				const txHash = Buffer.from(transaction.hash()).toString('hex');
				const signedXdr = transaction.toXdr();

				const newItem: INodeExecutionData = {
					json: {
						...item.json,
						signedXdr,
						txHash,
						publicKey: keypair.publicKey(),
						network: networkPassphrase,
						networkName,
					},
					pairedItem: itemIndex,
				};
				if (item.binary !== undefined) {
					newItem.binary = item.binary;
				}

				// No retries: a transaction that Horizon doesn't confirm fails the item, and the error
				// says whether it was rejected, not submitted, or may still be applied.
				if (horizon !== undefined) {
					// A transaction is applied only once, so a second item with the same one isn't
					// sent: it couldn't pay again.
					const firstItem = firstItemWith.get(txHash);
					let result: SubmissionResult;
					if (firstItem === undefined) {
						firstItemWith.set(txHash, itemIndex);
						result = await submitTransaction(horizon, transaction, txHash);
					} else {
						result = { failure: sameTransactionFailure(firstItem, txHash) };
					}
					if ('failure' in result) {
						const { failure } = result;
						if (this.continueOnFail()) {
							// The item is already signed, so it says what happened to its transaction
							// and carries the hash and the signed transaction to look up or resend.
							// n8n replaces the json of an item that has the error property, so this
							// one goes out without it, like the HTTP Request node's. With error as
							// its only key, n8n still sends it to the error output, and there it adds
							// the input item's fields when pairedItem is an object.
							returnData.push({
								json: {
									error: {
										message: failure.message,
										description: failure.description,
										outcome: failure.outcome,
										txHash,
										signedXdr,
									},
								},
								pairedItem: { item: itemIndex },
							});
							continue;
						}
						throw new NodeOperationError(
							node,
							failure.cause instanceof Error ? failure.cause : failure.message,
							{ itemIndex, message: failure.message, description: failure.description },
						);
					}
					newItem.json.submitted = true;
					newItem.json.ledger = result.ledger;
					applied.push({ itemIndex, txHash, ledger: result.ledger });
				}

				returnData.push(newItem);
			} catch (error) {
				// A NodeOperationError comes back as the same error and keeps its own itemIndex.
				const nodeError = new NodeOperationError(node, error, { itemIndex });
				// One that n8n built has the node as n8n keeps it, so it gets the copy.
				Object.assign(nodeError, { node });
				if (this.continueOnFail()) {
					returnData.push({
						json: items[itemIndex].json,
						error: nodeError,
						pairedItem: itemIndex,
					});
				} else {
					// n8n drops the output of the items before this one, so the error keeps the
					// transactions that were already applied.
					if (applied.length > 0) {
						addAppliedTransactions(nodeError, applied);
					}
					throw nodeError;
				}
			}
		}

		return [returnData];
	}
}

// What goes in the place of the Horizon URL in the node that is attached to an error.
const HIDDEN_HORIZON_URL = '[hidden by the node]';

// n8n attaches the node, with its saved parameters, to every error, stores that error with the
// execution and hands it to the error workflow. The address of a provider's Horizon can carry a
// key, so the copy of the node that goes into this node's errors has a mark in its place. n8n
// still keeps the address in the workflow and in its own copy of the node.
function nodeForErrors(node: INode): INode {
	const { horizonUrl } = node.parameters;
	if (horizonUrl === undefined || horizonUrl === '') {
		return node;
	}
	return { ...node, parameters: { ...node.parameters, horizonUrl: HIDDEN_HORIZON_URL } };
}

// What every item needs from the credential.
interface SignerCredential {
	secretKey: unknown;
	policy: Policy;
}

// It throws without an item index when n8n can't hand over the credential, when the secret key is
// empty, or when a policy field can't be read: a policy that can't be read never counts as "no
// limit".
async function readCredential(context: IExecuteFunctions, node: INode): Promise<SignerCredential> {
	const credentials = await context.getCredentials('stellarWalletApi');
	const secretKey = credentials.secretKey;

	// The SDK rejects an empty secret key like any secret key it can't use, so keypairFromSecret
	// throws here.
	if (isBlank(secretKey)) {
		keypairFromSecret(node, secretKey);
	}

	const reading = readPolicy(credentials);
	if ('invalid' in reading) {
		const { field, problem, fix } = reading.invalid;
		throw new NodeOperationError(
			node,
			`'${field}' in the Stellar Wallet API credential ${problem}`,
			{ description: `${fix} Nothing was signed.` },
		);
	}
	return { secretKey, policy: reading.policy };
}

// Signs a text with the wallet's key, as SEP-53 says, and returns the item with the text, its
// signature and the public key. It needs no network, so the item's networkName isn't read and
// nothing is sent. The credential has to allow it.
function signMessageItem(
	node: INode,
	item: INodeExecutionData,
	message: unknown,
	secretKey: unknown,
	policy: Policy,
	itemIndex: number,
): INodeExecutionData {
	const violation = checkMessageSigning(policy);
	if (violation !== undefined) {
		throw new NodeOperationError(node, violation.message, {
			itemIndex,
			description: violation.description,
		});
	}
	if (message === undefined || message === null || isBlank(message)) {
		throw new NodeOperationError(node, "'Message' is empty", {
			itemIndex,
			description: `${ENTER_MESSAGE} If it comes from an expression, check that the expression gives a value for this item.`,
		});
	}
	if (typeof message !== 'string') {
		throw new NodeOperationError(node, "'Message' is not text", {
			itemIndex,
			description: `${ENTER_MESSAGE} If it comes from an expression, check that it gives a string, not an object or a number.`,
		});
	}

	const keypair = keypairFromSecret(node, secretKey, itemIndex);
	// The text is signed as it is: trimming it would sign another text.
	const signature = Buffer.from(keypair.signMessage(message)).toString('base64');

	const newItem: INodeExecutionData = {
		json: { ...item.json, message, signature, publicKey: keypair.publicKey() },
		pairedItem: itemIndex,
	};
	if (item.binary !== undefined) {
		newItem.binary = item.binary;
	}
	return newItem;
}

// 0.1.1 saved the public network as mainnet. Reading it as public keeps those workflows signing for
// the network they were saved with.
function normalizeNetworkName<T>(networkName: T): T | 'public' {
	return networkName === 'mainnet' ? 'public' : networkName;
}

// Any other value fails instead of signing for a network the user didn't choose.
function networkNameFrom(node: INode, value: unknown, itemIndex: number): NetworkName {
	if (isNetworkName(value)) {
		return value;
	}
	throw new NodeOperationError(node, "'Network' must be public or testnet", {
		itemIndex,
		description: 'Choose public or testnet in the Network parameter.',
	});
}

// The network isn't stored in the transaction XDR, so the item has to say which network its
// transaction was built for, in networkName. A signature for the wrong network looks valid, and
// the network only rejects it on submission.
function checkItemNetwork(
	node: INode,
	itemNetworkName: unknown,
	nodeNetworkName: NetworkName,
	itemIndex: number,
): void {
	if (itemNetworkName === undefined || itemNetworkName === null || isBlank(itemNetworkName)) {
		throw new NodeOperationError(node, "'networkName' is missing from the input item", {
			itemIndex,
			description:
				"Add a 'networkName' field with public or testnet, the network the transaction was built for. An Edit Fields node before this one can add it, with 'Include Other Input Fields' turned on so the item keeps its other fields.",
		});
	}
	if (!isNetworkName(itemNetworkName)) {
		throw new NodeOperationError(node, "'networkName' must be public or testnet", {
			itemIndex,
			description:
				"Set 'networkName' in the input item to public or testnet, in lowercase and without spaces. It is the network the transaction was built for.",
		});
	}
	if (itemNetworkName !== nodeNetworkName) {
		// The node only knows what the item says: the label may be wrong, not the transaction.
		throw new NodeOperationError(
			node,
			`'networkName' is ${itemNetworkName} but 'Network' is ${nodeNetworkName}`,
			{
				itemIndex,
				description: `The input item says the transaction was built for ${itemNetworkName}, and this node signs for ${nodeNetworkName}. Choose ${itemNetworkName} in the 'Network' parameter, build the transaction for ${nodeNetworkName}, or fix 'networkName' in the input item if it is wrong.`,
			},
		);
	}
}

// The item index is left out for an empty secret key, which is checked once, before the items.
function keypairFromSecret(node: INode, secretKey: unknown, itemIndex?: number): Keypair {
	try {
		// The SDK decides first, also when the value isn't text.
		return Keypair.fromSecret(secretKey as string);
	} catch (error) {
		const { problem, fix } = explainInvalidSecretKey(secretKey, error);
		const message = `'Secret Key' in the Stellar Wallet API credential ${problem}`;
		// Without a safe SDK error, the error is built from the message, and n8n sets a copy of it
		// as the cause.
		const cause = sdkErrorSafeToKeep(secretKey, error);
		throw new NodeOperationError(node, cause ?? message, { itemIndex, message, description: fix });
	}
}

interface Rejection {
	// Completes "'Secret Key' …" or "'Transaction XDR' …" without repeating the value.
	problem: string;
	// How to fix it.
	fix: string;
}

// Says what is wrong with a secret key the SDK rejected. These checks only choose the text: the
// SDK alone decides which secret keys are valid. The messages only mention the secret key's first
// character and its length.
function explainInvalidSecretKey(secretKey: unknown, sdkError: unknown): Rejection {
	if (typeof secretKey !== 'string') {
		return { problem: 'is not text', fix: ENTER_SECRET_KEY };
	}
	if (isBlank(secretKey)) {
		return { problem: 'is empty', fix: ENTER_SECRET_KEY };
	}
	if (secretKey !== secretKey.trim()) {
		return {
			problem: 'has spaces or line breaks at the start or end',
			fix: 'Remove the spaces or line breaks around the secret key.',
		};
	}
	if (secretKey.startsWith('G')) {
		return {
			problem: 'looks like a public key',
			fix: "Enter the account's secret key, which starts with S, not its public key, which starts with G.",
		};
	}
	if (!secretKey.startsWith('S')) {
		return {
			problem: "doesn't start with S",
			fix: 'A Stellar secret key starts with S and has 56 characters.',
		};
	}
	if (secretKey.length !== 56) {
		const characters = secretKey.length === 1 ? '1 character' : `${secretKey.length} characters`;
		return {
			problem: `has ${characters} instead of 56`,
			fix: 'Check that the whole secret key was copied: it has 56 characters and starts with S.',
		};
	}
	if (/[^A-Z2-7]/.test(secretKey)) {
		return {
			problem: "has characters a Stellar secret key doesn't use",
			fix: 'A Stellar secret key only uses capital letters A to Z and digits 2 to 7.',
		};
	}
	const fix = 'Copy the secret key again from your wallet.';
	// The SDK text is added only when the SDK error is safe to keep as the cause.
	const keptError = sdkErrorSafeToKeep(secretKey, sdkError);
	if (keptError !== undefined) {
		return { problem: `looks like a typo (Stellar SDK: ${keptError.message})`, fix };
	}
	return { problem: 'looks like a typo', fix };
}

// Returns the SDK error if its text doesn't contain the secret key. SDK 17.1.0 never puts the key
// in its errors. A value that isn't text is compared as text, and an object also as JSON. If a
// conversion fails, nothing is compared and the error is kept. A blank secret key skips the check.
// It has nothing to leak, and the check would almost always drop its error, because every text
// contains the empty text and almost every one contains a space.
function sdkErrorSafeToKeep(secretKey: unknown, sdkError: unknown): Error | undefined {
	if (!(sdkError instanceof Error)) {
		return undefined;
	}
	if (isBlank(secretKey)) {
		return sdkError;
	}
	try {
		const enteredAsText = [String(secretKey)];
		if (typeof secretKey === 'object' && secretKey !== null) {
			enteredAsText.push(JSON.stringify(secretKey));
		}
		return enteredAsText.some((text) => sdkError.message.includes(text)) ? undefined : sdkError;
	} catch {
		return sdkError;
	}
}

function parseTransaction(
	node: INode,
	transactionXdr: unknown,
	networkPassphrase: string,
	itemIndex: number,
): Transaction {
	try {
		// The SDK decides first, also when the value is empty or isn't text.
		return new Transaction(transactionXdr as string, networkPassphrase);
	} catch (error) {
		const { problem, fix } = explainInvalidTransactionXdr(transactionXdr);
		throw new NodeOperationError(node, error, {
			itemIndex,
			message: `'Transaction XDR' ${problem}`,
			description: fix,
		});
	}
}

// A second signature of the same key makes the network reject the transaction with
// tx_bad_auth_extra, so an XDR that already has a valid one fails here, unsigned. A signature of
// another key is someone co-signing, and goes on.
function checkNotSignedByKey(
	node: INode,
	transaction: Transaction,
	keypair: Keypair,
	itemIndex: number,
): void {
	const hint = Buffer.from(keypair.signatureHint());
	const hash = transaction.hash();
	const alreadySigned = transaction.signatures.some((signature) => {
		if (!hint.equals(Buffer.from(signature.hint.toXdrObject()))) {
			return false;
		}
		try {
			return keypair.verify(hash, signature.signature);
		} catch {
			// A signature of the wrong length can't be this key's.
			return false;
		}
	});
	if (alreadySigned) {
		throw new NodeOperationError(node, "'Transaction XDR' already has this wallet's signature", {
			itemIndex,
			description:
				"The transaction already carries a signature of this credential's key. A second one makes the network reject it with tx_bad_auth_extra, so nothing was signed. To send it again, pass the unsigned transaction to this node, or send the signed one to Horizon yourself. To add another signer's signature, use that signer's credential.",
		});
	}
}

// Says what is wrong with a transaction XDR the SDK rejected. These checks only choose the text:
// the SDK alone decides which XDR is valid.
function explainInvalidTransactionXdr(transactionXdr: unknown): Rejection {
	if (typeof transactionXdr !== 'string') {
		return {
			problem: 'is not text',
			fix: 'Enter the base64 XDR of the transaction as text. If it comes from an expression, check that it gives a string, not an object or a number.',
		};
	}
	if (isBlank(transactionXdr)) {
		return {
			problem: 'is empty',
			fix: `${ENTER_TRANSACTION_XDR} If it comes from an expression, check that the expression gives a value for this item.`,
		};
	}
	if (isFeeBumpEnvelope(transactionXdr)) {
		return {
			problem: 'is a fee bump transaction',
			fix: "This node doesn't sign fee bump transactions. Sign the inner transaction instead.",
		};
	}
	return { problem: "isn't a valid transaction envelope", fix: ENTER_TRANSACTION_XDR };
}

// Reads the envelope type like the SDK does in TransactionBuilder.fromXdr, only to choose the
// message. An XDR that doesn't decode isn't a fee bump.
function isFeeBumpEnvelope(transactionXdr: string): boolean {
	try {
		const envelope = xdr.TransactionEnvelope.fromXdr(transactionXdr, 'base64');
		return envelope.type === 'envelopeTypeTxFeeBump';
	} catch {
		return false;
	}
}

// Empty text, or text with only spaces or line breaks. A value that isn't text isn't blank.
function isBlank(value: unknown): boolean {
	return typeof value === 'string' && value.trim() === '';
}
