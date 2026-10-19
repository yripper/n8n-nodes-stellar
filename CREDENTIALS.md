# Stellar Wallet API credential

The Stellar Signer node signs transactions, and messages if you allow it, with the secret key stored
in this credential.

## The secret key

- A Stellar account has two keys. The public key starts with `G` and identifies the account, so it's
  safe to share. The secret key starts with `S` and gives full control over the account and all its
  funds. Each key is 56 characters long.
- The credential doesn't store a network. The node signs a transaction with this secret key for the
  network chosen in its **Network** parameter.
- The same secret key works on `public` and on `testnet`, but each network has its own accounts: an
  account created on `testnet` doesn't exist on `public`.
- The node returns the public key that matches the secret key in its `publicKey` output field. It
  never returns the secret key.

## Get a secret key on testnet

`testnet` works like `public` but doesn't connect to real money. To create a testnet account:

1. Open the [Create Account Keypair](https://lab.stellar.org/account/create) page of Stellar Lab.
   Check that the network in the upper right corner of the page is Testnet.
2. Click **Generate keypair**.
3. Click **Fund account with Friendbot** to add 10,000 test XLM to the account.
4. Paste the secret key into the **Secret Key** field of this credential and save it. When you save
   it, n8n checks the secret key. If it is valid, n8n only shows _Connection tested successfully_.
   To see which account the key belongs to, look at the `publicKey` field in the Stellar Signer's
   output after it signs a transaction.

Testnet is usually reset 2 to 4 times a year, and a reset deletes every account. After a reset, fund
the account again or create a new one.

## Limit what the node signs

The credential can limit what the Stellar Signer signs with this secret key. Each limit on
transactions is optional. An empty limit, or a **Maximum Fee** of 0, means no limit, and that is how
they start. The node checks a transaction against the limits before it signs it. An item whose
transaction breaks a limit fails and isn't signed. These limits don't apply to messages, which have
their own switch.

- **Allowed Operations**: the operation types the node may sign, one per line. With only `payment`
  here, a transaction that has an `accountMerge` or a `setOptions` operation fails. The node checks
  every operation of the transaction. The names are the ones the Stellar SDK uses, in any letter
  case:

  `createAccount`, `payment`, `pathPaymentStrictReceive`, `pathPaymentStrictSend`,
  `manageSellOffer`, `manageBuyOffer`, `createPassiveSellOffer`, `setOptions`, `changeTrust`,
  `allowTrust`, `accountMerge`, `inflation`, `manageData`, `bumpSequence`, `createClaimableBalance`,
  `claimClaimableBalance`, `beginSponsoringFutureReserves`, `endSponsoringFutureReserves`,
  `revokeAccountSponsorship`, `revokeTrustlineSponsorship`, `revokeOfferSponsorship`,
  `revokeDataSponsorship`, `revokeClaimableBalanceSponsorship`, `revokeLiquidityPoolSponsorship`,
  `revokeSignerSponsorship`, `clawback`, `clawbackClaimableBalance`, `setTrustLineFlags`,
  `liquidityPoolDeposit`, `liquidityPoolWithdraw`, `invokeHostFunction`, `extendFootprintTtl`,
  `restoreFootprint`.

  Stellar's documentation lists **Revoke sponsorship** as one operation, and the SDK splits it into
  the seven `revoke…Sponsorship` types above: list the ones the workflow needs. `inflation` no
  longer works on the network, and `allowTrust` is deprecated in favor of `setTrustLineFlags`.

- **Maximum Amounts**: the most that one payment operation may send of each asset, one limit per
  line. Write `XLM=100` for lumens, or `CODE:ISSUER=100` for another asset, with its code and the
  address of the account that issues it. `native` also means lumens, as the Stellar SDK and CLI
  write them. An amount can have up to 7 decimals. The node looks at what each payment operation
  sends from its source account, which can be another account than this one, as in a payment to this
  account that the node co-signs: the amount of a `payment`, what a `pathPaymentStrictSend` sends,
  the most a `pathPaymentStrictReceive` may send, and the starting balance of a `createAccount`.
  While the field has any line, an operation that sends an asset without a line fails, so write a
  line for every asset the wallet pays in. A path payment needs a line only for the asset it sends.
  The limit is for each operation, not for the transaction or the run: ten payments of 10 pass a
  limit of 10. A limit of 0 means the node sends none of that asset, unlike **Maximum Fee**, where 0
  means no limit. Asset codes are case-sensitive, so a limit for `usdc` is not a limit for `USDC`: a
  payment in `USDC` then fails, because it has no line.

- **Allowed Assets**: the assets the node may pay in, one per line, written as in **Maximum
  Amounts**: `XLM` (or `native`), or `CODE:ISSUER`. The issuer is part of the asset, so the same
  code from another issuer isn't in the list. A path payment needs both the asset it sends and the
  asset it delivers. A `createAccount` pays in XLM.

- **Allowed Destinations**: the addresses the node may pay, one per line. An address is an account,
  56 characters starting with `G`, or a muxed address, 69 characters starting with `M`, which is an
  account plus a customer number. A `G` line allows that account and every muxed address of it. An
  `M` line allows only that muxed address. The node checks the destination of the four payment
  operations.

- **Maximum Fee**: the highest fee, in stroops, that a transaction may carry. One XLM is 10,000,000
  stroops. It is the transaction's total fee, for all its operations: the most the account agrees to
  pay, which can be more than what the network ends up charging. For a Soroban transaction, such as
  a contract call, it also includes the resource fee, which comes from the call's simulation. `0`,
  the default, means no limit.

- **Allow Message Signing**: whether the node may sign messages with this key, with its **Sign
  Message** operation. It is off by default, and Sign Message fails while it is off. Leave it off
  unless a workflow needs it. A signed message proves that this key signed a text, and other
  services accept such a proof, for example as a login. The node signs whatever text it receives, so
  turn it on only for a workflow that controls what that text says.

The node checks **Maximum Amounts**, **Allowed Assets** and **Allowed Destinations** only on those
four payment operations. Other operations, such as an `accountMerge` or a `createClaimableBalance`,
can also move funds, but the node doesn't read them. While any of them is set and **Allowed
Operations** is empty, the node signs only those four types and fails any other operation, such as
an `accountMerge`, an offer, a liquidity pool operation or a Soroban contract call. To sign another
type with the same credential, list it in **Allowed Operations** together with the payment types.
The node then signs it without looking at its amounts, assets or destinations, so an `accountMerge`
in that list can send the whole balance to any account. Only the list of types covers offers,
liquidity pools and Soroban.

`invokeHostFunction` calls a Soroban smart contract, and the node doesn't look at what the call
does. When the contract asks this account to authorize the call and the account is the source of the
transaction, the signature on the transaction is that authorization: no other signature is needed. A
`transfer` through an asset's contract, for example, moves the same XLM or tokens that **Maximum
Amounts** limits, without that limit. A call to a token's `approve` lets another account or a
contract spend from this one until the allowance's expiration ledger passes or someone revokes it,
also after the workflow has stopped. List `invokeHostFunction` only for a workflow that controls
which contract and function it calls.

A limit with a mistake never counts as no limit. If the node can't read one, for example because a
line isn't an operation type, nothing is signed: the run fails, or every item comes out failed when
the node's **On Error** setting is one of the **Continue** options. n8n also checks the limits when
you save the credential: if one has a mistake, it says that the credential test failed, and **More
details** shows which field and which line.

These limits protect against mistakes and against transactions that reach the workflow from outside.
They don't protect against someone who can edit the credential. In n8n's Community edition, whoever
can edit the workflow can also edit its credentials, and so these limits. On the n8n plans that have
credential sharing, a person who uses a shared credential can't see or change it. The limit that
always holds is the account itself: use a separate account with only the funds the workflow needs.

## Keep it safe

- Never share the secret key. Keep it only in this credential: don't paste it into node parameters
  or workflow notes, which are saved as part of the workflow.
- Use a separate account for each workflow or purpose, with only the funds it needs.
- Try your workflow on `testnet` first. On `public`, a signed transaction moves real funds once it
  is submitted to the network. With **Submit to Horizon** on, the node submits it right after it
  signs it.
- `public` is the node's default network. To try a workflow without real funds, choose **Testnet**
  in the **Network** parameter. Check it before you run a workflow.

More about accounts and keys:
[Create an account](https://developers.stellar.org/docs/build/guides/transactions/create-account) in
the Stellar docs.
