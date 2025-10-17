import { AIImageServiceConfig } from "./index";

/**
 * Configuration helper for common setups
 */
export class ConfigBuilder {
  private config: Partial<AIImageServiceConfig> = {};

  /**
   * Set Gemini API configuration
   */
  withGeminiApi(apiKey: string, model?: string): this {
    this.config.ai = {
      geminiApiKey: apiKey,
      model: model || "gemini-2.5-flash",
    };
    return this;
  }

  /**
   * Set MongoDB storage configuration
   */
  withMongoStorage(
    mongoUri: string,
    dbName: string,
    storagePaths: {
      physicalDir: string;
      publicDir: string;
      baseUrl: string;
    },
  ): this {
    this.config.storage = {
      mongoUri,
      dbName,
      physicalStorageDir: storagePaths.physicalDir,
      publicServeDir: storagePaths.publicDir,
      baseUrl: storagePaths.baseUrl,
    };
    return this;
  }

  /**
   * Build the final configuration
   */
  build(): AIImageServiceConfig {
    if (!this.config.ai) {
      throw new Error("AI configuration is required. Use withGeminiApi()");
    }

    return this.config as AIImageServiceConfig;
  }

  /**
   * Create a configuration from environment variables
   */
  static fromEnv(): AIImageServiceConfig {
    const builder = new ConfigBuilder();

    // Required: Gemini API
    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      throw new Error("GEMINI_API_KEY environment variable is required");
    }
    builder.withGeminiApi(geminiApiKey, process.env.GEMINI_MODEL);

    // Optional: MongoDB storage
    const mongoUri = process.env.MONGODB_URI;
    if (mongoUri) {
      const dbName = process.env.MONGODB_DB_NAME || "ai_images";
      const physicalDir =
        process.env.STORAGE_PHYSICAL_DIR || "./storage/images";
      const publicDir =
        process.env.STORAGE_PUBLIC_DIR || "./public/uploads/images";
      const baseUrl = process.env.STORAGE_BASE_URL || "/uploads/images";

      builder.withMongoStorage(mongoUri, dbName, {
        physicalDir,
        publicDir,
        baseUrl,
      });
    }

    return builder.build();
  }
}
