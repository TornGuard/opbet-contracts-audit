import { Address, BinaryWriter } from '@btc-vision/transaction';
import {
    opnet, OPNetUnit, Assert, Blockchain,
    OP20,
} from '@btc-vision/unit-test-framework';
import { FeeBetMarketRuntime } from './runtime/FeeBetMarketRuntime.js';
import { createRequire } from 'module';

const ONE = 10n ** 18n;
const BET_OU = 1n;
const OVER = 1n;
const UNDER = 2n;
const STATUS_ACTIVE = 0n;
const STATUS_LOST = 1n;
const STATUS_WON = 2n;
const STATUS_SETTLED = 3n;

// Fix ESM/CJS dual-package hazard
// Get the CJS Blockchain singleton used by ContractRuntime
const require2 = createRequire(import.meta.url);
const { Blockchain: CjsBlockchain } = require2('@btc-vision/unit-test-framework');

{
    const proto = FeeBetMarketRuntime.prototype as any;
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
}

await opnet('FeeBet_Market v8 — Token-based E2E', async (vm: OPNetUnit) => {
    let market: FeeBetMarketRuntime;
    let token: OP20;
    let deployer: Address;
    let user: Address;
    let marketAddr: Address;
    let tokenAddr: Address;

    vm.beforeEach(async () => {
        Blockchain.dispose();
        Blockchain.clearContracts();
        CjsBlockchain.dispose();
        CjsBlockchain.clearContracts();
        await Blockchain.init();

        deployer = Blockchain.generateRandomAddress();
        user = Blockchain.generateRandomAddress();
        marketAddr = Blockchain.generateRandomAddress();
        tokenAddr = Blockchain.generateRandomAddress();

        Blockchain.blockNumber = 1000n;
        Blockchain.msgSender = deployer;
        Blockchain.txOrigin = deployer;
        CjsBlockchain.blockNumber = 1000n;
        CjsBlockchain.msgSender = deployer;
        CjsBlockchain.txOrigin = deployer;

        // Deploy OPBET_Token
        token = new OP20({
            file: './build/OPBET_Token.wasm',
            decimals: 18,
            address: tokenAddr,
            deployer: deployer,
            gasLimit: 300_000_000_000n,
            deploymentCalldata: Buffer.from((() => {
                const w = new BinaryWriter();
                w.writeAddress(deployer); // team wallet
                return w.getBuffer();
            })()),
        });

        // Register on BOTH Blockchain singletons (ESM + CJS)
        Blockchain.register(token);
        CjsBlockchain.register(token);
        await token.init();

        // Deploy FeeBet_Market
        market = new FeeBetMarketRuntime(deployer, marketAddr, tokenAddr);
        Blockchain.register(market);
        CjsBlockchain.register(market);
        await market.init();
    });

    vm.afterEach(() => {
        Blockchain.dispose();
        CjsBlockchain.dispose();
    });

    // ═══════════════════════════════════════════
    // Basic setup tests
    // ═══════════════════════════════════════════

    await vm.it('should deploy and have nextBetId=1', async () => {
        const nextId = await market.getNextBetId();
        Assert.expect(nextId).toEqual(1n);
    });

    await vm.it('should add accepted token', async () => {
        await market.addAcceptedToken(tokenAddr, deployer);
        const accepted = await market.isTokenAccepted(tokenAddr);
        Assert.expect(accepted).toEqual(true);
    });

    await vm.it('should set maxBet', async () => {
        await market.setMaxBet(1000n * ONE, deployer);
        // If it doesn't throw, it worked
    });

    // ═══════════════════════════════════════════
    // Pool management tests
    // ═══════════════════════════════════════════

    await vm.it('should mint tokens and seed pool', async () => {
        // Mint tokens to deployer
        await token.mintRaw(deployer, 10000n * ONE);
        const bal = await token.balanceOf(deployer);
        Assert.expect(bal).toEqual(10000n * ONE);

        // Approve market
        await token.increaseAllowance(deployer, marketAddr, 10000n * ONE);

        // Add token and seed pool
        await market.addAcceptedToken(tokenAddr, deployer);
        await market.seedPool(tokenAddr, 5000n * ONE, deployer);

        const pool = await market.getPoolInfo(tokenAddr);
        Assert.expect(pool.totalPool).toEqual(5000n * ONE);
        Assert.expect(pool.pendingExposure).toEqual(0n);
    });

    // ═══════════════════════════════════════════
    // Bet placement tests
    // ═══════════════════════════════════════════

    await vm.it('should place O/U bet and read bet info', async () => {
        // Setup: mint, approve, add token, seed, set maxBet
        await token.mintRaw(deployer, 10000n * ONE);
        await token.increaseAllowance(deployer, marketAddr, 10000n * ONE);
        await market.addAcceptedToken(tokenAddr, deployer);
        await market.setMaxBet(1000n * ONE, deployer);
        await market.seedPool(tokenAddr, 5000n * ONE, deployer);

        // Set oracle for current block-1
        await market.setBlockData(999n, 1500n, 12000n, 1710000000n, deployer);

        // Place bet: OVER 1000, 10 tokens
        const betId = await market.placeBet(tokenAddr, BET_OU, OVER, 1000n, 10n * ONE, deployer);
        Assert.expect(betId).toEqual(1n);

        // Read bet info
        const info = await market.getBetInfo(1n);
        Assert.expect(info.betType).toEqual(BET_OU);
        Assert.expect(info.amount).toEqual(10n * ONE);
        Assert.expect(info.status).toEqual(STATUS_ACTIVE);
        Assert.expect(info.odds).toEqual(115n); // O/U default odds

        // Pool should reflect the deposit
        const pool = await market.getPoolInfo(tokenAddr);
        Assert.expect(pool.totalPool).toEqual(5010n * ONE); // 5000 + 10
        Assert.expect(pool.pendingExposure > 0n).toEqual(true);
    });

    // ═══════════════════════════════════════════
    // Resolution tests — THE CRITICAL TEST
    // ═══════════════════════════════════════════

    await vm.it('should resolve winning O/U bet and auto-pay', async () => {
        // Full setup
        await token.mintRaw(deployer, 10000n * ONE);
        await token.increaseAllowance(deployer, marketAddr, 10000n * ONE);
        await market.addAcceptedToken(tokenAddr, deployer);
        await market.setMaxBet(1000n * ONE, deployer);
        await market.seedPool(tokenAddr, 1000n * ONE, deployer);

        // Set oracle for block 999
        await market.setBlockData(999n, 1500n, 12000n, 1710000000n, deployer);

        // Place bet: OVER 1000, 10 tokens
        const betId = await market.placeBet(tokenAddr, BET_OU, OVER, 1000n, 10n * ONE, deployer);
        Assert.expect(betId).toEqual(1n);

        const info = await market.getBetInfo(1n);
        const targetBlock = info.targetBlock;

        // Advance block past target
        Blockchain.blockNumber = targetBlock + 1n;

        // Set oracle for target: fee=1500 > 1000 → OVER wins
        await market.setBlockData(targetBlock, 1500n, 12000n, 1710001000n, deployer);

        // RESOLVE — this is where the SafeMath underflow was happening
        const result = await market.resolveBet(1n, deployer);
        Assert.expect(result.won).toEqual(true);
        Assert.expect(result.payout > 0n).toEqual(true);

        // Check final bet status
        const afterInfo = await market.getBetInfo(1n);
        Assert.expect(afterInfo.status === STATUS_WON || afterInfo.status === STATUS_SETTLED).toEqual(true);
        Assert.expect(afterInfo.payout > 0n).toEqual(true);

        // Pool exposure should be 0 after resolution
        const pool = await market.getPoolInfo(tokenAddr);
        Assert.expect(pool.pendingExposure).toEqual(0n);
    });

    await vm.it('should resolve losing O/U bet', async () => {
        await token.mintRaw(deployer, 10000n * ONE);
        await token.increaseAllowance(deployer, marketAddr, 10000n * ONE);
        await market.addAcceptedToken(tokenAddr, deployer);
        await market.setMaxBet(1000n * ONE, deployer);
        await market.seedPool(tokenAddr, 1000n * ONE, deployer);
        await market.setBlockData(999n, 1500n, 12000n, 1710000000n, deployer);

        // OVER 2000, but fee will be 1500 → lose
        const betId = await market.placeBet(tokenAddr, BET_OU, OVER, 2000n, 10n * ONE, deployer);

        const info = await market.getBetInfo(betId);
        Blockchain.blockNumber = info.targetBlock + 1n;

        // fee=1500 < 2000 → OVER loses
        await market.setBlockData(info.targetBlock, 1500n, 12000n, 1710001000n, deployer);

        const result = await market.resolveBet(betId, deployer);
        Assert.expect(result.won).toEqual(false);
        Assert.expect(result.payout).toEqual(0n);

        const afterInfo = await market.getBetInfo(betId);
        Assert.expect(afterInfo.status).toEqual(STATUS_LOST);
    });

    // ═══════════════════════════════════════════
    // Pool accounting after resolution
    // ═══════════════════════════════════════════

    await vm.it('should have correct pool after win+loss cycle', async () => {
        await token.mintRaw(deployer, 10000n * ONE);
        await token.increaseAllowance(deployer, marketAddr, 10000n * ONE);
        await market.addAcceptedToken(tokenAddr, deployer);
        await market.setMaxBet(1000n * ONE, deployer);
        await market.seedPool(tokenAddr, 1000n * ONE, deployer);

        // Bet 1: WIN (OVER 1000, fee=1500)
        await market.setBlockData(999n, 1500n, 12000n, 1710000000n, deployer);
        const bet1 = await market.placeBet(tokenAddr, BET_OU, OVER, 1000n, 10n * ONE, deployer);
        const info1 = await market.getBetInfo(bet1);
        Blockchain.blockNumber = info1.targetBlock + 1n;
        await market.setBlockData(info1.targetBlock, 1500n, 12000n, 1710001000n, deployer);
        const r1 = await market.resolveBet(bet1, deployer);
        Assert.expect(r1.won).toEqual(true);

        // Bet 2: LOSE (OVER 2000, fee=1500)
        Blockchain.blockNumber = info1.targetBlock + 2n;
        await market.setBlockData(info1.targetBlock + 1n, 1500n, 12000n, 1710002000n, deployer);
        const bet2 = await market.placeBet(tokenAddr, BET_OU, OVER, 2000n, 10n * ONE, deployer);
        const info2 = await market.getBetInfo(bet2);
        Blockchain.blockNumber = info2.targetBlock + 1n;
        await market.setBlockData(info2.targetBlock, 1500n, 12000n, 1710003000n, deployer);
        const r2 = await market.resolveBet(bet2, deployer);
        Assert.expect(r2.won).toEqual(false);

        // Pool accounting
        const pool = await market.getPoolInfo(tokenAddr);
        Assert.expect(pool.pendingExposure).toEqual(0n);
        Assert.expect(pool.totalPool > 0n).toEqual(true);
    });

    // ═══════════════════════════════════════════
    // Drain pool test
    // ═══════════════════════════════════════════

    await vm.it('should drain pool after all bets resolved', async () => {
        await token.mintRaw(deployer, 10000n * ONE);
        await token.increaseAllowance(deployer, marketAddr, 10000n * ONE);
        await market.addAcceptedToken(tokenAddr, deployer);
        await market.setMaxBet(1000n * ONE, deployer);
        await market.seedPool(tokenAddr, 100n * ONE, deployer);

        const poolBefore = await market.getPoolInfo(tokenAddr);
        await market.drainPool(tokenAddr, ONE, deployer);
        const poolAfter = await market.getPoolInfo(tokenAddr);

        Assert.expect(poolAfter.totalPool < poolBefore.totalPool).toEqual(true);
    });
});
