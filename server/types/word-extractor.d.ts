declare module "word-extractor" {
  interface ExtractedDocument {
    getBody(): string;
  }

  class WordExtractor {
    extract(input: string | Buffer): Promise<ExtractedDocument>;
  }

  export = WordExtractor;
}
