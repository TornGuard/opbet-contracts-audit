import { Address, BinaryReader, BinaryWriter } from '@btc-vision/transaction';
import { BytecodeManager, CallResponse, ContractRuntime } from '@btc-vision/unit-test-framework';

// ─── Response shapes ──────────────────────────────────────────────────────────

export interface OraclePrice {
    price:       bigint;
    updateBlock: bigint;
    confidence:  bigint;
    roundId:     bigint;
    isFresh:     boolean;
}

export interface OracleConfig {
    minFeeders:    bigint;
    feederCount:   bigint;
    roundDuration: bigint;
}

// ─── Runtime ──────────────────────────────────────────────────────────────────

export class PriceOracleRuntime extends ContractRuntime {

    // ── Selectors ─────────────────────────────────────────────────────────────
    private readonly addFeederSel       = this.sel('addFeeder(address)');
    private readonly removeFeederSel    = this.sel('removeFeeder(address)');
    private readonly setMinFeedersSel   = this.sel('setMinFeeders(uint256)');
    private readonly setRoundDurSel     = this.sel('setRoundDuration(uint256)');
    private readonly submitPriceSel     = this.sel('submitPrice(uint256,uint256,uint256)');
    private readonly finalizeRoundSel   = this.sel('finalizeRound(uint256)');
    private readonly getPriceSel        = this.sel('getPrice(uint256)');
    private readonly latestPriceSel     = this.sel('latestPrice(uint256)');
    private readonly isFeederSel        = this.sel('isFeeder(address)');
    private readonly getConfigSel       = this.sel('getConfig()');

    public readonly deployerAddr: Address;

    public constructor(
        deployer: Address,
        address: Address,
        minFeeders: bigint = 1n,
        roundDuration: bigint = 0n,   // 0 = use contract default (60 blocks)
        gasLimit: bigint = 300_000_000_000n,
    ) {
        const cd = new BinaryWriter();
        cd.writeU256(minFeeders);
        cd.writeU256(roundDuration);

        super({
            address,
            deployer,
            gasLimit,
            deploymentCalldata: Buffer.from(cd.getBuffer()),
        });
        this.deployerAddr = deployer;
    }

    // ── Admin ─────────────────────────────────────────────────────────────────

    public async addFeeder(feeder: Address, sender?: Address): Promise<boolean> {
        const cdata = new BinaryWriter();
        cdata.writeSelector(this.addFeederSel);
        cdata.writeAddress(feeder);
        const res = await this.execute({ calldata: cdata.getBuffer(), sender, txOrigin: sender });
        this.assertOk(res);
        return new BinaryReader(res.response!).readBoolean();
    }

    public async removeFeeder(feeder: Address, sender?: Address): Promise<boolean> {
        const cdata = new BinaryWriter();
        cdata.writeSelector(this.removeFeederSel);
        cdata.writeAddress(feeder);
        const res = await this.execute({ calldata: cdata.getBuffer(), sender, txOrigin: sender });
        this.assertOk(res);
        return new BinaryReader(res.response!).readBoolean();
    }

    public async setMinFeeders(min: bigint, sender?: Address): Promise<boolean> {
        const cdata = new BinaryWriter();
        cdata.writeSelector(this.setMinFeedersSel);
        cdata.writeU256(min);
        const res = await this.execute({ calldata: cdata.getBuffer(), sender, txOrigin: sender });
        this.assertOk(res);
        return new BinaryReader(res.response!).readBoolean();
    }

    public async setRoundDuration(blocks: bigint, sender?: Address): Promise<boolean> {
        const cdata = new BinaryWriter();
        cdata.writeSelector(this.setRoundDurSel);
        cdata.writeU256(blocks);
        const res = await this.execute({ calldata: cdata.getBuffer(), sender, txOrigin: sender });
        this.assertOk(res);
        return new BinaryReader(res.response!).readBoolean();
    }

    // ── Feeder ────────────────────────────────────────────────────────────────

