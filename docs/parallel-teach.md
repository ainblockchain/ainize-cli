# Parallel teach jobs with AIN lifecycle records

`ainize teach parallel` uses the same signed dataset-training request as
`ainize teach train`, then records each observed job status with ain-js. A record
counts only after successful transaction finalization and an independent
validator confirms both the value and transaction inclusion in its block.

This command requires matching node/core source builds supporting
`teach.activeJobsPerKey`. It does not increase GPU trainer slots. Seventy admitted
or queued jobs are not evidence of seventy simultaneous GPU training processes;
the summary reports `peakActiveJobs` and `peakTrainingJobs` separately.

## Inputs

Use existing registered datasets, with their canonical SHA-256 and row counts:

```json
[
  {
    "datasetId": "00000000-0000-4000-8000-000000000001",
    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "rows": 8
  }
]
```

The example binding is a placeholder, not a real dataset. Dataset IDs must be
unique. For the DART experiment, select seventy logical datasets from the original
hundred; re-registering expired canonical bytes does not create a new logical
dataset for counting purposes.

Configure a write endpoint, a different validator for final reads, and a writable
application path. The example local account file uses the existing harness shape
`others[signerIndex].private_key`; keep that file private and outside Git.

```json
{
  "chainId": 0,
  "gasPrice": 0,
  "signerFile": "/private/genesis_accounts.json",
  "signerIndex": 14,
  "chains": [
    {
      "name": "cert-chain",
      "provider": "http://127.0.0.1:18082",
      "reader": "http://127.0.0.1:18084",
      "pathPrefix": "/apps/ai_network_dag/teach_pipelines"
    }
  ]
}
```

Use the chain's actual gas price and signing account. Transaction costs and write
permissions remain the operator's responsibility. Multiple configured routes are
used round-robin; different paths on one chain are not independent shards.

For native POA shards, each route can also declare
`parent: { provider, reader, shardPath }`, with two distinct parent validators and
the actual shard path (for example `/apps/year3_shard1`). The recorder then waits
for both parent validators' finalized proof-hash records to match the independently
read child transaction block. Parent proof paths and hashes are included in each
receipt. Parent endpoints must differ from the child endpoints. Set
`signerAccount: "owner"` to use the account file's `owner.private_key` for an
existing owner-only application; the default selects `others[signerIndex]`.

## Run

On an idle test node, configure admission and queue/daily/row quotas appropriate
for the workload, then restart only that node to load the configuration. Do not
interrupt existing training or disable resource limits. For example:

```sh
ainize config set teach.activeJobsPerKey 70
ainize config set teach.queueMax 80
ainize stop && ainize start -d
ainize teach parallel datasets.json \
  --chain-config chain.json \
  --output evidence/teach70 \
  --run-id teach70 \
  --concurrency 70 \
  --observe-seconds 120 \
  --json
```

The command requires the real gradient backend and checks dataset fingerprints,
row counts, admission capacity, and two healthy, distinct validators before
submitting jobs. Per-key/per-IP daily and row quotas still apply. Run the CLI,
node, and trainer in the experiment's resource-controlled Docker environment;
this command does not establish CPU, memory, or GPU isolation itself.

The output includes each real job ID, transaction hash, final block number, and
path of the form:

```text
/apps/ai_network_dag/teach_pipelines/teach70/jobs/<job-id>/states/<sequence>
```

`summary.json` distinguishes admitted jobs, independently verified initial
records, active jobs, actual `TRAINING` observations, and terminal jobs. A terminal
job is not necessarily successful. Ending the observation does not cancel
training, and the command does not publish learned knowledge automatically.

## Resume safely

Keep the output directory, manifest, and chain configuration unchanged. Repeat
the command with `--resume` to continue observing recorded jobs. Submission and
transaction intents are saved before network writes. An uncertain job submission
is adopted only if its name and dataset identify exactly one existing job;
uncertain transactions retain their original hash rather than being blindly
resubmitted. Investigate unresolved intents before attempting a new run.

Keep raw evidence private until reviewed: it can contain job errors and progress
metadata. Neither account files nor teaching keys belong in a public evidence
bundle.
