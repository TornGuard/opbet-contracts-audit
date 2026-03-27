import { Address, AddressMap, ExtendedAddressMap, SchnorrSignature } from '@btc-vision/transaction';
import { CallResult, OPNetEvent, IOP_NETContract } from 'opnet';

// ------------------------------------------------------------------
// Event Definitions
// ------------------------------------------------------------------

// ------------------------------------------------------------------
// Call Results
// ------------------------------------------------------------------

/**
 * @description Represents the result of the buyWithBTC function call.
 */
export type BuyWithBTC = CallResult<
    {
        tokensMinted: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the buyWithToken function call.
 */
export type BuyWithToken = CallResult<
    {
        tokensMinted: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the addSupportedToken function call.
 */
export type AddSupportedToken = CallResult<
    {
        success: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the removeSupportedToken function call.
 */
export type RemoveSupportedToken = CallResult<
    {
        success: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the getTokenInfo function call.
 */
export type GetTokenInfo = CallResult<{}, OPNetEvent<never>[]>;

/**
 * @description Represents the result of the setBTCPrice function call.
 */
export type SetBTCPrice = CallResult<
    {
        success: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the setPresaleActive function call.
 */
export type SetPresaleActive = CallResult<
    {
        success: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the devMint function call.
 */
export type DevMint = CallResult<
    {
        success: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the setMerkleRoot function call.
 */
export type SetMerkleRoot = CallResult<
    {
        success: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the claimAirdrop function call.
 */
export type ClaimAirdrop = CallResult<
    {
        success: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the airdropInfo function call.
 */
export type AirdropInfo = CallResult<{}, OPNetEvent<never>[]>;

/**
 * @description Represents the result of the presaleInfo function call.
 */
export type PresaleInfo = CallResult<{}, OPNetEvent<never>[]>;

/**
 * @description Represents the result of the getTaxRate function call.
 */
export type GetTaxRate = CallResult<
    {
        rate: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the getIsExempt function call.
 */
export type GetIsExempt = CallResult<
    {
        exempt: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the setTaxRate function call.
 */
export type SetTaxRate = CallResult<
    {
        success: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the setExempt function call.
 */
export type SetExempt = CallResult<
    {
        success: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the setTeamWallet function call.
 */
export type SetTeamWallet = CallResult<
    {
        success: boolean;
    },
    OPNetEvent<never>[]
>;

// ------------------------------------------------------------------
// IOPBET_Token
// ------------------------------------------------------------------
export interface IOPBET_Token extends IOP_NETContract {
    buyWithBTC(recipient: Address): Promise<BuyWithBTC>;
    buyWithToken(token: Address, tokenAmount: bigint): Promise<BuyWithToken>;
    addSupportedToken(token: Address, pricePerOPBET: bigint): Promise<AddSupportedToken>;
    removeSupportedToken(token: Address): Promise<RemoveSupportedToken>;
    getTokenInfo(token: Address): Promise<GetTokenInfo>;
    setBTCPrice(satsPerToken: bigint): Promise<SetBTCPrice>;
    setPresaleActive(active: boolean): Promise<SetPresaleActive>;
    devMint(to: Address, amount: bigint): Promise<DevMint>;
    setMerkleRoot(root: bigint): Promise<SetMerkleRoot>;
    claimAirdrop(recipient: Address, proof: Uint8Array): Promise<ClaimAirdrop>;
    airdropInfo(): Promise<AirdropInfo>;
    presaleInfo(): Promise<PresaleInfo>;
    getTaxRate(): Promise<GetTaxRate>;
    getIsExempt(addr: Address): Promise<GetIsExempt>;
    setTaxRate(newRate: bigint): Promise<SetTaxRate>;
    setExempt(addr: Address, exempt: boolean): Promise<SetExempt>;
    setTeamWallet(wallet: Address): Promise<SetTeamWallet>;
}
