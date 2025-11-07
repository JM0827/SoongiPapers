declare module "hash-wasm" {
  export interface Blake3Instance {
    init(): void;
    update(data: string | Uint8Array): void;
    digest(outputType?: "hex" | "binary" | "base64"): string;
  }

  export function createBLAKE3(): Promise<Blake3Instance>;
}
