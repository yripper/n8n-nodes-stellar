# Programmatic nodes

Programmatic-style nodes implement an `execute` method and have full control over HTTP calls, loops,
transformations, etc.

Also read `.agents/nodes.md` for shared node anatomy and conventions.

## When to use

- You need multiple dependent API calls per node execution.
- You need complex transformations or branching logic.
- The API doesn't map cleanly into simple "one request per item" patterns.

The nodes in this package are programmatic-style: they use the Stellar SDK to build, sign and read
transactions, which a declarative node can't do.

## Canonical execute pattern

```typescript
async execute(
  this: IExecuteFunctions,
): Promise<INodeExecutionData[][]> {
  const items = this.getInputData();
  const returnData: INodeExecutionData[] = [];

  for (let i = 0; i < items.length; i++) {
    try {
      const resource = this.getNodeParameter('resource', i) as string;
      const operation = this.getNodeParameter('operation', i) as string;

      // Implement logic based on resource + operation
      // Use the Stellar SDK here (see "Guidelines" below)
      const responseData = {};

      returnData.push({
        json: responseData,
        pairedItem: { item: i },
      });
    } catch (error) {
      // Implement a check to see what error we have
      const isApiError = true;
      // Use NodeApiError for API-related errors
      // and NodeOperationError for configuration/validation errors
      const nodeError = isApiError
        ? new NodeApiError(this.getNode(), error as Error, { itemIndex: i })
        : new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });

      if (this.continueOnFail()) {
        // Keep the input's data and attach the same error to the item
        returnData.push({
          json: items[i].json,
          error: nodeError,
          pairedItem: { item: i },
        });
        continue;
      }

      throw nodeError;
    }
  }

  return [returnData];
}
```

## Guidelines

- Always get input items via `this.getInputData()`
- Pass the correct item index as the second argument to `getNodeParameter`
- Handle errors using `NodeApiError` (for API failures) and `NodeOperationError` (for
  operational/validation errors). The Stellar Signer throws `NodeOperationError` for Horizon's
  answers too, on purpose: each outcome has its own message, and `NodeApiError` replaces a message
  with a generic one when the HTTP status or the error's code is a common one
  (`setDescriptiveErrorMessage` in `n8n-workflow`)
- Support `continueOnFail()` to allow workflows to proceed when possible. Return the failed item
  with its input's `json`, its error and its `pairedItem`, as the Stellar Signer does for an item
  that fails before it is signed. n8n then shows only the error's message, as the next point says
- n8n replaces the `json` of an item that has the `error` property with the error's message. To give
  a failed item fields of its own, as the Stellar Signer does for an item that fails after it was
  signed, return it without that property, with `error` as the only key of its `json` and
  `pairedItem` as an object (`{ item: i }`)
- The Stellar Signer calls the network only when **Submit to Horizon** is on, through the SDK's
  Horizon client. When a node needs the Stellar network, use that client instead of
  `this.helpers.httpRequest`
- Programmatic-style nodes support both **light and full versioning**. See `.agents/versioning.md`
  for details.
