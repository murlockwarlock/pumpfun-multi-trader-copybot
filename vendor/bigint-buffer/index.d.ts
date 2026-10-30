/// <reference types="node" />

export declare function toBigIntBE(value: Buffer | Uint8Array): bigint;
export declare function toBigIntLE(value: Buffer | Uint8Array): bigint;
export declare function toBufferBE(value: bigint, width: number): Buffer;
export declare function toBufferLE(value: bigint, width: number): Buffer;
