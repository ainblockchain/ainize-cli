# `ngram` — knowledge-patch marketplace node CLI

The successor of `ainize-cli`: one binary to run a **P2P knowledge-patch marketplace node** and talk to it —
publish patches (rows of an LLM's n-gram conditional-memory table), have peers verify them against a
benchmark, trade them over **HTTP 402 / x402**, keep the shared truth on a **local record DAG** or the
**AI Network blockchain** (via ain-js), and mirror files & change history into an **aindrive** drive.

```
npm install            # in the repo root (workspaces)
npm run build          # builds core → node → cli → agent → web
alias ngram="node $PWD/packages/cli/dist/bin.js"      # or: npm link -w packages/cli
```

Requirements: Node ≥ 24 (uses `node:sqlite`), python3 + numpy for synthetic demo patches, docker for the
optional local AIN chain, the reference runtime repo (`/mnt/newdata/qwen3.8`, vLLM + patch hook) for real
apply/verify.

## Quickstart (single node, local ledger)

```
ngram init --name alice --port 3402          # creates ~/.ngram/config.json + an AIN keypair (node identity)
ngram seed                                   # prototype ledger + real Qwen3.8 patches (if present) + synthetic branch demo
ngram start -d                               # background node; web console at http://localhost:3402
ngram login                                  # sets the operator password on first use, stores a token in ~/.ngram/cli.json
ngram status
ngram patch ls
```

`NGRAM_HOME` selects the node directory (default `~/.ngram`); `--node <url>` targets another node's API;
`--json` prints machine-readable output for every command.

## Multi-node demo (three terminals or `-d`)

Verification needs a quorum (default 2) of *independent* verifiers, so listing a patch needs peers:

```
# node A — seller + verifier
ngram init --name alice --port 3402 && ngram seed && ngram start -d && ngram login

# node B — verifier
NGRAM_HOME=~/.ngram-b ngram init --name bob --port 3403 --roles verifier --peer http://localhost:3402
NGRAM_HOME=~/.ngram-b ngram start -d

# node C — verifier + serving
NGRAM_HOME=~/.ngram-c ngram init --name carol --port 3404 --roles verifier,serving --peer http://localhost:3402
NGRAM_HOME=~/.ngram-c ngram start -d

ngram nodes                 # gossip found bob & carol
ngram patch ls              # ANNOUNCED → VERIFYING → LISTED as attestations arrive
ngram ledger graph          # lineage tree (royalties flow to ancestors)
NGRAM_HOME=~/.ngram-c ngram login && NGRAM_HOME=~/.ngram-c ngram patch buy law-kr-2026     # 402 → pay → download
NGRAM_HOME=~/.ngram-c ngram branch subscribe law/KR && ngram route jurisdiction=KR           # gateway routing
```

## Commands

| group | commands |
|---|---|
| setup | `init`, `config show\|set <key> <value>`, `keys show [--reveal]` |
| lifecycle | `start [-d] [--peer …] [--port]`, `stop`, `status`, `logs [-f] [--patch id] [--kind k]`, `seed [--no-real] [--no-synthetic]`, `nodes` |
| auth | `login [--password]` (or `NGRAM_PASSWORD`), `logout` |
| peers | `peers ls\|add <url>\|rm <url>` |
| patches | `patch ls\|get\|publish\|announce\|verify\|challenge\|buy [--apply]\|apply\|remove\|conflicts\|records\|rm` |
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
ngram patch publish /mnt/newdata/qwen3.8/results/train-fact/픽셀플러스.npz \
  --name "픽셀플러스 087600" --model Qwen3.8-Flash-Next --benchmark bench.json --price 0.1 --topic finance/krx --announce
ngram patch records pixelplus-087600      # anchor → attest… on the ledger
ngram patch conflicts pixelplus-087600    # address-set overlap (A₁ ∩ A₂) with other patches
```

The file must be readable by the node (same machine): the CLI passes its absolute path, the node computes
the sha256, row count and address set. Inline benchmark `samples` are what verifiers execute on the serving
model (apply → free-generation scoring → restore, restart-aware); without a runtime a verifier only
attests integrity (`verified_on: hash-only`).

## AIN blockchain ledger mode

```
ngram chain up                                  # docker: ainblockchain/ain-blockchain 1-node chain on :8081 (or deploy/docker-compose.ain.yml)
ngram init --ledger ain --ain-provider http://localhost:8081 --force
ngram chain setup                               # funds the node identity (local chain) and registers /apps/knowledge + market rules
ngram start -d && ngram login && ngram seed
ngram chain status
ngram chain fund <buyer-address> 500            # give an agent/second node AIN to pay with
```

In this mode anchors are `ain.knowledge.explore()` entries (lineage = graph edges), attestations /
settlements / branches / nodes live under `/apps/knowledge/market/*` behind write rules evaluated by the
chain, and x402 payments are AIN transfers whose tx hash is the payment proof.

## aindrive — files & change history

Every node mirrors its market state as plain files under `<dataDir>/drive/` (`patches/<id>/manifest.json`,
`benchmark.json`, `CHANGELOG.md`, the `.npz` body, `branches/*.json`, `ledger/records.jsonl`). Serve that folder
with aindrive so humans and agents can browse/share/sell it and every edit is versioned in aindrive's
Willow store:

```
ngram drive login          # one-time browser pairing (prints the sign-in link); Ctrl+C after "serving"
ngram drive up             # background aindrive agent for the folder
ngram drive status --files
ngram drive sync           # rewrite the mirror from the current ledger state
```

Editing `patches/<id>/benchmark.json` in the aindrive UI (or through `aindrive mcp`) while a patch is a
DRAFT updates the draft on the node. Set `AINDRIVE_SERVER` to use a self-hosted aindrive web server.

## Agent demo

```
npm run build -w packages/agent
node packages/agent/dist/bin.js run --market http://localhost:3402          # 픽셀플러스 087600 end-to-end
node packages/agent/dist/bin.js keys                                        # its own identity; fund it for AIN mode
```

See `packages/agent/README.md`.

## Exit codes

`0` ok · `1` command error · `2` node unreachable · `3` operator login required.
