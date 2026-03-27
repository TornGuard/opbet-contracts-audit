/**
 * opbet-raise.test.ts
 *
 * Comprehensive tests for OPBETRaise.ts
 * Covers: buyWithBTC, claimAirdrop, admin functions, views, security edge cases
 */

import { Address, BinaryWriter } from '@btc-vision/transaction';
import {
    opnet, OPNetUnit, Assert, Blockchain,
    Transaction, generateTransactionId,
} from '@btc-vision/unit-test-framework';
import { keccak_256 } from '@noble/hashes/sha3';
import { OPBETRaiseRuntime } from './runtime/OPBETRaiseRuntime.js';

// ─── Constants matching contract ─────────────────────────────────────────────

const ONE              = 10n ** 18n;
const PRESALE_CAP      = 10_000_000n * ONE;       // 10M OPBET
const AIRDROP_AMOUNT   = 5_000n * ONE;             // 5,000 OPBET
const AIRDROP_MAX      = 1_000n;
const SATS_PER_TOKEN   = 1n;                       // 1 sat per 1 OPBET

// ─── Treasury key — 32-byte x-only P2TR pubkey used in all tests ─────────────

const TREASURY_KEY_HEX = '0101010101010101010101010101010101010101010101010101010101010101';
const TREASURY_KEY_BYTES = Buffer.from(TREASURY_KEY_HEX, 'hex');

/** Build a P2TR scriptPubKey: OP_1 PUSH32 <32-byte key> */
function p2trScript(keyHex: string = TREASURY_KEY_HEX): Uint8Array {
    return Buffer.concat([Buffer.from([0x51, 0x20]), Buffer.from(keyHex, 'hex')]);
}

/** Set Blockchain.transaction with a P2TR output to the treasury */
function mockTreasuryOutput(sats: bigint, keyHex: string = TREASURY_KEY_HEX): void {
    const tx = new Transaction(generateTransactionId(), [], [], false);
    tx.addOutput(sats, undefined, p2trScript(keyHex));
    Blockchain.transaction = tx;
}

/** Set Blockchain.transaction with two P2TR outputs to the treasury */
function mockTwoTreasuryOutputs(sats1: bigint, sats2: bigint): void {
    const tx = new Transaction(generateTransactionId(), [], [], false);
    tx.addOutput(sats1, undefined, p2trScript());
    tx.addOutput(sats2, undefined, p2trScript());
    Blockchain.transaction = tx;
}

function clearTx(): void {
    Blockchain.transaction = null;
}

// ─── Merkle helpers (mirrors contract's keccak256 double-leaf tree) ───────────

function keccak256(data: Uint8Array): Uint8Array {
    return keccak_256(data);
}

function computeLeaf(addrBytes: Uint8Array): Uint8Array {
    return keccak256(keccak256(addrBytes));
}

function hashPair(a: Uint8Array, b: Uint8Array): Uint8Array {
    for (let i = 0; i < 32; i++) {
        if (a[i] < b[i]) return keccak256(Buffer.concat([a, b]));
        if (a[i] > b[i]) return keccak256(Buffer.concat([b, a]));
    }
    return keccak256(Buffer.concat([a, b]));
}

/** Build a 2-leaf Merkle tree. Returns root as bigint and proof for each leaf. */
function buildTree2(addr1: Address, addr2: Address): {
    root: bigint;
    proof1: Buffer;  // proof to verify addr1
    proof2: Buffer;  // proof to verify addr2
} {
    const leaf1 = computeLeaf(addr1.bytes);
    const leaf2 = computeLeaf(addr2.bytes);
    const root  = hashPair(leaf1, leaf2);
    return {
        root:   BigInt('0x' + Buffer.from(root).toString('hex')),
        proof1: Buffer.from(leaf2),
        proof2: Buffer.from(leaf1),
    };
}

/** Single-leaf tree: root = leaf itself, proof = empty */
function buildTree1(addr: Address): { root: bigint; proof: Buffer } {
    const leaf = computeLeaf(addr.bytes);
    return {
        root:  BigInt('0x' + Buffer.from(leaf).toString('hex')),
        proof: Buffer.alloc(0),
    };
}

