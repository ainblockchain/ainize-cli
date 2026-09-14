# `ainize` — Ainize knowledge-marketplace CLI

**Ainize** = *AI + -ize*, "make it usable by AI". The first Ainize (2019–2020) turned any GitHub repo into a
running AI service — you *ainized your repo* with the `ainize` CLI. This Ainize turns **knowledge** into
something an AI model actually knows — you *ainize your knowledge*: pick verified knowledge, test it live
against the model, and load it into a running model in seconds. Creators get paid per sale, and the first
three letters — **AIN** — are the AI Network, the chain that records payments and permissions.

So the CLI is called `ainize` again, for the same reason the 2019 one was: it is the verb. `ngram` (the
historical name of this binary, after the n-gram memory the patches live in) is installed as an alias to the
same program; help text follows whichever name you typed.

One binary runs a **P2P knowledge-marketplace node** and talks to it: publish knowledge patches (learned
memory items of an LLM — technically rows of its n-gram conditional-memory table), have independent nodes
verify them against a benchmark, **test them live** (`ainize chat`), trade them with **automatic payment**
(HTTP 402 / x402 — wallet AIN or node credit, no sign-up), keep the shared truth on a **local record DAG** or
the **AI Network blockchain** (via ain-js), and mirror files & change history into an **aindrive** drive.

```
npm install            # in the repo root (workspaces)
npm run build          # builds core → node → cli → agent → web
alias ainize="node $PWD/packages/cli/dist/bin.js"     # or: npm link -w packages/cli  → `ainize` and `ngram`
```

Requirements: Node ≥ 24 (uses `node:sqlite`), python3 + numpy for synthetic demo patches, docker for the
optional local AIN chain, the reference runtime repo (`/mnt/newdata/qwen3.8`, vLLM + patch hook) for real
apply / verify / chat.

## Quickstart (single node, local ledger)

```
ainize init --name alice --port 3402         # creates ~/.ainize/config.json + an AIN keypair (node identity)
ainize seed                                  # real Qwen3.8 patches (pixelplus-087600, krx-all-2761…) if the runtime repo is present
ainize start -d                              # background node; web console at http://localhost:3402
ainize login                                 # signs with this node's own key (no password), stores a token in ~/.ainize/cli.json
ainize status
ainize patch ls
ainize chat --list                           # what can be tested live on this node
ainize chat pixelplus-087600 "종목코드 픽셀플러스"
```

`AINIZE_HOME` selects the node directory (default `~/.ainize`); `--node <url>` targets another node's API;
`--json` prints machine-readable output for every command.

## ENSv2 / Continuity: resolve a name to knowledge

`ainize patch <name> --resolve-only` reads the ENS text records `ainize.node` (seller HTTP(S)
endpoint) and `ainize.patch` (published knowledge id). It prints their source and stops before
peering, login, purchase or loading. No initialized Ainize node or wallet is needed for resolution.
Both records must exist; missing records and RPC failures are errors, never demo values.

