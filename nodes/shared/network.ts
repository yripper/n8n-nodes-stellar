import { Networks } from '@stellar/stellar-sdk';

// The SDK's network names (Networks.PUBLIC, Networks.TESTNET), in lowercase. They are the values of
// the Network parameter and of the networkName field.
export type NetworkName = 'public' | 'testnet';

export function isNetworkName(value: unknown): value is NetworkName {
	return value === 'public' || value === 'testnet';
}

export const NETWORK_PASSPHRASES: Record<NetworkName, string> = {
	public: Networks.PUBLIC,
	testnet: Networks.TESTNET,
};

// SDF's Horizon server for each network.
const HORIZON_URLS: Record<NetworkName, string> = {
	public: 'https://horizon.stellar.org',
	testnet: 'https://horizon-testnet.stellar.org',
};

// The Horizon server to use for a network: SDF's, unless customUrl has another address.
export function horizonUrlFor(networkName: NetworkName, customUrl: string): string {
	return customUrl.trim() === '' ? HORIZON_URLS[networkName] : customUrl;
}
