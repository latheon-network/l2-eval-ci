# l2-eval-ci

Evaluation runs for Latheon's L2 framework comparison. Testnet research only, not part of the protocol.

`cdk/`: replays the Latheon V5 pool and distribution-router transactions (deploys, deposits, withdrawals with real Groth16 proofs; recorded on a local EVM from the unchanged contracts in latheon-network/Latheon) through the zkEVM of [cdk-erigon](https://github.com/0xPolygon/cdk-erigon) and reports the zkEVM virtual counters (steps, arith, binary, memAlign, keccak, padding, poseidon, sha256) of each transaction against the batch limits of the fork. It uses cdk-erigon's own counter harness (`zk/tests/zk_counters_test.go`).

The sender key in `cdk/latheon-txs.json` is the public Hardhat/Anvil test account #9. It holds nothing anywhere.

Run: GitHub Actions, workflow `cdk-erigon counters` (on push or manually). Results: job log and the `latheon-counters` artifact.

`arbitrum/`: starts the official Arbitrum nitro-testnode (L1 + L2 + an L3 whose gas is paid in a custom ERC-20 fee token, 18 decimals) in GitHub Actions and runs the Latheon evaluation scenario (`arbitrum/l2-eval/eval.js`, same 18 transactions, real proofs) on the L3. Workflow `arbitrum L3 custom gas token`. Results are committed to the `results` branch.
