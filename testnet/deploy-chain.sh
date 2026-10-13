#!/usr/bin/env bash
# Creates the Latheon test chain on Arbitrum Sepolia (once), writes the node config, starts everything,
# deposits test LTH into the chain and creates the token bridge. Safe to re-run: finished steps are skipped.
set -euo pipefail
cd "$(dirname "$0")"
if [ -z "${DEPLOYER_KEY:-}" ]; then
  read -r -s -p "Deployer private key (input hidden): " DEPLOYER_KEY; echo
  export DEPLOYER_KEY
fi

./chain-cmd.sh deploy

# chain id into .env for the explorer; node config readable by the nitro user (uid 1000) only
CID=$(sed -n 's/^CHAIN_ID=//p' chain/out/chain.env)
if grep -q '^CHAIN_ID=' .env; then sed -i "s/^CHAIN_ID=.*/CHAIN_ID=$CID/" .env; else echo "CHAIN_ID=$CID" >> .env; fi
chown 1000:1000 chain/secret/node-config.json && chmod 600 chain/secret/node-config.json

docker compose up -d
echo "== waiting for the L3 RPC (the node first waits for parent-chain finality of the deployment: up to ~1 hour, once)"
for i in $(seq 1 240); do
  if curl -s -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' http://127.0.0.1:8449 | grep -q result; then
    echo "L3 RPC is up"; break
  fi
  sleep 15
done

./chain-cmd.sh fund
./chain-cmd.sh bridge
./chain-cmd.sh batches || echo "No batch on Arbitrum Sepolia yet (the batch poster waits up to its max delay). Check later: ./chain-cmd.sh batches"
echo "Done. Public facts: chain/out/chain.json. Keep chain/secret/ private and backed up."