// ─── ESM/CJS dual-package singleton fix ──────────────────────────────────────
{
    const proto = OPBETRaiseRuntime.prototype as any;

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

    proto.onOutputsRequested = function() {
        const tx = Blockchain.transaction;
        if (!tx) return Promise.resolve(Buffer.alloc(2));
        return Promise.resolve(Buffer.from(tx.serializeOutputs()));
    };

    proto.onInputsRequested = function() {
        const tx = Blockchain.transaction;
        if (!tx) return Promise.resolve(Buffer.alloc(2));
        return Promise.resolve(Buffer.from(tx.serializeInputs()));
    };
}

// ─── Test suite ──────────────────────────────────────────────────────────────

await opnet('OPBETRaise — full test suite', async (vm: OPNetUnit) => {
    let raise:       OPBETRaiseRuntime;
    let deployer:    Address;
    let buyer:       Address;
    let buyer2:      Address;
    let contractAddr: Address;

    vm.beforeEach(async () => {
        Blockchain.dispose();
        Blockchain.clearContracts();
        await Blockchain.init();

        deployer     = Blockchain.generateRandomAddress();
        buyer        = Blockchain.generateRandomAddress();
        buyer2       = Blockchain.generateRandomAddress();
        contractAddr = Blockchain.generateRandomAddress();

        Blockchain.blockNumber = 100n;

        raise = new OPBETRaiseRuntime(deployer, contractAddr, TREASURY_KEY_HEX, SATS_PER_TOKEN);
        Blockchain.register(raise);
        await raise.init();
    });

    vm.afterEach(() => {
        clearTx();
        raise.dispose();
        Blockchain.dispose();
    });

    // ══════════════════════════════════════════════════════════════════════════
    // 1. INITIAL STATE
    // ══════════════════════════════════════════════════════════════════════════

    await vm.it('presaleInfo: correct initial state', async () => {
        const info = await raise.presaleInfo();
        Assert.expect(info.sold).toEqual(0n);
        Assert.expect(info.remaining).toEqual(PRESALE_CAP);
        Assert.expect(info.cap).toEqual(PRESALE_CAP);
        Assert.expect(info.satsPerToken).toEqual(SATS_PER_TOKEN);
        Assert.expect(info.active).toEqual(true);
    });

    await vm.it('airdropInfo: correct initial state', async () => {
        const info = await raise.airdropInfo();
        Assert.expect(info.merkleRoot).toEqual(0n);
        Assert.expect(info.claimCount).toEqual(0n);
        Assert.expect(info.maxClaims).toEqual(AIRDROP_MAX);
        Assert.expect(info.amountPerClaim).toEqual(AIRDROP_AMOUNT);
        Assert.expect(info.active).toEqual(true);
    });

    await vm.it('getBalance: zero for fresh address', async () => {
        const bal = await raise.getBalance(buyer);
        Assert.expect(bal.raiseOwed).toEqual(0n);
        Assert.expect(bal.airdropOwed).toEqual(0n);
        Assert.expect(bal.total).toEqual(0n);
    });

    // ══════════════════════════════════════════════════════════════════════════
    // 2. buyWithBTC
    // ══════════════════════════════════════════════════════════════════════════

    await vm.it('buyWithBTC: credits buyer with correct opbet owed', async () => {
        const SATS = 10_000n; // 10,000 sats → 10,000 OPBET (satsPerToken=1)
        mockTreasuryOutput(SATS);

        const owed = await raise.buyWithBTC(buyer, buyer);
        Assert.expect(owed).toEqual(SATS * ONE); // 10_000 * 1e18

        const bal = await raise.getBalance(buyer);
        Assert.expect(bal.raiseOwed).toEqual(SATS * ONE);
        Assert.expect(bal.total).toEqual(SATS * ONE);
    });

    await vm.it('buyWithBTC: multiple purchases accumulate correctly', async () => {
        mockTreasuryOutput(5_000n);
        await raise.buyWithBTC(buyer, buyer);
        clearTx();

        mockTreasuryOutput(3_000n);
        await raise.buyWithBTC(buyer, buyer);
        clearTx();

        const bal = await raise.getBalance(buyer);
        Assert.expect(bal.raiseOwed).toEqual(8_000n * ONE);
    });

    await vm.it('buyWithBTC: sums ALL P2TR outputs to treasury in one tx', async () => {
        mockTwoTreasuryOutputs(4_000n, 6_000n); // two outputs = 10,000 sats total

        const owed = await raise.buyWithBTC(buyer, buyer);
        Assert.expect(owed).toEqual(10_000n * ONE);
    });

    await vm.it('buyWithBTC: different buyer addresses tracked separately', async () => {
        mockTreasuryOutput(5_000n);
        await raise.buyWithBTC(buyer, buyer);
        clearTx();

        mockTreasuryOutput(2_000n);
        await raise.buyWithBTC(buyer2, buyer2);
        clearTx();

        const bal1 = await raise.getBalance(buyer);
        const bal2 = await raise.getBalance(buyer2);
        Assert.expect(bal1.raiseOwed).toEqual(5_000n * ONE);
        Assert.expect(bal2.raiseOwed).toEqual(2_000n * ONE);
    });

    await vm.it('buyWithBTC: presaleInfo updates sold/remaining', async () => {
        mockTreasuryOutput(1_000n);
        await raise.buyWithBTC(buyer, buyer);

        const info = await raise.presaleInfo();
        Assert.expect(info.sold).toEqual(1_000n * ONE);
        Assert.expect(info.remaining).toEqual(PRESALE_CAP - 1_000n * ONE);
    });

    await vm.it('buyWithBTC: reverts when payment exceeds remaining cap', async () => {
        // Fill to within 1 OPBET of the cap
        mockTreasuryOutput(9_999_999n);
        await raise.buyWithBTC(buyer, buyer);
        clearTx();

        // Try to buy 2 OPBET — only 1 remains → must revert (not clamp)
        mockTreasuryOutput(2n);
        await Assert.expectThrowAsync(() => raise.buyWithBTC(buyer2, buyer2));
        clearTx();

        // Cap still not reached — presale still open
        const info = await raise.presaleInfo();
        Assert.expect(info.sold).toEqual(9_999_999n * ONE);
        Assert.expect(info.active).toEqual(true);
    });

    await vm.it('buyWithBTC: reverts when presale cap already reached', async () => {
        // Fill the cap
        mockTreasuryOutput(10_000_000n);
        await raise.buyWithBTC(buyer, buyer);
        clearTx();

        // Next purchase should revert
        mockTreasuryOutput(1n);
        await Assert.expectThrowAsync(() => raise.buyWithBTC(buyer2, buyer2));
    });

    await vm.it('buyWithBTC: reverts when presale is paused', async () => {
        await raise.setPresaleActive(false, deployer);

        mockTreasuryOutput(1_000n);
        await Assert.expectThrowAsync(() => raise.buyWithBTC(buyer, buyer));
    });

    await vm.it('buyWithBTC: reverts with zero recipient address', async () => {
        mockTreasuryOutput(1_000n);
        await Assert.expectThrowAsync(() => raise.buyWithBTC(Address.dead(), buyer));
    });

    await vm.it('buyWithBTC: reverts when BTC price not set (satsPerToken = 0)', async () => {
        // Deploy a fresh contract with satsPerToken = 0
        const addr2 = Blockchain.generateRandomAddress();
        const raise0 = new OPBETRaiseRuntime(deployer, addr2, TREASURY_KEY_HEX, 0n);
        Blockchain.register(raise0);
        await raise0.init();

        mockTreasuryOutput(1_000n);
        await Assert.expectThrowAsync(() => raise0.buyWithBTC(buyer, buyer));

        raise0.dispose();
    });

    await vm.it('buyWithBTC: reverts when no treasury output found in tx', async () => {
        // Output goes to a DIFFERENT key — not the treasury
        const wrongKey = '0202020202020202020202020202020202020202020202020202020202020202';
        const tx = new Transaction(generateTransactionId(), [], [], false);
        tx.addOutput(1_000n, undefined, p2trScript(wrongKey));
        Blockchain.transaction = tx;

        await Assert.expectThrowAsync(() => raise.buyWithBTC(buyer, buyer));
    });

    // ══════════════════════════════════════════════════════════════════════════
    // 3. ADMIN: setBTCPrice
    // ══════════════════════════════════════════════════════════════════════════

    await vm.it('setBTCPrice: owner can update price', async () => {
        await raise.setBTCPrice(100n, deployer);
        const info = await raise.presaleInfo();
        Assert.expect(info.satsPerToken).toEqual(100n);
    });

    await vm.it('setBTCPrice: price = 0 disables BTC purchases', async () => {
        await raise.setBTCPrice(0n, deployer);

        mockTreasuryOutput(1_000n);
        await Assert.expectThrowAsync(() => raise.buyWithBTC(buyer, buyer));
    });

    await vm.it('setBTCPrice: non-owner reverts', async () => {
        await Assert.expectThrowAsync(() => raise.setBTCPrice(100n, buyer));
    });

    await vm.it('setBTCPrice: price change affects subsequent purchases', async () => {
        // At satsPerToken=1: 500 sats → 500 OPBET
        mockTreasuryOutput(500n);
        const owed1 = await raise.buyWithBTC(buyer, buyer);
        clearTx();
        Assert.expect(owed1).toEqual(500n * ONE);

        // Change to satsPerToken=10: 500 sats → 50 OPBET
        await raise.setBTCPrice(10n, deployer);
        mockTreasuryOutput(500n);
        const owed2 = await raise.buyWithBTC(buyer2, buyer2);
        clearTx();
        Assert.expect(owed2).toEqual(50n * ONE);
    });

    // ══════════════════════════════════════════════════════════════════════════
    // 4. ADMIN: setPresaleActive
    // ══════════════════════════════════════════════════════════════════════════

    await vm.it('setPresaleActive: owner can pause', async () => {
        await raise.setPresaleActive(false, deployer);
        const info = await raise.presaleInfo();
        Assert.expect(info.active).toEqual(false);
    });

    await vm.it('setPresaleActive: owner can resume', async () => {
        await raise.setPresaleActive(false, deployer);
        await raise.setPresaleActive(true, deployer);
        const info = await raise.presaleInfo();
        Assert.expect(info.active).toEqual(true);
    });

    await vm.it('setPresaleActive: non-owner reverts', async () => {
        await Assert.expectThrowAsync(() => raise.setPresaleActive(false, buyer));
    });

    // ══════════════════════════════════════════════════════════════════════════
    // 5. ADMIN: setMerkleRoot
    // ══════════════════════════════════════════════════════════════════════════

    await vm.it('setMerkleRoot: owner can set root', async () => {
        const { root } = buildTree1(buyer);
        await raise.setMerkleRoot(root, deployer);
        const info = await raise.airdropInfo();
        Assert.expect(info.merkleRoot).toEqual(root);
    });

    await vm.it('setMerkleRoot: non-owner reverts', async () => {
        const { root } = buildTree1(buyer);
        await Assert.expectThrowAsync(() => raise.setMerkleRoot(root, buyer));
    });

    // ══════════════════════════════════════════════════════════════════════════
    // 6. claimAirdrop
    // ══════════════════════════════════════════════════════════════════════════

    await vm.it('claimAirdrop: valid single-leaf proof registers allocation', async () => {
        const { root, proof } = buildTree1(buyer);
        await raise.setMerkleRoot(root, deployer);

        const ok = await raise.claimAirdrop(buyer, proof, buyer);
        Assert.expect(ok).toEqual(true);

        const bal = await raise.getBalance(buyer);
        Assert.expect(bal.airdropOwed).toEqual(AIRDROP_AMOUNT);
    });

    await vm.it('claimAirdrop: valid 2-leaf proof registers allocation for each', async () => {
        const { root, proof1, proof2 } = buildTree2(buyer, buyer2);
        await raise.setMerkleRoot(root, deployer);

        await raise.claimAirdrop(buyer, proof1, buyer);
        await raise.claimAirdrop(buyer2, proof2, buyer2);

        const bal1 = await raise.getBalance(buyer);
        const bal2 = await raise.getBalance(buyer2);
        Assert.expect(bal1.airdropOwed).toEqual(AIRDROP_AMOUNT);
        Assert.expect(bal2.airdropOwed).toEqual(AIRDROP_AMOUNT);
    });

    await vm.it('claimAirdrop: count increments after each claim', async () => {
        const { root, proof } = buildTree1(buyer);
        await raise.setMerkleRoot(root, deployer);
        await raise.claimAirdrop(buyer, proof, buyer);

        const info = await raise.airdropInfo();
        Assert.expect(info.claimCount).toEqual(1n);
    });

    await vm.it('claimAirdrop: double-claim reverts', async () => {
        const { root, proof } = buildTree1(buyer);
        await raise.setMerkleRoot(root, deployer);
        await raise.claimAirdrop(buyer, proof, buyer);

        await Assert.expectThrowAsync(() => raise.claimAirdrop(buyer, proof, buyer));
    });

    await vm.it('claimAirdrop: wrong proof reverts', async () => {
        const { root } = buildTree2(buyer, buyer2);
        await raise.setMerkleRoot(root, deployer);

        // Pass wrong proof (zeros)
        const badProof = Buffer.alloc(32, 0x00);
        await Assert.expectThrowAsync(() => raise.claimAirdrop(buyer, badProof, buyer));
    });

    await vm.it('claimAirdrop: reverts before merkle root is set', async () => {
        const { proof } = buildTree1(buyer);
        await Assert.expectThrowAsync(() => raise.claimAirdrop(buyer, proof, buyer));
    });

    await vm.it('claimAirdrop: reverts with malformed proof (not multiple of 32)', async () => {
        const { root } = buildTree1(buyer);
        await raise.setMerkleRoot(root, deployer);

        const badProof = Buffer.alloc(33, 0x01); // 33 bytes — not divisible by 32
        await Assert.expectThrowAsync(() => raise.claimAirdrop(buyer, badProof, buyer));
    });

    await vm.it('claimAirdrop: reverts with proof exceeding 30 levels', async () => {
        const { root } = buildTree1(buyer);
        await raise.setMerkleRoot(root, deployer);

        const hugeProof = Buffer.alloc(32 * 31, 0x01); // 31 levels — too long
        await Assert.expectThrowAsync(() => raise.claimAirdrop(buyer, hugeProof, buyer));
    });

    await vm.it('claimAirdrop: reverts with zero recipient', async () => {
        const { root, proof } = buildTree1(buyer);
        await raise.setMerkleRoot(root, deployer);

        await Assert.expectThrowAsync(() => raise.claimAirdrop(Address.dead(), proof, buyer));
    });

    // ══════════════════════════════════════════════════════════════════════════
    // 7. getBalance: combined raise + airdrop
    // ══════════════════════════════════════════════════════════════════════════

    await vm.it('getBalance: total is raise + airdrop combined', async () => {
        // Record a raise purchase
        mockTreasuryOutput(1_000n);
        await raise.buyWithBTC(buyer, buyer);
        clearTx();

        // Register airdrop
        const { root, proof } = buildTree1(buyer);
        await raise.setMerkleRoot(root, deployer);
        await raise.claimAirdrop(buyer, proof, buyer);

        const bal = await raise.getBalance(buyer);
        Assert.expect(bal.raiseOwed).toEqual(1_000n * ONE);
        Assert.expect(bal.airdropOwed).toEqual(AIRDROP_AMOUNT);
        Assert.expect(bal.total).toEqual(1_000n * ONE + AIRDROP_AMOUNT);
    });

    // ══════════════════════════════════════════════════════════════════════════
    // 8. DEPLOYMENT SECURITY
    // ══════════════════════════════════════════════════════════════════════════

    await vm.it('deployment: reverts with zero treasury key', async () => {
        const addr2 = Blockchain.generateRandomAddress();
        const raiseZero = new OPBETRaiseRuntime(deployer, addr2, '0'.repeat(64), 1n);
        Blockchain.register(raiseZero);

        await Assert.expectThrowAsync(() => raiseZero.init());
        raiseZero.dispose();
    });
});
