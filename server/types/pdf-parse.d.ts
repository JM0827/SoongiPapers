declare module "pdf-parse" {
  export interface PDFParseResult {
    numpages: number;
    numrender: number;
    info: Record<string, unknown>;
    metadata?: unknown;
    text: string;
    version: string;
  }

  export interface PDFParseOptions {
    pagerender?(page: unknown): Promise<string> | string;
    max?: number;
  }

  function pdf(
    data: Buffer | Uint8Array | ArrayBuffer,
    options?: PDFParseOptions,
  ): Promise<PDFParseResult>;

  export default pdf;
}
