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

export interface TokenInfo {
    price:     bigint;
    supported: boolean;
}

// ─── Runtime ──────────────────────────────────────────────────────────────────

export class OPBETTokenRuntime extends ContractRuntime {

    private readonly buyWithBTCSel        = this.sel('buyWithBTC(address)');
    private readonly buyWithTokenSel      = this.sel('buyWithToken(address,uint256)');
    private readonly claimAirdropSel      = this.sel('claimAirdrop(address,bytes)');
    private readonly setMerkleRootSel     = this.sel('setMerkleRoot(uint256)');
    private readonly devMintSel           = this.sel('devMint(address,uint256)');
    private readonly setBTCPriceSel       = this.sel('setBTCPrice(uint256)');
    private readonly setPresaleActiveSel  = this.sel('setPresaleActive(bool)');
    private readonly addSupportedTokenSel = this.sel('addSupportedToken(address,uint256)');
    private readonly removeSupportedTokenSel = this.sel('removeSupportedToken(address)');
    private readonly setTaxRateSel        = this.sel('setTaxRate(uint256)');
    private readonly setExemptSel         = this.sel('setExempt(address,bool)');
    private readonly transferSel          = this.sel('transfer(address,uint256)');
    private readonly transferFromSel      = this.sel('transferFrom(address,address,uint256)');
    private readonly approveSel           = this.sel('approve(address,uint256)');

    private readonly presaleInfoSel       = this.sel('presaleInfo()');
    private readonly airdropInfoSel       = this.sel('airdropInfo()');
    private readonly balanceOfSel         = this.sel('balanceOf(address)');
    private readonly totalSupplySel       = this.sel('totalSupply()');
    private readonly getTaxRateSel        = this.sel('getTaxRate()');
    private readonly getIsExemptSel       = this.sel('getIsExempt(address)');
    private readonly getTokenInfoSel      = this.sel('getTokenInfo(address)');

    public readonly deployerAddr: Address;

