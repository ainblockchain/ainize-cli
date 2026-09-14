# Hugging Face source to native training record

`ainize dataset <huggingface-dataset-url>` imports an existing source. It does not
publish a dataset to Hugging Face. Source metadata and import receipts remain
private local files under `<AINIZE_HOME>/hf-imports/import-*/`, not new public
blockchain fields. Sharing those files is a separate operator decision.

## Files and hash domains

Each import keeps the downloaded input, the mapped upload and `source.json` as
before. After the node accepts the dataset, the CLI now saves
`import-receipt.json` with mode 0600 **before requesting any training**. It records:

- The HF repository, resolved immutable revision and SHA-256 of `source.json`.
- `input_sha256`: downloaded input bytes, before column mapping.
- `upload_sha256`: mapped bytes sent to the Ainize dataset endpoint.
- `dataset_id`, `dataset_sha256`, `dataset_revision`, `accepted_rows`: the node's
  accepted canonical dataset snapshot and the destination node URL.

These three data hashes cover different bytes and need not match. The canonical
dataset hash is initially node-reported; verify it against a downloaded canonical
dataset before relying on it. Receipt creation rejects an inconsistent upload
hash/byte count rather than assuming an arbitrary server dataset is the import.
Repeated imports can return the same dataset (`created=false`); receipt files
are not a count of distinct datasets or supported models.

With `--train`, a separate `training-receipt.json` is written after the command
returns a job snapshot. With `--wait`, that is the returned post-wait snapshot.
The training link requires the job's dataset ID and hash to match the accepted
import. Neither the job status nor receipt existence proves real training or
inference. The JSON output exposes `import_receipt` and, when available,
`training_receipt` paths. The initial import receipt remains immutable and has
`job: null`; later training does not rewrite history.

If training is refused or interrupted, the accepted import receipt remains on
disk even when the command produces no successful JSON output. Inspect it and
`ainize teach jobs --dataset <dataset-id>` before retrying: a failed connection
does not establish that the node rejected a job. If import receipt persistence
fails, this invocation stops before it requests training. An upload connection
failure can still leave an unknown acceptance outcome; no receipt is fabricated.

## Trace to AINSCAN

1. Import using the required mapping and preserve the output:

   ```sh
   umask 077
   ainize dataset https://huggingface.co/datasets/owner/questions --train --wait --json > import-output.json
   ```

2. Check the local `source.json`, downloaded input and mapped upload against
   the hashes in the receipt. Preserve the immutable revision and mapping options.
3. Download the node's canonical dataset into a new file and verify its SHA-256:

   ```sh
   ainize teach dataset get <dataset-id> -o canonical-questions.jsonl --format jsonl
   sha256sum canonical-questions.jsonl
   ainize teach status <job-id> --json
   ```

   Select the same node with `--node <url>` when it is not the configured default.
   The canonical hash must equal the receipt's `dataset_sha256` and the job's
   `dataset.sha256`. Do not substitute the downloaded HF input hash.
4. Read the job's `chain_submissions` and locate the actual training transaction
   by its hash in AINSCAN configured for that chain. Its native lesson path must
   identify this job and node, and its dataset ID/hash must match the receipt.
   Inspect the recorded trainer model ID; do not infer it from the dataset name.
5. Independently verify real training/checks and patched inference before counting
   dataset/model integration as successful. A stub, queued job, failed job or
   imported-but-unused dataset is not a successful end-to-end integration.

The explorer still reads ordinary blockchain records. No experiment ID, source
upload endpoint or implicit public metadata publication is added. This local
chain of evidence is not an independent guarantee that the source license allows
redistribution or that a learned answer is correct.
