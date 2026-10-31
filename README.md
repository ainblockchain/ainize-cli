# Ainize CLI

Run a node, connect it to your wallet, and work with knowledge through Ainize APIs. Requires Node.js 24+.

## Install

```bash
npm install -g ainize
```

For the latest node-linking flow before its npm release:

```bash
git clone https://github.com/ainblockchain/ainize-cli.git
cd ainize-cli
npm ci
npm install -g .
```

## Connect a node

Sign in to https://ainize.ai using any MetaMask or compatible wallet, then run:

```bash
ainize init --home ~/.ainize-a --name node-a --port 3402
ainize login --home ~/.ainize-a
ainize start --home ~/.ainize-a -d
```

`login` opens the website approval page. On SSH, open the printed link yourself; `--no-open` only prints it. Approve with the wallet signed in on the website. The node then appears under **My nodes**.

`start` refuses until this node key has an unexpired website link (`node-link.json`) — run `login` first, and again when the link expires. Repeat with another home and port to connect more nodes to the same wallet. A running CLI node reports its status every minute. Disconnecting from the website removes the link, but does not stop the node process.

Node links allow status reporting only. They do not authorize spending or account operations. The node's private key stays on its machine.

## Operate your local node

```bash
ainize login --node-key --home ~/.ainize-a
ainize status --home ~/.ainize-a
ainize wallet --home ~/.ainize-a
ainize stop --home ~/.ainize-a
```

`--node-key` explicitly signs in with the local node key. `--device` explicitly requests CLI account delegation through a wallet approval. `--node <URL>` selects another API; `--hub <URL>` selects another website for node linking.

The website link is stored separately in `node-link.json`; it does not replace your local CLI target or session. Keep the node home private and backed up.

## Knowledge and models

```bash
ainize patch ls --node https://ainize.ai
ainize teach status https://ainize.ai
ainize --help
ainize teach --help
```

