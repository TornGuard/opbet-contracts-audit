import { u256 } from '@btc-vision/as-bignum/assembly';
import {
    Address,
    AddressMemoryMap,
    Blockchain,
    BytesWriter,
    Calldata,
    EMPTY_POINTER,
    NetEvent,
    OP_NET,
    Revert,
    SafeMath,
    Segwit,
    StoredBoolean,
    StoredU256,
    keccak256,
    keccak256Concat,
} from '@btc-vision/btc-runtime/runtime';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** 10,000,000 OPBET · 18 decimals — presale cap (10% of 100M supply) */
const PRESALE_CAP: u256 = u256.fromString('10000000000000000000000000');

/**
 * 1e18 — converts sats-per-whole-token to 18-decimal units.
 * opbetOwed = (satsPaid × 1e18) / satsPerWholeToken
 */
const TOKEN_DECIMALS: u256 = u256.fromString('1000000000000000000');

/** 5,000 OPBET per airdrop claim (18 decimals) */
const AIRDROP_AMOUNT: u256 = u256.fromString('5000000000000000000000');

/** Maximum 1,000 MOTO-holder airdrop slots */
const AIRDROP_MAX_CLAIMS: u256 = u256.fromU32(1000);

const U256_ONE: u256 = u256.One;

// ─────────────────────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────────────────────

/** Fired on every BTC purchase — records allocation in raise registry. */
@final
class RaisePurchaseEvent extends NetEvent {
    constructor(buyer: Address, satsPaid: u256, opbetOwed: u256) {
        const data = new BytesWriter(96);
        data.writeAddress(buyer);
        data.writeU256(satsPaid);
        data.writeU256(opbetOwed);
        super('RaisePurchase', data);
    }
}

/** Fired when a MOTO holder registers their airdrop claim. */
@final
class AirdropRegisteredEvent extends NetEvent {
    constructor(recipient: Address, amount: u256) {
        const data = new BytesWriter(64);
        data.writeAddress(recipient);
        data.writeU256(amount);
        super('AirdropRegistered', data);
    }
}

