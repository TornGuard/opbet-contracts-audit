/**
 * price-oracle.test.mts
 *
 * Unit tests for PriceOracle — multi-feeder, on-chain median aggregator.
 *
 * Test coverage:
 *   1. Deployment / getConfig
 *   2. Feeder management (addFeeder, removeFeeder, isFeeder, setMinFeeders)
 *   3. Solo mode (minFeeders=1) — single submission publishes immediately
 *   4. Multi-feeder mode (minFeeders=3) — median, threshold, order-independence
 *   5. Double-submission guard
 *   6. Deviation guard (>20% rejected)
 *   7. Stale-round auto-finalisation
 *   8. finalizeRound explicit call
 *   9. Access control (non-owner, non-feeder)
 */

import { Address, BinaryWriter } from '@btc-vision/transaction';
import { Assert, Blockchain, opnet, OPNetUnit } from '@btc-vision/unit-test-framework';
import { PriceOracleRuntime } from './runtime/PriceOracleRuntime.mjs';

// ── Constants ─────────────────────────────────────────────────────────────────

const BTC_USD = 0n;
const CONF    = 999_000n;   // 99.9% × 1e6

/** $67,000 × 1e8 */
const P67k = 6_700_000_000_000n;
/** $68,000 × 1e8 */
const P68k = 6_800_000_000_000n;
/** $66,000 × 1e8 */
const P66k = 6_600_000_000_000n;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Advance the VM block height by n. */
function advanceBlocks(n: number): void {
    Blockchain.blockNumber = Blockchain.blockNumber + BigInt(n);
}

// ── Test suite ────────────────────────────────────────────────────────────────

