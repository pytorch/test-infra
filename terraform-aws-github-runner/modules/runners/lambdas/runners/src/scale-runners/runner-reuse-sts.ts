import { Config } from './config';
import { redisLocked } from './cache';

export interface InstanceReuseState {
    instanceId: string;
    setupTimeout: number;
}

interface RedisRunnerReuseState {
    instanceId: string;
    ttl: number;
}

function encodeInt32ToBase64(num: number): string {
    if (!Number.isInteger(num) || num < -2147483648 || num > 2147483647) {
        throw new Error("Input must be a 32-bit signed integer.");
    }

    const buffer = new ArrayBuffer(4);
    const view = new DataView(buffer);
    view.setInt32(0, num, false);
    const bytes = new Uint8Array(buffer);
    const base64String = btoa(String.fromCharCode(...bytes));

    return base64String;
}

function simpleHashing(s: string, hashingSize: number): string {
    var hash = 0,
    i, chr;
    for (i = 0; i < s.length; i++) {
        chr = s.charCodeAt(i);
        hash = ((hash << 5) - hash) + chr;
        hash |= 0;
    }
    return encodeInt32ToBase64(hash % hashingSize);
}

export async function trySetRunnerForReuse(instanceReuseState: InstanceReuseState): Promise<boolean> {
    const instanceHash = simpleHashing(instanceReuseState.instanceId, 1000);

    await redisLocked('instanceReuseState', instanceHash, async () => {

    }, 30);
}
