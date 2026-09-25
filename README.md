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

Repeat with another home and port to connect more nodes to the same wallet. A running CLI node reports its status every minute. Disconnecting from the website removes the link, but does not stop the node process.

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
