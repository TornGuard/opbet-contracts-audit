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
    StoredBoolean,
    StoredAddress,
    StoredMapU256,
    EMPTY_POINTER,
} from '@btc-vision/btc-runtime/runtime';

// ═══════════════════════════════════════════════════════════
// OP20 SELECTORS (Keccak-256 of function signatures)
// ═══════════════════════════════════════════════════════════
const TRANSFER_SELECTOR: u32 = 0x3b88ef57; // transfer(address,uint256) — OPNet selector
const TRANSFER_FROM_SELECTOR: u32 = 0x4b6685e7; // transferFrom(address,address,uint256) — OPNet selector

// ═══════════════════════════════════════════════════════════
// BET TYPES
// ═══════════════════════════════════════════════════════════
const BET_OVER_UNDER: u256 = u256.fromU32(1);
const BET_EXACT: u256 = u256.fromU32(2);
const BET_TREND: u256 = u256.fromU32(3);
const BET_MEMPOOL: u256 = u256.fromU32(4);
const BET_BLOCKTIME: u256 = u256.fromU32(5);
const BET_SPIKE: u256 = u256.fromU32(6);

// ═══════════════════════════════════════════════════════════
// DIRECTIONS / OPTIONS
// ═══════════════════════════════════════════════════════════
const OPTION_1: u256 = u256.fromU32(1);
const OPTION_2: u256 = u256.fromU32(2);
const OPTION_3: u256 = u256.fromU32(3);
const OPTION_4: u256 = u256.fromU32(4);

// ═══════════════════════════════════════════════════════════
// FIXED ODDS (×100 for 2-decimal precision)
// ═══════════════════════════════════════════════════════════
const EXACT_ODDS: u256 = u256.fromU32(5000); // 50.00x
const TREND_ODDS: u256 = u256.fromU32(200); // 2.00x

const MEMPOOL_ODDS_1: u256 = u256.fromU32(240); // 2.40x
const MEMPOOL_ODDS_2: u256 = u256.fromU32(310); // 3.10x
const MEMPOOL_ODDS_3: u256 = u256.fromU32(450); // 4.50x
const MEMPOOL_ODDS_4: u256 = u256.fromU32(800); // 8.00x

const BLOCKTIME_ODDS_1: u256 = u256.fromU32(300); // 3.00x
const BLOCKTIME_ODDS_2: u256 = u256.fromU32(180); // 1.80x
const BLOCKTIME_ODDS_3: u256 = u256.fromU32(250); // 2.50x
const BLOCKTIME_ODDS_4: u256 = u256.fromU32(600); // 6.00x

const SPIKE_ODDS_1: u256 = u256.fromU32(500); // 5.00x
const SPIKE_ODDS_2: u256 = u256.fromU32(1200); // 12.00x
const SPIKE_ODDS_3: u256 = u256.fromU32(2500); // 25.00x
const SPIKE_ODDS_4: u256 = u256.fromU32(10000); // 100.00x

// ═══════════════════════════════════════════════════════════
// THRESHOLDS
// ═══════════════════════════════════════════════════════════
const MEMPOOL_THRESHOLD_1: u256 = u256.fromU32(15000);
const MEMPOOL_THRESHOLD_2: u256 = u256.fromU32(10000);
const MEMPOOL_THRESHOLD_3: u256 = u256.fromU32(20000);
const MEMPOOL_THRESHOLD_4: u256 = u256.fromU32(5000);

const SPIKE_THRESHOLD_1: u256 = u256.fromU32(5000); // 50 sat/vB (×100)
const SPIKE_THRESHOLD_2: u256 = u256.fromU32(10000); // 100
const SPIKE_THRESHOLD_3: u256 = u256.fromU32(20000); // 200
const SPIKE_THRESHOLD_4: u256 = u256.fromU32(50000); // 500

const EXACT_TOLERANCE: u256 = u256.fromU32(50); // ±0.50 sat/vB (×100)

const TIME_5_MIN: u256 = u256.fromU32(300);
const TIME_10_MIN: u256 = u256.fromU32(600);
const TIME_20_MIN: u256 = u256.fromU32(1200);

// Multi-block bet windows — now counted in Bitcoin blocks (not OPNet blocks).
// Bitcoin blocks average ~10 min each.
const TREND_BLOCKS: u64 = 3;        // 3 BTC blocks ≈ 30 min average
const MEMPOOL_SHORT_BLOCKS: u64 = 2; // 2 BTC blocks ≈ 20 min
const MEMPOOL_LONG_BLOCKS: u64 = 4;  // 4 BTC blocks ≈ 40 min
const SPIKE_BLOCKS: u64 = 6;         // 6 BTC blocks ≈ 1 hour

// O/U dynamic odds tier boundaries (basis points distance from current fee)
const TIER_1_BP: u256 = u256.fromU32(500); // 5%
const TIER_2_BP: u256 = u256.fromU32(1500); // 15%
const TIER_3_BP: u256 = u256.fromU32(3000); // 30%
const TIER_4_BP: u256 = u256.fromU32(5000); // 50%
const BP_SCALE: u256 = u256.fromU32(10000);

const HARD_TIER_1: u256 = u256.fromU32(180); // <5%: 1.80x
const HARD_TIER_2: u256 = u256.fromU32(220); // 5-15%: 2.20x
const HARD_TIER_3: u256 = u256.fromU32(300); // 15-30%: 3.00x
const HARD_TIER_4: u256 = u256.fromU32(500); // 30-50%: 5.00x
const HARD_TIER_5: u256 = u256.fromU32(1000); // >50%: 10.00x

const EASY_TIER_1: u256 = u256.fromU32(180); // <5%: 1.80x
const EASY_TIER_2: u256 = u256.fromU32(150); // 5-15%: 1.50x
const EASY_TIER_3: u256 = u256.fromU32(130); // 15-30%: 1.30x
const EASY_TIER_4: u256 = u256.fromU32(115); // 30-50%: 1.15x

