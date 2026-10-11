package vm

// Latheon: run the Latheon V5 pool and router transactions through the cdk-erigon zkEVM
// and report the zkEVM virtual counters of every transaction against the fork's batch limits.
// This file is copied into cdk-erigon/zk/tests by the CI workflow and reuses the helpers of
// zk_counters_test.go (chainConfig, newEthashConfig, newVmConfig, newEngine, noop).

import (
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"strings"
	"testing"

	"github.com/erigontech/erigon-lib/chain"
	"github.com/erigontech/erigon-lib/common"
	"github.com/erigontech/erigon-lib/crypto"
	"github.com/erigontech/erigon-lib/kv"
	"github.com/erigontech/erigon-lib/kv/memdb"
	"github.com/erigontech/erigon-lib/log/v3"
	"github.com/erigontech/erigon/core"
	"github.com/erigontech/erigon/core/rawdb"
	"github.com/erigontech/erigon/core/state"
	"github.com/erigontech/erigon/core/types"
	"github.com/erigontech/erigon/core/vm"
	"github.com/erigontech/erigon/core/vm/evmtypes"
	"github.com/erigontech/erigon/turbo/services"
	"github.com/erigontech/erigon/turbo/stages/mock"
	seq "github.com/erigontech/erigon/zk/sequencer"
	zktypes "github.com/erigontech/erigon/zk/types"
	"github.com/holiman/uint256"
)

type latheonTx struct {
	Label      string `json:"label"`
	Nonce      uint64 `json:"nonce"`
	To         string `json:"to"`
	Data       string `json:"data"`
	EvmGasUsed string `json:"evmGasUsed"`
}

type latheonInput struct {
	Sender     string      `json:"sender"`
	PrivateKey string      `json:"privateKey"`
	Txs        []latheonTx `json:"txs"`
}

type latheonCounter struct {
	Name  string  `json:"name"`
	Used  int     `json:"used"`
	Limit int     `json:"limit"`
	Pct   float64 `json:"pct"`
}

type latheonRow struct {
	Label      string           `json:"label"`
	Ok         bool             `json:"ok"`
	Error      string           `json:"error,omitempty"`
	ZkGasUsed  uint64           `json:"zkGasUsed"`
	EvmGasUsed string           `json:"evmGasUsed"`
	Counters   []latheonCounter `json:"counters"`
	MaxPct     float64          `json:"maxPct"`
	MaxName    string           `json:"maxName"`
	Overflow   bool             `json:"overflow"`
}

func latheonChainConfig(chainId int64) *chain.Config {
	c := chainConfig(chainId)
	c.ForkID9Elderberry2Block = big.NewInt(0)
	c.ForkID10 = big.NewInt(0)
	c.ForkID11 = big.NewInt(0)
	c.ForkID12BananaBlock = big.NewInt(0)
	c.ForkId13Durian = big.NewInt(0)
	return c
}

