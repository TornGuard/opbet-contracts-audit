import { u256 } from '@btc-vision/as-bignum/assembly';
import {
    Address,
    Blockchain,
    BytesWriter,
    Calldata,
    EMPTY_POINTER,
    AddressMemoryMap,
    NetEvent,
    OP20,
    OP20InitParameters,
    Revert,
    SafeMath,
    Segwit,
    StoredAddress,
    StoredBoolean,
    StoredU256,
    keccak256,
    keccak256Concat,
} from '@btc-vision/btc-runtime/runtime';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** 100,000,000 OPBET · 18 decimals. Hard cap — nobody can ever mint more. */
const MAX_SUPPLY: u256 = u256.fromString('100000000000000000000000000');
const DECIMALS: u8 = 18;

/** 3% transfer tax (300 basis points) */
const TAX_RATE_DEFAULT: u256 = u256.fromU32(300);
const BASIS_POINTS: u256 = u256.fromU32(10000);
const MAX_TAX_RATE: u256 = u256.fromU32(500); // 5% cap

/** Presale cap: 10% of max supply = 10,000,000 OPBET */
const PRESALE_CAP: u256 = u256.fromString('10000000000000000000000000');

/**
 * 1e18 — multiplier to convert whole-token prices to 18-decimal units.
 * BTC formula: tokensMinted = (satsPaid * 1e18) / satsPerWholeToken
 * This means satsPerToken in calldata = sats per 1 WHOLE OPBET (not per unit).
 * e.g. satsPerToken=1000 → 1000 sats buys 1 OPBET (≈$1 at $100k BTC)
 */
const TOKEN_DECIMALS: u256 = u256.fromString('1000000000000000000');

/** OP20 transferFrom(address,address,uint256) selector */
const TRANSFER_FROM_SELECTOR: u32 = 0x23b872dd;

const U256_ONE: u256 = u256.One;

/** Airdrop: 5,000 OPBET per claim (18 decimals) */
const AIRDROP_AMOUNT: u256 = u256.fromString('5000000000000000000000');
/** Airdrop: first 1,000 MOTO holders to claim */
const AIRDROP_MAX_CLAIMS: u256 = u256.fromU32(1000);

// ─────────────────────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fired on every presale purchase.
 * paymentToken: Address.zero() means BTC was used.
 */
@final
class PresalePurchaseEvent extends NetEvent {
    constructor(
        buyer: Address,
        paymentToken: Address,
        amountPaid: u256,
        tokensMinted: u256,
    ) {
        const data = new BytesWriter(128);
        data.writeAddress(buyer);
        data.writeAddress(paymentToken);
        data.writeU256(amountPaid);
        data.writeU256(tokensMinted);
        super('PresalePurchase', data);
    }
}

/** Fired once when the presale reaches its 10% cap. */
@final
class PresaleCompleteEvent extends NetEvent {
    constructor(totalSold: u256) {
        const data = new BytesWriter(32);
        data.writeU256(totalSold);
        super('PresaleComplete', data);
    }
}

/** Fired when BTC price is updated. */
@final
class BTCPriceUpdatedEvent extends NetEvent {
    constructor(satsPerToken: u256) {
        const data = new BytesWriter(32);
        data.writeU256(satsPerToken);
        super('BTCPriceUpdated', data);
    }
}

/** Fired when a supported payment token is added or updated. */
@final
class TokenSupportedEvent extends NetEvent {
    constructor(token: Address, pricePerOPBET: u256) {
        const data = new BytesWriter(64);
        data.writeAddress(token);
        data.writeU256(pricePerOPBET);
        super('TokenSupported', data);
    }
}

/** Fired when a payment token is removed. */
@final
class TokenRemovedEvent extends NetEvent {
    constructor(token: Address) {
        const data = new BytesWriter(32);
        data.writeAddress(token);
        super('TokenRemoved', data);
    }
}

/** Fired on every dev mint. */
@final
class DevMintEvent extends NetEvent {
    constructor(recipient: Address, amount: u256) {
        const data = new BytesWriter(64);
        data.writeAddress(recipient);
        data.writeU256(amount);
        super('DevMint', data);
    }
}