const MIN_ODDS: u256 = u256.fromU32(110); // 1.10x
const MAX_ODDS: u256 = u256.fromU32(2000); // 20.00x
const DEFAULT_OU_ODDS: u256 = u256.fromU32(190); // 1.90x

// Fee: 5% of profit to contract pool
const FEE_BPS: u256 = u256.fromU32(500);
const BASIS_POINTS: u256 = u256.fromU32(10000);
const ODDS_DIVISOR: u256 = u256.fromU32(100);

// Bet status lifecycle
const STATUS_ACTIVE: u256 = u256.Zero;
const STATUS_LOST: u256 = u256.fromU32(1);
const STATUS_WON: u256 = u256.fromU32(2);
const STATUS_SETTLED: u256 = u256.fromU32(3);

// Expiry: bets can be refunded after this many blocks past endBlock
const EXPIRY_BLOCKS: u64 = 200;

// Sanity cap: Bitcoin will never reach this height in any realistic timeframe
const MAX_BTC_BLOCK: u256 = u256.fromU64(10_000_000);
// Oracle can submit at most this many blocks ahead of the current known tip.
// Set to 10_000 (~70 days) to survive keeper restarts and long gaps without sequential catch-up.
const MAX_BLOCK_ADVANCE: u256 = u256.fromU64(10_000);

// Token whitelist sentinel value
const TOKEN_ACCEPTED: u256 = u256.One;

@final
export class FeeBet_Market extends OP_NET {
    // ═══════════════════════════════════════════════════════════
    // GLOBAL STORAGE
    // ═══════════════════════════════════════════════════════════
    private readonly nextBetIdPointer: u16 = Blockchain.nextPointer;
    private readonly teamWalletPointer: u16 = Blockchain.nextPointer;
    private readonly minBetPointer: u16 = Blockchain.nextPointer;
    private readonly maxBetPointer: u16 = Blockchain.nextPointer;
    private readonly pausedPointer: u16 = Blockchain.nextPointer;
    private readonly latestOracleFeePointer: u16 = Blockchain.nextPointer;
    private readonly currentBtcBlockPointer: u16 = Blockchain.nextPointer;

    private readonly _nextBetId: StoredU256 = new StoredU256(this.nextBetIdPointer, EMPTY_POINTER);
    private readonly _teamWallet: StoredAddress = new StoredAddress(this.teamWalletPointer);
    private readonly _minBet: StoredU256 = new StoredU256(this.minBetPointer, EMPTY_POINTER);
    private readonly _maxBet: StoredU256 = new StoredU256(this.maxBetPointer, EMPTY_POINTER);
    private readonly _paused: StoredBoolean = new StoredBoolean(this.pausedPointer, false);
    private readonly _latestOracleFee: StoredU256 = new StoredU256(this.latestOracleFeePointer, EMPTY_POINTER);
    // Latest Bitcoin block height known to the contract (updated by keeper via setBlockData)
    private readonly _currentBtcBlock: StoredU256 = new StoredU256(this.currentBtcBlockPointer, EMPTY_POINTER);

    // ═══════════════════════════════════════════════════════════
    // TOKEN WHITELIST (address → 1 = accepted)
    // ═══════════════════════════════════════════════════════════
    private readonly acceptedTokensPointer: u16 = Blockchain.nextPointer;
    private readonly _acceptedTokens: AddressMemoryMap = new AddressMemoryMap(this.acceptedTokensPointer);

    // ═══════════════════════════════════════════════════════════
    // PER-TOKEN POOL ACCOUNTING (token address → u256)
    // ═══════════════════════════════════════════════════════════
    private readonly tokenPoolPointer: u16 = Blockchain.nextPointer;
    private readonly tokenExposurePointer: u16 = Blockchain.nextPointer;

    private readonly _tokenPool: AddressMemoryMap = new AddressMemoryMap(this.tokenPoolPointer);
    private readonly _tokenExposure: AddressMemoryMap = new AddressMemoryMap(this.tokenExposurePointer);

    // ═══════════════════════════════════════════════════════════
    // BLOCK DATA ORACLE (keyed by block height)
    // ═══════════════════════════════════════════════════════════
    private readonly blockFeePointer: u16 = Blockchain.nextPointer;
    private readonly blockMempoolPointer: u16 = Blockchain.nextPointer;
    private readonly blockTimestampPointer: u16 = Blockchain.nextPointer;
    private readonly blockDataSetPointer: u16 = Blockchain.nextPointer;

    private readonly _blockFee: StoredMapU256 = new StoredMapU256(this.blockFeePointer);
    private readonly _blockMempool: StoredMapU256 = new StoredMapU256(this.blockMempoolPointer);
    private readonly _blockTimestamp: StoredMapU256 = new StoredMapU256(this.blockTimestampPointer);
    private readonly _blockDataSet: StoredMapU256 = new StoredMapU256(this.blockDataSetPointer);

    // ═══════════════════════════════════════════════════════════
    // PER-BET STORAGE (keyed by betId)
    // ═══════════════════════════════════════════════════════════
    private readonly betOwnerPointer: u16 = Blockchain.nextPointer;
    private readonly betTokenPointer: u16 = Blockchain.nextPointer;
    private readonly betTypePointer: u16 = Blockchain.nextPointer;
    private readonly betParam1Pointer: u16 = Blockchain.nextPointer;
    private readonly betParam2Pointer: u16 = Blockchain.nextPointer;
    private readonly betAmountPointer: u16 = Blockchain.nextPointer;
    private readonly betOddsPointer: u16 = Blockchain.nextPointer;
    private readonly betTargetBlockPointer: u16 = Blockchain.nextPointer;
    private readonly betEndBlockPointer: u16 = Blockchain.nextPointer;
    private readonly betStatusPointer: u16 = Blockchain.nextPointer;
    private readonly betRefFeePointer: u16 = Blockchain.nextPointer;
    private readonly betPayoutPointer: u16 = Blockchain.nextPointer;