    /**
     * @param deployer        - deployer/owner address
     * @param address         - contract address
     * @param teamWallet      - tax recipient address
     * @param tokensTreasury  - OP20 proceeds recipient address
     * @param treasuryKeyHex  - 64-char hex of 32-byte x-only P2TR pubkey
     * @param satsPerToken    - initial sats per 1 whole OPBET (0 = BTC disabled)
     */
    public constructor(
        deployer: Address,
        address: Address,
        teamWallet: Address,
        tokensTreasury: Address,
        treasuryKeyHex: string,
        satsPerToken: bigint,
    ) {
        const cd = new BinaryWriter();
        cd.writeAddress(teamWallet);
        cd.writeAddress(tokensTreasury);
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

    public async buyWithToken(
        token: Address,
        tokenAmount: bigint,
        sender?: Address,
    ): Promise<bigint> {
        const cd = new BinaryWriter();
        cd.writeSelector(this.buyWithTokenSel);
        cd.writeAddress(token);
        cd.writeU256(tokenAmount);
        const r = await this.exec(cd, sender ?? this.deployerAddr);
        this.check(r);
        return new BinaryReader(r.response).readU256();
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

    public async setMerkleRoot(root: bigint, sender?: Address): Promise<boolean> {
        const cd = new BinaryWriter();
        cd.writeSelector(this.setMerkleRootSel);
        cd.writeU256(root);
        const r = await this.exec(cd, sender ?? this.deployerAddr);
        this.check(r);
        return new BinaryReader(r.response).readBoolean();
    }

    public async devMint(to: Address, amount: bigint, sender?: Address): Promise<boolean> {
        const cd = new BinaryWriter();
        cd.writeSelector(this.devMintSel);
        cd.writeAddress(to);
        cd.writeU256(amount);
        const r = await this.exec(cd, sender ?? this.deployerAddr);
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
        cd.writeSelector(this.setPresaleActiveSel);
        cd.writeBoolean(active);
        const r = await this.exec(cd, sender ?? this.deployerAddr);
        this.check(r);
        return new BinaryReader(r.response).readBoolean();
    }

    public async addSupportedToken(
        token: Address,
        pricePerOPBET: bigint,
        sender?: Address,
    ): Promise<boolean> {
        const cd = new BinaryWriter();
        cd.writeSelector(this.addSupportedTokenSel);
        cd.writeAddress(token);
        cd.writeU256(pricePerOPBET);
        const r = await this.exec(cd, sender ?? this.deployerAddr);
        this.check(r);
        return new BinaryReader(r.response).readBoolean();
    }

    public async removeSupportedToken(token: Address, sender?: Address): Promise<boolean> {
        const cd = new BinaryWriter();
        cd.writeSelector(this.removeSupportedTokenSel);
        cd.writeAddress(token);
        const r = await this.exec(cd, sender ?? this.deployerAddr);
        this.check(r);
        return new BinaryReader(r.response).readBoolean();
    }

    public async setTaxRate(rate: bigint, sender?: Address): Promise<boolean> {
        const cd = new BinaryWriter();
        cd.writeSelector(this.setTaxRateSel);
        cd.writeU256(rate);
        const r = await this.exec(cd, sender ?? this.deployerAddr);
        this.check(r);
        return new BinaryReader(r.response).readBoolean();
    }

    public async setExempt(addr: Address, exempt: boolean, sender?: Address): Promise<boolean> {
        const cd = new BinaryWriter();
        cd.writeSelector(this.setExemptSel);
        cd.writeAddress(addr);
        cd.writeBoolean(exempt);
        const r = await this.exec(cd, sender ?? this.deployerAddr);
        this.check(r);
        return new BinaryReader(r.response).readBoolean();
    }

    public async transfer(to: Address, amount: bigint, sender?: Address): Promise<boolean> {
        const cd = new BinaryWriter();
        cd.writeSelector(this.transferSel);
        cd.writeAddress(to);
        cd.writeU256(amount);
        const r = await this.exec(cd, sender ?? this.deployerAddr);
        this.check(r);
        return new BinaryReader(r.response).readBoolean();
    }

    public async approve(spender: Address, amount: bigint, sender?: Address): Promise<boolean> {
        const cd = new BinaryWriter();
        cd.writeSelector(this.approveSel);
        cd.writeAddress(spender);
        cd.writeU256(amount);
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

    public async balanceOf(addr: Address): Promise<bigint> {
        const cd = new BinaryWriter();
        cd.writeSelector(this.balanceOfSel);
        cd.writeAddress(addr);
        const r = await this.exec(cd);
        this.check(r);
        return new BinaryReader(r.response).readU256();
    }

    public async totalSupply(): Promise<bigint> {
        const cd = new BinaryWriter();
        cd.writeSelector(this.totalSupplySel);
        const r = await this.exec(cd);
        this.check(r);
        return new BinaryReader(r.response).readU256();
    }

    public async getTaxRate(): Promise<bigint> {
        const cd = new BinaryWriter();
        cd.writeSelector(this.getTaxRateSel);
        const r = await this.exec(cd);
        this.check(r);
        return new BinaryReader(r.response).readU256();
    }

    public async getIsExempt(addr: Address): Promise<boolean> {
        const cd = new BinaryWriter();
        cd.writeSelector(this.getIsExemptSel);
        cd.writeAddress(addr);
        const r = await this.exec(cd);
        this.check(r);
        return new BinaryReader(r.response).readBoolean();
    }

    public async getTokenInfo(token: Address): Promise<TokenInfo> {
        const cd = new BinaryWriter();
        cd.writeSelector(this.getTokenInfoSel);
        cd.writeAddress(token);
        const r = await this.exec(cd);
        this.check(r);
        const rd = new BinaryReader(r.response);
        return { price: rd.readU256(), supported: rd.readBoolean() };
    }

    // ── Internal ───────────────────────────────────────────────────────────────

    protected handleError(error: Error): Error {
        return new Error(`(OPBETToken: ${this.address}) OP_NET: ${error.message}`);
    }

    protected defineRequiredBytecodes(): void {
        BytecodeManager.loadBytecode('./build/OPBET_Token.wasm', this.address);
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
