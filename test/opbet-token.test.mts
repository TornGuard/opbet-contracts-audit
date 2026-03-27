/**
 * opbet-token.test.mts
 *
 * VM tests for OPBET_Token.ts
 * Covers: buyWithBTC, claimAirdrop (Merkle), devMint, tax, presale controls, supply cap
 */

import { Address, BinaryWriter } from '@btc-vision/transaction';
import {
    opnet, OPNetUnit, Assert, Blockchain,
    Transaction, generateTransactionId,
} from '@btc-vision/unit-test-framework';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { OPBETTokenRuntime } from './runtime/OPBETTokenRuntime.js';

// ─── Constants matching contract ─────────────────────────────────────────────

const ONE             = 10n ** 18n;
const MAX_SUPPLY      = 100_000_000n * ONE;
const PRESALE_CAP     = 10_000_000n * ONE;
const AIRDROP_AMOUNT  = 5_000n * ONE;
const AIRDROP_MAX     = 1_000n;
const DEV_MINT_CAP    = 85_000_000n * ONE;
const SATS_PER_TOKEN  = 1n;
const TAX_DEFAULT     = 300n;   // 300 bps = 3%
const BASIS_POINTS    = 10_000n;

const TREASURY_KEY_HEX = '0101010101010101010101010101010101010101010101010101010101010101';

// ─── P2TR helpers ─────────────────────────────────────────────────────────────

function p2trScript(keyHex: string = TREASURY_KEY_HEX): Uint8Array {
    return Buffer.concat([Buffer.from([0x51, 0x20]), Buffer.from(keyHex, 'hex')]);
}

function mockTreasuryOutput(sats: bigint, keyHex: string = TREASURY_KEY_HEX): void {
    const tx = new Transaction(generateTransactionId(), [], [], false);
    tx.addOutput(sats, undefined, p2trScript(keyHex));
    Blockchain.transaction = tx;
}

function clearTx(): void {
    Blockchain.transaction = null;
}

// ─── Merkle helpers ───────────────────────────────────────────────────────────

function keccak256(data: Uint8Array): Uint8Array {
    return keccak_256(data);
}

function computeLeaf(addr: Address): Uint8Array {
    return keccak256(keccak256(Buffer.from(addr)));
}

function hashPair(a: Uint8Array, b: Uint8Array): Uint8Array {
    for (let i = 0; i < 32; i++) {
        if (a[i] < b[i]) return keccak256(Buffer.concat([a, b]));
        if (a[i] > b[i]) return keccak256(Buffer.concat([b, a]));
    }
    return keccak256(Buffer.concat([a, b]));
}

/** Single-leaf tree: root = leaf, proof = empty */
function buildTree1(addr: Address): { root: bigint; proof: Buffer } {
    const leaf = computeLeaf(addr);
    return { root: BigInt('0x' + Buffer.from(leaf).toString('hex')), proof: Buffer.alloc(0) };
}

/** 2-leaf tree */
function buildTree2(addr1: Address, addr2: Address): {
    root: bigint; proof1: Buffer; proof2: Buffer;
} {
    const leaf1 = computeLeaf(addr1);
    const leaf2 = computeLeaf(addr2);
    const root  = hashPair(leaf1, leaf2);
    return {
        root:   BigInt('0x' + Buffer.from(root).toString('hex')),
        proof1: Buffer.from(leaf2),
        proof2: Buffer.from(leaf1),
    };
}

