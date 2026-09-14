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

With `--train`, `training-submission.json` is saved with mode 0600 immediately
after job admission, before `--wait` starts polling. It binds the accepted Job ID
to the imported dataset ID/hash, using the same source revision and hash evidence.
A status request failure or wait timeout therefore does not discard an acknowledged
job's identity. This immutable file is an admission snapshot, not a completion
receipt. If its validation or persistence fails, polling stops but the already
accepted job is not cancelled or resubmitted.

A separate `training-receipt.json` is written after the command
returns a job snapshot. With `--wait`, that is the returned post-wait snapshot.
The training link requires the job's dataset ID and hash to match the accepted
import. Neither the job status nor receipt existence proves real training or
inference. The JSON output exposes `import_receipt` and, when available,
`training_submission_receipt` and `training_receipt` paths. The initial import receipt remains immutable and has
`job: null`; later training does not rewrite history.

If training is refused or interrupted, the accepted import receipt remains on
disk even when the command produces no successful JSON output. Inspect it and
`ainize teach jobs --dataset <dataset-id>` before retrying: a failed connection
does not establish that the node rejected a job. If import receipt persistence
fails, this invocation stops before it requests training. An upload connection
failure can still leave an unknown acceptance outcome; no receipt is fabricated.
If waiting was interrupted after admission, locate `training-submission.json`
under `<home>/hf-imports/import-*/` and use its Job ID with `ainize teach status`.
Do not create another job merely because the final `training-receipt.json` is absent.

## Download integrity verification

On 2026-09-14, the download integrity test and 14 HF import/direct-teach
regression tests passed, together with TypeScript checking. The integrity test
runs the CLI against a controlled local HTTP fixture and checks nonzero exit,
no new output, preservation of existing evidence, malformed/missing digests,
valid JSONL and CSV hash domains, and mode 0600 on a new output file. The
direct-teach regression downloads canonical JSONL from an actual temporary
Ainize node and compares its bytes with the node's dataset fingerprint.
HF responses and training in these regressions use fixtures/stubs. They are
not evidence of 100 dataset pipelines, GPU training or onchain inclusion.

```sh
node --test --import tsx test/dataset-download-integrity.test.ts test/teach-direct.test.ts test/huggingface-import-receipt.test.ts test/huggingface-dataset.test.ts
npm run typecheck
```

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
   Downloads now fail with a nonzero exit status before writing the output if
   the expected fingerprint is missing, malformed or mismatched. An existing
   output file is left untouched on verification failure; new output files use
   mode 0600. A successful JSONL download verifies the canonical dataset hash.
   CSV downloads instead verify the node's `x-content-sha256` export header;
   they do not verify the canonical JSONL hash or independently authenticate
   the dataset's HF origin. Use JSONL for the chain binding described here.
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

## Admission recovery validation (2026-09-14)

The HF import tests use mocked HF responses and a real local Ainize node with a
stub trainer. A forced job-status HTTP 503 after admission leaves the matching
`training-submission.json` intact, while no final `training-receipt.json` is
created. Exactly one training POST is observed; no automatic retry creates a
second job. Rejected admission creates no submission receipt. The accepted-job
receipt has mode 0600 and matching dataset ID/hash. Fourteen focused HF/direct
teach tests and TypeScript checking passed. This validates recovery metadata,
not real GPU training, source retrieval from live HF, or 100 completed pipelines.