await opnet('PriceOracle', async (vm: OPNetUnit) => {

    let oracle:   PriceOracleRuntime;
    let deployer: Address;
    let feeder1:  Address;
    let feeder2:  Address;
    let feeder3:  Address;
    let stranger: Address;
    let oracleAddr: Address;

    // ── beforeEach — fresh state every test ──────────────────────────────────

    vm.beforeEach(async () => {
        Blockchain.dispose();
        Blockchain.clearContracts();
        await Blockchain.init();

        deployer   = Blockchain.generateRandomAddress();
        feeder1    = Blockchain.generateRandomAddress();
        feeder2    = Blockchain.generateRandomAddress();
        feeder3    = Blockchain.generateRandomAddress();
        stranger   = Blockchain.generateRandomAddress();
        oracleAddr = Blockchain.generateRandomAddress();

        oracle = new PriceOracleRuntime(deployer, oracleAddr);
        Blockchain.register(oracle);

        // Deploy: minFeeders=1, roundDuration=0 (use default 60)
        await oracle.init();

        // Set deployer as the default sender
        Blockchain.txOrigin = deployer;
        Blockchain.msgSender = deployer;
    });

    vm.afterEach(() => {
        oracle.dispose();
        Blockchain.dispose();
    });

    // ── 1. Deployment ─────────────────────────────────────────────────────────

    await vm.it('deployment: getConfig returns correct defaults', async () => {
        const cfg = await oracle.getConfig();
        Assert.expect(cfg.minFeeders).toEqual(1n);
        Assert.expect(cfg.feederCount).toEqual(0n);
        Assert.expect(cfg.roundDuration).toEqual(60n); // DEFAULT_ROUND_DURATION
        vm.info(`Config: minFeeders=${cfg.minFeeders} feederCount=${cfg.feederCount} roundDur=${cfg.roundDuration}`);
    });

    await vm.it('deployment: latestPrice is 0 before any submission', async () => {
        const p = await oracle.latestPrice(BTC_USD);
        Assert.expect(p).toEqual(0n);
    });

    // ── 2. Feeder management ──────────────────────────────────────────────────

    await vm.it('feeder: addFeeder registers the feeder', async () => {
        await oracle.addFeeder(feeder1);
        Assert.expect(await oracle.isFeeder(feeder1)).toEqual(true);
        const cfg = await oracle.getConfig();
        Assert.expect(cfg.feederCount).toEqual(1n);
    });

    await vm.it('feeder: isFeeder returns false for unknown address', async () => {
        Assert.expect(await oracle.isFeeder(stranger)).toEqual(false);
    });

    await vm.it('feeder: removeFeeder deregisters the feeder', async () => {
        await oracle.addFeeder(feeder1);
        await oracle.removeFeeder(feeder1);
        Assert.expect(await oracle.isFeeder(feeder1)).toEqual(false);
        const cfg = await oracle.getConfig();
        Assert.expect(cfg.feederCount).toEqual(0n);
    });

    await vm.it('feeder: cannot addFeeder twice', async () => {
        await oracle.addFeeder(feeder1);
        await Assert.expect(async () => oracle.addFeeder(feeder1)).toThrow();
    });

    await vm.it('feeder: cannot removeFeeder if not registered', async () => {
        await Assert.expect(async () => oracle.removeFeeder(stranger)).toThrow();
    });

    await vm.it('feeder: setMinFeeders works when feederCount >= min', async () => {
        await oracle.addFeeder(feeder1);
        await oracle.addFeeder(feeder2);
        await oracle.addFeeder(feeder3);
        const ok = await oracle.setMinFeeders(2n);
        Assert.expect(ok).toEqual(true);
        const cfg = await oracle.getConfig();
        Assert.expect(cfg.minFeeders).toEqual(2n);
    });

    await vm.it('feeder: setMinFeeders rejects min > feederCount', async () => {
        await oracle.addFeeder(feeder1);
        await Assert.expect(async () => oracle.setMinFeeders(3n)).toThrow();
    });

    // ── 3. Solo mode (minFeeders=1) ───────────────────────────────────────────

    await vm.it('solo: single submission publishes price immediately', async () => {
        await oracle.addFeeder(feeder1);

        const { published } = await oracle.submitPrice(BTC_USD, P67k, CONF, feeder1);
        Assert.expect(published).toEqual(true);

        const p = await oracle.latestPrice(BTC_USD);
        Assert.expect(p).toEqual(P67k);
    });

    await vm.it('solo: getPrice returns correct data after publish', async () => {
        await oracle.addFeeder(feeder1);
        await oracle.submitPrice(BTC_USD, P67k, CONF, feeder1);

        const info = await oracle.getPrice(BTC_USD);
        Assert.expect(info.price).toEqual(P67k);
        Assert.expect(info.confidence).toEqual(CONF);
        Assert.expect(info.roundId).toEqual(1n);
        Assert.expect(info.isFresh).toEqual(true);
        vm.info(`Price: $${Number(info.price) / 1e8} roundId=${info.roundId} fresh=${info.isFresh}`);
    });

    await vm.it('solo: second submission opens a new round and publishes', async () => {
        await oracle.addFeeder(feeder1);

        await oracle.submitPrice(BTC_USD, P67k, CONF, feeder1);
        const { published } = await oracle.submitPrice(BTC_USD, P68k, CONF, feeder1);
        Assert.expect(published).toEqual(true);

        const info = await oracle.getPrice(BTC_USD);
        Assert.expect(info.price).toEqual(P68k);
        Assert.expect(info.roundId).toEqual(2n);
    });

    // ── 4. Multi-feeder mode (minFeeders=3) ───────────────────────────────────

    await vm.it('multi: does not publish until threshold is met', async () => {
        await oracle.addFeeder(feeder1);
        await oracle.addFeeder(feeder2);
        await oracle.addFeeder(feeder3);
        await oracle.setMinFeeders(3n);

        const r1 = await oracle.submitPrice(BTC_USD, P67k, CONF, feeder1);
        Assert.expect(r1.published).toEqual(false);

        const r2 = await oracle.submitPrice(BTC_USD, P68k, CONF, feeder2);
        Assert.expect(r2.published).toEqual(false);

        // Still 0 before threshold
        Assert.expect(await oracle.latestPrice(BTC_USD)).toEqual(0n);
    });

    await vm.it('multi: publishes median on third submission', async () => {
        await oracle.addFeeder(feeder1);
        await oracle.addFeeder(feeder2);
        await oracle.addFeeder(feeder3);
        await oracle.setMinFeeders(3n);

        // Prices: P66k, P67k, P68k — median = P67k
        await oracle.submitPrice(BTC_USD, P66k, CONF, feeder1);
        await oracle.submitPrice(BTC_USD, P68k, CONF, feeder2);
        const r3 = await oracle.submitPrice(BTC_USD, P67k, CONF, feeder3);

        Assert.expect(r3.published).toEqual(true);
        Assert.expect(await oracle.latestPrice(BTC_USD)).toEqual(P67k);
        vm.info(`Median of [P66k, P68k, P67k] = $${Number(await oracle.latestPrice(BTC_USD)) / 1e8}`);
    });

    await vm.it('multi: median is correct for even number of feeders (average of middle two)', async () => {
        await oracle.addFeeder(feeder1);
        await oracle.addFeeder(feeder2);
        await oracle.setMinFeeders(2n);

        // Two prices: P66k, P68k — median = average = P67k
        await oracle.submitPrice(BTC_USD, P66k, CONF, feeder1);
        const r = await oracle.submitPrice(BTC_USD, P68k, CONF, feeder2);

        Assert.expect(r.published).toEqual(true);
        Assert.expect(await oracle.latestPrice(BTC_USD)).toEqual(P67k);
    });

    await vm.it('multi: submission order does not affect median result', async () => {
        await oracle.addFeeder(feeder1);
        await oracle.addFeeder(feeder2);
        await oracle.addFeeder(feeder3);
        await oracle.setMinFeeders(3n);

        // Submit in reverse order: high, low, mid — should still get mid
        await oracle.submitPrice(BTC_USD, P68k, CONF, feeder1);
        await oracle.submitPrice(BTC_USD, P66k, CONF, feeder2);
        await oracle.submitPrice(BTC_USD, P67k, CONF, feeder3);

        Assert.expect(await oracle.latestPrice(BTC_USD)).toEqual(P67k);
    });

    // ── 5. Double-submission guard ────────────────────────────────────────────

    await vm.it('double-submit: same feeder cannot submit twice in one round', async () => {
        await oracle.addFeeder(feeder1);
        await oracle.addFeeder(feeder2);
        await oracle.setMinFeeders(2n);

        await oracle.submitPrice(BTC_USD, P67k, CONF, feeder1);

        // feeder1 tries again in the same round
        await Assert.expect(async () =>
            oracle.submitPrice(BTC_USD, P68k, CONF, feeder1),
        ).toThrow();
    });

    // ── 6. Deviation guard ────────────────────────────────────────────────────

    await vm.it('deviation: price within 20% is accepted', async () => {
        await oracle.addFeeder(feeder1);

        // Establish a base price
        await oracle.submitPrice(BTC_USD, P67k, CONF, feeder1);

        // Second submission: ~1% deviation — should be accepted
        const p2 = P67k + P67k / 100n;  // +1%
        const { published } = await oracle.submitPrice(BTC_USD, p2, CONF, feeder1);
        Assert.expect(published).toEqual(true);
    });

    await vm.it('deviation: price >20% above last accepted is rejected', async () => {
        await oracle.addFeeder(feeder1);

        // Establish base price
        await oracle.submitPrice(BTC_USD, P67k, CONF, feeder1);

        // +25% deviation — should revert
        const spikePrime = (P67k * 125n) / 100n;
        await Assert.expect(async () =>
            oracle.submitPrice(BTC_USD, spikePrime, CONF, feeder1),
        ).toThrow();
    });

    await vm.it('deviation: price >20% below last accepted is rejected', async () => {
        await oracle.addFeeder(feeder1);
        await oracle.submitPrice(BTC_USD, P67k, CONF, feeder1);

        // -25% deviation — should revert
        const crashPrice = (P67k * 75n) / 100n;
        await Assert.expect(async () =>
            oracle.submitPrice(BTC_USD, crashPrice, CONF, feeder1),
        ).toThrow();
    });

    // ── 7. Stale-round auto-finalisation ──────────────────────────────────────

    await vm.it('stale: next submitPrice auto-finalises stale round', async () => {
        await oracle.addFeeder(feeder1);
        await oracle.addFeeder(feeder2);
        await oracle.setMinFeeders(2n);

        // feeder1 submits — opens round 1, not yet published
        await oracle.submitPrice(BTC_USD, P67k, CONF, feeder1);
        Assert.expect(await oracle.latestPrice(BTC_USD)).toEqual(0n);

        // Advance past the round duration (default 60 blocks)
        advanceBlocks(61);

        // feeder1 submits again — auto-finalises stale round 1 first, then opens round 2
        const { published } = await oracle.submitPrice(BTC_USD, P67k, CONF, feeder1);
        // `published` reflects round 2 (feeder1 is 1 of 2 needed) → false
        Assert.expect(published).toEqual(false);
        vm.info(`Auto-finalised stale round. Published=${published} price=${await oracle.latestPrice(BTC_USD)}`);

        // Stale round was finalised → latestPrice is now P67k (median of round 1's 1 submission)
        Assert.expect(await oracle.latestPrice(BTC_USD)).toEqual(P67k);
    });

    // ── 8. finalizeRound explicit call ────────────────────────────────────────

    await vm.it('finalizeRound: rejects if round is not stale yet', async () => {
        await oracle.addFeeder(feeder1);
        await oracle.addFeeder(feeder2);
        await oracle.setMinFeeders(2n);

        await oracle.submitPrice(BTC_USD, P67k, CONF, feeder1);

        // Round is still fresh — should revert
        const res = await oracle.finalizeRound(BTC_USD, stranger);
        Assert.expect(res.error).toBeDefined();
    });

    await vm.it('finalizeRound: succeeds after round is stale', async () => {
        await oracle.addFeeder(feeder1);
        await oracle.addFeeder(feeder2);
        await oracle.setMinFeeders(2n);

        await oracle.submitPrice(BTC_USD, P67k, CONF, feeder1);

        advanceBlocks(61);

        const res = await oracle.finalizeRound(BTC_USD, stranger);
        Assert.expect(res.error).toBeUndefined();

        // The stale round had 1 submission — should be published
        Assert.expect(await oracle.latestPrice(BTC_USD)).toEqual(P67k);
    });

    await vm.it('finalizeRound: rejects if no open round', async () => {
        const res = await oracle.finalizeRound(BTC_USD, stranger);
        Assert.expect(res.error).toBeDefined();
    });

    // ── 9. Access control ─────────────────────────────────────────────────────

    await vm.it('access: non-feeder cannot submitPrice', async () => {
        // stranger is not registered as feeder
        await Assert.expect(async () =>
            oracle.submitPrice(BTC_USD, P67k, CONF, stranger),
        ).toThrow();
    });

    await vm.it('access: non-owner cannot addFeeder', async () => {
        await Assert.expect(async () =>
            oracle.addFeeder(feeder1, stranger),
        ).toThrow();
    });

    await vm.it('access: non-owner cannot removeFeeder', async () => {
        await oracle.addFeeder(feeder1);
        await Assert.expect(async () =>
            oracle.removeFeeder(feeder1, stranger),
        ).toThrow();
    });

    await vm.it('access: non-owner cannot setMinFeeders', async () => {
        await oracle.addFeeder(feeder1);
        await Assert.expect(async () =>
            oracle.setMinFeeders(1n, stranger),
        ).toThrow();
    });

    await vm.it('access: non-owner cannot setRoundDuration', async () => {
        await Assert.expect(async () =>
            oracle.setRoundDuration(120n, stranger),
        ).toThrow();
    });

    // ── 10. Price cannot be zero ──────────────────────────────────────────────

    await vm.it('validation: zero price is rejected', async () => {
        await oracle.addFeeder(feeder1);
        await Assert.expect(async () =>
            oracle.submitPrice(BTC_USD, 0n, CONF, feeder1),
        ).toThrow();
    });

    // ── 11. Gas profiling ─────────────────────────────────────────────────────

    await vm.it('gas: solo submitPrice gas cost', async () => {
        await oracle.addFeeder(feeder1);
        const { response } = await oracle.submitPrice(BTC_USD, P67k, CONF, feeder1);
        vm.info(`Gas (solo submitPrice): ${response.usedGas}`);
        Assert.expect(response.usedGas).toBeGreaterThan(0n);
    });

    await vm.it('gas: 3-feeder submitPrice (finalising round) gas cost', async () => {
        await oracle.addFeeder(feeder1);
        await oracle.addFeeder(feeder2);
        await oracle.addFeeder(feeder3);
        await oracle.setMinFeeders(3n);

        await oracle.submitPrice(BTC_USD, P66k, CONF, feeder1);
        await oracle.submitPrice(BTC_USD, P68k, CONF, feeder2);
        const { response } = await oracle.submitPrice(BTC_USD, P67k, CONF, feeder3);
        vm.info(`Gas (3-feeder, finalising): ${response.usedGas}`);
        Assert.expect(response.usedGas).toBeGreaterThan(0n);
    });
});
