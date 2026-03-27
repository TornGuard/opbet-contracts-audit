import { createRequire } from 'module';
import { Address, BinaryWriter } from '@btc-vision/transaction';
import {
    opnet, OPNetUnit, Assert, Blockchain,
    Transaction, TransactionOutput, generateTransactionId,
} from '@btc-vision/unit-test-framework';
import { TransactionOutputFlags } from 'opnet';
import { FeeBetMarketRuntime } from './runtime/FeeBetMarketRuntime.js';

// ── Fix dual-package StateHandler: get BOTH ESM and CJS singletons ──
// The ESM import above gives us the ESM StateHandler via Blockchain.
// But ContractRuntime internally loads the CJS copy, whose StateHandler
// retains contract storage across tests. We need to purge BOTH.
const _require = createRequire(import.meta.url);
// Use absolute path to bypass package.json exports restrictions
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const stateHandlerPath = resolve(
    __dirname, '..', 'node_modules', '@btc-vision',
    'unit-test-framework', 'build', 'opnet', 'vm', 'StateHandler.js',
);
const { StateHandler: CjsStateHandler } = _require(stateHandlerPath);

function purgeAllState(): void {
    // Purge CJS StateHandler (where contract WASM actually stores data)
    CjsStateHandler.purgeAll();
    // Also purge via Blockchain (ESM side) for good measure
    Blockchain.clearContracts();
}

// ── Constants matching contract ──
const BET_OU = 1n;
const BET_EXACT = 2n;
const BET_TREND = 3n;
const BET_MEMPOOL = 4n;
const BET_BLOCKTIME = 5n;
const BET_SPIKE = 6n;

const OVER = 1n;
const UNDER = 2n;
const OPT_1 = 1n;
const OPT_2 = 2n;
const OPT_3 = 3n;
const OPT_4 = 4n;

const STATUS_ACTIVE = 0n;
const STATUS_LOST = 1n;
const STATUS_WON = 2n;
const STATUS_SETTLED = 3n;

const BET_AMOUNT = 5000n;
const OPERATOR_P2OP = 'opt1p_test_operator_address_for_unit_testing_only';

// Helper: create a proper Transaction with outputs to operator
function mockOperatorDeposit(amount: bigint): void {
    const tx = new Transaction(generateTransactionId(), [], [], false);
    tx.addOutput(amount, OPERATOR_P2OP);
    Blockchain.transaction = tx;
}

// Helper: create a proper Transaction for processPayment
function mockPaymentOutput(bettorP2op: string, amount: bigint): void {
    const tx = new Transaction(generateTransactionId(), [], [], false);
    tx.addOutput(amount, bettorP2op);
    Blockchain.transaction = tx;
}

function clearTx(): void {
    Blockchain.transaction = null;
}

// ── Fix ESM/CJS dual-package hazard ──
// When tsx loads .mts as ESM, ContractRuntime.js's `import { Blockchain }`
// resolves to a DIFFERENT singleton than this test's Blockchain. We override
// every prototype method that reads from the wrong Blockchain to use ours.
{
    const proto = FeeBetMarketRuntime.prototype as any;

    // 1. setEnvironment: default `currentBlock = Blockchain.blockNumber` reads wrong singleton
    const _origSetEnv = proto.setEnvironment;
    proto.setEnvironment = function(
        msgSender?: any, txOrigin?: any, currentBlock?: bigint, dep?: any, addr?: any,
    ) {
        return _origSetEnv.call(
            this, msgSender, txOrigin,
            currentBlock ?? Blockchain.blockNumber,
            dep, addr,
        );
    };

    // 2. onOutputsRequested: reads `Blockchain.transaction` from wrong singleton
    proto.onOutputsRequested = function() {
        const tx = Blockchain.transaction;
        if (!tx) return Promise.resolve(Buffer.alloc(2));
        return Promise.resolve(Buffer.from(tx.serializeOutputs()));
    };

    // 3. onInputsRequested: same issue
    proto.onInputsRequested = function() {
        const tx = Blockchain.transaction;
        if (!tx) return Promise.resolve(Buffer.alloc(2));
        return Promise.resolve(Buffer.from(tx.serializeInputs()));
    };
}

