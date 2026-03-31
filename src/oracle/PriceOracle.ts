import { u256 } from '@btc-vision/as-bignum/assembly';
import {
    Address,
    AddressMemoryMap,
    Blockchain,
    BytesWriter,
    Calldata,
    OP_NET,
    Revert,
    SafeMath,
    StoredU256,
    StoredMapU256,
    EMPTY_POINTER,
} from '@btc-vision/btc-runtime/runtime';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum registered feeders. Bounds all loops — gas predictable. */
const MAX_FEEDERS: u32 = 10;

/**
 * Composite storage key helpers.
 * symbolId is expected to be small (0=BTC, 1=ETH, …).
 * feederIdx is 1–MAX_FEEDERS.
 * Key space: symbolId * 100 + feederIdx — safe for symbolId < 10_000.
 */
function pendingKey(symbolId: u256, feederIdx: u256): u256 {
    return SafeMath.add(SafeMath.mul(symbolId, u256.fromU32(100)), feederIdx);
}

/** Default round duration: 60 OPNet blocks (~1 h assuming 1-min OPNet blocks). */
const DEFAULT_ROUND_DURATION: u256 = u256.fromU32(60);

/**
 * Max deviation allowed between a new submission and the last accepted price.
 * 2000 = 20% in basis points (10_000 = 100%).
 * Prevents a compromised feeder from moving price by more than 20% alone.
 */
const MAX_DEVIATION_BPS: u256 = u256.fromU32(2000);
const BPS_BASE: u256           = u256.fromU32(10000);

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PriceOracle — Decentralised multi-feeder price aggregator for OPNet.
 *
 * ## How it works
 *
 * 1. Owner whitelists feeder wallet addresses (addFeeder).
 * 2. Each feeder runs its own keeper and calls submitPrice(symbolId, price, confidence).
 * 3. The first submission for a symbol opens a new "round".
 * 4. When `minFeeders` distinct feeders have submitted within the round, the
 *    contract computes the on-chain median and publishes it as the accepted price.
 * 5. If a round is older than `roundDuration` blocks and has at least one
 *    submission, any subsequent submitPrice call auto-finalises it first, then
 *    opens a new round.  No separate cron or manual tx needed.
 *
 * ## Running solo (Phase 1)
 *
 * Deploy with minFeeders = 1.  A single keeper works exactly as before — every
 * submission is accepted immediately.  Add more feeders and raise minFeeders
 * as the network grows.
 *
 * ## Gas profile
 *
 * All loops are bounded by MAX_FEEDERS (10).  Median is an insertion sort on
 * ≤10 u256s.  No unbounded iteration.
 */
@final
export class PriceOracle extends OP_NET {

    // ── Global config storage ─────────────────────────────────────────────────

    private readonly minFeedersPointer:    u16 = Blockchain.nextPointer;
    private readonly feederCountPointer:   u16 = Blockchain.nextPointer;
    private readonly roundDurationPointer: u16 = Blockchain.nextPointer;

    private readonly _minFeeders:    StoredU256 = new StoredU256(this.minFeedersPointer,    EMPTY_POINTER);
    private readonly _feederCount:   StoredU256 = new StoredU256(this.feederCountPointer,   EMPTY_POINTER);
    private readonly _roundDuration: StoredU256 = new StoredU256(this.roundDurationPointer, EMPTY_POINTER);

    // ── Feeder registry ───────────────────────────────────────────────────────
    // feeder address → 1-based index  (0 = not a feeder)

    private readonly feedersPointer: u16 = Blockchain.nextPointer;
    private readonly _feeders: AddressMemoryMap = new AddressMemoryMap(this.feedersPointer);

    // ── Per-symbol round state (keyed by symbolId) ────────────────────────────

    private readonly roundIdPointer:        u16 = Blockchain.nextPointer;
    private readonly roundOpenedAtPointer:  u16 = Blockchain.nextPointer;
    private readonly roundCountPointer:     u16 = Blockchain.nextPointer;

    private readonly _roundId:       StoredMapU256 = new StoredMapU256(this.roundIdPointer);
    private readonly _roundOpenedAt: StoredMapU256 = new StoredMapU256(this.roundOpenedAtPointer);
    private readonly _roundCount:    StoredMapU256 = new StoredMapU256(this.roundCountPointer);

