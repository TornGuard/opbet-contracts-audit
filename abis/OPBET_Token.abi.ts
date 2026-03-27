import { ABIDataTypes, BitcoinAbiTypes, OP_NET_ABI } from 'opnet';

export const OPBET_TokenEvents = [];

export const OPBET_TokenAbi = [
    {
        name: 'buyWithBTC',
        inputs: [{ name: 'recipient', type: ABIDataTypes.ADDRESS }],
        outputs: [{ name: 'tokensMinted', type: ABIDataTypes.UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'buyWithToken',
        inputs: [
            { name: 'token', type: ABIDataTypes.ADDRESS },
            { name: 'tokenAmount', type: ABIDataTypes.UINT256 },
        ],
        outputs: [{ name: 'tokensMinted', type: ABIDataTypes.UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'addSupportedToken',
        inputs: [
            { name: 'token', type: ABIDataTypes.ADDRESS },
            { name: 'pricePerOPBET', type: ABIDataTypes.UINT256 },
        ],
        outputs: [{ name: 'success', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'removeSupportedToken',
        inputs: [{ name: 'token', type: ABIDataTypes.ADDRESS }],
        outputs: [{ name: 'success', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'getTokenInfo',
        inputs: [{ name: 'token', type: ABIDataTypes.ADDRESS }],
        outputs: [],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'setBTCPrice',
        inputs: [{ name: 'satsPerToken', type: ABIDataTypes.UINT256 }],
        outputs: [{ name: 'success', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'setPresaleActive',
        inputs: [{ name: 'active', type: ABIDataTypes.BOOL }],
        outputs: [{ name: 'success', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'devMint',
        inputs: [
            { name: 'to', type: ABIDataTypes.ADDRESS },
            { name: 'amount', type: ABIDataTypes.UINT256 },
        ],
        outputs: [{ name: 'success', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'setMerkleRoot',
        inputs: [{ name: 'root', type: ABIDataTypes.UINT256 }],
        outputs: [{ name: 'success', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'claimAirdrop',
        inputs: [
            { name: 'recipient', type: ABIDataTypes.ADDRESS },
            { name: 'proof', type: ABIDataTypes.BYTES },
        ],
        outputs: [{ name: 'success', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'airdropInfo',
        inputs: [],
        outputs: [],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'presaleInfo',
        inputs: [],
        outputs: [],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'getTaxRate',
        inputs: [],
        outputs: [{ name: 'rate', type: ABIDataTypes.UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'getIsExempt',
        inputs: [{ name: 'addr', type: ABIDataTypes.ADDRESS }],
        outputs: [{ name: 'exempt', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'setTaxRate',
        inputs: [{ name: 'newRate', type: ABIDataTypes.UINT256 }],
        outputs: [{ name: 'success', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'setExempt',
        inputs: [
            { name: 'addr', type: ABIDataTypes.ADDRESS },
            { name: 'exempt', type: ABIDataTypes.BOOL },
        ],
        outputs: [{ name: 'success', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'setTeamWallet',
        inputs: [{ name: 'wallet', type: ABIDataTypes.ADDRESS }],
        outputs: [{ name: 'success', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
    ...OPBET_TokenEvents,
    ...OP_NET_ABI,
];

export default OPBET_TokenAbi;