The default on-chain path uses **viem 2.56.5 or newer**, `normalize` and `getEnsText` through
the chain's canonical Universal Resolver, including viem's CCIP-Read gateway/callback handling.
It does not call an ENSv2 registry's `resolver(namehash)`. The
[official app tutorial](https://docs.ens.domains/ensv2/tutorial-app-developers/) describes this API;
the [readiness guide](https://docs.ens.domains/web/ensv2-readiness/) requires viem ≥2.35.0.
The proxy address comes from viem's chain definition, not an application deployment constant.

Build and test this checkout (Node 24 is required; these commands also work from a Node 22 host):

```sh
cd /mnt/newdata/gov/hackathon/ainize-cli
npx --yes --package=node@24 -c 'npm ci'
npx --yes --package=node@24 -c 'npm run build'
npx --yes --package=node@24 -c 'node --test --import tsx test/ens.test.ts test/ens-rpc.test.ts'
python3 -m pip install --target node_modules/.test-python 'numpy==2.2.6'
PYTHONPATH="$PWD/node_modules/.test-python" npx --yes --package=node@24 -c 'npm test'
```

The full suite's existing node fixtures require Python 3 with NumPy; the ENS-only tests do not.
The command above installs NumPy inside this ignored `node_modules` directory.

Resolve **your own registered Sepolia name**, after its publisher has set both records to real values:

```sh
read -r -p 'Registered Sepolia ENS name: ' CONTINUITY_ENS_NAME
export CONTINUITY_ENS_NAME
export ENS_RPC_URL='https://ethereum-sepolia-rpc.publicnode.com'
unset ENS_REGISTRY
npx --yes --package=node@24 -c 'node dist/bin.js patch "$CONTINUITY_ENS_NAME" --ens-chain sepolia --resolve-only --json'
```

Also remove `ens.registry` from the selected home's config if previously configured: any supplied
registry selects legacy mode. Check that output says `source: "on-chain"` and `Universal Resolver ...
on sepolia (11155111)`. A local names entry takes priority and is explicitly reported as `names-file`
or `config`; remove that entry to test the live chain. The RPC's `eth_chainId` must match the selected
network before any record lookup. RPC URLs and provider error bodies are omitted from resolution output.

Options and configuration precedence:

| Setting | Flag | Environment | Node config | Default |
| --- | --- | --- | --- | --- |
| RPC | `--rpc` | `ENS_RPC_URL` | `ens.rpc` | Required for network lookup |
| Network | `--ens-chain` | `ENS_CHAIN` | `ens.chain` | `sepolia`; also supports `mainnet` |
| Legacy registry | `--registry` | `ENS_REGISTRY` | `ens.registry` | Unset: Universal Resolver |

Flags override environment, which overrides config. ENS names are normalized with ENSIP-15;
Unicode names and DNS names imported into ENS are accepted as well as `.eth` names.

For **explicit legacy ENSv1 mode**, supply the actual ENSv1 registry address and matching RPC/network:

```sh
read -r -p 'Legacy ENSv1 registry address: ' ENS_REGISTRY
read -r -p 'Matching RPC URL: ' ENS_RPC_URL
read -r -p 'Network (sepolia or mainnet): ' ENS_CHAIN
export ENS_REGISTRY ENS_RPC_URL ENS_CHAIN
npx --yes --package=node@24 -c 'node dist/bin.js patch "$CONTINUITY_ENS_NAME" --resolve-only --json'
```

Legacy mode calls `registry.resolver(namehash)` followed by the discovered resolver's `text` methods;
it is not the ENSv2 path. Names-file mode remains available with a JSON object mapping normalized names
to `{ "node": "<real seller URL>", "patch": "<real published id>" }` (or an enclosing `names` object):

```sh
read -r -p 'Path to your names JSON file: ' CONTINUITY_NAMES_FILE
export CONTINUITY_NAMES_FILE
npx --yes --package=node@24 -c 'node dist/bin.js patch "$CONTINUITY_ENS_NAME" --names "$CONTINUITY_NAMES_FILE" --resolve-only --json'
```

Search order is `--names`, `<selected home>/names.json`, `~/.ainize/names.json`, then `config.json`
`ens.names`, then on-chain. The local examples describe a file format, not registered names.

After verifying a real name, use it against your configured buyer node with a budget:

```sh
unset ENS_REGISTRY
export ENS_CHAIN=sepolia
export ENS_RPC_URL='https://ethereum-sepolia-rpc.publicnode.com'
npx --yes --package=node@24 -c 'node dist/bin.js patch "$CONTINUITY_ENS_NAME" --max-price 30'
```

The normal flow then peers with the resolved seller and buys/loads on **your** node. This requires an
initialized, running buyer node, reachable seller, published knowledge and the existing payment/runtime
prerequisites. Registration and record writes are publisher operations; this CLI integration is read-only.
Use the official tutorial's resolver discovery and record-writing instructions to set both text records.

Verification evidence (2026-09-13): the publicnode Sepolia RPC reported chain id `11155111`, block
`11696406`, and 2,491 bytes of code at viem's canonical Universal Resolver proxy
`0xeeeeeeee14d718c2b47d9923deab1335e144eeee`. A live `getEnsText` call for
`ur.integration-tests.eth` / `ainize.node` returned `null`; that name has not been demonstrated to carry
Continuity's records. The compiled CLI also returned the expected missing-record error (exit 1).
Additional Sepolia probes returned `0x1111111111111111111111111111111111111111` for the address of
`ur.integration-tests.eth`, and a revert for `test.offchaindemo.eth`; they did not reproduce the readiness
guide's expected address vectors and do not establish live CCIP-Read success on Sepolia.
The Node 24 build and all 75 tests passed with NumPy available. Automated RPC fixtures exercise both text records, normalized DNS wire encoding,
CCIP-Read gateway and on-chain callback, legacy mode, missing records, chain mismatch, and CLI argument
forwarding. These fixtures are tests, not deployment evidence. **A publisher-owned ENSv2 Sepolia name
with both real records, and the full live resolve → purchase → load flow, remain unverified.** No name
registration, record-writing transaction or Continuity contract deployment is claimed here.

## Hugging Face dataset → teach → marketplace

`ainize dataset <huggingface-url>` imports an **existing** Hugging Face dataset into the selected Ainize
node. It does not create a Hub repository, publish data to Hugging Face, train automatically, or make a
marketplace listing. The returned `dataset_id` feeds the normal teaching workflow:

```sh
ainize init --name my-node --peer https://ainize.ai
ainize start -d && ainize login
ainize dataset https://huggingface.co/datasets/owner/questions --config default --split train --json
ainize teach <dataset-id> --key-file /private/teaching-key --wait
ainize teach publish <job-id> --name "My knowledge" --consent-permanent --consent-rights
ainize use <published-knowledge-id>
ainize chat <published-knowledge-id> "Question"
```

Replace placeholders with real values. Use `ainize teach ./questions.csv --wait` to upload and train a
local file directly, or `ainize teach dataset upload questions.csv` to upload without training.
`ainize teach train <target>` remains a compatibility alias. Files named like subcommands must use an
explicit path, for example `./status`. Configure a compatible real serving/training runtime before training. Publication needs
your own rights/permanence consent, successful server-side checks and any operator review; it is not
automatic consent to republish third-party data. A reachable peer is not a listing: peers must use the same
ledger, reach the seller endpoint, and obtain independent verification quorum. Do not re-initialize a live
AIN node as `local` merely to match a peer; use a separate home or coordinate the deployment.

Supported source URLs are dataset repositories, `/viewer/<config>/<split>`, and
`/resolve/<revision>/<file>`. `dataset import <url>` is an explicit alias. Use `--columns` when the source
does not already have Ainize question/answer fields:

```sh
ainize dataset https://huggingface.co/datasets/lhoestq/demo1 --split train \
  --columns '{"prompt":"review","answer":"star"}'
ainize dataset https://huggingface.co/datasets/owner/questions --revision <commit-sha> \
  --file data/train.jsonl
```

Repository imports use the Dataset Viewer, validate its revision on every page, reject truncated/partial
responses, and import the whole selected split up to 10,000 rows. Larger splits require an explicit
`--limit` (optionally `--offset`); provenance reports that selection rather than claiming the whole dataset.
Multiple configurations require `--config`. If the viewer is not ready, use `--file` for an immutable
JSONL/JSON/CSV/TSV/TXT file; the file mode cannot be combined with split/config/row selection. Imports are
limited to 32 MiB. This adapter supports data convertible to Ainize teaching rows, not arbitrary image/audio
training. Normal node validation, row limits, PII checks and canonicalization still apply; inspect `report`
for rejected or modified rows.

`--train --wait` optionally queues and observes the same lesson, without publishing it. Restricted datasets
can use `--hf-token-file` pointing to a private (0600) file; gating terms must already be accepted. The token
is not forwarded to the Ainize node or recorded in provenance. Raw input, mapped upload bytes and source
metadata are saved privately under `AINIZE_HOME/hf-imports/`. Output distinguishes source revision and
hashes from the node's canonical dataset hash. Existing `ainize dataset get <knowledge-id>` is unchanged.

## `ainize chat` — test knowledge live before you buy it

ChatMode asks the serving model the same question **before** and **after** a patch is loaded, and marks the
answer against the patch's benchmark (**정답 ✓ / 오답 ✗**). Loading is live — no restart — and the node
restores the model afterwards.

```
ainize chat --list                                   # testable patches + runtime state (model, live-apply hook, lock)
ainize chat pixelplus-087600 "종목코드 픽셀플러스"      # one shot: base answer, patched answer, latency, load time, 정답 marker
ainize chat pixelplus-087600                         # interactive session — transcript is kept, /quit to exit
ainize chat krx-all-2761 --mode patched --thinking --max-tokens 400
```

| option | meaning |
|---|---|
| `--mode base\|patched\|compare` | model only / with the patch loaded / both (default `compare`) |
| `--thinking` | let the model think first; its reasoning is shown dimmed |
| `--max-tokens N` | answer length limit (1–1024, default 200) |
| `--system "…"` | system prompt prepended to the conversation |
| `--json` | raw `POST /api/chat` response (one JSON object per turn in a session) |

In a session `/mode base|patched|compare` switches mode, `/reset` clears the transcript, `/quit` exits
(Ctrl+D works too). The conversation continues from the *patched* answer. Public visitors get a free hourly
trial quota per node (shown after each answer); whoever owns the node (after `ainize login`) is unlimited. A patch
is testable on a node that holds its body — the seller node, or yours after `ainize patch buy <id>`.

## Signing in from a machine that is not the node's

On the node's own machine `ainize login` signs with the key in `config.json` — it already owns everything that
node published, and nothing needs to be asked. Anywhere else there is no such key, and copying your wallet key
onto a laptop is the thing wallets exist to prevent. So the CLI keeps a key of its own and asks a person to
vouch for it, once:

```
$ ainize login --node https://ainize.ai

  Open this to authorise this machine:

    https://ainize.ai/authorize?code=7Qd…

  key  0x9f2c…            ← compare this against the page before approving
  name "kmh@laptop"

  Waiting…  (Ctrl-C to stop)
```

Open the link in a browser, connect your wallet, read what is being asked, and approve it with one signature.
The CLI then holds a session that is **you** — your knowledge, your payouts, your ownership — made by a key that
never left this machine. The node writes the binding down, so the next `ainize login` here needs no browser at
all.

| | |
|---|---|
| `ainize whoami` | which address you act as, and which key is doing the acting |
| `ainize bindings` | every machine that acts as you, and which one is reading this |
| `ainize bindings --end 0x…` | shut out a laptop you no longer have — its sessions end with it |
| `ainize logout` | end this session, keep the key |
| `ainize logout --forget` | and destroy this machine's key too |

The key lives in `~/.ainize/cli-key.json`, mode 0600. It is worth what an ssh key is worth: whoever can read it
can act as you on any node that has a binding for it, until you end it. Only its *address* is ever sent.

Signing in is open to anyone — it gives you a **name**, not a permission. Running the node is separate:
`ainize operators` lists who owns it, and an owner can add another from Account settings in the browser.

## Multi-node demo (three terminals or `-d`)

Verification needs a quorum (default 2) of *independent* verifiers, so listing a patch needs peers:

```
# node A — seller + verifier
ainize init --name alice --port 3402 && ainize seed && ainize start -d && ainize login

# node B — verifier
AINIZE_HOME=~/.ainize-b ainize init --name bob --port 3403 --roles verifier --peer http://localhost:3402
AINIZE_HOME=~/.ainize-b ainize start -d

# node C — verifier + serving
AINIZE_HOME=~/.ainize-c ainize init --name carol --port 3404 --roles verifier,serving --peer http://localhost:3402
AINIZE_HOME=~/.ainize-c ainize start -d

ainize nodes                 # gossip found bob & carol
ainize patch ls              # ANNOUNCED → VERIFYING → VERIFIED as attestations arrive
ainize ledger graph          # lineage tree (original authors share in derived-patch revenue)
AINIZE_HOME=~/.ainize-c ainize login && AINIZE_HOME=~/.ainize-c ainize patch buy law-kr-2026     # 402 → pay → download
AINIZE_HOME=~/.ainize-c ainize branch subscribe law/KR && ainize route jurisdiction=KR           # gateway routing
```

## Commands

| group | commands |
|---|---|
| setup | `init`, `config show\|set <key> <value>`, `keys show [--reveal]` |
| lifecycle | `start [-d] [--peer …] [--port]`, `stop`, `status`, `logs [-f] [--patch id] [--kind k]`, `seed [--no-real] [--no-synthetic]`, `nodes` |
| auth | `login [--device] [--label …] [--as <key>]`, `whoami`, `bindings [--end 0x…]`, `operators [--add\|--remove 0x…]`, `logout [--forget]` |
| peers | `peers ls\|add <url>\|rm <url>` |
| patches | `patch ls\|get\|publish\|announce\|verify\|challenge\|buy [--apply]\|apply\|remove\|conflicts\|records\|rm` |
| chat | `chat --list`, `chat <id> [prompt]` (`--mode`, `--thinking`, `--max-tokens`, `--system`) — live test before/after |
| ledger | `ledger ls [--kind]\|verify\|graph\|export <file>` |
| branches | `branch ls\|create <name> --context k=v --patch id\|add <name> <id>\|subscribe\|unsubscribe`, `route k=v…` |
| wallet | `wallet` — balance, sales, royalties |
| drive | `drive status\|up\|stop\|sync\|login` — aindrive files & change history |
| chain | `chain up\|down\|status\|fund <addr> [amount]\|setup` — local AIN blockchain |

### Publishing a patch

```
cat > bench.json <<'EOF'
{ "schema": "krx-ticker-codes", "queries": 8, "format": ["template"], "collateral_bound_nat": 0.1,
  "samples": [ { "prompt": "종목코드 픽셀플러스 ", "expect": "087600" } ] }
EOF
ainize patch publish /mnt/newdata/qwen3.8/results/train-fact/픽셀플러스.npz \
  --name "픽셀플러스 087600" --model Qwen3.8-Flash-Next --benchmark bench.json --price 0.1 --topic finance/krx --announce
ainize patch records pixelplus-087600      # anchor → attest… on the ledger
ainize patch conflicts pixelplus-087600    # overlap / conflict check with other patches (address-set intersection)
ainize chat pixelplus-087600 "종목코드 픽셀플러스"   # see it work
```

The file must be readable by the node (same machine): the CLI passes its absolute path, the node computes
the sha256, memory-item count and address set. Inline benchmark `samples` are what verifiers execute on the
serving model (apply → free-generation scoring → restore, restart-aware) and what `chat` uses for the 정답
marker; without a runtime a verifier only attests integrity (`verified_on: hash-only`).

## AIN blockchain ledger mode

```
ainize chain up                                 # docker: ainblockchain/ain-blockchain 1-node chain on :8081 (or deploy/docker-compose.ain.yml)
ainize init --ledger ain --ain-provider http://localhost:8081 --force
ainize chain setup                              # funds the node identity (local chain) and registers /apps/knowledge + market rules
ainize start -d && ainize login && ainize seed
ainize chain status
ainize chain fund <buyer-address> 500           # give an agent/second node AIN to pay with
```

In this mode anchors are `ain.knowledge.explore()` entries (lineage = graph edges), attestations /
settlements / branches / nodes live under `/apps/knowledge/market/*` behind write rules evaluated by the
chain, and payments are AIN transfers whose tx hash is the payment proof. Prices are in **AIN** (the AI
Network token; this demo runs a local dev chain) or, on the local ledger, in node **CREDIT** (development
credit granted by the node — see `/api/info.initial_credit`).

## aindrive — files & change history

Every node mirrors its market state as plain files under `<dataDir>/drive/` (`patches/<id>/manifest.json`,
`benchmark.json`, `CHANGELOG.md`, the `.npz` body, `branches/*.json`, `ledger/records.jsonl`). Serve that folder
with aindrive so humans and agents can browse/share/sell it and every edit is versioned in aindrive's
Willow store:

```
ainize drive login         # one-time browser pairing (prints the sign-in link); Ctrl+C after "serving"
ainize drive up            # background aindrive agent for the folder
ainize drive status --files
ainize drive sync          # rewrite the mirror from the current ledger state
```

Editing `patches/<id>/benchmark.json` in the aindrive UI (or through `aindrive mcp`) while a patch is a
DRAFT updates the draft on the node. Set `AINDRIVE_SERVER` to use a self-hosted aindrive web server.

## Agent demo

```
npm run build -w packages/agent
node packages/agent/dist/bin.js run --market http://localhost:3402          # 픽셀플러스 087600 end-to-end
node packages/agent/dist/bin.js keys                                        # its own identity; fund it for AIN mode
node packages/agent/dist/bin.js balance                                     # credit left (initial grant read from /api/info)
```

See `packages/agent/README.md`.

## Exit codes

`0` ok · `1` command error · `2` node unreachable · `3` operator login required.