await opnet('FeeBet_Market v4 — All Bet Types', async (vm: OPNetUnit) => {
    let market: FeeBetMarketRuntime;
    // Generate fresh addresses per test to avoid stale state from dual-package StateHandler
    let deployer: Address;
    let user: Address;
    let contractAddr: Address;

    // ════════════════════════════════════════════════════
    // SETUP
    // ════════════════════════════════════════════════════
    vm.beforeEach(async () => {
        Blockchain.dispose();
        purgeAllState();  // Purges BOTH ESM and CJS StateHandler singletons
        await Blockchain.init();

        // Fresh addresses each test — avoids "Block data already set" from prior test's state
        deployer = Blockchain.generateRandomAddress();
        user = Blockchain.generateRandomAddress();
        contractAddr = Blockchain.generateRandomAddress();

        // Set block number BEFORE any contract calls
        Blockchain.blockNumber = 200n;

        // Deploy contract
        market = new FeeBetMarketRuntime(deployer, contractAddr);
        Blockchain.register(market);
        await market.init();

        // Configure operator P2OP (pass deployer explicitly for onlyDeployer check)
        await market.setOperatorP2op(OPERATOR_P2OP, deployer);

        // Seed pool with 1M sats
        await market.seedPool(1_000_000n, deployer);
    });

    vm.afterEach(() => {
        clearTx();
        market.dispose();
        Blockchain.dispose();
        CjsStateHandler.purgeAll();  // Ensure CJS state is fully cleared after each test
    });

    // Helper: place a bet as user
    async function placeBetAsUser(
        betType: bigint,
        param1: bigint,
        param2: bigint,
        amount: bigint = BET_AMOUNT,
    ): Promise<bigint> {
        mockOperatorDeposit(amount);
        const betId = await market.placeBet(betType, param1, param2, user);
        clearTx();
        return betId;
    }

    // Helper: set oracle data as deployer (advances blockchain if needed)
    async function setOracle(
        blockHeight: bigint,
        fee: bigint,
        mempool: bigint = 12000n,
        timestamp: bigint = 1700000000n,
    ): Promise<void> {
        // Ensure contract sees a block number past the one we're setting
        if (Blockchain.blockNumber <= blockHeight) {
            Blockchain.blockNumber = blockHeight + 1n;
        }
        await market.setBlockData(blockHeight, fee, mempool, timestamp, deployer);
    }

    // Helper: resolve as anyone
    async function resolve(betId: bigint): Promise<{ won: boolean; payout: bigint }> {
        return market.resolveBet(betId, user);
    }

    // ════════════════════════════════════════════════════
    // 1. OVER/UNDER
    // ════════════════════════════════════════════════════
    await vm.it('O/U: OVER wins when fee >= threshold', async () => {
        // Set oracle so dynamic odds work
        await setOracle(99n, 1500n);

        const betId = await placeBetAsUser(BET_OU, OVER, 1000n);
        const info = await market.getBetInfo(betId);
        Assert.expect(info.betType).toEqual(BET_OU);
        Assert.expect(info.status).toEqual(STATUS_ACTIVE);

        // Set target block fee = 1500 >= threshold 1000 → OVER wins
        await setOracle(info.endBlock, 1500n);
        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(true);
        Assert.expect(result.payout > 0n).toEqual(true);
    });

    await vm.it('O/U: OVER loses when fee < threshold', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_OU, OVER, 2000n);
        const info = await market.getBetInfo(betId);

        await setOracle(info.endBlock, 1500n);
        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(false);
        Assert.expect(result.payout).toEqual(0n);
    });

    await vm.it('O/U: UNDER wins when fee < threshold', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_OU, UNDER, 2000n);
        const info = await market.getBetInfo(betId);

        await setOracle(info.endBlock, 1500n);
        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(true);
    });

    await vm.it('O/U: UNDER loses when fee >= threshold', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_OU, UNDER, 1000n);
        const info = await market.getBetInfo(betId);

        await setOracle(info.endBlock, 1500n);
        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(false);
    });

    await vm.it('O/U: Edge — fee equals threshold → OVER wins, UNDER loses', async () => {
        await setOracle(99n, 1500n);

        // OVER 1500 when fee is 1500 → should WIN
        const overBet = await placeBetAsUser(BET_OU, OVER, 1500n);
        const overInfo = await market.getBetInfo(overBet);
        await setOracle(overInfo.endBlock, 1500n);
        const overResult = await resolve(overBet);
        Assert.expect(overResult.won).toEqual(true);

        // UNDER 1500 when fee is 1500 → should LOSE
        const underBet = await placeBetAsUser(BET_OU, UNDER, 1500n);
        const underInfo = await market.getBetInfo(underBet);
        await setOracle(underInfo.endBlock, 1500n);
        const underResult = await resolve(underBet);
        Assert.expect(underResult.won).toEqual(false);
    });

    await vm.it('O/U: Dynamic odds — easy bet gets low odds', async () => {
        await setOracle(99n, 1500n); // current fee 15 sat/vB

        // OVER 1000 (10 sat/vB) — easy, threshold well below current fee
        const betId = await placeBetAsUser(BET_OU, OVER, 1000n);
        const info = await market.getBetInfo(betId);
        // 33% distance → easy tier 3 or 4 → odds 1.15x-1.30x
        Assert.expect(info.odds <= 180n).toEqual(true);
        Assert.expect(info.odds >= 110n).toEqual(true);
    });

    await vm.it('O/U: Dynamic odds — hard bet gets high odds', async () => {
        await setOracle(99n, 1500n);

        // OVER 2000 (20 sat/vB) — hard, threshold above current fee
        const betId = await placeBetAsUser(BET_OU, OVER, 2000n);
        const info = await market.getBetInfo(betId);
        // 33% distance → hard tier → odds 3.00x-5.00x
        Assert.expect(info.odds >= 300n).toEqual(true);
    });

    // ════════════════════════════════════════════════════
    // 2. EXACT FEE
    // ════════════════════════════════════════════════════
    await vm.it('Exact: wins when fee within ±0.50 tolerance', async () => {
        await setOracle(99n, 1500n);
        // Predict 1500 (15 sat/vB), tolerance is ±50 (0.50 sat/vB)
        const betId = await placeBetAsUser(BET_EXACT, 1500n, 0n);
        const info = await market.getBetInfo(betId);
        Assert.expect(info.odds).toEqual(5000n); // 50x

        // Actual fee = 1520 → diff = 20 <= 50 → WIN
        await setOracle(info.endBlock, 1520n);
        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(true);
    });

    await vm.it('Exact: wins at boundary (diff = tolerance)', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_EXACT, 1500n, 0n);
        const info = await market.getBetInfo(betId);

        // Actual fee = 1550 → diff = 50 = tolerance → WIN (inclusive)
        await setOracle(info.endBlock, 1550n);
        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(true);
    });

    await vm.it('Exact: loses when fee outside tolerance', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_EXACT, 1500n, 0n);
        const info = await market.getBetInfo(betId);

        // Actual fee = 1551 → diff = 51 > 50 → LOSE
        await setOracle(info.endBlock, 1551n);
        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(false);
    });

    await vm.it('Exact: wins when fee below prediction within tolerance', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_EXACT, 1500n, 0n);
        const info = await market.getBetInfo(betId);

        // Actual fee = 1450 → diff = 50 = tolerance → WIN
        await setOracle(info.endBlock, 1450n);
        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(true);
    });

    await vm.it('Exact: loses when fee far below prediction', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_EXACT, 1500n, 0n);
        const info = await market.getBetInfo(betId);

        // Actual fee = 1000 → diff = 500 >> 50 → LOSE
        await setOracle(info.endBlock, 1000n);
        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(false);
    });

    // ════════════════════════════════════════════════════
    // 3. TREND
    // ════════════════════════════════════════════════════
    await vm.it('Trend: UP wins when avg fee > reference fee', async () => {
        // Set oracle fee before placing bet (this becomes refFee)
        await setOracle(99n, 1500n);

        const betId = await placeBetAsUser(BET_TREND, OVER, 0n); // OVER = UP
        const info = await market.getBetInfo(betId);
        Assert.expect(info.odds).toEqual(200n); // 2.00x

        // Set blocks in the target range with higher fees
        const target = info.targetBlock;
        const end = info.endBlock;
        for (let b = target; b <= end; b++) {
            await setOracle(b, 2000n, 12000n, 1700000000n + (b - target) * 600n);
        }

        // Avg fee = 2000 > refFee 1500 → UP wins
        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(true);
    });

    await vm.it('Trend: UP loses when avg fee < reference fee', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_TREND, OVER, 0n);
        const info = await market.getBetInfo(betId);

        const target = info.targetBlock;
        const end = info.endBlock;
        for (let b = target; b <= end; b++) {
            await setOracle(b, 1000n, 12000n, 1700000000n + (b - target) * 600n);
        }

        // Avg fee = 1000 < refFee 1500 → UP loses
        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(false);
    });

    await vm.it('Trend: DOWN wins when avg fee < reference fee', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_TREND, UNDER, 0n); // UNDER = DOWN
        const info = await market.getBetInfo(betId);

        const target = info.targetBlock;
        const end = info.endBlock;
        for (let b = target; b <= end; b++) {
            await setOracle(b, 1000n, 12000n, 1700000000n + (b - target) * 600n);
        }

        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(true);
    });

    await vm.it('Trend: DOWN loses when avg fee > reference fee', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_TREND, UNDER, 0n);
        const info = await market.getBetInfo(betId);

        const target = info.targetBlock;
        const end = info.endBlock;
        for (let b = target; b <= end; b++) {
            await setOracle(b, 2000n, 12000n, 1700000000n + (b - target) * 600n);
        }

        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(false);
    });

    await vm.it('Trend: refFee is auto-captured from oracle, not user-controlled', async () => {
        await setOracle(99n, 1500n); // latestOracleFee = 1500

        const betId = await placeBetAsUser(BET_TREND, OVER, 9999n); // param2 ignored
        const info = await market.getBetInfo(betId);
        // refFee stored internally should be 1500 (from oracle), not 9999

        // Set avg = 1600 > 1500 → UP wins
        const target = info.targetBlock;
        const end = info.endBlock;
        for (let b = target; b <= end; b++) {
            await setOracle(b, 1600n, 12000n, 1700000000n + (b - target) * 600n);
        }

        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(true); // Proves refFee was 1500, not 9999
    });

    // ════════════════════════════════════════════════════
    // 4. MEMPOOL
    // ════════════════════════════════════════════════════
    await vm.it('Mempool Opt1: >15k wins when mempool > 15000', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_MEMPOOL, OPT_1, 0n);
        const info = await market.getBetInfo(betId);
        Assert.expect(info.odds).toEqual(240n); // 2.40x

        // End block mempool = 16000 > 15000 → WIN
        await setOracle(info.endBlock, 1500n, 16000n);
        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(true);
    });

    await vm.it('Mempool Opt1: >15k loses when mempool <= 15000', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_MEMPOOL, OPT_1, 0n);
        const info = await market.getBetInfo(betId);

        await setOracle(info.endBlock, 1500n, 15000n);
        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(false); // Not strictly greater
    });

    await vm.it('Mempool Opt2: <10k wins when mempool < 10000', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_MEMPOOL, OPT_2, 0n);
        const info = await market.getBetInfo(betId);
        Assert.expect(info.odds).toEqual(310n); // 3.10x

        await setOracle(info.endBlock, 1500n, 9000n);
        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(true);
    });

    await vm.it('Mempool Opt2: <10k loses when mempool >= 10000', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_MEMPOOL, OPT_2, 0n);
        const info = await market.getBetInfo(betId);

        await setOracle(info.endBlock, 1500n, 10000n);
        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(false);
    });

    await vm.it('Mempool Opt3: >20k@+12 wins', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_MEMPOOL, OPT_3, 0n);
        const info = await market.getBetInfo(betId);
        Assert.expect(info.odds).toEqual(450n); // 4.50x

        await setOracle(info.endBlock, 1500n, 21000n);
        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(true);
    });

    await vm.it('Mempool Opt4: <5k@+12 wins', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_MEMPOOL, OPT_4, 0n);
        const info = await market.getBetInfo(betId);
        Assert.expect(info.odds).toEqual(800n); // 8.00x

        await setOracle(info.endBlock, 1500n, 4000n);
        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(true);
    });

    await vm.it('Mempool Opt4: <5k@+12 loses when >= 5000', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_MEMPOOL, OPT_4, 0n);
        const info = await market.getBetInfo(betId);

        await setOracle(info.endBlock, 1500n, 5000n);
        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(false);
    });

    // ════════════════════════════════════════════════════
    // 5. BLOCKTIME
    // ════════════════════════════════════════════════════
    await vm.it('BlockTime Opt1: <5min wins when timeDiff < 300s', async () => {
        await setOracle(99n, 1500n, 12000n, 1700000000n);
        const betId = await placeBetAsUser(BET_BLOCKTIME, OPT_1, 0n);
        const info = await market.getBetInfo(betId);
        Assert.expect(info.odds).toEqual(300n); // 3.00x

        // Previous block = target-1, current block = target
        const prevBlock = info.targetBlock - 1n;
        await setOracle(prevBlock, 1500n, 12000n, 1700000000n);
        // Target block = 200 seconds later (< 300s)
        await setOracle(info.targetBlock, 1500n, 12000n, 1700000200n);

        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(true);
    });

    await vm.it('BlockTime Opt1: <5min loses when timeDiff >= 300s', async () => {
        await setOracle(99n, 1500n, 12000n, 1700000000n);
        const betId = await placeBetAsUser(BET_BLOCKTIME, OPT_1, 0n);
        const info = await market.getBetInfo(betId);

        const prevBlock = info.targetBlock - 1n;
        await setOracle(prevBlock, 1500n, 12000n, 1700000000n);
        await setOracle(info.targetBlock, 1500n, 12000n, 1700000300n); // exactly 300s

        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(false); // strict < 300
    });

    await vm.it('BlockTime Opt2: 5-10min wins when 300 <= timeDiff < 600', async () => {
        await setOracle(99n, 1500n, 12000n, 1700000000n);
        const betId = await placeBetAsUser(BET_BLOCKTIME, OPT_2, 0n);
        const info = await market.getBetInfo(betId);
        Assert.expect(info.odds).toEqual(180n); // 1.80x

        const prevBlock = info.targetBlock - 1n;
        await setOracle(prevBlock, 1500n, 12000n, 1700000000n);
        await setOracle(info.targetBlock, 1500n, 12000n, 1700000400n); // 400s

        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(true);
    });

    await vm.it('BlockTime Opt3: 10-20min wins when 600 <= timeDiff < 1200', async () => {
        await setOracle(99n, 1500n, 12000n, 1700000000n);
        const betId = await placeBetAsUser(BET_BLOCKTIME, OPT_3, 0n);
        const info = await market.getBetInfo(betId);
        Assert.expect(info.odds).toEqual(250n); // 2.50x

        const prevBlock = info.targetBlock - 1n;
        await setOracle(prevBlock, 1500n, 12000n, 1700000000n);
        await setOracle(info.targetBlock, 1500n, 12000n, 1700000900n); // 900s

        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(true);
    });

    await vm.it('BlockTime Opt4: 20+min wins when timeDiff >= 1200', async () => {
        await setOracle(99n, 1500n, 12000n, 1700000000n);
        const betId = await placeBetAsUser(BET_BLOCKTIME, OPT_4, 0n);
        const info = await market.getBetInfo(betId);
        Assert.expect(info.odds).toEqual(600n); // 6.00x

        const prevBlock = info.targetBlock - 1n;
        await setOracle(prevBlock, 1500n, 12000n, 1700000000n);
        await setOracle(info.targetBlock, 1500n, 12000n, 1700001500n); // 1500s

        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(true);
    });

    await vm.it('BlockTime Opt4: 20+min loses when timeDiff < 1200', async () => {
        await setOracle(99n, 1500n, 12000n, 1700000000n);
        const betId = await placeBetAsUser(BET_BLOCKTIME, OPT_4, 0n);
        const info = await market.getBetInfo(betId);

        const prevBlock = info.targetBlock - 1n;
        await setOracle(prevBlock, 1500n, 12000n, 1700000000n);
        await setOracle(info.targetBlock, 1500n, 12000n, 1700001100n); // 1100s < 1200

        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(false);
    });

    await vm.it('BlockTime: reverts when previous block data missing', async () => {
        await setOracle(99n, 1500n, 12000n, 1700000000n);
        const betId = await placeBetAsUser(BET_BLOCKTIME, OPT_1, 0n);
        const info = await market.getBetInfo(betId);

        // Set target block but NOT previous block
        await setOracle(info.targetBlock, 1500n, 12000n, 1700000200n);

        await Assert.expect(async () => {
            await resolve(betId);
        }).toThrow('Previous block data required');
    });

    // ════════════════════════════════════════════════════
    // 6. SPIKE
    // ════════════════════════════════════════════════════
    await vm.it('Spike Opt1: 50+ wins when max fee >= 5000', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_SPIKE, OPT_1, 0n);
        const info = await market.getBetInfo(betId);
        Assert.expect(info.odds).toEqual(500n); // 5.00x

        // Set one block in range with fee spike to 5000 (50 sat/vB)
        const target = info.targetBlock;
        const end = info.endBlock;
        // Most blocks normal, one block spikes
        for (let b = target; b <= end; b++) {
            const fee = b === target + 5n ? 5000n : 1500n;
            await setOracle(b, fee, 12000n, 1700000000n + (b - target) * 600n);
        }

        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(true);
    });

    await vm.it('Spike Opt1: 50+ loses when max fee < 5000', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_SPIKE, OPT_1, 0n);
        const info = await market.getBetInfo(betId);

        const target = info.targetBlock;
        const end = info.endBlock;
        for (let b = target; b <= end; b++) {
            await setOracle(b, 4999n, 12000n, 1700000000n + (b - target) * 600n);
        }

        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(false);
    });

    await vm.it('Spike Opt2: 100+ wins when max fee >= 10000', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_SPIKE, OPT_2, 0n);
        const info = await market.getBetInfo(betId);
        Assert.expect(info.odds).toEqual(1200n); // 12.00x

        const target = info.targetBlock;
        const end = info.endBlock;
        for (let b = target; b <= end; b++) {
            const fee = b === target + 3n ? 10000n : 1500n;
            await setOracle(b, fee, 12000n, 1700000000n + (b - target) * 600n);
        }

        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(true);
    });

    await vm.it('Spike Opt3: 200+ wins at boundary (max fee = 20000)', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_SPIKE, OPT_3, 0n);
        const info = await market.getBetInfo(betId);
        Assert.expect(info.odds).toEqual(2500n); // 25.00x

        const target = info.targetBlock;
        const end = info.endBlock;
        for (let b = target; b <= end; b++) {
            const fee = b === target ? 20000n : 1500n; // exactly at threshold
            await setOracle(b, fee, 12000n, 1700000000n + (b - target) * 600n);
        }

        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(true); // >= check (inclusive)
    });

    await vm.it('Spike Opt4: 500+ loses when max fee < 50000', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_SPIKE, OPT_4, 0n);
        const info = await market.getBetInfo(betId);
        Assert.expect(info.odds).toEqual(10000n); // 100.00x

        const target = info.targetBlock;
        const end = info.endBlock;
        for (let b = target; b <= end; b++) {
            await setOracle(b, 49999n, 12000n, 1700000000n + (b - target) * 600n);
        }

        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(false);
    });

    // ════════════════════════════════════════════════════
    // SECURITY: Access control & edge cases
    // ════════════════════════════════════════════════════
    await vm.it('Security: non-deployer cannot setBlockData', async () => {
        await Assert.expect(async () => {
            await market.setBlockData(100n, 1500n, 12000n, 1700000000n, user);
        }).toThrow();
    });

    await vm.it('Security: non-deployer cannot processPayment', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_OU, OVER, 1000n);
        const info = await market.getBetInfo(betId);
        await setOracle(info.endBlock, 1500n);
        await resolve(betId);

        await Assert.expect(async () => {
            await market.processPayment(betId, 'some_address', user);
        }).toThrow();
    });

    await vm.it('Security: cannot resolve twice', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_OU, OVER, 1000n);
        const info = await market.getBetInfo(betId);
        await setOracle(info.endBlock, 1500n);
        await resolve(betId);

        await Assert.expect(async () => {
            await resolve(betId);
        }).toThrow('Already resolved');
    });

    await vm.it('Security: cannot pay lost bet', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_OU, OVER, 2000n);
        const info = await market.getBetInfo(betId);
        await setOracle(info.endBlock, 1500n);
        await resolve(betId);

        await Assert.expect(async () => {
            await market.processPayment(betId, 'bettor', deployer);
        }).toThrow('Bet not in WON state');
    });

    await vm.it('Security: oracle data is immutable', async () => {
        await setOracle(99n, 1500n);

        await Assert.expect(async () => {
            await setOracle(99n, 2000n); // try overwriting
        }).toThrow('Block data already set');
    });

    await vm.it('Security: solvency check prevents oversized bets', async () => {
        await setOracle(99n, 1500n);

        await Assert.expect(async () => {
            // 10M bet × 1.15x = 11.5M payout > 1M pool
            await placeBetAsUser(BET_OU, OVER, 1000n, 10_000_000n);
        }).toThrow('Insufficient pool liquidity');
    });

    await vm.it('Security: bet when paused reverts', async () => {
        await market.setPaused(true, deployer);

        await Assert.expect(async () => {
            await placeBetAsUser(BET_OU, OVER, 1000n);
        }).toThrow('Market is paused');
    });

    await vm.it('Security: invalid bet type reverts', async () => {
        await setOracle(99n, 1500n);

        await Assert.expect(async () => {
            await placeBetAsUser(99n, 1n, 0n);
        }).toThrow('Invalid bet type');
    });

    await vm.it('Security: invalid direction reverts', async () => {
        await setOracle(99n, 1500n);

        await Assert.expect(async () => {
            await placeBetAsUser(BET_OU, 3n, 1000n); // direction must be 1 or 2
        }).toThrow('Invalid direction');
    });

    await vm.it('Pool: drain works but not below exposure', async () => {
        // Drain some
        const result = await market.drainPool(500_000n, deployer);
        Assert.expect(result).toEqual(true);

        const pool = await market.getPoolInfo();
        Assert.expect(pool.totalPool).toEqual(500_000n);

        // Place a bet to create exposure
        await setOracle(99n, 1500n);
        await placeBetAsUser(BET_OU, OVER, 1000n, BET_AMOUNT);

        // Try to drain below exposure
        await Assert.expect(async () => {
            await market.drainPool(500_000n, deployer);
        }).toThrow('Cannot drain below pending exposure');
    });

    // ════════════════════════════════════════════════════
    // PAYOUT FLOW: processPayment end-to-end
    // ════════════════════════════════════════════════════
    await vm.it('Payout: processPayment after win sets SETTLED status', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_OU, OVER, 1000n);
        const info = await market.getBetInfo(betId);
        await setOracle(info.endBlock, 1500n);
        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(true);

        // Verify status is WON
        const afterResolve = await market.getBetInfo(betId);
        Assert.expect(afterResolve.status).toEqual(STATUS_WON);

        // processPayment: operator pays the bettor
        const bettorP2op = 'opt1p_bettor_test_address_for_unit_testing';
        mockPaymentOutput(bettorP2op, afterResolve.payout);
        await market.processPayment(betId, bettorP2op, deployer);
        clearTx();

        // Status should now be SETTLED
        const afterPay = await market.getBetInfo(betId);
        Assert.expect(afterPay.status).toEqual(STATUS_SETTLED);
    });

    await vm.it('Payout: payout math — profit fee is 5% of profit, not amount', async () => {
        await setOracle(99n, 1500n);
        // Use exact bet for predictable odds (50x)
        const betId = await placeBetAsUser(BET_EXACT, 1500n, 0n);
        const info = await market.getBetInfo(betId);
        Assert.expect(info.odds).toEqual(5000n);

        await setOracle(info.endBlock, 1500n); // exact match → win
        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(true);

        // grossPayout = 5000 * 5000 / 100 = 250000
        // profit = 250000 - 5000 = 245000
        // fee = 245000 * 500 / 10000 = 12250
        // payout = 250000 - 12250 = 237750
        Assert.expect(result.payout).toEqual(237750n);
    });

    await vm.it('Payout: cannot processPayment on ACTIVE bet', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_OU, OVER, 1000n);

        await Assert.expect(async () => {
            await market.processPayment(betId, 'some_addr', deployer);
        }).toThrow('Bet not in WON state');
    });

    await vm.it('Payout: cannot processPayment twice (SETTLED is not WON)', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_OU, OVER, 1000n);
        const info = await market.getBetInfo(betId);
        await setOracle(info.endBlock, 1500n);
        await resolve(betId);

        const afterResolve = await market.getBetInfo(betId);
        const bettorP2op = 'opt1p_bettor_test_address_for_unit_testing';
        mockPaymentOutput(bettorP2op, afterResolve.payout);
        await market.processPayment(betId, bettorP2op, deployer);
        clearTx();

        // Second processPayment should fail — status is now SETTLED
        await Assert.expect(async () => {
            mockPaymentOutput(bettorP2op, afterResolve.payout);
            await market.processPayment(betId, bettorP2op, deployer);
        }).toThrow('Bet not in WON state');
        clearTx();
    });

    // ════════════════════════════════════════════════════
    // REFUND PATH
    // ════════════════════════════════════════════════════
    await vm.it('Refund: works after expiry when oracle data missing', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_OU, OVER, 1000n);
        const info = await market.getBetInfo(betId);

        // Advance past expiry (endBlock + 200)
        Blockchain.blockNumber = info.endBlock + 201n;

        const refundAmount = await market.refundBet(betId, user);
        Assert.expect(refundAmount).toEqual(BET_AMOUNT); // full refund = original stake

        // Status should be WON (for processPayment flow)
        const after = await market.getBetInfo(betId);
        Assert.expect(after.status).toEqual(STATUS_WON);
        Assert.expect(after.payout).toEqual(BET_AMOUNT);
    });

    await vm.it('Refund: reverts before expiry', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_OU, OVER, 1000n);
        const info = await market.getBetInfo(betId);

        // Still within expiry window
        Blockchain.blockNumber = info.endBlock + 100n;

        await Assert.expect(async () => {
            await market.refundBet(betId, user);
        }).toThrow('Not yet expired');
    });

    await vm.it('Refund: reverts when oracle data exists', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_OU, OVER, 1000n);
        const info = await market.getBetInfo(betId);

        // Set oracle data AND advance past expiry
        await setOracle(info.endBlock, 1500n);
        Blockchain.blockNumber = info.endBlock + 201n;

        await Assert.expect(async () => {
            await market.refundBet(betId, user);
        }).toThrow('Oracle data exists - use resolveBet');
    });

    await vm.it('Refund: reverts on already resolved bet', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_OU, OVER, 1000n);
        const info = await market.getBetInfo(betId);
        await setOracle(info.endBlock, 1500n);
        await resolve(betId);

        Blockchain.blockNumber = info.endBlock + 201n;

        await Assert.expect(async () => {
            await market.refundBet(betId, user);
        }).toThrow('Already resolved');
    });

    // ════════════════════════════════════════════════════
    // EXACT: Additional boundary tests
    // ════════════════════════════════════════════════════
    await vm.it('Exact: loses at boundary+1 below prediction', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_EXACT, 1500n, 0n);
        const info = await market.getBetInfo(betId);

        // diff = 51 > 50 → lose
        await setOracle(info.endBlock, 1449n);
        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(false);
    });

    await vm.it('Exact: rejects zero prediction', async () => {
        await setOracle(99n, 1500n);

        await Assert.expect(async () => {
            await placeBetAsUser(BET_EXACT, 0n, 0n);
        }).toThrow('Prediction cannot be zero');
    });

    await vm.it('Exact: wins with very low prediction when fee matches', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_EXACT, 100n, 0n);
        const info = await market.getBetInfo(betId);

        // fee = 80, prediction = 100, diff = 20 <= 50 → win
        await setOracle(info.endBlock, 80n);
        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(true);
    });

    // ════════════════════════════════════════════════════
    // TREND: Tie and partial data
    // ════════════════════════════════════════════════════
    await vm.it('Trend: UP loses when avg fee exactly equals refFee (strict >)', async () => {
        await setOracle(99n, 1500n); // refFee = 1500

        const betId = await placeBetAsUser(BET_TREND, OVER, 0n);
        const info = await market.getBetInfo(betId);

        // Set all blocks to exactly 1500 → avg = 1500 = refFee
        const target = info.targetBlock;
        const end = info.endBlock;
        for (let b = target; b <= end; b++) {
            await setOracle(b, 1500n, 12000n, 1700000000n + (b - target) * 600n);
        }

        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(false); // gt fails: avg is NOT > refFee
    });

    await vm.it('Trend: DOWN loses when avg fee exactly equals refFee (strict <)', async () => {
        await setOracle(99n, 1500n);

        const betId = await placeBetAsUser(BET_TREND, UNDER, 0n);
        const info = await market.getBetInfo(betId);

        const target = info.targetBlock;
        const end = info.endBlock;
        for (let b = target; b <= end; b++) {
            await setOracle(b, 1500n, 12000n, 1700000000n + (b - target) * 600n);
        }

        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(false); // lt fails: avg is NOT < refFee
    });

    await vm.it('Trend: requires oracle fee to be set', async () => {
        // No oracle data set yet, so latestOracleFee = 0
        await Assert.expect(async () => {
            await placeBetAsUser(BET_TREND, OVER, 0n);
        }).toThrow('Oracle fee required for trend bet');
    });

    await vm.it('Trend: partial block data uses only available blocks', async () => {
        await setOracle(99n, 1500n); // refFee = 1500

        const betId = await placeBetAsUser(BET_TREND, OVER, 0n);
        const info = await market.getBetInfo(betId);

        // Only set first and last block with high fees, skip middle ones
        // Contract sums only blocks with dataSet > 0
        const target = info.targetBlock;
        const end = info.endBlock;
        await setOracle(target, 2000n, 12000n, 1700000000n);
        await setOracle(end, 2000n, 12000n, 1700003600n);

        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(true); // avg of 2000+2000 = 2000 > 1500
    });

    // ════════════════════════════════════════════════════
    // MEMPOOL: Missing boundary tests
    // ════════════════════════════════════════════════════
    await vm.it('Mempool Opt3: >20k loses when mempool = 20000', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_MEMPOOL, OPT_3, 0n);
        const info = await market.getBetInfo(betId);

        // Exactly 20000 → not strictly > 20000 → lose
        await setOracle(info.endBlock, 1500n, 20000n);
        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(false);
    });

    await vm.it('Mempool Opt3: >20k loses when mempool < 20000', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_MEMPOOL, OPT_3, 0n);
        const info = await market.getBetInfo(betId);

        await setOracle(info.endBlock, 1500n, 19000n);
        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(false);
    });

    await vm.it('Mempool Opt1: exactly at boundary 15001 wins', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_MEMPOOL, OPT_1, 0n);
        const info = await market.getBetInfo(betId);

        await setOracle(info.endBlock, 1500n, 15001n);
        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(true);
    });

    await vm.it('Mempool Opt2: exactly at boundary 9999 wins', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_MEMPOOL, OPT_2, 0n);
        const info = await market.getBetInfo(betId);

        await setOracle(info.endBlock, 1500n, 9999n);
        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(true);
    });

    await vm.it('Mempool Opt4: exactly at boundary 4999 wins', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_MEMPOOL, OPT_4, 0n);
        const info = await market.getBetInfo(betId);

        await setOracle(info.endBlock, 1500n, 4999n);
        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(true);
    });

    // ════════════════════════════════════════════════════
    // BLOCKTIME: Exact boundary tests
    // ════════════════════════════════════════════════════
    await vm.it('BlockTime: exactly 300s → Opt2 wins (300 is in 5-10min range)', async () => {
        await setOracle(99n, 1500n, 12000n, 1700000000n);
        const betId = await placeBetAsUser(BET_BLOCKTIME, OPT_2, 0n);
        const info = await market.getBetInfo(betId);

        const prevBlock = info.targetBlock - 1n;
        await setOracle(prevBlock, 1500n, 12000n, 1700000000n);
        await setOracle(info.targetBlock, 1500n, 12000n, 1700000300n); // exactly 300s

        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(true); // !lt(300, 300)=true && lt(300, 600)=true
    });

    await vm.it('BlockTime: exactly 600s → Opt3 wins (600 is in 10-20min range)', async () => {
        await setOracle(99n, 1500n, 12000n, 1700000000n);
        const betId = await placeBetAsUser(BET_BLOCKTIME, OPT_3, 0n);
        const info = await market.getBetInfo(betId);

        const prevBlock = info.targetBlock - 1n;
        await setOracle(prevBlock, 1500n, 12000n, 1700000000n);
        await setOracle(info.targetBlock, 1500n, 12000n, 1700000600n); // exactly 600s

        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(true); // !lt(600, 600)=true && lt(600, 1200)=true
    });

    await vm.it('BlockTime: exactly 600s → Opt2 loses (upper boundary exclusive)', async () => {
        await setOracle(99n, 1500n, 12000n, 1700000000n);
        const betId = await placeBetAsUser(BET_BLOCKTIME, OPT_2, 0n);
        const info = await market.getBetInfo(betId);

        const prevBlock = info.targetBlock - 1n;
        await setOracle(prevBlock, 1500n, 12000n, 1700000000n);
        await setOracle(info.targetBlock, 1500n, 12000n, 1700000600n); // exactly 600s

        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(false); // lt(600, 600)=false → fails
    });

    await vm.it('BlockTime: exactly 1200s → Opt4 wins (boundary inclusive)', async () => {
        await setOracle(99n, 1500n, 12000n, 1700000000n);
        const betId = await placeBetAsUser(BET_BLOCKTIME, OPT_4, 0n);
        const info = await market.getBetInfo(betId);

        const prevBlock = info.targetBlock - 1n;
        await setOracle(prevBlock, 1500n, 12000n, 1700000000n);
        await setOracle(info.targetBlock, 1500n, 12000n, 1700001200n); // exactly 1200s

        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(true); // !lt(1200, 1200)=true
    });

    await vm.it('BlockTime: exactly 1200s → Opt3 loses (upper boundary exclusive)', async () => {
        await setOracle(99n, 1500n, 12000n, 1700000000n);
        const betId = await placeBetAsUser(BET_BLOCKTIME, OPT_3, 0n);
        const info = await market.getBetInfo(betId);

        const prevBlock = info.targetBlock - 1n;
        await setOracle(prevBlock, 1500n, 12000n, 1700000000n);
        await setOracle(info.targetBlock, 1500n, 12000n, 1700001200n); // exactly 1200s

        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(false); // lt(1200, 1200)=false → fails
    });

    await vm.it('BlockTime: timestamp reversal → timeDiff=0 → Opt1 wins', async () => {
        await setOracle(99n, 1500n, 12000n, 1700000000n);
        const betId = await placeBetAsUser(BET_BLOCKTIME, OPT_1, 0n);
        const info = await market.getBetInfo(betId);

        const prevBlock = info.targetBlock - 1n;
        await setOracle(prevBlock, 1500n, 12000n, 1700001000n);
        // Target block timestamp <= prev → timeDiff = 0 (< 300) → Opt1 wins
        await setOracle(info.targetBlock, 1500n, 12000n, 1700000500n);

        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(true); // timeDiff=0 < 300
    });

    // ════════════════════════════════════════════════════
    // SPIKE: Missing cases
    // ════════════════════════════════════════════════════
    await vm.it('Spike Opt2: 100+ loses when max fee < 10000', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_SPIKE, OPT_2, 0n);
        const info = await market.getBetInfo(betId);

        const target = info.targetBlock;
        const end = info.endBlock;
        for (let b = target; b <= end; b++) {
            await setOracle(b, 9999n, 12000n, 1700000000n + (b - target) * 600n);
        }

        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(false);
    });

    await vm.it('Spike Opt3: 200+ loses when max fee < 20000', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_SPIKE, OPT_3, 0n);
        const info = await market.getBetInfo(betId);

        const target = info.targetBlock;
        const end = info.endBlock;
        for (let b = target; b <= end; b++) {
            await setOracle(b, 19999n, 12000n, 1700000000n + (b - target) * 600n);
        }

        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(false);
    });

    await vm.it('Spike Opt4: 500+ wins when max fee >= 50000', async () => {
        // Need bigger pool for 100x odds
        await market.seedPool(50_000_000n, deployer);
        await setOracle(99n, 1500n);

        const betId = await placeBetAsUser(BET_SPIKE, OPT_4, 0n);
        const info = await market.getBetInfo(betId);
        Assert.expect(info.odds).toEqual(10000n); // 100x

        const target = info.targetBlock;
        const end = info.endBlock;
        for (let b = target; b <= end; b++) {
            const fee = b === target + 10n ? 50000n : 1500n;
            await setOracle(b, fee, 12000n, 1700000000n + (b - target) * 600n);
        }

        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(true);
    });

    await vm.it('Spike Opt1: exact boundary — max fee = 5000 wins (>=)', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_SPIKE, OPT_1, 0n);
        const info = await market.getBetInfo(betId);

        const target = info.targetBlock;
        const end = info.endBlock;
        for (let b = target; b <= end; b++) {
            // All blocks at exactly 5000 → max = 5000 >= 5000
            await setOracle(b, 5000n, 12000n, 1700000000n + (b - target) * 600n);
        }

        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(true);
    });

    await vm.it('Spike Opt2: exact boundary — max fee = 10000 wins (>=)', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_SPIKE, OPT_2, 0n);
        const info = await market.getBetInfo(betId);

        const target = info.targetBlock;
        const end = info.endBlock;
        for (let b = target; b <= end; b++) {
            const fee = b === target ? 10000n : 1500n;
            await setOracle(b, fee, 12000n, 1700000000n + (b - target) * 600n);
        }

        const result = await resolve(betId);
        Assert.expect(result.won).toEqual(true);
    });

    // ════════════════════════════════════════════════════
    // CONCURRENT BETS & POOL ACCOUNTING
    // ════════════════════════════════════════════════════
    await vm.it('Concurrent: multiple active bets resolve independently', async () => {
        await setOracle(99n, 1500n);

        // Place 3 different bets
        const bet1 = await placeBetAsUser(BET_OU, OVER, 1000n);
        const bet2 = await placeBetAsUser(BET_OU, UNDER, 2000n);
        const bet3 = await placeBetAsUser(BET_OU, OVER, 3000n);

        const info1 = await market.getBetInfo(bet1);
        const info2 = await market.getBetInfo(bet2);
        const info3 = await market.getBetInfo(bet3);

        // All target same block. fee = 1500:
        // bet1: OVER 1000 → fee 1500 >= 1000 → WIN
        // bet2: UNDER 2000 → fee 1500 < 2000 → WIN
        // bet3: OVER 3000 → fee 1500 < 3000 → LOSE
        await setOracle(info1.endBlock, 1500n);

        const r1 = await resolve(bet1);
        const r2 = await resolve(bet2);
        const r3 = await resolve(bet3);

        Assert.expect(r1.won).toEqual(true);
        Assert.expect(r2.won).toEqual(true);
        Assert.expect(r3.won).toEqual(false);
    });

    await vm.it('Pool: exposure decreases after resolution', async () => {
        await setOracle(99n, 1500n);

        const poolBefore = await market.getPoolInfo();
        Assert.expect(poolBefore.pendingExposure).toEqual(0n);

        const betId = await placeBetAsUser(BET_OU, OVER, 1000n);
        const poolAfterBet = await market.getPoolInfo();
        Assert.expect(poolAfterBet.pendingExposure > 0n).toEqual(true);

        const info = await market.getBetInfo(betId);
        await setOracle(info.endBlock, 1500n);
        await resolve(betId);

        const poolAfterResolve = await market.getPoolInfo();
        Assert.expect(poolAfterResolve.pendingExposure).toEqual(0n);
    });

    await vm.it('Pool: lost bet keeps pool intact (pool retains deposit)', async () => {
        await setOracle(99n, 1500n);

        const poolBefore = await market.getPoolInfo();

        const betId = await placeBetAsUser(BET_OU, OVER, 2000n); // will lose
        const poolAfterBet = await market.getPoolInfo();
        // Pool increased by bet amount
        Assert.expect(poolAfterBet.totalPool).toEqual(poolBefore.totalPool + BET_AMOUNT);

        const info = await market.getBetInfo(betId);
        await setOracle(info.endBlock, 1500n);
        await resolve(betId);

        // Pool still has the bet amount (house wins)
        const poolAfterResolve = await market.getPoolInfo();
        Assert.expect(poolAfterResolve.totalPool).toEqual(poolBefore.totalPool + BET_AMOUNT);
    });

    // ════════════════════════════════════════════════════
    // MIN/MAX BET ENFORCEMENT
    // ════════════════════════════════════════════════════
    await vm.it('Security: below minimum bet (1000) reverts', async () => {
        await setOracle(99n, 1500n);

        await Assert.expect(async () => {
            await placeBetAsUser(BET_OU, OVER, 1000n, 999n);
        }).toThrow('Below minimum bet');
    });

    await vm.it('Security: above maximum bet (100M) reverts', async () => {
        await setOracle(99n, 1500n);
        await market.seedPool(500_000_000n, deployer); // huge pool

        await Assert.expect(async () => {
            await placeBetAsUser(BET_OU, OVER, 1000n, 100_000_001n);
        }).toThrow('Above maximum bet');
    });

    await vm.it('Security: setMinBet and setMaxBet update limits', async () => {
        await setOracle(99n, 1500n);

        // Raise min to 2000
        await market.setMinBet(2000n, deployer);

        // 1500 should now be below minimum
        await Assert.expect(async () => {
            await placeBetAsUser(BET_OU, OVER, 1000n, 1500n);
        }).toThrow('Below minimum bet');

        // 2000 should be fine
        const betId = await placeBetAsUser(BET_OU, OVER, 1000n, 2000n);
        Assert.expect(betId >= 0n).toEqual(true);
    });

    await vm.it('Security: non-deployer cannot setMinBet', async () => {
        await Assert.expect(async () => {
            await market.setMinBet(2000n, user);
        }).toThrow();
    });

    await vm.it('Security: non-deployer cannot seedPool', async () => {
        await Assert.expect(async () => {
            await market.seedPool(100n, user);
        }).toThrow();
    });

    await vm.it('Security: non-deployer cannot drainPool', async () => {
        await Assert.expect(async () => {
            await market.drainPool(100n, user);
        }).toThrow();
    });

    await vm.it('Security: invalid option (5) reverts for mempool bet', async () => {
        await setOracle(99n, 1500n);

        await Assert.expect(async () => {
            await placeBetAsUser(BET_MEMPOOL, 5n, 0n);
        }).toThrow('Invalid option');
    });

    await vm.it('Security: O/U threshold zero reverts', async () => {
        await setOracle(99n, 1500n);

        await Assert.expect(async () => {
            await placeBetAsUser(BET_OU, OVER, 0n);
        }).toThrow('Threshold cannot be zero');
    });

    await vm.it('Security: resolve reverts when block data not available', async () => {
        await setOracle(99n, 1500n);
        const betId = await placeBetAsUser(BET_OU, OVER, 1000n);

        // Don't set oracle for endBlock → should revert
        await Assert.expect(async () => {
            await resolve(betId);
        }).toThrow('Block data not yet available');
    });

    await vm.it('Security: refund on nonexistent bet reverts', async () => {
        Blockchain.blockNumber = 500n;

        await Assert.expect(async () => {
            await market.refundBet(999n, user);
        }).toThrow('Bet not found');
    });

    await vm.it('Security: bet ID increments correctly', async () => {
        await setOracle(99n, 1500n);

        const id1 = await placeBetAsUser(BET_OU, OVER, 1000n);
        const id2 = await placeBetAsUser(BET_OU, UNDER, 2000n);
        const id3 = await placeBetAsUser(BET_EXACT, 1500n, 0n);

        Assert.expect(id2).toEqual(id1 + 1n);
        Assert.expect(id3).toEqual(id2 + 1n);
    });
});
