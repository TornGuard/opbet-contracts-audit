import { Blockchain } from '@btc-vision/btc-runtime/runtime';
import { FeeBet_Market } from './FeeBet_Market';
import { revertOnError } from '@btc-vision/btc-runtime/runtime/abort/abort';

Blockchain.contract = (): FeeBet_Market => {
    return new FeeBet_Market();
};

export * from '@btc-vision/btc-runtime/runtime/exports';

export function abort(message: string, fileName: string, line: u32, column: u32): void {
    revertOnError(message, fileName, line, column);
}
