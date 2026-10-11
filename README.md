# l2-eval-ci

Evaluation runs for Latheon's L2 framework comparison. Testnet research only, not part of the protocol.

`cdk/`: replays the Latheon V5 pool and distribution-router transactions (deploys, deposits, withdrawals with real Groth16 proofs; recorded on a local EVM from the unchanged contracts in latheon-network/Latheon) through the zkEVM of [cdk-erigon](https://github.com/0xPolygon/cdk-erigon) and reports the zkEVM virtual counters (steps, arith, binary, memAlign, keccak, padding, poseidon, sha256) of each transaction against the batch limits of the fork. It uses cdk-erigon's own counter harness (`zk/tests/zk_counters_test.go`).

The sender key in `cdk/latheon-txs.json` is the public Hardhat/Anvil test account #9. It holds nothing anywhere.

Run: GitHub Actions, workflow `cdk-erigon counters` (on push or manually). Results: job log and the `latheon-counters` artifact.
