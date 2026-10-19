import { Icon, ICredentialType, INodeProperties } from 'n8n-workflow';

export class StellarWalletApi implements ICredentialType {
	name = 'stellarWalletApi';
	displayName = 'Stellar Wallet API';

	icon: Icon = {
		light: 'file:../nodes/StellarSigner/stellarLogo.svg',
		dark: 'file:../nodes/StellarSigner/stellarLogo.dark.svg',
	};

	documentationUrl = 'https://github.com/yripper/n8n-nodes-stellar/blob/main/CREDENTIALS.md';

	properties: INodeProperties[] = [
		{
			displayName: 'Secret Key',
			name: 'secretKey',
			type: 'string',
			typeOptions: {
				password: true,
			},
			default: '',
			placeholder: 'e.g. SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
			description: 'The secret key of your Stellar wallet (starts with S)',
		},
		{
			displayName: 'Allowed Operations',
			name: 'allowedOperations',
			type: 'string',
			typeOptions: {
				rows: 4,
			},
			default: '',
			placeholder: 'e.g. payment',
			description:
				"The operation types this wallet may sign, one per line, such as payment or createAccount. A transaction with any other operation fails and isn't signed. Leave empty to sign any operation, or only payment operations while Maximum Amounts, Allowed Assets or Allowed Destinations is set.",
		},
		{
			displayName: 'Maximum Amounts',
			name: 'maxAmounts',
			type: 'string',
			typeOptions: {
				rows: 4,
			},
			default: '',
			placeholder: 'e.g. XLM=100',
			description:
				'The highest amount of each asset that one payment operation (payment, pathPaymentStrictSend, pathPaymentStrictReceive or createAccount) may send, one per line, as XLM=100 or CODE:ISSUER=100, where ISSUER is the address of the account that issues the asset. XLM can also be written native. While any limit is set, a payment that sends an asset without a line fails. Leave empty for no limits.',
		},
		{
			displayName: 'Allowed Assets',
			name: 'allowedAssets',
			type: 'string',
			typeOptions: {
				rows: 4,
			},
			default: '',
			placeholder: 'e.g. XLM',
			description:
				'The assets this wallet may pay in, one per line, as XLM or CODE:ISSUER, where ISSUER is the address of the account that issues the asset. XLM can also be written native. A path payment needs both the asset it sends and the asset it delivers. Leave empty to pay in any asset.',
		},
		{
			displayName: 'Allowed Destinations',
			name: 'allowedDestinations',
			type: 'string',
			typeOptions: {
				rows: 4,
			},
			default: '',
			placeholder: 'e.g. GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
			description:
				'The addresses this wallet may pay, one per line. A G address also allows its muxed (M) addresses. An M address allows only itself. Leave empty to pay any address.',
		},
		{
			displayName: 'Maximum Fee',
			name: 'maxFee',
			type: 'number',
			typeOptions: {
				minValue: 0,
				numberPrecision: 0,
			},
			default: 0,
			description:
				"The highest fee that a transaction may carry, in stroops: 1 XLM is 10,000,000 stroops. It is the transaction's total fee, for all its operations, and for a Soroban transaction it includes the resource fee. 0 means no limit.",
		},
		{
			displayName: 'Allow Message Signing',
			name: 'allowMessageSigning',
			type: 'boolean',
			default: false,
			description:
				'Whether the Stellar Signer may sign messages (SEP-53) with this wallet. Leave it off unless a workflow needs it: a signed message can prove control of the key to another service.',
		},
	];
}
