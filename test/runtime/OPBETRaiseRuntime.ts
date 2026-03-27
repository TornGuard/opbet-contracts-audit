import { Address, BinaryReader, BinaryWriter } from '@btc-vision/transaction';
import { BytecodeManager, CallResponse, ContractRuntime } from '@btc-vision/unit-test-framework';

// ─── Decoded response shapes ──────────────────────────────────────────────────

export interface PresaleInfo {
    sold:         bigint;
    remaining:    bigint;
    cap:          bigint;
    satsPerToken: bigint;
    active:       boolean;
}

export interface AirdropInfo {
    merkleRoot:     bigint;
    claimCount:     bigint;
    maxClaims:      bigint;
    amountPerClaim: bigint;
    active:         boolean;
}

export interface RaiseBalance {
    raiseOwed:   bigint;
    airdropOwed: bigint;
    total:       bigint;
}

// ─── Runtime ──────────────────────────────────────────────────────────────────

export class OPBETRaiseRuntime extends ContractRuntime {

    private readonly buyWithBTCSel    = this.sel('buyWithBTC(address)');
    private readonly setMerkleRootSel = this.sel('setMerkleRoot(uint256)');
    private readonly claimAirdropSel  = this.sel('claimAirdrop(address,bytes)');
    private readonly setBTCPriceSel   = this.sel('setBTCPrice(uint256)');
    private readonly setActiveSel     = this.sel('setPresaleActive(bool)');
    private readonly presaleInfoSel   = this.sel('presaleInfo()');
    private readonly airdropInfoSel   = this.sel('airdropInfo()');
    private readonly getBalanceSel    = this.sel('getBalance(address)');

    public readonly deployerAddr: Address;

    /**
     * @param deployer        - deployer/owner address
     * @param address         - contract address
     * @param treasuryKeyHex  - 64-char hex of 32-byte x-only P2TR pubkey (no 0x prefix)
     * @param satsPerToken    - initial sats per 1 whole OPBET (0 = disabled)
     */
    public constructor(
        deployer: Address,
        address: Address,
        treasuryKeyHex: string,
        satsPerToken: bigint,
    ) {
        const cd = new BinaryWriter();
        // treasuryKey as u256 big-endian (matches readU256 in onDeployment)
        const keyBigInt = BigInt('0x' + treasuryKeyHex.padStart(64, '0'));
        cd.writeU256(keyBigInt);
        cd.writeU256(satsPerToken);

        super({
            address,
            deployer,
            gasLimit: 300_000_000_000n,
            deploymentCalldata: Buffer.from(cd.getBuffer()),
        });
        this.deployerAddr = deployer;
    }

    // ── Write methods ──────────────────────────────────────────────────────────

    public async buyWithBTC(recipient: Address, sender?: Address): Promise<bigint> {
        const cd = new BinaryWriter();
        cd.writeSelector(this.buyWithBTCSel);
        cd.writeAddress(recipient);
        const r = await this.exec(cd, sender ?? recipient);
        this.check(r);
        return new BinaryReader(r.response).readU256();
    }

    public async setMerkleRoot(root: bigint, sender?: Address): Promise<boolean> {
        const cd = new BinaryWriter();
        cd.writeSelector(this.setMerkleRootSel);
        cd.writeU256(root);
        const r = await this.exec(cd, sender ?? this.deployerAddr);
        this.check(r);
        return new BinaryReader(r.response).readBoolean();
    }

    public async claimAirdrop(
        recipient: Address,
        proof: Buffer,
        sender?: Address,
    ): Promise<boolean> {
        const cd = new BinaryWriter();
        cd.writeSelector(this.claimAirdropSel);
        cd.writeAddress(recipient);
        cd.writeBytesWithLength(proof);
        const r = await this.exec(cd, sender ?? recipient);
        this.check(r);
        return new BinaryReader(r.response).readBoolean();
    }

    public async setBTCPrice(sats: bigint, sender?: Address): Promise<boolean> {
        const cd = new BinaryWriter();
        cd.writeSelector(this.setBTCPriceSel);
        cd.writeU256(sats);
        const r = await this.exec(cd, sender ?? this.deployerAddr);
        this.check(r);
        return new BinaryReader(r.response).readBoolean();
    }

    public async setPresaleActive(active: boolean, sender?: Address): Promise<boolean> {
        const cd = new BinaryWriter();
        cd.writeSelector(this.setActiveSel);
        cd.writeBoolean(active);
        const r = await this.exec(cd, sender ?? this.deployerAddr);
        this.check(r);
        return new BinaryReader(r.response).readBoolean();
    }

    // ── Read methods ───────────────────────────────────────────────────────────

    public async presaleInfo(): Promise<PresaleInfo> {
        const cd = new BinaryWriter();
        cd.writeSelector(this.presaleInfoSel);
        const r = await this.exec(cd);
        this.check(r);
        const rd = new BinaryReader(r.response);
        return {
            sold:         rd.readU256(),
            remaining:    rd.readU256(),
            cap:          rd.readU256(),
            satsPerToken: rd.readU256(),
            active:       rd.readBoolean(),
        };
    }

    public async airdropInfo(): Promise<AirdropInfo> {
        const cd = new BinaryWriter();
        cd.writeSelector(this.airdropInfoSel);
        const r = await this.exec(cd);
        this.check(r);
        const rd = new BinaryReader(r.response);
        return {
            merkleRoot:     rd.readU256(),
            claimCount:     rd.readU256(),
            maxClaims:      rd.readU256(),
            amountPerClaim: rd.readU256(),
            active:         rd.readBoolean(),
        };
    }

    public async getBalance(addr: Address): Promise<RaiseBalance> {
        const cd = new BinaryWriter();
        cd.writeSelector(this.getBalanceSel);
        cd.writeAddress(addr);
        const r = await this.exec(cd);
        this.check(r);
        const rd = new BinaryReader(r.response);
        return {
            raiseOwed:   rd.readU256(),
            airdropOwed: rd.readU256(),
            total:       rd.readU256(),
        };
    }

    // ── Internal ───────────────────────────────────────────────────────────────

    protected handleError(error: Error): Error {
        return new Error(`(OPBETRaise: ${this.address}) OP_NET: ${error.message}`);
    }

    protected defineRequiredBytecodes(): void {
        BytecodeManager.loadBytecode('./build/OPBETRaise.wasm', this.address);
    }

    private async exec(cd: BinaryWriter, sender?: Address): Promise<CallResponse> {
        const params: any = { calldata: cd.getBuffer() };
        if (sender) { params.sender = sender; params.txOrigin = sender; }
        return this.execute(params);
    }

    private check(r: CallResponse): void {
        if (r.error) throw this.handleError(r.error);
        if (!r.response) throw new Error('No response to decode');
    }

    private sel(signature: string): number {
        return Number(`0x${this.abiCoder.encodeSelector(signature)}`);
    }
}