/** Fired when presale is paused or resumed. */
@final
class PresaleStatusEvent extends NetEvent {
    constructor(active: bool) {
        const data = new BytesWriter(1);
        data.writeBoolean(active);
        super('PresaleStatus', data);
    }
}

/** Fired when a MOTO holder successfully claims their airdrop. */
@final
class AirdropClaimedEvent extends NetEvent {
    constructor(recipient: Address, amount: u256) {
        const data = new BytesWriter(64);
        data.writeAddress(recipient);
        data.writeU256(amount);
        super('AirdropClaimed', data);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Contract
// ─────────────────────────────────────────────────────────────────────────────

@final
export class OPBET_Token extends OP20 {
    // ── Token storage ──────────────────────────────────────────────────────
    private readonly taxRatePointer: u16       = Blockchain.nextPointer;
    private readonly teamWalletPointer: u16    = Blockchain.nextPointer;
    private readonly taxExemptPointer: u16     = Blockchain.nextPointer;

    private readonly _taxRate: StoredU256      = new StoredU256(this.taxRatePointer, EMPTY_POINTER);
    private readonly _teamWallet: StoredAddress = new StoredAddress(this.teamWalletPointer);
    private readonly _taxExempt: AddressMemoryMap = new AddressMemoryMap(this.taxExemptPointer);

    // ── Presale storage ────────────────────────────────────────────────────
    private readonly presaleSoldPointer: u16   = Blockchain.nextPointer;
    private readonly presaleActivePointer: u16 = Blockchain.nextPointer;
    private readonly satsPerTokenPointer: u16  = Blockchain.nextPointer;
    private readonly treasuryKeyPointer: u16   = Blockchain.nextPointer;

    // Supported OP20 payment tokens:
    //   _tokenPrice[tokenAddr] = price in that token's smallest unit per 1 OPBET (0 = unsupported)
    // All OP20 proceeds go to a single _tokensTreasury address.
    private readonly tokenPricePointer: u16      = Blockchain.nextPointer;
    private readonly tokensTreasuryPointer: u16  = Blockchain.nextPointer;

    private readonly _presaleSold: StoredU256    = new StoredU256(this.presaleSoldPointer, EMPTY_POINTER);
    private readonly _presaleActive: StoredBoolean = new StoredBoolean(this.presaleActivePointer, true);
    private readonly _satsPerToken: StoredU256   = new StoredU256(this.satsPerTokenPointer, EMPTY_POINTER);
    /** 32-byte x-only P2TR pubkey of BTC treasury, stored as big-endian u256 */
    private readonly _treasuryKey: StoredU256    = new StoredU256(this.treasuryKeyPointer, EMPTY_POINTER);
    private readonly _tokenPrice: AddressMemoryMap   = new AddressMemoryMap(this.tokenPricePointer);
    /** Single OPNet address that receives proceeds for all supported OP20 tokens */
    private readonly _tokensTreasury: StoredAddress  = new StoredAddress(this.tokensTreasuryPointer);

    // ── Airdrop / Merkle storage ───────────────────────────────────────────
    private readonly merkleRootPointer: u16        = Blockchain.nextPointer;
    private readonly airdropClaimedPointer: u16    = Blockchain.nextPointer;
    private readonly airdropCountPointer: u16      = Blockchain.nextPointer;

    /** Merkle root of MOTO-holder snapshot (keccak256 double-leaf tree) */
    private readonly _merkleRoot: StoredU256       = new StoredU256(this.merkleRootPointer, EMPTY_POINTER);
    /** claimed[address] = 1 after a successful claim */
    private readonly _airdropClaimed: AddressMemoryMap = new AddressMemoryMap(this.airdropClaimedPointer);
    /** Total number of claims so far */
    private readonly _airdropCount: StoredU256     = new StoredU256(this.airdropCountPointer, EMPTY_POINTER);

    public constructor() {
        super();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Deployment
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Deployment calldata (in order):
     *   1. teamWallet      : Address  — tax recipient; also tax-exempt
     *   2. tokensTreasury  : Address  — OPNet address receiving all OP20 token proceeds
     *   3. treasuryKey     : u256     — 32-byte x-only P2TR pubkey of BTC treasury (big-endian)
     *   4. initSatsPerToken: u256     — sats per 1 OPBET (18-dec unit); 0 to disable BTC
     */
    public override onDeployment(calldata: Calldata): void {
        this.instantiate(new OP20InitParameters(MAX_SUPPLY, DECIMALS, 'OP_BET', 'OPBET'));

        this._taxRate.value = TAX_RATE_DEFAULT;

        const teamWallet: Address = calldata.readAddress();
        this._setTeamWallet(teamWallet);

        const tokensTreasury: Address = calldata.readAddress();
        if (tokensTreasury.equals(Address.zero())) throw new Revert('Invalid tokensTreasury');
        this._tokensTreasury.value = tokensTreasury;

        const treasuryKey: u256 = calldata.readU256();
        this._treasuryKey.value = treasuryKey;

        const initSatsPerToken: u256 = calldata.readU256();
        this._satsPerToken.value = initSatsPerToken;

        // Deployer and team wallet are always tax-exempt
        this._taxExempt.set(Blockchain.tx.sender, U256_ONE);
        this._taxExempt.set(teamWallet, U256_ONE);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Presale: Buy with BTC
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Purchase OPBET tokens by paying BTC in the same transaction.
     *
     * HOW IT WORKS:
     *   OPNet contracts never hold BTC. Instead you include TWO outputs in one tx:
     *     Output 1 → BTC to treasury address `bc1ptexj...` (your actual payment)
     *     Output 2 → This contract call (buyWithBTC)
     *
     *   The contract scans Blockchain.tx.outputs for a P2TR output matching the
     *   stored treasury key, reads the sats amount, and mints tokens accordingly.
     *   BTC lands directly in your treasury wallet — zero custody risk.
     *
     * Formula: tokens = floor(satsPaid / satsPerToken)
     */
    @method({ name: 'recipient', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'tokensMinted', type: ABIDataTypes.UINT256 })
    public buyWithBTC(calldata: Calldata): BytesWriter {
        this._requirePresaleActive();

        // Caller explicitly passes their own address — avoids relying on
        // Blockchain.tx.sender which can be zero when wallet has no MLDSA identity linked.
        const recipient: Address = calldata.readAddress();
        if (recipient.equals(Address.zero())) throw new Revert('Invalid recipient address');

        const satsPerToken: u256 = this._satsPerToken.value;
        if (u256.eq(satsPerToken, u256.Zero)) throw new Revert('BTC presale price not set');

        const satsPaid: u64 = this._findBTCPaymentToTreasury();
        if (satsPaid === 0) throw new Revert('No BTC output to treasury found in this tx');

        // tokensMinted = (satsPaid × 1e18) / satsPerWholeToken
        const tokensMinted: u256 = SafeMath.div(
            SafeMath.mul(u256.fromU64(satsPaid), TOKEN_DECIMALS),
            satsPerToken,
        );
        if (u256.eq(tokensMinted, u256.Zero)) throw new Revert('Payment too small for 1 token unit');

        this._mintPresale(recipient, Address.zero(), u256.fromU64(satsPaid), tokensMinted);

        const writer = new BytesWriter(32);
        writer.writeU256(tokensMinted);
        return writer;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Presale: Buy with any supported OP20 token
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Purchase OPBET tokens using any supported OP20 token (MOTO, USDC, etc.).
     *
     * HOW IT WORKS:
     *   1. Caller calls token.increaseAllowance(thisContract, tokenAmount) first.
     *   2. Caller calls buyWithToken(tokenAddress, tokenAmount).
     *   3. Contract verifies token is supported, pulls tokens via transferFrom,
     *      sends them to the configured per-token treasury, mints OPBET.
     *
     * Formula: opbetMinted = floor(tokenAmount / pricePerOPBET)
     */
    @method(
        { name: 'token', type: ABIDataTypes.ADDRESS },
        { name: 'tokenAmount', type: ABIDataTypes.UINT256 },
    )
    @returns({ name: 'tokensMinted', type: ABIDataTypes.UINT256 })
    public buyWithToken(calldata: Calldata): BytesWriter {
        this._requirePresaleActive();

        const token: Address = calldata.readAddress();
        const tokenAmount: u256 = calldata.readU256();
        if (u256.eq(tokenAmount, u256.Zero)) throw new Revert('tokenAmount cannot be zero');

        const pricePerOPBET: u256 = this._tokenPrice.get(token);
        if (u256.eq(pricePerOPBET, u256.Zero)) throw new Revert('Token not supported for presale');

        const opbetMinted: u256 = SafeMath.div(tokenAmount, pricePerOPBET);
        if (u256.eq(opbetMinted, u256.Zero)) throw new Revert('Token amount too small for 1 OPBET unit');

        // Pull payment tokens from buyer to the shared OP20 treasury
        this._pullToken(token, Blockchain.tx.sender, this._tokensTreasury.value, tokenAmount);

        this._mintPresale(Blockchain.tx.sender, token, tokenAmount, opbetMinted);

        const writer = new BytesWriter(32);
        writer.writeU256(opbetMinted);
        return writer;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Admin: Token support management
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Add or update a supported OP20 payment token. Owner only.
     * All proceeds go to the shared tokensTreasury set at deployment.
     *
     * @param token         — OP20 contract address to accept as payment
     * @param pricePerOPBET — smallest units of that token required per 1 OPBET (18-dec unit)
     *                        e.g. MOTO (18 dec): 1000 * 1e18 = 1000 MOTO per OPBET
     */
    @method(
        { name: 'token', type: ABIDataTypes.ADDRESS },
        { name: 'pricePerOPBET', type: ABIDataTypes.UINT256 },
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public addSupportedToken(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);

        const token: Address = calldata.readAddress();
        const pricePerOPBET: u256 = calldata.readU256();

        if (token.equals(Address.zero())) throw new Revert('Invalid token address');
        if (u256.eq(pricePerOPBET, u256.Zero)) throw new Revert('Price must be > 0');

        this._tokenPrice.set(token, pricePerOPBET);
        this.emitEvent(new TokenSupportedEvent(token, pricePerOPBET));

        const writer = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    /**
     * Remove a supported payment token. Owner only.
     * Sets price to 0 — buyWithToken() will revert for this token.
     */
    @method({ name: 'token', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public removeSupportedToken(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);

        const token: Address = calldata.readAddress();
        this._tokenPrice.set(token, u256.Zero);

        this.emitEvent(new TokenRemovedEvent(token));

        const writer = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    /** Read whether a token is supported and its price per OPBET. */
    @method({ name: 'token', type: ABIDataTypes.ADDRESS })
    public getTokenInfo(calldata: Calldata): BytesWriter {
        const token: Address = calldata.readAddress();
        const price: u256 = this._tokenPrice.get(token);

        const writer = new BytesWriter(33);
        writer.writeU256(price);                         // 0 = not supported
        writer.writeBoolean(!u256.eq(price, u256.Zero)); // supported?
        return writer;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Admin: BTC price + presale controls
    // ─────────────────────────────────────────────────────────────────────────

    /** Update BTC price. Owner only. Pass 0 to disable BTC purchases. */
    @method({ name: 'satsPerToken', type: ABIDataTypes.UINT256 })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public setBTCPrice(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);

        const sats: u256 = calldata.readU256();
        this._satsPerToken.value = sats;
        this.emitEvent(new BTCPriceUpdatedEvent(sats));

        const writer = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    /** Pause or resume the presale. Owner only. */
    @method({ name: 'active', type: ABIDataTypes.BOOL })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public setPresaleActive(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);

        const active: bool = calldata.readBoolean();
        this._presaleActive.value = active;
        this.emitEvent(new PresaleStatusEvent(active));

        const writer = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Dev Mint (owner only — free allocation)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Mint tokens freely to any address. Owner only.
     * Use for: team, advisors, partnerships, airdrops, ecosystem grants.
     * Does NOT count toward the 10% presale cap.
     * Cannot exceed MAX_SUPPLY (100M) — the OP20 _mint enforces this.
     */
    @method(
        { name: 'to', type: ABIDataTypes.ADDRESS },
        { name: 'amount', type: ABIDataTypes.UINT256 },
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public devMint(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);

        const to: Address = calldata.readAddress();
        if (to.equals(Address.zero())) throw new Revert('Cannot mint to zero address');
        const amount: u256 = calldata.readU256();
        if (u256.eq(amount, u256.Zero)) throw new Revert('Amount cannot be zero');

        this._mint(to, amount);
        this.emitEvent(new DevMintEvent(to, amount));

        const writer = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Airdrop: Merkle-based MOTO holder claim
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Set the Merkle root for the MOTO-holder airdrop. Owner only.
     * Root is built off-chain from the MOTO snapshot using
     * leaf = keccak256(keccak256(address)) and sorted-pair node hashing.
     */
    @method({ name: 'root', type: ABIDataTypes.UINT256 })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public setMerkleRoot(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        const root: u256 = calldata.readU256();
        this._merkleRoot.value = root;
        const writer = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    /**
     * Claim 5,000 OPBET airdrop as a MOTO holder.
     *
     * CALL PATTERN:
     *   1. Off-chain: run `node scripts/build-merkle.js` after MOTO snapshot
     *   2. Off-chain: retrieve your proof array from merkle.json
     *   3. On-chain: call claimAirdrop(yourAddress, proof)
     *
     * Proof encoding: flat byte array, N × 32 bytes, one sibling hash per level.
     * Leaf = keccak256(keccak256(recipientAddress))  (32-byte raw address bytes)
     * Node = keccak256(sort_lex(left, right))         (sorted to match off-chain tree)
     */
    @method(
        { name: 'recipient', type: ABIDataTypes.ADDRESS },
        { name: 'proof',     type: ABIDataTypes.BYTES   },
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public claimAirdrop(calldata: Calldata): BytesWriter {
        const recipient: Address = calldata.readAddress();
        if (recipient.equals(Address.zero())) throw new Revert('Invalid recipient');

        const root: u256 = this._merkleRoot.value;
        if (u256.eq(root, u256.Zero)) throw new Revert('Airdrop not configured');

        const count: u256 = this._airdropCount.value;
        if (u256.ge(count, AIRDROP_MAX_CLAIMS)) throw new Revert('Airdrop fully claimed');

        if (u256.gt(this._airdropClaimed.get(recipient), u256.Zero)) {
            throw new Revert('Already claimed');
        }

        const proofBytes: Uint8Array = calldata.readBytesWithLength();
        if (proofBytes.length % 32 !== 0) throw new Revert('Invalid proof length');

        const leaf: Uint8Array = this._computeLeaf(recipient);
        if (!this._verifyMerkleProof(leaf, proofBytes, root)) {
            throw new Revert('Invalid Merkle proof');
        }

        this._airdropClaimed.set(recipient, U256_ONE);
        this._airdropCount.value = SafeMath.add(count, U256_ONE);

        this._mint(recipient, AIRDROP_AMOUNT);
        this.emitEvent(new AirdropClaimedEvent(recipient, AIRDROP_AMOUNT));

        const writer = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    /** View: airdrop status — root, claimCount, maxClaims, amountPerClaim, active */
    @method()
    public airdropInfo(_calldata: Calldata): BytesWriter {
        const count: u256 = this._airdropCount.value;
        const writer = new BytesWriter(32 + 32 + 32 + 32 + 1);
        writer.writeU256(this._merkleRoot.value);
        writer.writeU256(count);
        writer.writeU256(AIRDROP_MAX_CLAIMS);
        writer.writeU256(AIRDROP_AMOUNT);
        writer.writeBoolean(u256.lt(count, AIRDROP_MAX_CLAIMS));
        return writer;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Full presale snapshot:
     *   sold(u256) | remaining(u256) | cap(u256) | satsPerToken(u256) | active(bool)
     */
    @method()
    public presaleInfo(_calldata: Calldata): BytesWriter {
        const sold: u256 = this._presaleSold.value;
        const remaining: u256 = u256.gt(PRESALE_CAP, sold)
            ? SafeMath.sub(PRESALE_CAP, sold)
            : u256.Zero;

        const writer = new BytesWriter(32 + 32 + 32 + 32 + 1);
        writer.writeU256(sold);
        writer.writeU256(remaining);
        writer.writeU256(PRESALE_CAP);
        writer.writeU256(this._satsPerToken.value);
        writer.writeBoolean(this._presaleActive.value);
        return writer;
    }

    @method()
    @returns({ name: 'rate', type: ABIDataTypes.UINT256 })
    public getTaxRate(_calldata: Calldata): BytesWriter {
        const writer = new BytesWriter(32);
        writer.writeU256(this._taxRate.value);
        return writer;
    }

    @method({ name: 'addr', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'exempt', type: ABIDataTypes.BOOL })
    public getIsExempt(calldata: Calldata): BytesWriter {
        const writer = new BytesWriter(1);
        writer.writeBoolean(u256.gt(this._taxExempt.get(calldata.readAddress()), u256.Zero));
        return writer;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Token admin
    // ─────────────────────────────────────────────────────────────────────────

    @method({ name: 'newRate', type: ABIDataTypes.UINT256 })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public setTaxRate(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        const newRate: u256 = calldata.readU256();
        if (u256.gt(newRate, MAX_TAX_RATE)) throw new Revert('Tax rate exceeds 5% cap');
        this._taxRate.value = newRate;
        const writer = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    @method(
        { name: 'addr', type: ABIDataTypes.ADDRESS },
        { name: 'exempt', type: ABIDataTypes.BOOL },
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public setExempt(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        const addr: Address = calldata.readAddress();
        const exempt: bool = calldata.readBoolean();
        this._taxExempt.set(addr, exempt ? U256_ONE : u256.Zero);
        const writer = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    @method({ name: 'wallet', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public setTeamWallet(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        this._setTeamWallet(calldata.readAddress());
        const writer = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // OP20 transfer overrides (3% tax)
    // ─────────────────────────────────────────────────────────────────────────

    public override transfer(calldata: Calldata): BytesWriter {
        const to: Address = calldata.readAddress();
        const amount: u256 = calldata.readU256();
        this._transferWithTax(Blockchain.tx.sender, to, amount);
        const writer = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    public override transferFrom(calldata: Calldata): BytesWriter {
        const from: Address = calldata.readAddress();
        const to: Address = calldata.readAddress();
        const amount: u256 = calldata.readU256();
        this._spendAllowance(from, Blockchain.tx.sender, amount);
        this._transferWithTax(from, to, amount);
        const writer = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internals
    // ─────────────────────────────────────────────────────────────────────────

    private _mintPresale(
        buyer: Address,
        paymentToken: Address,
        amountPaid: u256,
        opbetMinted: u256,
    ): void {
        const newSold: u256 = SafeMath.add(this._presaleSold.value, opbetMinted);
        if (u256.gt(newSold, PRESALE_CAP)) throw new Revert('Purchase exceeds presale cap');

        this._presaleSold.value = newSold;
        this._mint(buyer, opbetMinted);
        this.emitEvent(new PresalePurchaseEvent(buyer, paymentToken, amountPaid, opbetMinted));

        if (u256.eq(newSold, PRESALE_CAP)) {
            this._presaleActive.value = false;
            this.emitEvent(new PresaleCompleteEvent(newSold));
        }
    }

    private _requirePresaleActive(): void {
        if (!this._presaleActive.value) throw new Revert('Presale is not active');
    }

    /**
     * Scans tx outputs for a P2TR output to the stored treasury key.
     * Returns satoshis paid, or 0 if not found.
     *
     * P2TR script format: 0x51 0x20 <32-byte x-only pubkey>
     */
    private _findBTCPaymentToTreasury(): u64 {
        const treasuryKey: u256 = this._treasuryKey.value;
        const outputs = Blockchain.tx.outputs;

        for (let i = 0; i < outputs.length; i++) {
            const output = outputs[i];

            // Path A: hasScriptPubKey — simulation provides raw P2TR bytes
            const script = output.scriptPublicKey;
            if (script !== null && script.length === 34 && script[0] === 0x51 && script[1] === 0x20) {
                if (this._keyBytesMatch(script, 2, treasuryKey)) {
                    return output.value;
                }
            }

            // Path B: hasTo — OPNet node provides the bech32(m) address string on-chain
            const to = output.to;
            if (to !== null) {
                const dec = Segwit.decodeOrNull(to);
                if (dec !== null && dec.version === 1 && dec.program.length === 32) {
                    if (this._keyBytesMatch(dec.program, 0, treasuryKey)) {
                        return output.value;
                    }
                }
            }
        }
        return 0;
    }

    /**
     * Byte-for-byte compare of buf[offset..offset+32] against the stored big-endian treasury key.
     * Used for both the raw scriptPubKey path (offset=2, skipping OP_1 PUSH32) and the
     * decoded witness-program path (offset=0, 32 bytes directly).
     */
    private _keyBytesMatch(buf: Uint8Array, offset: i32, key: u256): bool {
        const keyBytes: Uint8Array = key.toUint8Array(true);
        for (let i: i32 = 0; i < 32; i++) {
            if (buf[offset + i] !== keyBytes[i]) return false;
        }
        return true;
    }

    /**
     * Cross-contract: token.transferFrom(from, to, amount).
     * Requires `from` to have pre-approved this contract on `token`.
     */
    private _pullToken(token: Address, from: Address, to: Address, amount: u256): void {
        const calldata = new BytesWriter(132);
        calldata.writeSelector(TRANSFER_FROM_SELECTOR);
        calldata.writeAddress(from);
        calldata.writeAddress(to);
        calldata.writeU256(amount);

        const result = Blockchain.call(token, calldata, true);
        if (result.data.byteLength > 0) {
            if (!result.data.readBoolean()) {
                throw new Revert('Token transferFrom failed — check allowance');
            }
        }
    }

    private _transferWithTax(from: Address, to: Address, amount: u256): void {
        if (to.equals(Address.zero())) throw new Revert('Transfer to zero address');

        const senderExempt: bool  = u256.gt(this._taxExempt.get(from), u256.Zero);
        const recipientExempt: bool = u256.gt(this._taxExempt.get(to), u256.Zero);

        if (senderExempt || recipientExempt) {
            this._transfer(from, to, amount);
            return;
        }

        const taxAmount: u256 = SafeMath.div(SafeMath.mul(amount, this._taxRate.value), BASIS_POINTS);
        const netAmount: u256 = SafeMath.sub(amount, taxAmount);

        if (u256.gt(taxAmount, u256.Zero)) {
            this._transfer(from, this._teamWallet.value, taxAmount);
        }
        this._transfer(from, to, netAmount);
    }

    private _setTeamWallet(wallet: Address): void {
        if (wallet.equals(Address.zero())) throw new Revert('Invalid team wallet');
        this._teamWallet.value = wallet;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Merkle proof internals
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Compute double-keccak256 leaf for an address.
     * leaf = keccak256(keccak256(addressBytes))
     * Matches the off-chain build-merkle.js computation.
     */
    private _computeLeaf(addr: Address): Uint8Array {
        const addrBytes = new Uint8Array(32);
        for (let i: i32 = 0; i < 32; i++) {
            addrBytes[i] = addr[i];
        }
        return keccak256(keccak256(addrBytes));
    }

    /**
     * Hash a sorted pair of 32-byte nodes (standard Merkle tree pattern).
     * Smaller byte array (lexicographic) goes first.
     */
    private _hashPair(a: Uint8Array, b: Uint8Array): Uint8Array {
        for (let i: i32 = 0; i < 32; i++) {
            if (a[i] < b[i]) return keccak256Concat(a, b);
            if (a[i] > b[i]) return keccak256Concat(b, a);
        }
        return keccak256Concat(a, b);
    }

    /**
     * Verify a Merkle proof.
     * @param leaf      - 32-byte keccak256(keccak256(address))
     * @param proof     - flat byte array of N×32 sibling hashes
     * @param root      - expected Merkle root (u256, big-endian)
     */
    private _verifyMerkleProof(leaf: Uint8Array, proof: Uint8Array, root: u256): bool {
        const nodeCount: i32 = proof.length / 32;
        let current: Uint8Array = leaf;

        for (let i: i32 = 0; i < nodeCount; i++) {
            const node = new Uint8Array(32);
            for (let j: i32 = 0; j < 32; j++) {
                node[j] = proof[i * 32 + j];
            }
            current = this._hashPair(current, node);
        }

        const rootBytes: Uint8Array = root.toUint8Array(true); // big-endian
        for (let i: i32 = 0; i < 32; i++) {
            if (current[i] !== rootBytes[i]) return false;
        }
        return true;
    }
}
