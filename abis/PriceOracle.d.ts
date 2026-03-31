import { Address, AddressMap, ExtendedAddressMap, SchnorrSignature } from '@btc-vision/transaction';
import { CallResult, OPNetEvent, IOP_NETContract } from 'opnet';

// ------------------------------------------------------------------
// Event Definitions
// ------------------------------------------------------------------

// ------------------------------------------------------------------
// Call Results
// ------------------------------------------------------------------

/**
 * @description Represents the result of the addFeeder function call.
 */
export type AddFeeder = CallResult<
    {
        success: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the removeFeeder function call.
 */
export type RemoveFeeder = CallResult<
    {
        success: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the setMinFeeders function call.
 */
export type SetMinFeeders = CallResult<
    {
        success: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the setRoundDuration function call.
 */
export type SetRoundDuration = CallResult<
    {
        success: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the submitPrice function call.
 */
export type SubmitPrice = CallResult<
    {
        published: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the finalizeRound function call.
 */
export type FinalizeRound = CallResult<
    {
        published: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the getPrice function call.
 */
export type GetPrice = CallResult<
    {
        price: bigint;
        updateBlock: bigint;
        confidence: bigint;
        roundId: bigint;
        isFresh: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the latestPrice function call.
 */
export type LatestPrice = CallResult<
    {
        price: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the isFeeder function call.
 */
export type IsFeeder = CallResult<
    {
        authorized: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the getConfig function call.
 */
export type GetConfig = CallResult<
    {
        minFeeders: bigint;
        feederCount: bigint;
        roundDuration: bigint;
    },
    OPNetEvent<never>[]
>;

// ------------------------------------------------------------------
// IPriceOracle
// ------------------------------------------------------------------
export interface IPriceOracle extends IOP_NETContract {
    addFeeder(feeder: Address): Promise<AddFeeder>;
    removeFeeder(feeder: Address): Promise<RemoveFeeder>;
    setMinFeeders(min: bigint): Promise<SetMinFeeders>;
    setRoundDuration(blocks: bigint): Promise<SetRoundDuration>;
    submitPrice(symbolId: bigint, price: bigint, confidence: bigint): Promise<SubmitPrice>;
    finalizeRound(symbolId: bigint): Promise<FinalizeRound>;
    getPrice(symbolId: bigint): Promise<GetPrice>;
    latestPrice(symbolId: bigint): Promise<LatestPrice>;
    isFeeder(feeder: Address): Promise<IsFeeder>;
    getConfig(): Promise<GetConfig>;
}