Training and loading knowledge require a configured model and patch hook. Installing the CLI does not install a model or website. See [the current guides](https://ainize.ai/docs).

## Development

```bash
npm ci
npm run build
npm test
```

### Hosted agent repositories

Use the same Git history as the ainize web console:

```sh
ainize agent clone desk --node https://ainize.ai
ainize agent pulls desk --state open --node https://ainize.ai
ainize agent pulls desk --head proposal --title "Improve answers" --node https://ainize.ai
ainize agent pulls desk --number 1 --merge --node https://ainize.ai
ainize agent mirror desk --repo https://github.com/owner/repo --folder agents/desk --node https://ainize.ai
ainize agent mirror desk --sync --node https://ainize.ai
```

`AINIZE_TOKEN` or the saved CLI token authenticates these calls. Clone supplies it only for that Git process;
it is never written into the remote URL or repository configuration. Later Git pushes use your credential
helper with an ainize API key as the password. A push to `main` deploys the agent; a proposal branch can be
reviewed before merging. Mirror detach (`--detach`) stops following the upstream and retains the current runtime.

## Reviewed manual AIN transfers (pending release)

These commands require the node's reviewed-transfer API. They are not yet in the published 0.4.1 package. An older node is refused; the CLI never falls back to the old immediate-send route. A node website link alone cannot authorize spending: use an owner wallet session for the selected node.

```bash
# Prepare only: saves an exact amount and recipient, prints a request ID, does not broadcast.
ainize wallet prepare 0xRECIPIENT 0.125 --memo "Invoice 42" --node https://your-node.example
# Replace REQUEST_ID with the full ID returned above. Review before authorizing.
ainize wallet submit REQUEST_ID --node https://your-node.example
# Read-only recovery after an interrupted response; never resubmits.
ainize wallet status REQUEST_ID --node https://your-node.example
ainize wallet history --limit 20 --node https://your-node.example
# Cancels only a prepared request. It cannot undo a submitted transaction.
ainize wallet cancel REQUEST_ID --node https://your-node.example
```

Replace `0xRECIPIENT` with a complete AIN address. This spends the **node wallet**, not the operator's personal wallet. The review shows the full recipient, amount, transaction hash, node and chain/RPC. `wallet send ADDRESS AMOUNT` combines prepare and explicit review/submit. `--yes` on send/submit authorizes that transfer without a prompt; use it only when the script already has authorization. Declining leaves the preparation saved for inspection or cancellation.

Amounts are decimal strings with up to six places; scientific notation, hex, zero and values that would round are refused. `--memo` is a note of up to 200 characters stored on the node, never in the on-chain transaction. An optional `--request-id` on prepare/send is 32 lowercase hexadecimal characters; retain it for recovery and never reuse it for different content. Only one unresolved manual transfer is allowed per node wallet journal.

`submitted` means the outcome remains unconfirmed, not success. Do not create a replacement send after a timeout. Inspect the **same ID on the same node** using the printed recovery command. Repeating submit for an already submitted/terminal request only reads its receipt. Missing chain lookup is not evidence that nothing was sent. A pending request can also reflect interruption before broadcast; it is not automatically expired or resent.

History lists saved states, newest first. Use `next_cursor` unchanged with `wallet history --cursor VALUE --limit N`; inspect an exact ID to refresh its chain outcome. `status` without an ID reads the latest request. `--json` emits one structured result and takes precedence over `--quiet`; quiet mode prints full request IDs.

For submit/send, exit 0 means finalized successful execution; 4 means pending or unconfirmed; 1 includes terminal rejection/cancellation. Prepare exits 0 only for a saved preparation; cancel exits 0 only for cancelled preparation. Successful status/history reads exit 0 regardless of the transaction state: scripts must inspect `operation.state`/`items`. Finalized failure may still incur fees. Full Node.js 24+ integration, node/CLI compatibility, build and package release must be validated on ainize before rollout.

## Reviewed chain setup (pending release)

Setup now uses the selected **running node's** reviewed API and owner session. It no longer funds a local account automatically, stakes 100 AIN by default, or switches to an offline signer when the node cannot be reached. Start/link the node and obtain its owner session before setup; `--node URL` works without a local node configuration.

```bash
ainize chain setup --status --node https://your-node.example
ainize chain setup --node https://your-node.example
# Read exactly the saved request, including after a lost response:
ainize chain setup --status --request-id REQUEST_ID --node https://your-node.example
# Only after inspecting a terminal unconfirmed attempt and deciding to try again:
ainize chain setup --retry-of PREVIOUS_REQUEST_ID --node https://your-node.example
```

Interactive setup shows the active node wallet, provider, chain, app and prior request, and requires confirmation; `--yes` explicitly authorizes those changes in advance. Chain fees can apply. Funding a local test identity is a separate `chain fund ADDRESS AMOUNT` action; `setup --fund` is refused before any request. Setup does not perform staking. Current rule verification, app creation reported by the SDK, administrator, transaction and saved operation state are distinct facts. Verified rules do not prove transaction finality or app/runtime readiness.

The server atomically checks `expected_request` (the exact latest request reviewed, or null) before admitting a new request. An explicit retry must name the current terminal unconfirmed attempt and gets a new ID. A running request is never automatically retried or expired. Same-ID replay is read-only. Lost write replies trigger only an exact-ID read, not another POST or an unrelated latest request. Unknown IDs and changed chain configurations are errors, not a fallback to another receipt.

`--status` exits 0 for a valid read regardless of the saved outcome. Applying setup exits 0 only when current rules are verified and the saved request is verified (or no request is needed); pending/unconfirmed outcomes exit 4. JSON and quiet output follow the transfer conventions above; interactive review stays on stderr. These commands require `exact_request_status` and `reviewed_selection` capabilities. Legacy unreviewed setup is disabled on the new server. Published 0.4.1 and older web clients require coordinated migration; full ainize/Node 24+ validation and release remain pending.