// ─── ESM/CJS singleton fix ────────────────────────────────────────────────────
{
    const proto = OPBETTokenRuntime.prototype as any;
    const _origSetEnv = proto.setEnvironment;
    proto.setEnvironment = function(
        msgSender?: any, txOrigin?: any, currentBlock?: bigint, dep?: any, addr?: any,
    ) {
        return _origSetEnv.call(this, msgSender, txOrigin,
            currentBlock ?? Blockchain.blockNumber, dep, addr);
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

// ─── Test suite ───────────────────────────────────────────────────────────────

await opnet('OPBET_Token — mint + Merkle airdrop', async (vm: OPNetUnit) => {
    let token:       OPBETTokenRuntime;
    let deployer:    Address;
    let teamWallet:  Address;
    let treasury:    Address;
    let buyer:       Address;
    let buyer2:      Address;
    let contractAddr: Address;

    vm.beforeEach(async () => {
        Blockchain.dispose();
        Blockchain.clearContracts();
        await Blockchain.init();

        deployer     = Blockchain.generateRandomAddress();
        teamWallet   = Blockchain.generateRandomAddress();
        treasury     = Blockchain.generateRandomAddress();
        buyer        = Blockchain.generateRandomAddress();
        buyer2       = Blockchain.generateRandomAddress();
        contractAddr = Blockchain.generateRandomAddress();

        Blockchain.blockNumber = 100n;

        token = new OPBETTokenRuntime(
            deployer, contractAddr,
            teamWallet, treasury,
            TREASURY_KEY_HEX, SATS_PER_TOKEN,
        );
        Blockchain.register(token);
        await token.init();
    });

    vm.afterEach(() => {
        clearTx();
        token.dispose();
        Blockchain.dispose();
    });

    // ══════════════════════════════════════════════════════════════════════════
    // 1. INITIAL STATE
    // ══════════════════════════════════════════════════════════════════════════

    await vm.it('totalSupply is zero at deployment', async () => {
        Assert.expect(await token.totalSupply()).toEqual(0n);
    });

    await vm.it('presaleInfo: correct initial state', async () => {
        const info = await token.presaleInfo();
        Assert.expect(info.sold).toEqual(0n);
        Assert.expect(info.remaining).toEqual(PRESALE_CAP);
        Assert.expect(info.cap).toEqual(PRESALE_CAP);
        Assert.expect(info.satsPerToken).toEqual(SATS_PER_TOKEN);
        Assert.expect(info.active).toEqual(true);
    });

    await vm.it('airdropInfo: correct initial state', async () => {
        const info = await token.airdropInfo();
        Assert.expect(info.merkleRoot).toEqual(0n);
        Assert.expect(info.claimCount).toEqual(0n);
        Assert.expect(info.maxClaims).toEqual(AIRDROP_MAX);
        Assert.expect(info.amountPerClaim).toEqual(AIRDROP_AMOUNT);
        Assert.expect(info.active).toEqual(true);
    });

    await vm.it('deployer and teamWallet are tax-exempt at deployment', async () => {
        Assert.expect(await token.getIsExempt(deployer)).toEqual(true);
        Assert.expect(await token.getIsExempt(teamWallet)).toEqual(true);
        Assert.expect(await token.getIsExempt(buyer)).toEqual(false);
    });

    await vm.it('default tax rate is 300 bps (3%)', async () => {
        Assert.expect(await token.getTaxRate()).toEqual(TAX_DEFAULT);
    });

    // ══════════════════════════════════════════════════════════════════════════
    // 2. buyWithBTC — presale minting
    // ══════════════════════════════════════════════════════════════════════════

    await vm.it('buyWithBTC: mints correct amount and updates totalSupply', async () => {
        const SATS = 10_000n;
        mockTreasuryOutput(SATS);

        const minted = await token.buyWithBTC(buyer, buyer);
        Assert.expect(minted).toEqual(SATS * ONE);
        Assert.expect(await token.balanceOf(buyer)).toEqual(SATS * ONE);
        Assert.expect(await token.totalSupply()).toEqual(SATS * ONE);
    });

    await vm.it('buyWithBTC: updates presaleInfo sold/remaining', async () => {
        mockTreasuryOutput(1_000n);
        await token.buyWithBTC(buyer, buyer);

        const info = await token.presaleInfo();
        Assert.expect(info.sold).toEqual(1_000n * ONE);
        Assert.expect(info.remaining).toEqual(PRESALE_CAP - 1_000n * ONE);
    });

    await vm.it('buyWithBTC: multiple buys accumulate balance', async () => {
        mockTreasuryOutput(3_000n);
        await token.buyWithBTC(buyer, buyer);
        clearTx();

        mockTreasuryOutput(7_000n);
        await token.buyWithBTC(buyer, buyer);
        clearTx();

        Assert.expect(await token.balanceOf(buyer)).toEqual(10_000n * ONE);
    });

    await vm.it('buyWithBTC: auto-closes presale at cap', async () => {
        mockTreasuryOutput(10_000_000n);
        await token.buyWithBTC(buyer, buyer);

        const info = await token.presaleInfo();
        Assert.expect(info.sold).toEqual(PRESALE_CAP);
        Assert.expect(info.active).toEqual(false);
    });

    await vm.it('buyWithBTC: reverts when presale paused', async () => {
        await token.setPresaleActive(false, deployer);
        mockTreasuryOutput(1_000n);
        await Assert.expect(async () => token.buyWithBTC(buyer, buyer)).toThrow();
    });

    await vm.it('buyWithBTC: reverts when no treasury output in tx', async () => {
        const wrongKey = '0202020202020202020202020202020202020202020202020202020202020202';
        const tx = new Transaction(generateTransactionId(), [], [], false);
        tx.addOutput(1_000n, undefined, p2trScript(wrongKey));
        Blockchain.transaction = tx;
        await Assert.expect(async () => token.buyWithBTC(buyer, buyer)).toThrow();
    });

    await vm.it('buyWithBTC: reverts when satsPerToken is 0', async () => {
        await token.setBTCPrice(0n, deployer);
        mockTreasuryOutput(1_000n);
        await Assert.expect(async () => token.buyWithBTC(buyer, buyer)).toThrow();
    });

    await vm.it('buyWithBTC: clamps to remaining at cap boundary (no revert — BTC already paid)', async () => {
        // Fill to within 1 OPBET of the cap
        mockTreasuryOutput(9_999_999n);
        await token.buyWithBTC(buyer, buyer);
        clearTx();

        // Try to buy 2 OPBET when only 1 remains — clamps to 1, does NOT revert
        mockTreasuryOutput(2n);
        const minted = await token.buyWithBTC(buyer2, buyer2);
        clearTx();

        Assert.expect(minted).toEqual(1n * ONE); // clamped to remaining
        Assert.expect((await token.presaleInfo()).sold).toEqual(PRESALE_CAP);
        Assert.expect((await token.presaleInfo()).active).toEqual(false);
    });

    // ══════════════════════════════════════════════════════════════════════════
    // 3. Merkle airdrop — claimAirdrop
    // ══════════════════════════════════════════════════════════════════════════

    await vm.it('claimAirdrop: valid single-leaf proof mints 5,000 OPBET', async () => {
        const { root, proof } = buildTree1(buyer);
        await token.setMerkleRoot(root, deployer);

        const ok = await token.claimAirdrop(buyer, proof, buyer);
        Assert.expect(ok).toEqual(true);
        Assert.expect(await token.balanceOf(buyer)).toEqual(AIRDROP_AMOUNT);
        Assert.expect(await token.totalSupply()).toEqual(AIRDROP_AMOUNT);
    });

    await vm.it('claimAirdrop: valid 2-leaf proof — both claimants receive tokens', async () => {
        const { root, proof1, proof2 } = buildTree2(buyer, buyer2);
        await token.setMerkleRoot(root, deployer);

        await token.claimAirdrop(buyer, proof1, buyer);
        await token.claimAirdrop(buyer2, proof2, buyer2);

        Assert.expect(await token.balanceOf(buyer)).toEqual(AIRDROP_AMOUNT);
        Assert.expect(await token.balanceOf(buyer2)).toEqual(AIRDROP_AMOUNT);
        Assert.expect(await token.totalSupply()).toEqual(AIRDROP_AMOUNT * 2n);
    });

    await vm.it('claimAirdrop: claimCount increments after each claim', async () => {
        const { root, proof } = buildTree1(buyer);
        await token.setMerkleRoot(root, deployer);
        await token.claimAirdrop(buyer, proof, buyer);

        Assert.expect((await token.airdropInfo()).claimCount).toEqual(1n);
    });

    await vm.it('claimAirdrop: double-claim reverts without double-minting', async () => {
        const { root, proof } = buildTree1(buyer);
        await token.setMerkleRoot(root, deployer);
        await token.claimAirdrop(buyer, proof, buyer);

        await Assert.expect(async () => token.claimAirdrop(buyer, proof, buyer)).toThrow();
        Assert.expect(await token.balanceOf(buyer)).toEqual(AIRDROP_AMOUNT); // no double mint
    });

    await vm.it('claimAirdrop: wrong proof reverts', async () => {
        const { root } = buildTree2(buyer, buyer2);
        await token.setMerkleRoot(root, deployer);

        await Assert.expect(async () =>
            token.claimAirdrop(buyer, Buffer.alloc(32, 0x00), buyer)
        ).toThrow();
    });

    await vm.it('claimAirdrop: reverts when root not set', async () => {
        const { proof } = buildTree1(buyer);
        await Assert.expect(async () => token.claimAirdrop(buyer, proof, buyer)).toThrow();
    });

    await vm.it('claimAirdrop: reverts with malformed proof (not multiple of 32)', async () => {
        const { root } = buildTree1(buyer);
        await token.setMerkleRoot(root, deployer);
        await Assert.expect(async () =>
            token.claimAirdrop(buyer, Buffer.alloc(33, 0x01), buyer)
        ).toThrow();
    });

    await vm.it('claimAirdrop: buyer who also bought in presale gets both allocations', async () => {
        // Presale buy
        mockTreasuryOutput(1_000n);
        await token.buyWithBTC(buyer, buyer);
        clearTx();

        // Airdrop claim
        const { root, proof } = buildTree1(buyer);
        await token.setMerkleRoot(root, deployer);
        await token.claimAirdrop(buyer, proof, buyer);

        const expected = 1_000n * ONE + AIRDROP_AMOUNT;
        Assert.expect(await token.balanceOf(buyer)).toEqual(expected);
    });

    // ══════════════════════════════════════════════════════════════════════════
    // 4. setMerkleRoot
    // ══════════════════════════════════════════════════════════════════════════

    await vm.it('setMerkleRoot: owner sets root and airdropInfo reflects it', async () => {
        const { root } = buildTree1(buyer);
        await token.setMerkleRoot(root, deployer);
        Assert.expect((await token.airdropInfo()).merkleRoot).toEqual(root);
    });

    await vm.it('setMerkleRoot: non-owner reverts', async () => {
        const { root } = buildTree1(buyer);
        await Assert.expect(async () => token.setMerkleRoot(root, buyer)).toThrow();
    });

    await vm.it('setMerkleRoot: can be updated by owner (unlike OPBETRaise)', async () => {
        const { root: root1 } = buildTree1(buyer);
        const { root: root2 } = buildTree1(buyer2);
        await token.setMerkleRoot(root1, deployer);
        await token.setMerkleRoot(root2, deployer);
        Assert.expect((await token.airdropInfo()).merkleRoot).toEqual(root2);
    });

    // ══════════════════════════════════════════════════════════════════════════
    // 5. devMint
    // ══════════════════════════════════════════════════════════════════════════

    await vm.it('devMint: owner mints to any address', async () => {
        const amount = 1_000_000n * ONE;
        await token.devMint(buyer, amount, deployer);
        Assert.expect(await token.balanceOf(buyer)).toEqual(amount);
        Assert.expect(await token.totalSupply()).toEqual(amount);
    });

    await vm.it('devMint: non-owner reverts', async () => {
        await Assert.expect(async () =>
            token.devMint(buyer2, 1n * ONE, buyer)
        ).toThrow();
    });

    await vm.it('devMint: reverts when exceeding 85M dev cap', async () => {
        // Mint exactly at the cap — should succeed
        await token.devMint(buyer, DEV_MINT_CAP, deployer);
        Assert.expect(await token.balanceOf(buyer)).toEqual(DEV_MINT_CAP);

        // One more unit — must revert
        await Assert.expect(async () =>
            token.devMint(buyer, 1n, deployer)
        ).toThrow();
    });

    await vm.it('devMint: does not count toward presale cap', async () => {
        await token.devMint(buyer, 1_000_000n * ONE, deployer);
        const info = await token.presaleInfo();
        Assert.expect(info.sold).toEqual(0n); // presale counter untouched
        Assert.expect(info.remaining).toEqual(PRESALE_CAP);
    });

    // ══════════════════════════════════════════════════════════════════════════
    // 6. Transfer tax
    // ══════════════════════════════════════════════════════════════════════════

    await vm.it('transfer: tax-exempt sender pays no tax', async () => {
        // Deployer is tax-exempt by default
        await token.devMint(deployer, 10_000n * ONE, deployer);
        await token.transfer(buyer, 1_000n * ONE, deployer);

        Assert.expect(await token.balanceOf(buyer)).toEqual(1_000n * ONE);
    });

    await vm.it('transfer: non-exempt sender pays 3% tax to teamWallet', async () => {
        // Give buyer some tokens first (via exempt deployer mint + transfer)
        await token.devMint(deployer, 10_000n * ONE, deployer);
        await token.transfer(buyer, 1_000n * ONE, deployer);

        // buyer (non-exempt) transfers 1000 OPBET
        const transferAmount = 1_000n * ONE;
        const tax = (transferAmount * TAX_DEFAULT) / BASIS_POINTS; // 30 OPBET
        const net  = transferAmount - tax;

        await token.transfer(buyer2, transferAmount, buyer);

        Assert.expect(await token.balanceOf(buyer2)).toEqual(net);
        Assert.expect(await token.balanceOf(teamWallet)).toEqual(tax);
    });

    await vm.it('setTaxRate: owner can lower tax rate', async () => {
        await token.setTaxRate(100n, deployer); // 1%
        Assert.expect(await token.getTaxRate()).toEqual(100n);
    });

    await vm.it('setTaxRate: reverts above 5% (500 bps)', async () => {
        await Assert.expect(async () => token.setTaxRate(501n, deployer)).toThrow();
    });

    await vm.it('setTaxRate: non-owner reverts', async () => {
        await Assert.expect(async () => token.setTaxRate(100n, buyer)).toThrow();
    });

    await vm.it('setExempt: owner can exempt an address', async () => {
        await token.setExempt(buyer, true, deployer);
        Assert.expect(await token.getIsExempt(buyer)).toEqual(true);
    });

    // ══════════════════════════════════════════════════════════════════════════
    // 7. Supported OP20 tokens
    // ══════════════════════════════════════════════════════════════════════════

    await vm.it('addSupportedToken: owner adds token, getTokenInfo reflects it', async () => {
        const payToken = Blockchain.generateRandomAddress();
        await token.addSupportedToken(payToken, 1000n * ONE, deployer);
        const info = await token.getTokenInfo(payToken);
        Assert.expect(info.supported).toEqual(true);
        Assert.expect(info.price).toEqual(1000n * ONE);
    });

    await vm.it('addSupportedToken: non-owner reverts', async () => {
        await Assert.expect(async () =>
            token.addSupportedToken(Blockchain.generateRandomAddress(), 1000n, buyer)
        ).toThrow();
    });

    await vm.it('removeSupportedToken: marks token as unsupported', async () => {
        const payToken = Blockchain.generateRandomAddress();
        await token.addSupportedToken(payToken, 1000n * ONE, deployer);
        await token.removeSupportedToken(payToken, deployer);
        const info = await token.getTokenInfo(payToken);
        Assert.expect(info.supported).toEqual(false);
    });

    // ══════════════════════════════════════════════════════════════════════════
    // 8. Supply cap integrity
    // ══════════════════════════════════════════════════════════════════════════

    await vm.it('airdrop supply is separate from devMint cap', async () => {
        // Max out devMint (85M)
        await token.devMint(buyer, DEV_MINT_CAP, deployer);

        // Airdrop should still work — it draws from the reserved 5M pool
        const { root, proof } = buildTree1(buyer2);
        await token.setMerkleRoot(root, deployer);
        await token.claimAirdrop(buyer2, proof, buyer2);

        Assert.expect(await token.balanceOf(buyer2)).toEqual(AIRDROP_AMOUNT);
        const total = DEV_MINT_CAP + AIRDROP_AMOUNT;
        Assert.expect(await token.totalSupply()).toEqual(total);
    });
});