    // ── Per-symbol published state ────────────────────────────────────────────

    private readonly latestPricePointer:       u16 = Blockchain.nextPointer;
    private readonly latestConfidencePointer:  u16 = Blockchain.nextPointer;
    private readonly latestUpdateBlockPointer: u16 = Blockchain.nextPointer;
    private readonly latestRoundIdPointer:     u16 = Blockchain.nextPointer;

    private readonly _latestPrice:       StoredMapU256 = new StoredMapU256(this.latestPricePointer);
    private readonly _latestConfidence:  StoredMapU256 = new StoredMapU256(this.latestConfidencePointer);
    private readonly _latestUpdateBlock: StoredMapU256 = new StoredMapU256(this.latestUpdateBlockPointer);
    private readonly _latestRoundId:     StoredMapU256 = new StoredMapU256(this.latestRoundIdPointer);

    // ── Per-(symbol × feederIdx) pending submissions ──────────────────────────
    // key = pendingKey(symbolId, feederIdx)

    private readonly pendingPricePointer:      u16 = Blockchain.nextPointer;
    private readonly pendingConfPointer:       u16 = Blockchain.nextPointer;
    private readonly submittedInRoundPointer:  u16 = Blockchain.nextPointer;

    private readonly _pendingPrice:     StoredMapU256 = new StoredMapU256(this.pendingPricePointer);
    private readonly _pendingConf:      StoredMapU256 = new StoredMapU256(this.pendingConfPointer);
    /** Stores the roundId at which feeder last submitted for this symbol. */
    private readonly _submittedInRound: StoredMapU256 = new StoredMapU256(this.submittedInRoundPointer);

    // ─────────────────────────────────────────────────────────────────────────
    // DEPLOYMENT
    // ─────────────────────────────────────────────────────────────────────────

    public constructor() {
        super();
    }

