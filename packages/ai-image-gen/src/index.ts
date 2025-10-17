import {
  AIImageGenerator,
  ImageGenerationOptions,
  AIImageConfig,
} from "./generator";
import {
  ImageStorageService,
  StorageConfig,
  ImageStorageResult,
  StoredImageMetadata,
} from "./storage";

export interface AIImageServiceConfig {
  ai: AIImageConfig;
  storage?: StorageConfig;
}

export interface GenerateAndStoreOptions extends ImageGenerationOptions {
  storeImage?: boolean;
  createdBy?: string;
  tags?: string[];
}

export interface GenerationResult {
  svgContent: string;
  dataUrl: string;
  stored?: ImageStorageResult;
}

/**
 * Complete AI Image Generation Service
 * Combines generation and storage capabilities
 */
export class AIImageService {
  private generator: AIImageGenerator;
  private storage?: ImageStorageService;
  private config: AIImageServiceConfig;

  constructor(config: AIImageServiceConfig) {
    this.config = config;
    this.generator = new AIImageGenerator(config.ai);

    if (config.storage) {
      this.storage = new ImageStorageService(config.storage);
    }
  }

  async initialize(): Promise<void> {
    if (this.storage) {
      await this.storage.initialize();
    }
  }

  /**
   * Generate image and optionally store it
   */
  async generateImage(
    prompt: string,
    options: GenerateAndStoreOptions = {},
  ): Promise<GenerationResult> {
    const { storeImage = false, createdBy, tags, ...genOptions } = options;

    // Generate SVG content
    const svgContent = await this.generator.textToImage(prompt, genOptions);
    const dataUrl = this.generator.svgToDataUrl(svgContent);

    const result: GenerationResult = {
      svgContent,
      dataUrl,
    };

    // Store if requested and storage is available
    if (storeImage && this.storage) {
      const metadata: Partial<StoredImageMetadata> = {
        originalSource: "ai-generated",
        prompt,
        mimeType: "image/svg+xml",
        dimensions: {
          width: genOptions.width || 900,
          height: genOptions.height || 600,
        },
        aiModel: "gemini-2.5-flash",
        enhancementParams: {
          style: genOptions.style,
        },
        tags,
      };

      result.stored = await this.storage.storeImage(
        svgContent,
        metadata,
        createdBy,
      );
    }

    return result;
  }

  /**
   * Generate book cover with optimized prompt
   */
  async generateBookCover(
    title: string,
    summary: string,
    genre?: string,
    options: GenerateAndStoreOptions = {},
  ): Promise<GenerationResult> {
    const prompt = this.generator.createBookCoverPrompt(title, summary, genre);

    return this.generateImage(prompt, {
      ...options,
      style: "book-cover",
      width: 900,
      height: 600,
    });
  }

  /**
   * Generate article illustration with optimized prompt
   */
  async generateArticleIllustration(
    title: string,
    content: string,
    options: GenerateAndStoreOptions = {},
  ): Promise<GenerationResult> {
    const prompt = this.generator.createArticleIllustrationPrompt(
      title,
      content,
    );

    return this.generateImage(prompt, {
      ...options,
      style: "artistic",
      width: 800,
      height: 400,
    });
  }

  /**
   * Get storage statistics (if storage is available)
   */
  async getStats() {
    return this.storage?.getStorageStats();
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    if (this.storage) {
      await this.storage.cleanup();
    }
  }
}

// Re-export types and classes for easy importing
export {
  AIImageGenerator,
  ImageStorageService,
  type ImageGenerationOptions,
  type AIImageConfig,
  type StorageConfig,
  type StoredImageMetadata,
  type ImageStorageResult,
};