/** Fired when the presale is paused or resumed. */
@final
class PresaleStatusEvent extends NetEvent {
    constructor(active: bool) {
        const data = new BytesWriter(1);
        data.writeBoolean(active);
        super('PresaleStatus', data);
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

/** Fired when the Merkle root is set. */
@final
class MerkleRootSetEvent extends NetEvent {
    constructor(root: u256) {
        const data = new BytesWriter(32);
        data.writeU256(root);
        super('MerkleRootSet', data);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Contract
// ─────────────────────────────────────────────────────────────────────────────

/**
 * OPBETRaise — presale registry contract.
 *
 * Accepts BTC payments and records OPBET allocation claims.
 * MOTO holders register airdrop eligibility via Merkle proof.
 * No token is minted yet — this is a pure registry.
 * At TGE the deployer snapshots all balances and distributes via the real token.
 *
 * Deployment calldata (in order):
 *   1. treasuryKey     : u256  — 32-byte x-only P2TR pubkey of BTC treasury
 *   2. initSatsPerToken: u256  — sats per 1 whole OPBET; 0 = BTC purchases disabled
 */
@final
export class OPBETRaise extends OP_NET {
    // ── Presale storage ────────────────────────────────────────────────────
    private readonly presaleSoldPointer:   u16 = Blockchain.nextPointer;
    private readonly presaleActivePointer: u16 = Blockchain.nextPointer;
    private readonly satsPerTokenPointer:  u16 = Blockchain.nextPointer;
    private readonly treasuryKeyPointer:   u16 = Blockchain.nextPointer;

    private readonly _presaleSold:   StoredU256   = new StoredU256(this.presaleSoldPointer, EMPTY_POINTER);
    private readonly _presaleActive: StoredBoolean = new StoredBoolean(this.presaleActivePointer, true);
    private readonly _satsPerToken:  StoredU256   = new StoredU256(this.satsPerTokenPointer, EMPTY_POINTER);
    /** 32-byte x-only P2TR pubkey of BTC treasury, stored as big-endian u256 */
    private readonly _treasuryKey:  StoredU256   = new StoredU256(this.treasuryKeyPointer, EMPTY_POINTER);

    // ── Raise registry — how much OPBET each address is owed ──────────────
    /** opbetOwed[address] = total OPBET (18-dec) registered for this address via presale */
    private readonly raiseBalancePointer: u16 = Blockchain.nextPointer;
    private readonly _raiseBalance: AddressMemoryMap = new AddressMemoryMap(this.raiseBalancePointer);

    // ── Airdrop / Merkle storage ───────────────────────────────────────────
    private readonly merkleRootPointer:     u16 = Blockchain.nextPointer;
    private readonly airdropClaimedPointer: u16 = Blockchain.nextPointer;
    private readonly airdropCountPointer:   u16 = Blockchain.nextPointer;
    /** airdropOwed[address] = AIRDROP_AMOUNT once registered (0 = not yet claimed) */
    private readonly airdropBalancePointer: u16 = Blockchain.nextPointer;

    private readonly _merkleRoot:     StoredU256       = new StoredU256(this.merkleRootPointer, EMPTY_POINTER);
    private readonly _airdropClaimed: AddressMemoryMap = new AddressMemoryMap(this.airdropClaimedPointer);
    private readonly _airdropCount:   StoredU256       = new StoredU256(this.airdropCountPointer, EMPTY_POINTER);
    private readonly _airdropBalance: AddressMemoryMap = new AddressMemoryMap(this.airdropBalancePointer);

    public constructor() {
        super();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Deployment
    // ─────────────────────────────────────────────────────────────────────────

    public override onDeployment(calldata: Calldata): void {
        const treasuryKey: u256 = calldata.readU256();
        if (u256.eq(treasuryKey, u256.Zero)) throw new Revert('Invalid treasury key');
        this._treasuryKey.value = treasuryKey;

        const initSatsPerToken: u256 = calldata.readU256();
        this._satsPerToken.value = initSatsPerToken;

        // Explicitly write presale active — StoredBoolean default not reliable in all runtimes
        this._presaleActive.value = true;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Buy with BTC
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Register a BTC raise contribution.
     *
     * Include a P2TR output to the treasury address in the same transaction.
     * The contract reads that output's value, computes opbetOwed, and records it.
     * No token is minted — this is a registry entry only.
     *
     * @param recipient — the OPNet address to credit (avoids relying on tx.sender)
     */
    @method({ name: 'recipient', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'opbetOwed', type: ABIDataTypes.UINT256 })
    public buyWithBTC(calldata: Calldata): BytesWriter {
        if (!this._presaleActive.value) throw new Revert('Presale is not active');

        const recipient: Address = calldata.readAddress();
        if (recipient.equals(Address.zero())) throw new Revert('Invalid recipient address');

        const satsPerToken: u256 = this._satsPerToken.value;
        if (u256.eq(satsPerToken, u256.Zero)) throw new Revert('BTC presale price not set');

        const satsPaid: u64 = this._findBTCPaymentToTreasury();
        if (satsPaid === 0) throw new Revert('No BTC output to treasury found in this tx');

        // opbetOwed = (satsPaid × 1e18) / satsPerWholeToken
        const opbetOwed: u256 = SafeMath.div(
            SafeMath.mul(u256.fromU64(satsPaid), TOKEN_DECIMALS),
            satsPerToken,
        );
        if (u256.eq(opbetOwed, u256.Zero)) throw new Revert('Payment too small for 1 token unit');

        // Guard presale capacity — revert (not clamp) because BTC is already paid to treasury
        const currentSold: u256 = this._presaleSold.value;
        const remaining: u256 = u256.gt(PRESALE_CAP, currentSold)
            ? SafeMath.sub(PRESALE_CAP, currentSold)
            : u256.Zero;
        if (u256.eq(remaining, u256.Zero)) throw new Revert('Presale cap reached');
        if (u256.gt(opbetOwed, remaining)) throw new Revert('Payment exceeds remaining presale cap');
        const actualOwed: u256 = opbetOwed;

        // Record in registry
        const prev: u256 = this._raiseBalance.get(recipient);
        this._raiseBalance.set(recipient, SafeMath.add(prev, actualOwed));

        const newSold: u256 = SafeMath.add(currentSold, actualOwed);
        this._presaleSold.value = newSold;

        this.emitEvent(new RaisePurchaseEvent(recipient, u256.fromU64(satsPaid), actualOwed));

        if (u256.ge(newSold, PRESALE_CAP)) {
            this._presaleActive.value = false;
        }

        const writer = new BytesWriter(32);
        writer.writeU256(actualOwed);
        return writer;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Airdrop: MOTO holder Merkle registration
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
        // Root is immutable once set — prevents eligibility set manipulation after claims begin
        if (!u256.eq(this._merkleRoot.value, u256.Zero)) throw new Revert('Merkle root already set');
        const root: u256 = calldata.readU256();
        if (u256.eq(root, u256.Zero)) throw new Revert('Invalid root');
        this._merkleRoot.value = root;
        this.emitEvent(new MerkleRootSetEvent(root));
        const writer = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    /**
     * Register a MOTO-holder airdrop claim.
     *
     * Verifies Merkle proof that recipient is in the MOTO snapshot,
     * then records AIRDROP_AMOUNT (5,000 OPBET) in the registry.
     * No tokens are minted — registry entry only.
     * MOTO holders must register within 30 days of TGE or lose their slot.
     *
     * @param recipient — address in the Merkle snapshot
     * @param proof     — flat N×32 sibling hashes
     */
    @method(
        { name: 'recipient', type: ABIDataTypes.ADDRESS },
        { name: 'proof',     type: ABIDataTypes.BYTES   },
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public claimAirdrop(calldata: Calldata): BytesWriter {
        const recipient: Address = calldata.readAddress();
        if (recipient.equals(Address.zero())) throw new Revert('Invalid recipient');
        // Prevent griefing: only the recipient can register their own claim
        if (!Blockchain.tx.sender.equals(recipient)) throw new Revert('Sender must be recipient');

        const root: u256 = this._merkleRoot.value;
        if (u256.eq(root, u256.Zero)) throw new Revert('Airdrop not configured');

        const count: u256 = this._airdropCount.value;
        if (u256.ge(count, AIRDROP_MAX_CLAIMS)) throw new Revert('Airdrop fully claimed');

        if (u256.gt(this._airdropClaimed.get(recipient), u256.Zero)) {
            throw new Revert('Already claimed');
        }

        const proofBytes: Uint8Array = calldata.readBytesWithLength();
        if (proofBytes.length % 32 !== 0) throw new Revert('Invalid proof length');
        if (proofBytes.length > 32 * 30) throw new Revert('Proof too long (max 30 levels)');

        const leaf: Uint8Array = this._computeLeaf(recipient);
        if (!this._verifyMerkleProof(leaf, proofBytes, root)) {
            throw new Revert('Invalid Merkle proof');
        }

        // Mark as registered
        this._airdropClaimed.set(recipient, U256_ONE);
        this._airdropCount.value = SafeMath.add(count, U256_ONE);
        this._airdropBalance.set(recipient, AIRDROP_AMOUNT);

        this.emitEvent(new AirdropRegisteredEvent(recipient, AIRDROP_AMOUNT));

        const writer = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Admin
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

    /** Airdrop status: root | claimCount | maxClaims | amountPerClaim | active */
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

    /**
     * Total OPBET owed to an address: raise purchases + airdrop registration combined.
     * @param addr — OPNet address to query
     * @returns raiseOwed(u256) | airdropOwed(u256) | total(u256)
     */
    @method({ name: 'addr', type: ABIDataTypes.ADDRESS })
    public getBalance(calldata: Calldata): BytesWriter {
        const addr: Address = calldata.readAddress();
        const raiseOwed: u256    = this._raiseBalance.get(addr);
        const airdropOwed: u256  = this._airdropBalance.get(addr);
        const total: u256        = SafeMath.add(raiseOwed, airdropOwed);

        const writer = new BytesWriter(96);
        writer.writeU256(raiseOwed);
        writer.writeU256(airdropOwed);
        writer.writeU256(total);
        return writer;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internals
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Scans tx outputs for P2TR outputs to the stored treasury key.
     * Accumulates ALL matching outputs (handles multi-output transactions).
     * Returns total satoshis paid, or 0 if none found.
     */
    private _findBTCPaymentToTreasury(): u64 {
        const treasuryKey: u256 = this._treasuryKey.value;
        const outputs = Blockchain.tx.outputs;
        let total: u64 = 0;

        for (let i = 0; i < outputs.length; i++) {
            const output = outputs[i];

            // Path A: raw P2TR scriptPubKey bytes (simulation)
            const script = output.scriptPublicKey;
            if (script !== null && script.length === 34 && script[0] === 0x51 && script[1] === 0x20) {
                if (this._keyBytesMatch(script, 2, treasuryKey)) {
                    total += output.value;
                    continue;
                }
            }

            // Path B: bech32m address string (on-chain node)
            const to = output.to;
            if (to !== null) {
                const dec = Segwit.decodeOrNull(to);
                if (dec !== null && dec.version === 1 && dec.program.length === 32) {
                    if (this._keyBytesMatch(dec.program, 0, treasuryKey)) {
                        total += output.value;
                    }
                }
            }
        }
        return total;
    }

    private _keyBytesMatch(buf: Uint8Array, offset: i32, key: u256): bool {
        const keyBytes: Uint8Array = key.toUint8Array(true);
        for (let i: i32 = 0; i < 32; i++) {
            if (buf[offset + i] !== keyBytes[i]) return false;
        }
        return true;
    }

    private _computeLeaf(addr: Address): Uint8Array {
        const addrBytes = new Uint8Array(32);
        for (let i: i32 = 0; i < 32; i++) {
            addrBytes[i] = addr[i];
        }
        return keccak256(keccak256(addrBytes));
    }

    private _hashPair(a: Uint8Array, b: Uint8Array): Uint8Array {
        for (let i: i32 = 0; i < 32; i++) {
            if (a[i] < b[i]) return keccak256Concat(a, b);
            if (a[i] > b[i]) return keccak256Concat(b, a);
        }
        return keccak256Concat(a, b);
    }

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

        const rootBytes: Uint8Array = root.toUint8Array(true);
        for (let i: i32 = 0; i < 32; i++) {
            if (current[i] !== rootBytes[i]) return false;
        }
        return true;
    }
}
