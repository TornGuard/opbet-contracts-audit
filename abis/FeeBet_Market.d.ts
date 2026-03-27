import { Address, AddressMap, ExtendedAddressMap, SchnorrSignature } from '@btc-vision/transaction';
import { CallResult, OPNetEvent, IOP_NETContract } from 'opnet';

// ------------------------------------------------------------------
// Event Definitions
// ------------------------------------------------------------------

// ------------------------------------------------------------------
// Call Results
// ------------------------------------------------------------------

/**
 * @description Represents the result of the placeBet function call.
 */
export type PlaceBet = CallResult<
    {
        betId: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the resolveBet function call.
 */
export type ResolveBet = CallResult<
    {
        won: boolean;
        payout: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the refundBet function call.
 */
export type RefundBet = CallResult<
    {
        refundAmount: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the setBlockData function call.
 */
export type SetBlockData = CallResult<
    {
        success: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the seedPool function call.
 */
export type SeedPool = CallResult<
    {
        success: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the drainPool function call.
 */
export type DrainPool = CallResult<
    {
        success: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the addAcceptedToken function call.
 */
export type AddAcceptedToken = CallResult<
    {
        success: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the removeAcceptedToken function call.
 */
export type RemoveAcceptedToken = CallResult<
    {
        success: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the getBetInfo function call.
 */
export type GetBetInfo = CallResult<
    {
        betType: bigint;
        param1: bigint;
        param2: bigint;
        amount: bigint;
        odds: bigint;
        targetBlock: bigint;
        endBlock: bigint;
        status: bigint;
        payout: bigint;
        token: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the getBlockData function call.
 */
export type GetBlockData = CallResult<
    {
        medianFee: bigint;
        mempoolCount: bigint;
        blockTimestamp: bigint;
        dataSet: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the getNextBetId function call.
 */
export type GetNextBetId = CallResult<
    {
        nextBetId: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the getCurrentBtcBlock function call.
 */
export type GetCurrentBtcBlock = CallResult<
    {
        currentBtcBlock: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the getBetOwner function call.
 */
export type GetBetOwner = CallResult<
    {
        owner: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the getPoolInfo function call.
 */
export type GetPoolInfo = CallResult<
    {
        totalPool: bigint;
        pendingExposure: bigint;
        latestOracleFee: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the isTokenAccepted function call.
 */
export type IsTokenAccepted = CallResult<
    {
        accepted: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the setMinBet function call.
 */
export type SetMinBet = CallResult<
    {
        success: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the setMaxBet function call.
 */
export type SetMaxBet = CallResult<
    {
        success: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the setPaused function call.
 */
export type SetPaused = CallResult<
    {
        success: boolean;
    },
    OPNetEvent<never>[]
>;

// ------------------------------------------------------------------
// IFeeBet_Market
// ------------------------------------------------------------------
export interface IFeeBet_Market extends IOP_NETContract {
    placeBet(token: Address, betType: bigint, param1: bigint, param2: bigint, amount: bigint): Promise<PlaceBet>;
    resolveBet(betId: bigint): Promise<ResolveBet>;
    refundBet(betId: bigint): Promise<RefundBet>;
    setBlockData(
        blockHeight: bigint,
        medianFee: bigint,
        mempoolCount: bigint,
        blockTimestamp: bigint,
    ): Promise<SetBlockData>;
    seedPool(token: Address, amount: bigint): Promise<SeedPool>;
    drainPool(token: Address, amount: bigint): Promise<DrainPool>;
    addAcceptedToken(token: Address): Promise<AddAcceptedToken>;
    removeAcceptedToken(token: Address): Promise<RemoveAcceptedToken>;
    getBetInfo(betId: bigint): Promise<GetBetInfo>;
    getBlockData(blockHeight: bigint): Promise<GetBlockData>;
    getNextBetId(): Promise<GetNextBetId>;
    getCurrentBtcBlock(): Promise<GetCurrentBtcBlock>;
    getBetOwner(betId: bigint): Promise<GetBetOwner>;
    getPoolInfo(token: Address): Promise<GetPoolInfo>;
    isTokenAccepted(token: Address): Promise<IsTokenAccepted>;
    setMinBet(amount: bigint): Promise<SetMinBet>;
    setMaxBet(amount: bigint): Promise<SetMaxBet>;
    setPaused(paused: boolean): Promise<SetPaused>;
}