    private readonly _betOwner: StoredMapU256 = new StoredMapU256(this.betOwnerPointer);
    private readonly _betToken: StoredMapU256 = new StoredMapU256(this.betTokenPointer);
    private readonly _betType: StoredMapU256 = new StoredMapU256(this.betTypePointer);
    private readonly _betParam1: StoredMapU256 = new StoredMapU256(this.betParam1Pointer);
    private readonly _betParam2: StoredMapU256 = new StoredMapU256(this.betParam2Pointer);
    private readonly _betAmount: StoredMapU256 = new StoredMapU256(this.betAmountPointer);
    private readonly _betOdds: StoredMapU256 = new StoredMapU256(this.betOddsPointer);
    private readonly _betTargetBlock: StoredMapU256 = new StoredMapU256(this.betTargetBlockPointer);
    private readonly _betEndBlock: StoredMapU256 = new StoredMapU256(this.betEndBlockPointer);
    private readonly _betStatus: StoredMapU256 = new StoredMapU256(this.betStatusPointer);
    private readonly _betRefFee: StoredMapU256 = new StoredMapU256(this.betRefFeePointer);
    private readonly _betPayout: StoredMapU256 = new StoredMapU256(this.betPayoutPointer);

    public constructor() {
        super();
    }

    // ═══════════════════════════════════════════════════════════
    // DEPLOYMENT
    // ═══════════════════════════════════════════════════════════
    public override onDeployment(calldata: Calldata): void {
        const teamWallet: Address = calldata.readAddress();
        if (teamWallet.equals(Address.zero())) {
            throw new Revert('Invalid team wallet');
        }

        this._teamWallet.value = teamWallet;
        this._nextBetId.set(u256.One);
        this._minBet.set(u256.fromU64(1000));
        this._maxBet.set(u256.fromU64(100000000000)); // 1000 tokens (8 decimals)
        this._latestOracleFee.set(u256.Zero);
    }

    // ═══════════════════════════════════════════════════════════
    // PLACE BET — Pulls OP20 tokens from user via transferFrom
    // User must call token.increaseAllowance(market, amount) first.
    // Tokens are held by this contract until resolution.
    // ═══════════════════════════════════════════════════════════
    @method(
        { name: 'token', type: ABIDataTypes.ADDRESS },
        { name: 'betType', type: ABIDataTypes.UINT256 },
        { name: 'param1', type: ABIDataTypes.UINT256 },
        { name: 'param2', type: ABIDataTypes.UINT256 },
        { name: 'amount', type: ABIDataTypes.UINT256 },
    )
    @returns({ name: 'betId', type: ABIDataTypes.UINT256 })
    public placeBet(calldata: Calldata): BytesWriter {
        if (this._paused.value) {
            throw new Revert('Market is paused');
        }

        const token: Address = calldata.readAddress();
        const betType: u256 = calldata.readU256();
        const param1: u256 = calldata.readU256();
        const param2: u256 = calldata.readU256();
        const amount: u256 = calldata.readU256();

        // Validate token is whitelisted
        if (!u256.eq(this._acceptedTokens.get(token), TOKEN_ACCEPTED)) {
            throw new Revert('Token not accepted');
        }

        // Validate amount
        if (u256.lt(amount, this._minBet.value)) {
            throw new Revert('Below minimum bet');
        }
        if (u256.gt(amount, this._maxBet.value)) {
            throw new Revert('Above maximum bet');
        }

        // Determine bet parameters — use Bitcoin block height, not OPNet block height.
        // The keeper feeds real Bitcoin block data via setBlockData, keyed by BTC block height.
        const currentBtcBlock: u256 = this._currentBtcBlock.value;
        if (u256.eq(currentBtcBlock, u256.Zero)) {
            throw new Revert('Oracle not initialized: no Bitcoin block data submitted yet');
        }
        const nextBtcBlock: u256 = SafeMath.add(currentBtcBlock, u256.One);
        let targetBlock: u256 = nextBtcBlock;
        let endBlock: u256 = targetBlock;
        let odds: u256 = u256.Zero;
        let refFee: u256 = u256.Zero;

        if (u256.eq(betType, BET_OVER_UNDER)) {
            this.validateDirection(param1);
            if (u256.eq(param2, u256.Zero)) {
                throw new Revert('Threshold cannot be zero');
            }
            odds = this.calculateOUOdds(param1, param2);

        } else if (u256.eq(betType, BET_EXACT)) {
            if (u256.eq(param1, u256.Zero)) {
                throw new Revert('Prediction cannot be zero');
            }
            odds = EXACT_ODDS;

        } else if (u256.eq(betType, BET_TREND)) {
            this.validateDirection(param1);
            refFee = this._latestOracleFee.value;
            if (u256.eq(refFee, u256.Zero)) {
                throw new Revert('Oracle fee required for trend bet');
            }
            endBlock = SafeMath.add(nextBtcBlock, u256.fromU64(TREND_BLOCKS - 1));
            odds = TREND_ODDS;

        } else if (u256.eq(betType, BET_MEMPOOL)) {
            this.validateOption(param1);
            odds = this.getMempoolOdds(param1);
            if (u256.eq(param1, OPTION_3) || u256.eq(param1, OPTION_4)) {
                endBlock = SafeMath.add(nextBtcBlock, u256.fromU64(MEMPOOL_LONG_BLOCKS - 1));
            } else {
                endBlock = SafeMath.add(nextBtcBlock, u256.fromU64(MEMPOOL_SHORT_BLOCKS - 1));
            }

        } else if (u256.eq(betType, BET_BLOCKTIME)) {
            this.validateOption(param1);
            odds = this.getBlockTimeOdds(param1);

        } else if (u256.eq(betType, BET_SPIKE)) {
            this.validateOption(param1);
            odds = this.getSpikeOdds(param1);
            endBlock = SafeMath.add(nextBtcBlock, u256.fromU64(SPIKE_BLOCKS - 1));

        } else {
            throw new Revert('Invalid bet type');
        }

        // Solvency check: pool must cover all pending exposure + this bet's payout
        const grossPayout: u256 = SafeMath.div(SafeMath.mul(amount, odds), ODDS_DIVISOR);
        const currentPool: u256 = this._tokenPool.get(token);
        const currentExposure: u256 = this._tokenExposure.get(token);
        const newExposure: u256 = SafeMath.add(currentExposure, grossPayout);

        // Pool will include this deposit after transferFrom
        const newPool: u256 = SafeMath.add(currentPool, amount);
        if (u256.gt(newExposure, newPool)) {
            throw new Revert('Insufficient pool liquidity');
        }

        // Pull tokens from user (checks-effects-interactions: update state first)
        const betId: u256 = this._nextBetId.value;
        this._nextBetId.set(SafeMath.add(betId, u256.One));

        // Store bet BEFORE external call (reentrancy safe)
        this._betOwner.set(betId, u256.fromUint8ArrayBE(Blockchain.tx.sender));
        this._betToken.set(betId, u256.fromUint8ArrayBE(token));
        this._betType.set(betId, betType);
        this._betParam1.set(betId, param1);
        this._betParam2.set(betId, param2);
        this._betAmount.set(betId, amount);
        this._betOdds.set(betId, odds);
        this._betTargetBlock.set(betId, targetBlock);
        this._betEndBlock.set(betId, endBlock);
        this._betRefFee.set(betId, refFee);

        // Update pool accounting BEFORE external call
        this._tokenPool.set(token, newPool);
        this._tokenExposure.set(token, newExposure);

        // Pull tokens from user via transferFrom(sender, contract, amount)
        this.pullTokens(token, Blockchain.tx.sender, amount);

        const writer: BytesWriter = new BytesWriter(32);
        writer.writeU256(betId);
        return writer;
    }