    /**
     * @param minFeeders  Minimum feeders required to publish a price (1 = solo mode).
     * @param roundDuration  OPNet blocks a round stays open (0 = use default 60).
     */
    public override onDeployment(calldata: Calldata): void {
        const min: u256 = calldata.readU256();
        const dur: u256 = calldata.readU256();

        if (u256.eq(min, u256.Zero)) throw new Revert('minFeeders must be >= 1');

        this._minFeeders.set(min);
        this._roundDuration.set(u256.eq(dur, u256.Zero) ? DEFAULT_ROUND_DURATION : dur);
        this._feederCount.set(u256.Zero);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ADMIN — FEEDER MANAGEMENT
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Register a new feeder wallet.
     * Only the contract deployer can call this.
     *
     * @param feeder  p2tr address of the feeder's wallet.
     */
    @method({ name: 'feeder', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public addFeeder(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);

        const feeder: Address = calldata.readAddress();
        if (feeder.equals(Address.zero())) throw new Revert('Invalid feeder address');

        const existing: u256 = this._feeders.get(feeder);
        if (!u256.eq(existing, u256.Zero)) throw new Revert('Already a feeder');

        const newCount: u256 = SafeMath.add(this._feederCount.value, u256.One);
        if (u256.gt(newCount, u256.fromU32(MAX_FEEDERS))) throw new Revert('Max feeders reached');

        // Assign a 1-based index so we can use it as a storage slot
        this._feeders.set(feeder, newCount);
        this._feederCount.set(newCount);

        const writer: BytesWriter = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    /**
     * Remove a feeder. Any pending round submissions from this feeder are
     * orphaned (they won't count toward the threshold after removal).
     */
    @method({ name: 'feeder', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public removeFeeder(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);

        const feeder: Address = calldata.readAddress();
        const idx: u256 = this._feeders.get(feeder);
        if (u256.eq(idx, u256.Zero)) throw new Revert('Not a feeder');

        this._feeders.delete(feeder);

        const newCount: u256 = SafeMath.sub(this._feederCount.value, u256.One);
        this._feederCount.set(newCount);

        const writer: BytesWriter = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    /**
     * Adjust how many feeders must agree before a price is published.
     * Cannot exceed current feederCount.
     */
    @method({ name: 'min', type: ABIDataTypes.UINT256 })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public setMinFeeders(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);

        const min: u256 = calldata.readU256();
        if (u256.eq(min, u256.Zero)) throw new Revert('minFeeders must be >= 1');
        if (u256.gt(min, this._feederCount.value)) throw new Revert('min > feederCount');

        this._minFeeders.set(min);

        const writer: BytesWriter = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    /**
     * Change how long a round stays open before becoming stale.
     * @param blocks  OPNet blocks (≈1 min each on testnet).
     */
    @method({ name: 'blocks', type: ABIDataTypes.UINT256 })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public setRoundDuration(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);

        const blocks: u256 = calldata.readU256();
        if (u256.eq(blocks, u256.Zero)) throw new Revert('Duration must be > 0');

        this._roundDuration.set(blocks);

        const writer: BytesWriter = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // FEEDER — PRICE SUBMISSION
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Submit a price observation for a symbol.
     *
     * Flow:
     *   1. Verify caller is a registered feeder.
     *   2. If an open round is stale, auto-finalise it (publish median of
     *      whatever arrived) before starting a fresh round.
     *   3. Open a new round if none is open.
     *   4. Store submission.  If threshold is now met → publish median.
     *
     * @param symbolId    0 = BTC/USD, 1 = ETH/USD, …
     * @param price       Price scaled ×10^8 (e.g. $67,000 = 6_700_000_000_000).
     * @param confidence  Confidence scaled ×10^6 (e.g. 99.9% = 999_000).
     */
    @method(
        { name: 'symbolId',   type: ABIDataTypes.UINT256 },
        { name: 'price',      type: ABIDataTypes.UINT256 },
        { name: 'confidence', type: ABIDataTypes.UINT256 },
    )
    @returns({ name: 'published', type: ABIDataTypes.BOOL })
    public submitPrice(calldata: Calldata): BytesWriter {
        const caller: Address = Blockchain.tx.sender;
        const feederIdx: u256 = this._feeders.get(caller);
        if (u256.eq(feederIdx, u256.Zero)) throw new Revert('Not a registered feeder');

        const symbolId:   u256 = calldata.readU256();
        const price:      u256 = calldata.readU256();
        const confidence: u256 = calldata.readU256();

        if (u256.eq(price, u256.Zero)) throw new Revert('Price cannot be zero');

        // ── Deviation guard: reject if > MAX_DEVIATION_BPS from last accepted ─
        const lastPrice: u256 = this._latestPrice.get(symbolId);
        if (!u256.eq(lastPrice, u256.Zero)) {
            const diff: u256 = u256.gt(price, lastPrice)
                ? SafeMath.sub(price, lastPrice)
                : SafeMath.sub(lastPrice, price);
            // diff / lastPrice > MAX_DEVIATION_BPS / BPS_BASE
            // → diff * BPS_BASE > MAX_DEVIATION_BPS * lastPrice
            const lhs: u256 = SafeMath.mul(diff, BPS_BASE);
            const rhs: u256 = SafeMath.mul(MAX_DEVIATION_BPS, lastPrice);
            if (u256.gt(lhs, rhs)) throw new Revert('Price deviation exceeds 20%');
        }

        const currentBlock: u256 = u256.fromU64(Blockchain.block.number);
        const currentRound: u256 = this._roundId.get(symbolId);
        const roundDur:     u256 = this._roundDuration.value;

        // ── Auto-finalise stale round ─────────────────────────────────────────
        const isRoundOpen: bool = !u256.eq(currentRound, u256.Zero);
        if (isRoundOpen) {
            const openedAt: u256  = this._roundOpenedAt.get(symbolId);
            const deadline: u256  = SafeMath.add(openedAt, roundDur);
            const isStale:  bool  = u256.gt(currentBlock, deadline);
            const hasAny:   bool  = u256.gt(this._roundCount.get(symbolId), u256.Zero);

            if (isStale && hasAny) {
                this._finalise(symbolId, currentRound);
                // Round is now closed; fall through to open a new one
            } else if (isStale) {
                // Stale with zero submissions — just reset
                this._roundId.set(symbolId, u256.Zero);
            }
        }

        // ── Open new round if none active ─────────────────────────────────────
        const activeRound: u256 = this._roundId.get(symbolId);
        const isNewRound:  bool = u256.eq(activeRound, u256.Zero);
        // Use _latestRoundId as the base for the next round ID so the counter
        // is monotonically increasing even after a round is finalised (which
        // resets _roundId to 0 but leaves _latestRoundId at the last value).
        const thisRound:   u256 = isNewRound
            ? SafeMath.add(this._latestRoundId.get(symbolId), u256.One)
            : activeRound;

        if (isNewRound) {
            this._roundId.set(symbolId, thisRound);
            this._roundOpenedAt.set(symbolId, currentBlock);
            this._roundCount.set(symbolId, u256.Zero);
        }

        // ── Prevent double submission in same round ───────────────────────────
        const subKey: u256 = pendingKey(symbolId, feederIdx);
        const lastSubRound: u256 = this._submittedInRound.get(subKey);
        if (u256.eq(lastSubRound, thisRound)) throw new Revert('Already submitted this round');

        // ── Store submission ──────────────────────────────────────────────────
        this._pendingPrice.set(subKey, price);
        this._pendingConf.set(subKey, confidence);
        this._submittedInRound.set(subKey, thisRound);

        const newCount: u256 = SafeMath.add(this._roundCount.get(symbolId), u256.One);
        this._roundCount.set(symbolId, newCount);

        // ── Publish if threshold met ──────────────────────────────────────────
        const threshold: u256 = this._minFeeders.value;
        let published:   bool = false;

        if (u256.ge(newCount, threshold)) {
            this._finalise(symbolId, thisRound);
            published = true;
        }

        const writer: BytesWriter = new BytesWriter(1);
        writer.writeBoolean(published);
        return writer;
    }

    /**
     * Emergency fallback: anyone can finalise a stale round.
     * In normal operation, the next `submitPrice` handles this automatically.
     * Useful if ALL feeders are offline and someone else needs to push the price.
     */
    @method({ name: 'symbolId', type: ABIDataTypes.UINT256 })
    @returns({ name: 'published', type: ABIDataTypes.BOOL })
    public finalizeRound(calldata: Calldata): BytesWriter {
        const symbolId:   u256 = calldata.readU256();
        const roundId:    u256 = this._roundId.get(symbolId);

        if (u256.eq(roundId, u256.Zero)) throw new Revert('No open round');

        const openedAt:   u256 = this._roundOpenedAt.get(symbolId);
        const deadline:   u256 = SafeMath.add(openedAt, this._roundDuration.value);
        const now:        u256 = u256.fromU64(Blockchain.block.number);

        if (!u256.gt(now, deadline)) throw new Revert('Round not yet stale');

        const count: u256 = this._roundCount.get(symbolId);
        if (u256.eq(count, u256.Zero)) {
            // Nothing submitted — just close the round
            this._roundId.set(symbolId, u256.Zero);
            const writer: BytesWriter = new BytesWriter(1);
            writer.writeBoolean(false);
            return writer;
        }

        this._finalise(symbolId, roundId);

        const writer: BytesWriter = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // VIEWS
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Returns the latest published price for a symbol.
     *
     * @returns price, updateBlock, confidence, roundId, isFresh
     *          isFresh = true if updated within the last 2 × roundDuration blocks.
     */
    @method({ name: 'symbolId', type: ABIDataTypes.UINT256 })
    @returns(
        { name: 'price',       type: ABIDataTypes.UINT256 },
        { name: 'updateBlock', type: ABIDataTypes.UINT256 },
        { name: 'confidence',  type: ABIDataTypes.UINT256 },
        { name: 'roundId',     type: ABIDataTypes.UINT256 },
        { name: 'isFresh',     type: ABIDataTypes.BOOL },
    )
    public getPrice(calldata: Calldata): BytesWriter {
        const symbolId:   u256 = calldata.readU256();
        const price:      u256 = this._latestPrice.get(symbolId);
        const updateBlk:  u256 = this._latestUpdateBlock.get(symbolId);
        const confidence: u256 = this._latestConfidence.get(symbolId);
        const roundId:    u256 = this._latestRoundId.get(symbolId);
        const now:        u256 = u256.fromU64(Blockchain.block.number);
        const freshWindow: u256 = SafeMath.mul(this._roundDuration.value, u256.fromU32(2));
        const isFresh:    bool = !u256.eq(updateBlk, u256.Zero) &&
                                  u256.le(SafeMath.sub(now, updateBlk), freshWindow);

        const writer: BytesWriter = new BytesWriter(5 * 32 + 1);
        writer.writeU256(price);
        writer.writeU256(updateBlk);
        writer.writeU256(confidence);
        writer.writeU256(roundId);
        writer.writeBoolean(isFresh);
        return writer;
    }

    /** Convenience: just the latest price, no extras. */
    @method({ name: 'symbolId', type: ABIDataTypes.UINT256 })
    @returns({ name: 'price', type: ABIDataTypes.UINT256 })
    public latestPrice(calldata: Calldata): BytesWriter {
        const symbolId: u256 = calldata.readU256();
        const writer: BytesWriter = new BytesWriter(32);
        writer.writeU256(this._latestPrice.get(symbolId));
        return writer;
    }

    /** Is this address a registered feeder? */
    @method({ name: 'feeder', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'authorized', type: ABIDataTypes.BOOL })
    public isFeeder(calldata: Calldata): BytesWriter {
        const feeder: Address = calldata.readAddress();
        const idx: u256 = this._feeders.get(feeder);
        const writer: BytesWriter = new BytesWriter(1);
        writer.writeBoolean(!u256.eq(idx, u256.Zero));
        return writer;
    }

    /** Returns current config: minFeeders, feederCount, roundDuration. */
    @returns(
        { name: 'minFeeders',    type: ABIDataTypes.UINT256 },
        { name: 'feederCount',   type: ABIDataTypes.UINT256 },
        { name: 'roundDuration', type: ABIDataTypes.UINT256 },
    )
    public getConfig(_calldata: Calldata): BytesWriter {
        const writer: BytesWriter = new BytesWriter(3 * 32);
        writer.writeU256(this._minFeeders.value);
        writer.writeU256(this._feederCount.value);
        writer.writeU256(this._roundDuration.value);
        return writer;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // INTERNAL
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Compute on-chain median from pending submissions and publish.
     * Bounded loop: MAX_FEEDERS iterations max.
     */
    private _finalise(symbolId: u256, roundId: u256): void {
        const count: u32 = this._roundCount.get(symbolId).lo1 as u32;

        // Collect submitted prices into a fixed array
        const prices: StaticArray<u256> = new StaticArray<u256>(MAX_FEEDERS as i32);
        const confs:  StaticArray<u256> = new StaticArray<u256>(MAX_FEEDERS as i32);
        let filled: u32 = 0;

        for (let i: u32 = 1; i <= MAX_FEEDERS && filled < count; i++) {
            const fIdx: u256 = u256.fromU32(i);
            const key: u256 = pendingKey(symbolId, fIdx);
            const lastRound: u256 = this._submittedInRound.get(key);
            if (u256.eq(lastRound, roundId)) {
                prices[filled as i32] = this._pendingPrice.get(key);
                confs[filled as i32]  = this._pendingConf.get(key);
                filled++;
            }
        }

        if (filled == 0) return;

        const medPrice: u256 = _median(prices, filled as i32);
        const medConf:  u256 = _median(confs,  filled as i32);

        // Publish
        this._latestPrice.set(symbolId, medPrice);
        this._latestConfidence.set(symbolId, medConf);
        this._latestUpdateBlock.set(symbolId, u256.fromU64(Blockchain.block.number));
        this._latestRoundId.set(symbolId, roundId);

        // Close round
        this._roundId.set(symbolId, u256.Zero);
        this._roundCount.set(symbolId, u256.Zero);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// PURE HELPER — insertion sort + median (no heap alloc, bounded size)
// ─────────────────────────────────────────────────────────────────────────────

function _median(arr: StaticArray<u256>, n: i32): u256 {
    // Insertion sort (O(n²) fine for n ≤ 10)
    for (let i: i32 = 1; i < n; i++) {
        const key: u256 = arr[i];
        let j: i32 = i - 1;
        while (j >= 0 && u256.gt(arr[j], key)) {
            arr[j + 1] = arr[j];
            j--;
        }
        arr[j + 1] = key;
    }

    const mid: i32 = n / 2;
    if (n % 2 == 0) {
        // Even count: average of two midpoints
        return SafeMath.div(
            SafeMath.add(arr[mid - 1], arr[mid]),
            u256.fromU32(2),
        );
    }
    return arr[mid];
}
