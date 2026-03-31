import { ABIDataTypes, BitcoinAbiTypes, OP_NET_ABI } from 'opnet';

export const PriceOracleEvents = [];

export const PriceOracleAbi = [
    {
        name: 'addFeeder',
        inputs: [{ name: 'feeder', type: ABIDataTypes.ADDRESS }],
        outputs: [{ name: 'success', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'removeFeeder',
        inputs: [{ name: 'feeder', type: ABIDataTypes.ADDRESS }],
        outputs: [{ name: 'success', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'setMinFeeders',
        inputs: [{ name: 'min', type: ABIDataTypes.UINT256 }],
        outputs: [{ name: 'success', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'setRoundDuration',
        inputs: [{ name: 'blocks', type: ABIDataTypes.UINT256 }],
        outputs: [{ name: 'success', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'submitPrice',
        inputs: [
            { name: 'symbolId', type: ABIDataTypes.UINT256 },
            { name: 'price', type: ABIDataTypes.UINT256 },
            { name: 'confidence', type: ABIDataTypes.UINT256 },
        ],
        outputs: [{ name: 'published', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'finalizeRound',
        inputs: [{ name: 'symbolId', type: ABIDataTypes.UINT256 }],
        outputs: [{ name: 'published', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'getPrice',
        inputs: [{ name: 'symbolId', type: ABIDataTypes.UINT256 }],
        outputs: [
            { name: 'price', type: ABIDataTypes.UINT256 },
            { name: 'updateBlock', type: ABIDataTypes.UINT256 },
            { name: 'confidence', type: ABIDataTypes.UINT256 },
            { name: 'roundId', type: ABIDataTypes.UINT256 },
            { name: 'isFresh', type: ABIDataTypes.BOOL },
        ],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'latestPrice',
        inputs: [{ name: 'symbolId', type: ABIDataTypes.UINT256 }],
        outputs: [{ name: 'price', type: ABIDataTypes.UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'isFeeder',
        inputs: [{ name: 'feeder', type: ABIDataTypes.ADDRESS }],
        outputs: [{ name: 'authorized', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'getConfig',
        inputs: [],
        outputs: [
            { name: 'minFeeders', type: ABIDataTypes.UINT256 },
            { name: 'feederCount', type: ABIDataTypes.UINT256 },
            { name: 'roundDuration', type: ABIDataTypes.UINT256 },
        ],
        type: BitcoinAbiTypes.Function,
    },
    ...PriceOracleEvents,
    ...OP_NET_ABI,
];

export default PriceOracleAbi;
