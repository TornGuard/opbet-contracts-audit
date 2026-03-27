import { Blockchain } from '@btc-vision/btc-runtime/runtime';
import { OPBETRaise } from './OPBETRaise';
import { revertOnError } from '@btc-vision/btc-runtime/runtime/abort/abort';

Blockchain.contract = (): OPBETRaise => {
    return new OPBETRaise();
};

export * from '@btc-vision/btc-runtime/runtime/exports';

export function abort(message: string, fileName: string, line: u32, column: u32): void {
    revertOnError(message, fileName, line, column);
}
