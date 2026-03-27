import { ABIDataTypes, BitcoinAbiTypes, OP_NET_ABI } from 'opnet';

export const FeeBet_MarketEvents = [];

export const FeeBet_MarketAbi = [
    {
        name: 'placeBet',
        inputs: [
            { name: 'token', type: ABIDataTypes.ADDRESS },
            { name: 'betType', type: ABIDataTypes.UINT256 },
            { name: 'param1', type: ABIDataTypes.UINT256 },
            { name: 'param2', type: ABIDataTypes.UINT256 },
            { name: 'amount', type: ABIDataTypes.UINT256 },
        ],
        outputs: [{ name: 'betId', type: ABIDataTypes.UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'resolveBet',
        inputs: [{ name: 'betId', type: ABIDataTypes.UINT256 }],
        outputs: [
            { name: 'won', type: ABIDataTypes.BOOL },
            { name: 'payout', type: ABIDataTypes.UINT256 },
        ],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'refundBet',
        inputs: [{ name: 'betId', type: ABIDataTypes.UINT256 }],
        outputs: [{ name: 'refundAmount', type: ABIDataTypes.UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'setBlockData',
        inputs: [
            { name: 'blockHeight', type: ABIDataTypes.UINT256 },
            { name: 'medianFee', type: ABIDataTypes.UINT256 },
            { name: 'mempoolCount', type: ABIDataTypes.UINT256 },
            { name: 'blockTimestamp', type: ABIDataTypes.UINT256 },
        ],
        outputs: [{ name: 'success', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'seedPool',
        inputs: [
            { name: 'token', type: ABIDataTypes.ADDRESS },
            { name: 'amount', type: ABIDataTypes.UINT256 },
        ],
        outputs: [{ name: 'success', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'drainPool',
        inputs: [
            { name: 'token', type: ABIDataTypes.ADDRESS },
            { name: 'amount', type: ABIDataTypes.UINT256 },
        ],
        outputs: [{ name: 'success', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'addAcceptedToken',
        inputs: [{ name: 'token', type: ABIDataTypes.ADDRESS }],
        outputs: [{ name: 'success', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'removeAcceptedToken',
        inputs: [{ name: 'token', type: ABIDataTypes.ADDRESS }],
        outputs: [{ name: 'success', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'getBetInfo',
        inputs: [{ name: 'betId', type: ABIDataTypes.UINT256 }],
        outputs: [
            { name: 'betType', type: ABIDataTypes.UINT256 },
            { name: 'param1', type: ABIDataTypes.UINT256 },
            { name: 'param2', type: ABIDataTypes.UINT256 },
            { name: 'amount', type: ABIDataTypes.UINT256 },
            { name: 'odds', type: ABIDataTypes.UINT256 },
            { name: 'targetBlock', type: ABIDataTypes.UINT256 },
            { name: 'endBlock', type: ABIDataTypes.UINT256 },
            { name: 'status', type: ABIDataTypes.UINT256 },
            { name: 'payout', type: ABIDataTypes.UINT256 },
            { name: 'token', type: ABIDataTypes.UINT256 },
        ],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'getBlockData',
        inputs: [{ name: 'blockHeight', type: ABIDataTypes.UINT256 }],
        outputs: [
            { name: 'medianFee', type: ABIDataTypes.UINT256 },
            { name: 'mempoolCount', type: ABIDataTypes.UINT256 },
            { name: 'blockTimestamp', type: ABIDataTypes.UINT256 },
            { name: 'dataSet', type: ABIDataTypes.UINT256 },
        ],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'getNextBetId',
        inputs: [],
        outputs: [{ name: 'nextBetId', type: ABIDataTypes.UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'getCurrentBtcBlock',
        inputs: [],
        outputs: [{ name: 'currentBtcBlock', type: ABIDataTypes.UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'getBetOwner',
        inputs: [{ name: 'betId', type: ABIDataTypes.UINT256 }],
        outputs: [{ name: 'owner', type: ABIDataTypes.UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'getPoolInfo',
        inputs: [{ name: 'token', type: ABIDataTypes.ADDRESS }],
        outputs: [
            { name: 'totalPool', type: ABIDataTypes.UINT256 },
            { name: 'pendingExposure', type: ABIDataTypes.UINT256 },
            { name: 'latestOracleFee', type: ABIDataTypes.UINT256 },
        ],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'isTokenAccepted',
        inputs: [{ name: 'token', type: ABIDataTypes.ADDRESS }],
        outputs: [{ name: 'accepted', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'setMinBet',
        inputs: [{ name: 'amount', type: ABIDataTypes.UINT256 }],
        outputs: [{ name: 'success', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'setMaxBet',
        inputs: [{ name: 'amount', type: ABIDataTypes.UINT256 }],
        outputs: [{ name: 'success', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'setPaused',
        inputs: [{ name: 'paused', type: ABIDataTypes.BOOL }],
        outputs: [{ name: 'success', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
    ...FeeBet_MarketEvents,
    ...OP_NET_ABI,
];

export default FeeBet_MarketAbi;