    /**
     * Submit a price. Returns { published, response }.
     * Throws if the contract reverts.
     */
    public async submitPrice(
        symbolId:   bigint,
        price:      bigint,
        confidence: bigint,
        sender?:    Address,
    ): Promise<{ published: boolean; response: CallResponse }> {
        const cdata = new BinaryWriter();
        cdata.writeSelector(this.submitPriceSel);
        cdata.writeU256(symbolId);
        cdata.writeU256(price);
        cdata.writeU256(confidence);
        const res = await this.execute({ calldata: cdata.getBuffer(), sender, txOrigin: sender });
        this.assertOk(res);
        return { published: new BinaryReader(res.response!).readBoolean(), response: res };
    }

    /** Like submitPrice but swallows the revert and returns null. */
    public async trySubmitPrice(
        symbolId:   bigint,
        price:      bigint,
        confidence: bigint,
        sender?:    Address,
    ): Promise<CallResponse> {
        const cdata = new BinaryWriter();
        cdata.writeSelector(this.submitPriceSel);
        cdata.writeU256(symbolId);
        cdata.writeU256(price);
        cdata.writeU256(confidence);
        return this.execute({ calldata: cdata.getBuffer(), sender, txOrigin: sender });
    }

    public async finalizeRound(symbolId: bigint, sender?: Address): Promise<CallResponse> {
        const cdata = new BinaryWriter();
        cdata.writeSelector(this.finalizeRoundSel);
        cdata.writeU256(symbolId);
        return this.execute({ calldata: cdata.getBuffer(), sender, txOrigin: sender });
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    public async getPrice(symbolId: bigint): Promise<OraclePrice> {
        const cdata = new BinaryWriter();
        cdata.writeSelector(this.getPriceSel);
        cdata.writeU256(symbolId);
        const res = await this.execute({ calldata: cdata.getBuffer() });
        this.assertOk(res);
        const r = new BinaryReader(res.response!);
        return {
            price:       r.readU256(),
            updateBlock: r.readU256(),
            confidence:  r.readU256(),
            roundId:     r.readU256(),
            isFresh:     r.readBoolean(),
        };
    }

    public async latestPrice(symbolId: bigint): Promise<bigint> {
        const cdata = new BinaryWriter();
        cdata.writeSelector(this.latestPriceSel);
        cdata.writeU256(symbolId);
        const res = await this.execute({ calldata: cdata.getBuffer() });
        this.assertOk(res);
        return new BinaryReader(res.response!).readU256();
    }

    public async isFeeder(feeder: Address): Promise<boolean> {
        const cdata = new BinaryWriter();
        cdata.writeSelector(this.isFeederSel);
        cdata.writeAddress(feeder);
        const res = await this.execute({ calldata: cdata.getBuffer() });
        this.assertOk(res);
        return new BinaryReader(res.response!).readBoolean();
    }

    public async getConfig(): Promise<OracleConfig> {
        const cdata = new BinaryWriter();
        cdata.writeSelector(this.getConfigSel);
        const res = await this.execute({ calldata: cdata.getBuffer() });
        this.assertOk(res);
        const r = new BinaryReader(res.response!);
        return {
            minFeeders:    r.readU256(),
            feederCount:   r.readU256(),
            roundDuration: r.readU256(),
        };
    }

    // ── Framework overrides ───────────────────────────────────────────────────

    protected defineRequiredBytecodes(): void {
        BytecodeManager.loadBytecode('./build/PriceOracle.wasm', this.address);
    }

    protected handleError(error: Error): Error {
        return new Error(`(PriceOracle: ${this.address}) OP_NET: ${error.message}`);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private sel(sig: string): number {
        return Number(`0x${this.abiCoder.encodeSelector(sig)}`);
    }

    private assertOk(res: CallResponse): void {
        if (res.error) throw this.handleError(res.error);
        if (!res.response) throw new Error('No response bytes');
    }
}
