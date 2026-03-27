import { Blockchain } from '@btc-vision/btc-runtime/runtime';
import { OPBET_Token } from './OPBET_Token';
import { revertOnError } from '@btc-vision/btc-runtime/runtime/abort/abort';

Blockchain.contract = (): OPBET_Token => {
    return new OPBET_Token();
};

export * from '@btc-vision/btc-runtime/runtime/exports';

export function abort(message: string, fileName: string, line: u32, column: u32): void {
    revertOnError(message, fileName, line, column);
}