    // ═══════════════════════════════════════════════════════════
    // RESOLVE BET — Permissionless, auto-pays winner
    // Anyone can call once oracle data is available.
    // If won: contract transfers tokens to winner in same tx.
    // ═══════════════════════════════════════════════════════════
    @method({ name: 'betId', type: ABIDataTypes.UINT256 })
    @returns(
        { name: 'won', type: ABIDataTypes.BOOL },
        { name: 'payout', type: ABIDataTypes.UINT256 },
    )
    public resolveBet(calldata: Calldata): BytesWriter {
        const betId: u256 = calldata.readU256();

        const amount: u256 = this._betAmount.get(betId);
        if (u256.eq(amount, u256.Zero)) {
            throw new Revert('Bet not found');
        }
        if (!u256.eq(this._betStatus.get(betId), STATUS_ACTIVE)) {
            throw new Revert('Already resolved');
        }

        const endBlock: u256 = this._betEndBlock.get(betId);
        if (u256.eq(this._blockDataSet.get(endBlock), u256.Zero)) {
            throw new Revert('Block data not yet available');
        }

        const betType: u256 = this._betType.get(betId);
        const param1: u256 = this._betParam1.get(betId);
        const param2: u256 = this._betParam2.get(betId);
        const odds: u256 = this._betOdds.get(betId);
        const targetBlock: u256 = this._betTargetBlock.get(betId);
        const refFee: u256 = this._betRefFee.get(betId);
        const tokenU256: u256 = this._betToken.get(betId);
        const token: Address = Address.fromUint8Array(tokenU256.toUint8Array(true));

        const grossPayout: u256 = SafeMath.div(SafeMath.mul(amount, odds), ODDS_DIVISOR);
        const won: bool = this.resolveBetInternal(betType, param1, param2, targetBlock, endBlock, refFee);

        let payout: u256 = u256.Zero;

        // Update all state BEFORE any external call (reentrancy safe)
        if (won) {
            const profit: u256 = SafeMath.sub(grossPayout, amount);
            const fee: u256 = SafeMath.div(SafeMath.mul(profit, FEE_BPS), BASIS_POINTS);
            payout = SafeMath.sub(grossPayout, fee);

            this._betStatus.set(betId, STATUS_WON);
            this._betPayout.set(betId, payout);

            // Deduct payout from pool
            this._tokenPool.set(token, SafeMath.sub(this._tokenPool.get(token), payout));
        } else {
            this._betStatus.set(betId, STATUS_LOST);
            // Tokens stay in pool — no deduction
        }

        // Reduce pending exposure
        this._tokenExposure.set(token, SafeMath.sub(this._tokenExposure.get(token), grossPayout));

        // Auto-pay winner via token transfer (external call AFTER state update)
        if (won && u256.gt(payout, u256.Zero)) {
            const owner: Address = Address.fromUint8Array(this._betOwner.get(betId).toUint8Array(true));
            // Mark settled BEFORE external call (reentrancy guard)
            this._betStatus.set(betId, STATUS_SETTLED);
            this.pushTokens(token, owner, payout);
        }

        const writer: BytesWriter = new BytesWriter(33);
        writer.writeBoolean(won);
        writer.writeU256(payout);
        return writer;
    }

