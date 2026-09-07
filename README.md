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
ainize login                                 # sets the operator password on first use, stores a token in ~/.ainize/cli.json
ainize status
ainize patch ls
ainize chat --list                           # what can be tested live on this node
ainize chat pixelplus-087600 "종목코드 픽셀플러스"
```

`AINIZE_HOME` selects the node directory (default `~/.ainize`); `--node <url>` targets another node's API;
`--json` prints machine-readable output for every command.

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
trial quota per node (shown after each answer); the node operator (after `ainize login`) is unlimited. A patch
is testable on a node that holds its body — the seller node, or yours after `ainize patch buy <id>`.

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
ainize patch ls              # ANNOUNCED → VERIFYING → LISTED as attestations arrive
ainize ledger graph          # lineage tree (original authors share in derived-patch revenue)
AINIZE_HOME=~/.ainize-c ainize login && AINIZE_HOME=~/.ainize-c ainize patch buy law-kr-2026     # 402 → pay → download
AINIZE_HOME=~/.ainize-c ainize branch subscribe law/KR && ainize route jurisdiction=KR           # gateway routing
```

## Commands

| group | commands |
|---|---|
| setup | `init`, `config show\|set <key> <value>`, `keys show [--reveal]` |
| lifecycle | `start [-d] [--peer …] [--port]`, `stop`, `status`, `logs [-f] [--patch id] [--kind k]`, `seed [--no-real] [--no-synthetic]`, `nodes` |
| auth | `login [--password]` (or `AINIZE_PASSWORD`), `logout` |
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