func Test_LatheonCounters(t *testing.T) {
	os.Setenv(seq.SEQUENCER_ENV_KEY, "1")
	defer os.Setenv(seq.SEQUENCER_ENV_KEY, "0")

	path := os.Getenv("LATHEON_TXS")
	if path == "" {
		path = "./latheon-txs.json"
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var in latheonInput
	if err := json.Unmarshal(raw, &in); err != nil {
		t.Fatalf("parse input: %v", err)
	}

	forkId := uint16(13)
	if v := os.Getenv("LATHEON_FORK"); v != "" {
		fmt.Sscanf(v, "%d", &forkId)
	}
	levels := []int{0, 32, 64} // 0 = SMT depth of this test's genesis state
	all := map[string][]latheonRow{}

	m := mock.Mock(t)
	blockReader, _ := m.BlocksIO()

	for _, lv := range levels {
		rows := runLatheon(t, blockReader, in, forkId, lv)
		key := fmt.Sprintf("smtLevels=%d", lv)
		if lv == 0 {
			key = "smtLevels=genesis"
		}
		all[key] = rows
		fmt.Printf("\n==== LATHEON fork %d, %s ====\n", forkId, key)
		fmt.Printf("%-30s %-5s %11s %11s %7s %-6s %s\n", "tx", "ok", "zkGas", "evmGas", "max%", "maxCtr", "overflow")
		for _, r := range rows {
			fmt.Printf("%-30s %-5v %11d %11s %6.1f%% %-6s %v %s\n", r.Label, r.Ok, r.ZkGasUsed, r.EvmGasUsed, r.MaxPct, r.MaxName, r.Overflow, r.Error)
			parts := []string{}
			for _, c := range r.Counters {
				parts = append(parts, fmt.Sprintf("%s=%d/%d(%.2f%%)", c.Name, c.Used, c.Limit, c.Pct))
			}
			fmt.Printf("    %s\n", strings.Join(parts, " "))
		}
	}
	out, _ := json.MarshalIndent(map[string]interface{}{"forkId": forkId, "mcpReduction": 0.6, "results": all}, "", " ")
	_ = os.WriteFile(os.Getenv("LATHEON_OUT_DIR")+"latheon-counters-result.json", out, 0o644)
	fmt.Println("\n==== LATHEON JSON ====")
	fmt.Println(string(out))
}

func runLatheon(t *testing.T, blockReader services.FullBlockReader, in latheonInput, forkId uint16, smtLevelsArg int) []latheonRow {
	db, tx := memdb.NewTestTx(t)
	defer db.Close()
	defer tx.Rollback()
	for _, table := range kv.ChaindataTables {
		if err := tx.CreateBucket(table); err != nil {
			t.Fatalf("create bucket: %v", err)
		}
	}

	const chainId = int64(1001)
	key, err := crypto.HexToECDSA(strings.TrimPrefix(in.PrivateKey, "0x"))
	if err != nil {
		t.Fatalf("key: %v", err)
	}
	sender := crypto.PubkeyToAddress(key.PublicKey)
	if !strings.EqualFold(sender.Hex(), in.Sender) {
		t.Fatalf("sender mismatch %s vs %s", sender.Hex(), in.Sender)
	}
	balance, _ := new(big.Int).SetString("1000000000000000000000000000000", 10)
	genesis := &types.Genesis{
		Alloc:  types.GenesisAlloc{sender: {Balance: balance}},
		Config: &chain.Config{ChainID: big.NewInt(chainId)},
	}
	_, _, sparseTree, err := core.WriteGenesisState(genesis, tx, fmt.Sprintf("%s/latheon-%d", os.TempDir(), smtLevelsArg), log.New())
	if err != nil {
		t.Fatalf("genesis: %v", err)
	}
	smtLevels := smtLevelsArg
	if smtLevels == 0 {
		smtLevels = sparseTree.GetDepth()
	}

	chainCfg := latheonChainConfig(chainId)
	vmCfg := newVmConfig()
	engine := newEngine(chainCfg, newEthashConfig(), blockReader, db)
	ibs := state.New(state.NewPlainStateReader(tx))

	header := &types.Header{Number: big.NewInt(1), Difficulty: big.NewInt(0)}
	getHeader := func(hash common.Hash, number uint64) *types.Header { return rawdb.ReadHeader(tx, hash, number) }
	blockHashFunc := core.GetHashFn(header, getHeader)
	sequencerAddress := common.HexToAddress("0x0000000000000000000000000000000000000ace")
	signer := types.LatestSignerForChainID(big.NewInt(chainId))
	gasPrice := uint256.NewInt(1)

	var rows []latheonRow
	for _, lt := range in.Txs {
		data := common.FromHex(lt.Data)
		var unsigned types.Transaction
		if lt.To == "" {
			unsigned = types.NewContractCreation(lt.Nonce, uint256.NewInt(0), transactionGasLimit, gasPrice, data)
		} else {
			unsigned = types.NewTransaction(lt.Nonce, common.HexToAddress(lt.To), uint256.NewInt(0), transactionGasLimit, gasPrice, data)
		}
		transaction, err := types.SignTx(unsigned, *signer, key)
		if err != nil {
			t.Fatalf("sign %s: %v", lt.Label, err)
		}

		batchCollector := vm.NewBatchCounterCollector(smtLevels, forkId, 0.6, false, nil)
		if _, err := batchCollector.StartNewBlock(false); err != nil {
			t.Fatalf("start block: %v", err)
		}
		txCounters := vm.NewTransactionCounter(transaction, smtLevels, forkId, 0.6, false)
		if _, err := batchCollector.AddNewTransactionCounters(txCounters); err != nil {
			t.Fatalf("add counters %s: %v", lt.Label, err)
		}

		vmCfg.Config.SkipAnalysis = core.SkipAnalysis(chainCfg, header.Number.Uint64())
		blockContext := core.NewEVMBlockContext(header, blockHashFunc, engine, &sequencerAddress, chainCfg)
		vmCfg.CounterCollector = txCounters.ExecutionCounters()
		evm := vm.NewZkEVM(blockContext, evmtypes.TxContext{}, ibs, chainCfg, vmCfg)
		gasPool := new(core.GasPool).AddGas(transactionGasLimit)

		row := latheonRow{Label: lt.Label, EvmGasUsed: lt.EvmGasUsed}
		_, result, err := core.ApplyTransaction_zkevm(chainCfg, engine, evm, gasPool, ibs, noop, header, transaction, &header.GasUsed, zktypes.EFFECTIVE_GAS_PRICE_PERCENTAGE_MAXIMUM, true)
		if err != nil {
			row.Error = "apply: " + err.Error()
		} else {
			row.ZkGasUsed = result.UsedGas
			row.Ok = !result.Failed()
			if result.Failed() {
				row.Error = "reverted: " + result.Err.Error()
			}
			if err := txCounters.ProcessTx(ibs, result.ReturnData); err != nil {
				row.Error += " processTx: " + err.Error()
			}
		}
		batchCollector.UpdateExecutionAndProcessingCountersCache(txCounters)
		combined, err := batchCollector.CombineCollectors(false)
		if err != nil {
			t.Fatalf("combine %s: %v", lt.Label, err)
		}
		for i, c := range combined {
			if c == nil {
				continue
			}
			pct := 0.0
			if c.Limit() > 0 {
				pct = 100 * float64(c.Used()) / float64(c.Limit())
			}
			name := string(vm.CounterKeyNames[i])
			row.Counters = append(row.Counters, latheonCounter{Name: name, Used: c.Used(), Limit: c.Limit(), Pct: pct})
			if pct > row.MaxPct {
				row.MaxPct, row.MaxName = pct, name
			}
		}
		row.Overflow = row.MaxPct > 100
		rows = append(rows, row)
	}
	return rows
}