    // ═══════════════════════════════════════════════════════════
    // REFUND BET — For expired bets where oracle data was never set
    // Permissionless after EXPIRY_BLOCKS.
    // Returns original stake to bettor via token transfer.
    // ═══════════════════════════════════════════════════════════
    @method({ name: 'betId', type: ABIDataTypes.UINT256 })
    @returns({ name: 'refundAmount', type: ABIDataTypes.UINT256 })
    public refundBet(calldata: Calldata): BytesWriter {
        const betId: u256 = calldata.readU256();

        const amount: u256 = this._betAmount.get(betId);
        if (u256.eq(amount, u256.Zero)) {
            throw new Revert('Bet not found');
        }
        if (!u256.eq(this._betStatus.get(betId), STATUS_ACTIVE)) {
            throw new Revert('Already resolved');
        }

        const endBlock: u256 = this._betEndBlock.get(betId);
        // Compare against current Bitcoin block height, not OPNet block height
        const currentBtcBlock: u256 = this._currentBtcBlock.value;
        const expiryBlock: u256 = SafeMath.add(endBlock, u256.fromU64(EXPIRY_BLOCKS));
        if (u256.lt(currentBtcBlock, expiryBlock)) {
            throw new Revert('Not yet expired');
        }
        if (u256.gt(this._blockDataSet.get(endBlock), u256.Zero)) {
            throw new Revert('Oracle data exists - use resolveBet');
        }

        const odds: u256 = this._betOdds.get(betId);
        const grossPayout: u256 = SafeMath.div(SafeMath.mul(amount, odds), ODDS_DIVISOR);
        const tokenU256: u256 = this._betToken.get(betId);
        const token: Address = Address.fromUint8Array(tokenU256.toUint8Array(true));

        // Update state BEFORE external call (reentrancy safe)
        this._betStatus.set(betId, STATUS_SETTLED);
        this._betPayout.set(betId, amount);
        this._tokenPool.set(token, SafeMath.sub(this._tokenPool.get(token), amount));
        this._tokenExposure.set(token, SafeMath.sub(this._tokenExposure.get(token), grossPayout));

        // Refund tokens to bettor
        const owner: Address = Address.fromUint8Array(this._betOwner.get(betId).toUint8Array(true));
        this.pushTokens(token, owner, amount);

        const writer: BytesWriter = new BytesWriter(32);
        writer.writeU256(amount);
        return writer;
    }

