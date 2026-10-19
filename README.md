# n8n-nodes-stellar

This is an n8n community node. It lets you sign Stellar transactions in your n8n workflows, with a
secret key stored in an n8n credential, and optionally submit them to the network. It can also sign
a message with that key.

[Stellar](https://stellar.org/) is a public blockchain network for payments and asset issuance. Its
native currency is the lumen (XLM).

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/n8n-community-license) workflow
automation platform.

[Installation](#installation)  
[Operations](#operations)  
[Credentials](#credentials)  
[Compatibility](#compatibility)  
[Usage](#usage)  
[Resources](#resources)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in
the n8n community nodes documentation.

## Operations

The package has one node, **Stellar Signer**, with two operations:

- **Sign Transaction** (`signTransaction`), the default: signs a Stellar transaction and returns it
  signed. It can also submit the signed transaction to the network, which is off by default.
- **Sign Message** (`signMessage`): signs a text with the wallet's key. See
  [Sign a message](#sign-a-message).

A workflow saved before the **Operation** parameter existed signs transactions, once its input items
carry `networkName`, as explained below.

### Sign a transaction

Parameters:

- **Transaction XDR** (`xdr`): the transaction to sign, as base64 XDR. It can already carry other
  signers' signatures, to co-sign it (see [Usage](#usage)).
- **Network** (`network`): Public (`public`) or Testnet (`testnet`). The transaction is signed for
  this network.
- **Submit to Horizon** (`submit`): off by default. When it is on, the node submits the transaction
  it signed to the network through [Horizon](https://developers.stellar.org/docs/data/apis/horizon)
  and waits for the result. It submits once and doesn't retry. If the value comes from an
  expression, it must be `true` or `false`: n8n fails the item for any other text.
- **Horizon URL** (`horizonUrl`): shown when **Submit to Horizon** is on, and empty by default. Set
  it to submit to another Horizon server, such as your own or a provider's. It must be an `https`
  address; plain `http` is accepted only for a server on `localhost`. It can't include a user name
  or a password. It accepts an expression, so several nodes can share one address from a variable. A
  provider's address can carry a key, so the node keeps it out of the errors that n8n stores and
  sends to an error workflow: they name only the server. n8n itself stores the address in the
  workflow as you wrote it.

> **`public` is the default network.** On the public network, a signed transaction moves real funds
> once it is submitted, and with **Submit to Horizon** on the node submits it itself. To try a
> workflow without real funds, choose **Testnet** in the **Network** parameter. Check the
> **Network** parameter before you run a workflow. Workflows saved with the 0.1.1 value `mainnet`
> sign for the public network once their items carry `networkName` set to `public`, as described
> below.

Each input item must have a `networkName` field with `public` or `testnet`, the network the
transaction was built for. The Stellar Signer signs only when that value is the same as the
**Network** parameter. If the field is missing, has another value or names the other network, that
item fails and isn't signed.

The network isn't stored in the transaction XDR, so this field is how the node knows which network
the transaction was built for. If the XDR comes from a node that doesn't set it, add the field with
an **Edit Fields** node before the Stellar Signer, with **Include Other Input Fields** turned on so
the item keeps the XDR.

Each output item keeps the fields of its input item and adds:

| Field         | Description                                                         |
| ------------- | ------------------------------------------------------------------- |
| `signedXdr`   | The signed transaction, as base64 XDR.                              |
| `txHash`      | The transaction hash, in hex.                                       |
| `publicKey`   | The public key of the credential's secret key, the key that signed. |
| `network`     | The full network passphrase.                                        |
| `networkName` | `public` or `testnet`.                                              |

With **Submit to Horizon** on, the node sends the transaction to SDF's Horizon server for the chosen
network: `https://horizon-testnet.stellar.org` for `testnet` and `https://horizon.stellar.org` for
`public`. Stellar's Horizon page names SDF's `testnet` server but not the `public` one: if it stops
answering, enter your provider's address in **Horizon URL**. Each output item also has:

| Field       | Description                                             |
| ----------- | ------------------------------------------------------- |
| `submitted` | `true`: Horizon confirmed the transaction.              |
| `ledger`    | The number of the ledger that included the transaction. |

Before it signs a transaction without a memo that pays a `G` address with a payment, a path payment
or an account merge, the node asks that Horizon server whether the destination account requires a
memo ([SEP-29](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0029.md)). If
it does, or if Horizon doesn't answer or answers with an error, the item fails and nothing is signed
or sent. A destination account that doesn't exist yet requires nothing.

The node waits up to 60 seconds for each answer from Horizon and doesn't follow redirects. Error
messages count a transaction's operations from 1 and a run's items from 0, as n8n does.

### When Horizon doesn't confirm a transaction

The node submits once. When Horizon gives no verdict, the node looks the transaction up by its hash
on the same Horizon server: at once, and then every 5 seconds for up to 30 seconds. If the
transaction is there, the item comes out as submitted, with its ledger, or as `rejected` if the
network included it as failed. If Horizon doesn't confirm the transaction, the item fails, and the
error says which of these happened:

| Outcome         | What happened                                                                                                                                                                                                                                                     | What to do                                                                                                                                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rejected`      | Horizon answered with result codes, such as `tx_failed` and `op_underfunded`, or the node found the transaction in a ledger as failed.                                                                                                                            | Do what the error's description says. Some codes, explained below, let this same signed transaction in later: then don't also build a new one. For `tx_too_late`, check first that the payment wasn't already made. |
| `not_submitted` | The transaction didn't reach the network. Horizon answered with one of the errors it gives before it passes a transaction on, for example a rate limit, or the node didn't send it because an earlier item had the same one.                                      | Do what the error's description says.                                                                                                                                                                               |
| `uncertain`     | Horizon gave no final answer, and the node didn't find the transaction when it looked it up: Horizon timed out or answered with a server error, the connection failed, the answer wasn't one of Horizon's, or Horizon rejected the transaction with `tx_bad_seq`. | Send the same signed transaction again until Horizon gives a final result, and look it up by its hash. For `tx_bad_seq`, compare sequence numbers, as explained below.                                              |

An uncertain result doesn't mean the transaction failed. Unless the error says `tx_bad_seq`, which
is explained below, the network can still apply the transaction until the limit it was built with,
and the error gives it: a time, a ledger number, or both. Look it up by its hash, for example at
`<Horizon URL>/transactions/<txHash>`. The node already looked for it there, for up to 30 seconds,
and the error says whether it didn't find it or couldn't look. Not finding a transaction on a
Horizon server doesn't prove that it wasn't applied: a server can be set up to keep only some
transactions, or only recent ones. After that limit, the account's sequence number settles it: if it
is lower than the transaction's, the transaction was not applied. The error gives the transaction's
number.

Only Horizon's own errors count as `not_submitted`. An error from another server, such as a 401 from
a provider that didn't accept its key, comes out as `uncertain`, and its description says to check
**Horizon URL**.

Sending the same signed transaction again is safe, because the network applies a transaction only
once. After an uncertain result, Stellar's documentation advises sending it again until Horizon
gives a final result or the time limit passes, because the network may have dropped it from its
queue. There are two ways to do it:

- Run this node again with the same unsigned transaction. It signs it into the same signed
  transaction and submits it.
- Send `signedXdr` to Horizon yourself, for example with an **HTTP Request** node that posts it as
  the `tx` form field to `<Horizon URL>/transactions`.

Passing `signedXdr` through a Stellar Signer with the same credential fails the item before it is
signed: a second signature of the same key makes the network reject the transaction. Use one of the
two ways above.

What can pay twice is a **new** transaction for the same payment, which has another hash. Don't
build one until you know that the first wasn't applied.

The result code `tx_bad_seq` is uncertain too. Every account numbers its transactions, and Horizon
answers `tx_bad_seq` when a transaction's number isn't the next one for its account. That has two
meanings, and Horizon's answer doesn't say which. Compare the account's sequence number, at
`<Horizon URL>/accounts/<account>`, with the transaction's. If the account's number is lower, the
transaction is ahead: it can still be applied if it is sent again once the account gets to the
number before it, until its limit. If the account's number is equal or higher, the account already
used that number and this transaction can't be applied anymore. The transaction that used it may be
the same payment built twice: the account's last transactions are at
`<Horizon URL>/accounts/<account>/transactions`.

The result code `tx_too_late` is a rejection: the transaction's time limit or ledger limit passed,
or is seconds away, and the network no longer takes it. After `tx_bad_seq` or `tx_too_late`, check
that the payment wasn't already made before you build a new transaction.

The result codes `tx_insufficient_fee` and `tx_too_early` are rejections that the same signed
transaction can get past later: when the network asks for a lower fee, or when its start time or
first ledger comes. Send that same transaction again later or build a new one, but not both: if the
two are applied, the payment is made twice. For `tx_insufficient_fee` there is a third way: wrap the
same signed transaction in a fee bump transaction with a higher fee. A fee bump is built and signed
outside this node, for example with the Stellar SDK, by the account that pays the fee. It doesn't
sign the inner transaction again or change its sequence number, so, like sending it again, it can't
pay twice, and it works only while the inner transaction is within its limits.

The result codes `tx_insufficient_balance` and `tx_bad_minseq_age_or_gap` (which the Stellar SDK
writes `tx_bad_min_seq_age_or_gap`) are rejections that the same signed transaction can get past
too. The first means that the account can't pay the fee without going below its minimum balance:
send the account XLM and send the same transaction again, or wrap it in a fee bump paid by another
account. The second means that the transaction asks for a minimum time or number of ledgers after
its account's sequence number last changed: send it again once that has passed. Don't build a new
transaction for the same payment while this one can still be applied.

The result code `tx_bad_auth` is a rejection for the signatures. When an account of the transaction
needs more signature weight than the transaction carries, the same signed transaction can still be
applied: pass `signedXdr` through a Stellar Signer with the credential of another signer of the
account, and submit it. The code also comes from a key that isn't a signer of that account, or from
signatures made for another network than the Horizon server's, and then only a new transaction
helps. Do one or the other, never both. `tx_bad_auth_extra` means that the transaction carries a
signature the account doesn't use: a key signed it twice, a key that is no longer a signer signed
it, or it has more signatures than the account's threshold needs. Sign the same unsigned transaction
again with only the keys it needs: it keeps its hash, so it can't pay twice.

A `tx_failed` transaction may have been included in a ledger as failed. Then its fee was charged,
its sequence number was used, and Horizon has it under its hash.

Leave n8n's **Retry On Fail** setting off on this node while **Submit to Horizon** is on. A retry
runs the node again for all its items, also the ones whose transactions were already applied, and
sends every transaction again. That can't pay twice: Horizon answers a transaction that it already
applied, and still has in its history, with the first result.

With the node's **On Error** setting on one of the **Continue** options, an item that fails after it
was signed has an `error` object with what you need to follow it up:

| Field               | Description                                                  |
| ------------------- | ------------------------------------------------------------ |
| `error.message`     | What happened.                                               |
| `error.description` | What to do next.                                             |
| `error.outcome`     | `rejected`, `not_submitted` or `uncertain`.                  |
| `error.txHash`      | The transaction hash, to look it up.                         |
| `error.signedXdr`   | The signed transaction, to send it again as described above. |

With **Continue**, that item has only the `error` object. With **Continue (using error output)**, it
also keeps the fields of its input item. An item that fails before it is signed, for example for a
wrong `networkName`, has `error` as a text with the message, as in other n8n nodes.

If the node can't use the credential at all, nothing is signed. That happens when n8n can't hand the
credential over, when the secret key is empty, or when one of the credential's limits can't be read.
With **On Error** on **Stop Workflow**, the run fails. With one of the **Continue** options, every
item comes out failed instead of going on unsigned. Each has `error` as a text with that same
message, without the fields of its input item, and the execution finishes as successful.

### Several payments in one run

Each item is one transaction, and the node submits them one at a time, in order.

- With **On Error** on **Stop Workflow**, which is n8n's default, the first item that fails stops
  the run and n8n discards the output of the items before it, although their transactions were
  applied. The error says how many were applied and lists their hashes. Don't run the workflow again
  from the start after that: it would build new transactions and pay the applied ones a second time.
- To keep each item's result, set **On Error** to **Continue (using error output)**, or put the node
  inside a **Loop Over Items** node so it handles one item per run.
- An item with the same transaction as an earlier item of the run fails and isn't sent: a
  transaction is applied only once, so it pays once. Build a separate transaction for each payment.

### Sign a message

With **Operation** on **Sign Message**, the node signs the text of the **Message** parameter
(`message`) with the wallet's key, following
[SEP-53](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0053.md). It signs
the text exactly as it arrives, without trimming it. A text that is empty or has only spaces and
line breaks fails the item. The node doesn't need a `networkName` field in the item, and it sends
nothing to the network.

Each output item keeps the fields of its input item and adds:

| Field       | Description                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------- |
| `message`   | The text that was signed.                                                                                           |
| `signature` | The signature, 64 bytes as base64.                                                                                  |
| `publicKey` | The public key of the credential's secret key, the key that signed the text. It identifies the key, not an account. |

If the input item already has a field with one of these names, the node's value replaces it.

Anyone can check the signature with the Stellar SDK:
`Keypair.fromPublicKey(publicKey).verifyMessage(message, Buffer.from(signature, 'base64'))`.

Sign Message fails unless **Allow Message Signing** is on in the credential, and it is off by
default. A signed message proves that the wallet's key signed that text, and other services accept
such a proof, for example as a login. The node signs whatever text it receives, and n8n has no
screen that shows the text before it is signed. Don't sign a text that comes from outside the
workflow, such as a webhook or a form, without checking what it says first.

## Credentials

The node uses the **Stellar Wallet API** credential (`stellarWalletApi`). Its one required field is
**Secret Key** (`secretKey`). See [CREDENTIALS.md](CREDENTIALS.md) for what the secret key is, how
to get one on Testnet and how to keep it safe.

The secret key lives only in the credential. The node never returns it in its output or in its error
messages.

The credential can also limit what the node signs:

- **Allowed Operations** (`allowedOperations`): the operation types the node may sign, one per line,
  such as `payment`. A transaction with any other operation fails the item before it is signed. With
  `invokeHostFunction` in the list, the node signs Soroban contract calls without looking at what
  they do, and its signature can authorize the call, such as a token allowance that outlasts the
  run.
- **Maximum Amounts** (`maxAmounts`): the most that one operation may send of each asset, one limit
  per line, as `XLM=100` or `CODE:ISSUER=100`, where `ISSUER` is the address of the account that
  issues the asset. `XLM` can also be written `native`. While it has any line, an operation that
  sends an asset without a line fails.
- **Allowed Assets** (`allowedAssets`): the assets the node may pay in, one per line, written the
  same way. A path payment needs the asset it sends and the asset it delivers.
- **Allowed Destinations** (`allowedDestinations`): the addresses the node may pay, one per line. A
  `G` address also allows its muxed (`M`) addresses.
- **Maximum Fee** (`maxFee`): the highest fee that a transaction may carry, in stroops: 1 XLM is
  10,000,000 stroops. `0`, the default, means no limit.
- **Allow Message Signing** (`allowMessageSigning`): off by default. **Sign Message** fails unless
  it is on.

While **Maximum Amounts**, **Allowed Assets** or **Allowed Destinations** is set, the node signs
only the four payment operations (`payment`, `pathPaymentStrictSend`, `pathPaymentStrictReceive` and
`createAccount`), unless **Allowed Operations** lists other types.

The limits on transactions are optional: an empty limit, or a **Maximum Fee** of 0, means no limit.
They don't apply to messages. A limit that the node can't read stops every item before anything is
signed: the run fails, or, with **On Error** on one of the **Continue** options, every item comes
out failed. In n8n's Community edition, whoever can edit the workflow can also edit the credential,
so these limits guard against mistakes, not against that person. The limit that always holds is the
account: use one with only the funds the workflow needs.
[CREDENTIALS.md](CREDENTIALS.md#limit-what-the-node-signs) has the details.

## Compatibility

- Node.js 24 or later.
- The node depends on `@stellar/stellar-sdk` 17.1.0, which npm installs with the package.

## Usage

The Stellar Signer sits between a node that builds a transaction and a node that uses the signed
result:

1. A previous node produces the unsigned transaction XDR, in an item that has a `networkName` field
   with the network the transaction was built for.
2. In the Stellar Signer, set **Transaction XDR** with an expression that reads that XDR from the
   previous node's output, and choose the same network in **Network**.
3. The next node reads the signed transaction with `{{ $json.signedXdr }}`. To send it to the
   network from this node instead, turn on **Submit to Horizon** and read `{{ $json.ledger }}`.

To co-sign a transaction that needs several signatures, because its account needs them or because an
operation has another source account, pass `signedXdr` through another Stellar Signer with the
credential of the next signer. Each key signs once: if the XDR already has a valid signature of the
credential's key, the item fails before it is signed, because the network rejects a repeated
signature with `tx_bad_auth_extra`. The network also rejects a signature that the account doesn't
need: once the signatures reach the account's threshold, one more, even a valid one, gets
`tx_bad_auth_extra`.

## Resources

- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
- [Stellar transactions](https://developers.stellar.org/docs/learn/fundamentals/transactions)