    // ═══════════════════════════════════════════════════════════
    // SET BLOCK DATA (Oracle — deployer only)
    // ═══════════════════════════════════════════════════════════
    @method(
        { name: 'blockHeight', type: ABIDataTypes.UINT256 },
        { name: 'medianFee', type: ABIDataTypes.UINT256 },
        { name: 'mempoolCount', type: ABIDataTypes.UINT256 },
        { name: 'blockTimestamp', type: ABIDataTypes.UINT256 },
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public setBlockData(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);

        const blockHeight: u256 = calldata.readU256();
        const medianFee: u256 = calldata.readU256();
        const mempoolCount: u256 = calldata.readU256();
        const blockTimestamp: u256 = calldata.readU256();

        if (u256.eq(medianFee, u256.Zero)) {
            throw new Revert('Median fee cannot be zero');
        }
        if (u256.eq(blockTimestamp, u256.Zero)) {
            throw new Revert('Timestamp cannot be zero');
        }

        // Sanity: reject absurdly large block heights
        if (u256.gt(blockHeight, MAX_BTC_BLOCK)) {
            throw new Revert('Block height exceeds maximum');
        }

        // Prevent jumping far ahead of known tip (guards against oracle key compromise)
        const currentTip: u256 = this._currentBtcBlock.value;
        if (!u256.eq(currentTip, u256.Zero)) {
            const maxAllowed: u256 = SafeMath.add(currentTip, MAX_BLOCK_ADVANCE);
            if (u256.gt(blockHeight, maxAllowed)) {
                throw new Revert('Block height too far ahead of current tip');
            }
        }

        if (u256.gt(this._blockDataSet.get(blockHeight), u256.Zero)) {
            throw new Revert('Block data already set');
        }

        // blockHeight is a Bitcoin block height — no comparison to OPNet block number.
        // Bitcoin heights (~941,000+) are unrelated to OPNet heights.
        this._blockFee.set(blockHeight, medianFee);
        this._blockMempool.set(blockHeight, mempoolCount);
        this._blockTimestamp.set(blockHeight, blockTimestamp);
        this._blockDataSet.set(blockHeight, u256.One);
        this._latestOracleFee.set(medianFee);

        // Advance the known Bitcoin block height if this is a newer block
        if (u256.gt(blockHeight, this._currentBtcBlock.value)) {
            this._currentBtcBlock.set(blockHeight);
        }

        const writer: BytesWriter = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    // ═══════════════════════════════════════════════════════════
    // SEED POOL — Deployer deposits real tokens as bankroll
    // Deployer must call token.increaseAllowance(market, amount) first.
    // ═══════════════════════════════════════════════════════════
    @method(
        { name: 'token', type: ABIDataTypes.ADDRESS },
        { name: 'amount', type: ABIDataTypes.UINT256 },
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public seedPool(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);

        const token: Address = calldata.readAddress();
        const amount: u256 = calldata.readU256();

        if (u256.eq(amount, u256.Zero)) {
            throw new Revert('Amount must be positive');
        }
        if (!u256.eq(this._acceptedTokens.get(token), TOKEN_ACCEPTED)) {
            throw new Revert('Token not accepted');
        }

        // Update state before external call
        this._tokenPool.set(token, SafeMath.add(this._tokenPool.get(token), amount));

        // Pull tokens from deployer
        this.pullTokens(token, Blockchain.tx.sender, amount);

        const writer: BytesWriter = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    // ═══════════════════════════════════════════════════════════
    // DRAIN POOL — Deployer withdraws excess tokens
    // Cannot drain below pending exposure.
    // ═══════════════════════════════════════════════════════════
    @method(
        { name: 'token', type: ABIDataTypes.ADDRESS },
        { name: 'amount', type: ABIDataTypes.UINT256 },
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public drainPool(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);

        const token: Address = calldata.readAddress();
        const amount: u256 = calldata.readU256();

        const pool: u256 = this._tokenPool.get(token);
        if (u256.gt(amount, pool)) {
            throw new Revert('Cannot drain more than pool');
        }
        const newPool: u256 = SafeMath.sub(pool, amount);
        if (u256.lt(newPool, this._tokenExposure.get(token))) {
            throw new Revert('Cannot drain below pending exposure');
        }

        // Update state before external call
        this._tokenPool.set(token, newPool);

        // Send tokens to deployer
        this.pushTokens(token, Blockchain.tx.sender, amount);

        const writer: BytesWriter = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    // ═══════════════════════════════════════════════════════════
    // TOKEN WHITELIST — Deployer manages accepted tokens
    // ═══════════════════════════════════════════════════════════
    @method({ name: 'token', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public addAcceptedToken(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        const token: Address = calldata.readAddress();
        if (token.equals(Address.zero())) {
            throw new Revert('Invalid token address');
        }
        this._acceptedTokens.set(token, TOKEN_ACCEPTED);

        const writer: BytesWriter = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    @method({ name: 'token', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public removeAcceptedToken(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        const token: Address = calldata.readAddress();

        // Cannot remove token with active exposure
        if (u256.gt(this._tokenExposure.get(token), u256.Zero)) {
            throw new Revert('Token has pending exposure');
        }

        this._acceptedTokens.delete(token);

        const writer: BytesWriter = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    // ═══════════════════════════════════════════════════════════
    // VIEWS
    // ═══════════════════════════════════════════════════════════
    @method({ name: 'betId', type: ABIDataTypes.UINT256 })
    @returns(
        { name: 'betType', type: ABIDataTypes.UINT256 },
        { name: 'param1', type: ABIDataTypes.UINT256 },
        { name: 'param2', type: ABIDataTypes.UINT256 },
        { name: 'amount', type: ABIDataTypes.UINT256 },
        { name: 'odds', type: ABIDataTypes.UINT256 },
        { name: 'targetBlock', type: ABIDataTypes.UINT256 },
        { name: 'endBlock', type: ABIDataTypes.UINT256 },
        { name: 'status', type: ABIDataTypes.UINT256 },
        { name: 'payout', type: ABIDataTypes.UINT256 },
        { name: 'token', type: ABIDataTypes.UINT256 },
    )
    public getBetInfo(calldata: Calldata): BytesWriter {
        const betId: u256 = calldata.readU256();
        const writer: BytesWriter = new BytesWriter(32 * 10);
        writer.writeU256(this._betType.get(betId));
        writer.writeU256(this._betParam1.get(betId));
        writer.writeU256(this._betParam2.get(betId));
        writer.writeU256(this._betAmount.get(betId));
        writer.writeU256(this._betOdds.get(betId));
        writer.writeU256(this._betTargetBlock.get(betId));
        writer.writeU256(this._betEndBlock.get(betId));
        writer.writeU256(this._betStatus.get(betId));
        writer.writeU256(this._betPayout.get(betId));
        writer.writeU256(this._betToken.get(betId));
        return writer;
    }

    @method({ name: 'blockHeight', type: ABIDataTypes.UINT256 })
    @returns(
        { name: 'medianFee', type: ABIDataTypes.UINT256 },
        { name: 'mempoolCount', type: ABIDataTypes.UINT256 },
        { name: 'blockTimestamp', type: ABIDataTypes.UINT256 },
        { name: 'dataSet', type: ABIDataTypes.UINT256 },
    )
    public getBlockData(calldata: Calldata): BytesWriter {
        const blockHeight: u256 = calldata.readU256();
        const writer: BytesWriter = new BytesWriter(32 * 4);
        writer.writeU256(this._blockFee.get(blockHeight));
        writer.writeU256(this._blockMempool.get(blockHeight));
        writer.writeU256(this._blockTimestamp.get(blockHeight));
        writer.writeU256(this._blockDataSet.get(blockHeight));
        return writer;
    }

    @method()
    @returns({ name: 'nextBetId', type: ABIDataTypes.UINT256 })
    public getNextBetId(_calldata: Calldata): BytesWriter {
        const writer: BytesWriter = new BytesWriter(32);
        writer.writeU256(this._nextBetId.value);
        return writer;
    }

    @method()
    @returns({ name: 'currentBtcBlock', type: ABIDataTypes.UINT256 })
    public getCurrentBtcBlock(_calldata: Calldata): BytesWriter {
        const writer: BytesWriter = new BytesWriter(32);
        writer.writeU256(this._currentBtcBlock.value);
        return writer;
    }

    @method({ name: 'betId', type: ABIDataTypes.UINT256 })
    @returns({ name: 'owner', type: ABIDataTypes.UINT256 })
    public getBetOwner(calldata: Calldata): BytesWriter {
        const betId: u256 = calldata.readU256();
        const writer: BytesWriter = new BytesWriter(32);
        writer.writeU256(this._betOwner.get(betId));
        return writer;
    }

    @method({ name: 'token', type: ABIDataTypes.ADDRESS })
    @returns(
        { name: 'totalPool', type: ABIDataTypes.UINT256 },
        { name: 'pendingExposure', type: ABIDataTypes.UINT256 },
        { name: 'latestOracleFee', type: ABIDataTypes.UINT256 },
    )
    public getPoolInfo(calldata: Calldata): BytesWriter {
        const token: Address = calldata.readAddress();
        const writer: BytesWriter = new BytesWriter(32 * 3);
        writer.writeU256(this._tokenPool.get(token));
        writer.writeU256(this._tokenExposure.get(token));
        writer.writeU256(this._latestOracleFee.value);
        return writer;
    }

    @method({ name: 'token', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'accepted', type: ABIDataTypes.BOOL })
    public isTokenAccepted(calldata: Calldata): BytesWriter {
        const token: Address = calldata.readAddress();
        const writer: BytesWriter = new BytesWriter(1);
        writer.writeBoolean(u256.eq(this._acceptedTokens.get(token), TOKEN_ACCEPTED));
        return writer;
    }

    // ═══════════════════════════════════════════════════════════
    // ADMIN
    // ═══════════════════════════════════════════════════════════
    @method({ name: 'amount', type: ABIDataTypes.UINT256 })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public setMinBet(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        this._minBet.set(calldata.readU256());
        const writer: BytesWriter = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    @method({ name: 'amount', type: ABIDataTypes.UINT256 })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public setMaxBet(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        this._maxBet.set(calldata.readU256());
        const writer: BytesWriter = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    @method({ name: 'paused', type: ABIDataTypes.BOOL })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public setPaused(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        this._paused.value = calldata.readBoolean();
        const writer: BytesWriter = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    // ═══════════════════════════════════════════════════════════
    // BET RESOLUTION (internal)
    // ═══════════════════════════════════════════════════════════
    private resolveBetInternal(
        betType: u256, param1: u256, param2: u256,
        targetBlock: u256, endBlock: u256, refFee: u256,
    ): bool {
        if (u256.eq(betType, BET_OVER_UNDER)) return this.resolveOverUnder(param1, param2, targetBlock);
        if (u256.eq(betType, BET_EXACT)) return this.resolveExact(param1, targetBlock);
        if (u256.eq(betType, BET_TREND)) return this.resolveTrend(param1, targetBlock, endBlock, refFee);
        if (u256.eq(betType, BET_MEMPOOL)) return this.resolveMempool(param1, endBlock);
        if (u256.eq(betType, BET_BLOCKTIME)) return this.resolveBlockTime(param1, targetBlock);
        if (u256.eq(betType, BET_SPIKE)) return this.resolveSpike(param1, targetBlock, endBlock);
        return false;
    }

    private resolveOverUnder(direction: u256, threshold: u256, targetBlock: u256): bool {
        const fee: u256 = this._blockFee.get(targetBlock);
        if (u256.eq(direction, OPTION_1)) return !u256.lt(fee, threshold); // fee >= threshold
        return u256.lt(fee, threshold); // fee < threshold
    }

    private resolveExact(prediction: u256, targetBlock: u256): bool {
        const fee: u256 = this._blockFee.get(targetBlock);
        let diff: u256;
        if (u256.gt(fee, prediction)) {
            diff = SafeMath.sub(fee, prediction);
        } else {
            diff = SafeMath.sub(prediction, fee);
        }
        return !u256.gt(diff, EXACT_TOLERANCE);
    }

    private resolveTrend(direction: u256, targetBlock: u256, endBlock: u256, refFee: u256): bool {
        let sum: u256 = u256.Zero;
        let count: u256 = u256.Zero;
        let block: u256 = targetBlock;

        const maxIter: u32 = <u32>TREND_BLOCKS + 1;
        for (let i: u32 = 0; i < maxIter; i++) {
            if (u256.gt(block, endBlock)) break;
            if (u256.gt(this._blockDataSet.get(block), u256.Zero)) {
                sum = SafeMath.add(sum, this._blockFee.get(block));
                count = SafeMath.add(count, u256.One);
            }
            block = SafeMath.add(block, u256.One);
        }

        // Require ALL blocks in the window to have data — partial averages are unfair
        const expectedBlocks: u256 = SafeMath.add(SafeMath.sub(endBlock, targetBlock), u256.One);
        if (!u256.eq(count, expectedBlocks)) {
            throw new Revert('Trend: missing block data in window');
        }
        const avgFee: u256 = SafeMath.div(sum, count);

        if (u256.eq(direction, OPTION_1)) return u256.gt(avgFee, refFee);
        return u256.lt(avgFee, refFee);
    }

    private resolveMempool(option: u256, endBlock: u256): bool {
        const count: u256 = this._blockMempool.get(endBlock);
        if (u256.eq(option, OPTION_1)) return u256.gt(count, MEMPOOL_THRESHOLD_1);
        if (u256.eq(option, OPTION_2)) return u256.lt(count, MEMPOOL_THRESHOLD_2);
        if (u256.eq(option, OPTION_3)) return u256.gt(count, MEMPOOL_THRESHOLD_3);
        return u256.lt(count, MEMPOOL_THRESHOLD_4);
    }

    private resolveBlockTime(option: u256, targetBlock: u256): bool {
        const thisTimestamp: u256 = this._blockTimestamp.get(targetBlock);
        const prevBlock: u256 = SafeMath.sub(targetBlock, u256.One);

        if (u256.eq(this._blockDataSet.get(prevBlock), u256.Zero)) {
            throw new Revert('Previous block data required');
        }

        const prevTimestamp: u256 = this._blockTimestamp.get(prevBlock);
        let timeDiff: u256;
        if (u256.gt(thisTimestamp, prevTimestamp)) {
            timeDiff = SafeMath.sub(thisTimestamp, prevTimestamp);
        } else {
            timeDiff = u256.Zero;
        }

        if (u256.eq(option, OPTION_1)) return u256.lt(timeDiff, TIME_5_MIN);
        if (u256.eq(option, OPTION_2)) return !u256.lt(timeDiff, TIME_5_MIN) && u256.lt(timeDiff, TIME_10_MIN);
        if (u256.eq(option, OPTION_3)) return !u256.lt(timeDiff, TIME_10_MIN) && u256.lt(timeDiff, TIME_20_MIN);
        return !u256.lt(timeDiff, TIME_20_MIN);
    }

    private resolveSpike(option: u256, targetBlock: u256, endBlock: u256): bool {
        let maxFee: u256 = u256.Zero;
        let block: u256 = targetBlock;

        const maxIter: u32 = <u32>SPIKE_BLOCKS + 1;
        for (let i: u32 = 0; i < maxIter; i++) {
            if (u256.gt(block, endBlock)) break;
            if (u256.gt(this._blockDataSet.get(block), u256.Zero)) {
                const fee: u256 = this._blockFee.get(block);
                if (u256.gt(fee, maxFee)) maxFee = fee;
            }
            block = SafeMath.add(block, u256.One);
        }

        if (u256.eq(option, OPTION_1)) return !u256.lt(maxFee, SPIKE_THRESHOLD_1);
        if (u256.eq(option, OPTION_2)) return !u256.lt(maxFee, SPIKE_THRESHOLD_2);
        if (u256.eq(option, OPTION_3)) return !u256.lt(maxFee, SPIKE_THRESHOLD_3);
        return !u256.lt(maxFee, SPIKE_THRESHOLD_4);
    }

    // ═══════════════════════════════════════════════════════════
    // DYNAMIC O/U ODDS
    // ═══════════════════════════════════════════════════════════
    private calculateOUOdds(direction: u256, threshold: u256): u256 {
        const currentFee: u256 = this._latestOracleFee.value;
        if (u256.eq(currentFee, u256.Zero)) {
            return DEFAULT_OU_ODDS;
        }

        let hardBet: bool;
        let distance: u256;

        if (u256.eq(direction, OPTION_1)) {
            if (!u256.lt(threshold, currentFee)) {
                hardBet = true;
                distance = SafeMath.sub(threshold, currentFee);
            } else {
                hardBet = false;
                distance = SafeMath.sub(currentFee, threshold);
            }
        } else {
            if (!u256.gt(threshold, currentFee)) {
                hardBet = true;
                distance = SafeMath.sub(currentFee, threshold);
            } else {
                hardBet = false;
                distance = SafeMath.sub(threshold, currentFee);
            }
        }

        const ratio: u256 = SafeMath.div(SafeMath.mul(distance, BP_SCALE), currentFee);

        let odds: u256;
        if (hardBet) {
            if (u256.lt(ratio, TIER_1_BP)) { odds = HARD_TIER_1; }
            else if (u256.lt(ratio, TIER_2_BP)) { odds = HARD_TIER_2; }
            else if (u256.lt(ratio, TIER_3_BP)) { odds = HARD_TIER_3; }
            else if (u256.lt(ratio, TIER_4_BP)) { odds = HARD_TIER_4; }
            else { odds = HARD_TIER_5; }
        } else {
            if (u256.lt(ratio, TIER_1_BP)) { odds = EASY_TIER_1; }
            else if (u256.lt(ratio, TIER_2_BP)) { odds = EASY_TIER_2; }
            else if (u256.lt(ratio, TIER_3_BP)) { odds = EASY_TIER_3; }
            else if (u256.lt(ratio, TIER_4_BP)) { odds = EASY_TIER_4; }
            else { odds = MIN_ODDS; }
        }

        if (u256.lt(odds, MIN_ODDS)) odds = MIN_ODDS;
        if (u256.gt(odds, MAX_ODDS)) odds = MAX_ODDS;
        return odds;
    }

    private getMempoolOdds(option: u256): u256 {
        if (u256.eq(option, OPTION_1)) return MEMPOOL_ODDS_1;
        if (u256.eq(option, OPTION_2)) return MEMPOOL_ODDS_2;
        if (u256.eq(option, OPTION_3)) return MEMPOOL_ODDS_3;
        return MEMPOOL_ODDS_4;
    }

    private getBlockTimeOdds(option: u256): u256 {
        if (u256.eq(option, OPTION_1)) return BLOCKTIME_ODDS_1;
        if (u256.eq(option, OPTION_2)) return BLOCKTIME_ODDS_2;
        if (u256.eq(option, OPTION_3)) return BLOCKTIME_ODDS_3;
        return BLOCKTIME_ODDS_4;
    }

    private getSpikeOdds(option: u256): u256 {
        if (u256.eq(option, OPTION_1)) return SPIKE_ODDS_1;
        if (u256.eq(option, OPTION_2)) return SPIKE_ODDS_2;
        if (u256.eq(option, OPTION_3)) return SPIKE_ODDS_3;
        return SPIKE_ODDS_4;
    }

    // ═══════════════════════════════════════════════════════════
    // VALIDATION
    // ═══════════════════════════════════════════════════════════
    private validateDirection(d: u256): void {
        if (!u256.eq(d, OPTION_1) && !u256.eq(d, OPTION_2)) {
            throw new Revert('Invalid direction: 1 or 2');
        }
    }

    private validateOption(o: u256): void {
        if (!u256.eq(o, OPTION_1) && !u256.eq(o, OPTION_2) &&
            !u256.eq(o, OPTION_3) && !u256.eq(o, OPTION_4)) {
            throw new Revert('Invalid option: 1-4');
        }
    }

    // ═══════════════════════════════════════════════════════════
    // CROSS-CONTRACT TOKEN CALLS
    // ═══════════════════════════════════════════════════════════

    /**
     * Pull tokens from a user to this contract via transferFrom.
     * Requires prior allowance: token.increaseAllowance(thisContract, amount).
     */
    private pullTokens(token: Address, from: Address, amount: u256): void {
        const callWriter: BytesWriter = new BytesWriter(100);
        callWriter.writeSelector(TRANSFER_FROM_SELECTOR);
        callWriter.writeAddress(from);
        callWriter.writeAddress(Blockchain.contract.address);
        callWriter.writeU256(amount);

        const result = Blockchain.call(token, callWriter, true);
        if (result.data.byteLength > 0) {
            if (!result.data.readBoolean()) {
                throw new Revert('Token transferFrom failed');
            }
        }
    }

    /**
     * Push tokens from this contract to a recipient via transfer.
     */
    private pushTokens(token: Address, to: Address, amount: u256): void {
        const callWriter: BytesWriter = new BytesWriter(68);
        callWriter.writeSelector(TRANSFER_SELECTOR);
        callWriter.writeAddress(to);
        callWriter.writeU256(amount);

        const result = Blockchain.call(token, callWriter, true);
        if (result.data.byteLength > 0) {
            if (!result.data.readBoolean()) {
                throw new Revert('Token transfer failed');
            }
        }
    }
}
