import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { MongoClient, Db, Collection, ObjectId } from "mongodb";

export interface StoredImageMetadata {
  _id?: ObjectId;
  id: string; // UUID for the image
  originalSource: "ai-generated" | "ai-enhanced" | "external";
  sourceUrl?: string;
  prompt?: string;
  generatedAt: Date;
  mimeType: string;
  fileSize: number;
  dimensions?: {
    width: number;
    height: number;
  };
  aiModel?: string;
  enhancementParams?: {
    strength?: number;
    style?: string;
    preserveComposition?: boolean;
  };
  createdBy?: string;
  usageCount?: number;
  tags?: string[];
}

export interface ImageStorageResult {
  publicUrl: string;
  metadata: StoredImageMetadata;
  filePath: string;
}

export interface StorageConfig {
  mongoUri: string;
  dbName: string;
  physicalStorageDir: string;
  publicServeDir: string;
  baseUrl: string;
}

export interface StorageStats {
  totalImages: number;
  totalSizeBytes: number;
  bySource: Record<string, number>;
  byModel: Record<string, number>;
}

/**
 * Image Storage Service with MongoDB metadata management
 */
export class ImageStorageService {
  private readonly config: StorageConfig;
  private readonly collectionName = "image_metadata";
  private mongoClient?: MongoClient;
  private db?: Db;

  constructor(config: StorageConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    try {
      // Create storage directories
      await Promise.all([
        fs.mkdir(this.config.physicalStorageDir, { recursive: true }),
        fs.mkdir(this.config.publicServeDir, { recursive: true }),
      ]);

      // Connect to MongoDB
      this.mongoClient = new MongoClient(this.config.mongoUri);
      await this.mongoClient.connect();
      this.db = this.mongoClient.db(this.config.dbName);

      // Create indexes
      const collection = this.db.collection<StoredImageMetadata>(
        this.collectionName,
      );
      await collection.createIndexes([
        { key: { id: 1 }, unique: true },
        { key: { originalSource: 1 } },
        { key: { generatedAt: -1 } },
        { key: { createdBy: 1 } },
        { key: { aiModel: 1 } },
        { key: { tags: 1 } },
      ]);

      console.log("✅ Image storage service initialized");
    } catch (error) {
      console.error("Failed to initialize image storage:", error);
      throw error;
    }
  }

  async storeImage(
    imageContent: string | Buffer,
    metadata: Partial<StoredImageMetadata>,
    createdBy?: string,
  ): Promise<ImageStorageResult> {
    if (!this.db) {
      throw new Error(
        "Storage service not initialized. Call initialize() first.",
      );
    }

    const imageId = crypto.randomUUID();
    const extension = this.getExtensionFromMimeType(
      metadata.mimeType || "image/svg+xml",
    );
    const filename = `${imageId}.${extension}`;

    // Convert to buffer
    let buffer: Buffer;
    if (typeof imageContent === "string") {
      buffer = Buffer.from(imageContent, "utf8");
    } else {
      buffer = imageContent;
    }

    // Create full metadata
    const fullMetadata: StoredImageMetadata = {
      id: imageId,
      originalSource: metadata.originalSource || "ai-generated",
      sourceUrl: metadata.sourceUrl,
      prompt: metadata.prompt,
      generatedAt: new Date(),
      mimeType: metadata.mimeType || "image/svg+xml",
      fileSize: buffer.length,
      dimensions: metadata.dimensions,
      aiModel: metadata.aiModel || "gemini-2.5-flash",
      enhancementParams: metadata.enhancementParams,
      createdBy,
      usageCount: 0,
      tags: metadata.tags || [],
    };

    // Store physical file
    const physicalPath = path.join(this.config.physicalStorageDir, filename);
    await fs.writeFile(physicalPath, buffer);

    // Store metadata in MongoDB
    const collection = this.db.collection<StoredImageMetadata>(
      this.collectionName,
    );
    const result = await collection.insertOne(fullMetadata);
    fullMetadata._id = result.insertedId;

    // Create symlink or copy to public directory
    const publicPath = path.join(this.config.publicServeDir, filename);
    try {
      await fs.symlink(physicalPath, publicPath);
    } catch {
      await fs.copyFile(physicalPath, publicPath);
    }

    return {
      publicUrl: `${this.config.baseUrl}/${filename}`,
      metadata: fullMetadata,
      filePath: physicalPath,
    };
  }

  async getImageMetadata(imageId: string): Promise<StoredImageMetadata | null> {
    if (!this.db) return null;

    try {
      const collection = this.db.collection<StoredImageMetadata>(
        this.collectionName,
      );
      return await collection.findOne({ id: imageId });
    } catch (error) {
      console.error("Failed to get image metadata:", error);
      return null;
    }
  }

  async deleteImage(imageId: string): Promise<boolean> {
    if (!this.db) return false;

    try {
      const metadata = await this.getImageMetadata(imageId);
      if (!metadata) return false;

      // Remove from MongoDB
      const collection = this.db.collection<StoredImageMetadata>(
        this.collectionName,
      );
      await collection.deleteOne({ id: imageId });

      // Remove physical files
      const extension = this.getExtensionFromMimeType(metadata.mimeType);
      const filename = `${imageId}.${extension}`;
      const physicalPath = path.join(this.config.physicalStorageDir, filename);
      const publicPath = path.join(this.config.publicServeDir, filename);

      await Promise.allSettled([
        fs.unlink(physicalPath),
        fs.unlink(publicPath),
      ]);

      return true;
    } catch (error) {
      console.error("Failed to delete image:", error);
      return false;
    }
  }

  async getStorageStats(): Promise<StorageStats> {
    if (!this.db) {
      return { totalImages: 0, totalSizeBytes: 0, bySource: {}, byModel: {} };
    }

    try {
      const collection = this.db.collection<StoredImageMetadata>(
        this.collectionName,
      );

      const [totalImages, totalSize, bySource, byModel] = await Promise.all([
        collection.countDocuments(),
        collection
          .aggregate([{ $group: { _id: null, total: { $sum: "$fileSize" } } }])
          .toArray(),
        collection
          .aggregate([
            { $group: { _id: "$originalSource", count: { $sum: 1 } } },
          ])
          .toArray(),
        collection
          .aggregate([{ $group: { _id: "$aiModel", count: { $sum: 1 } } }])
          .toArray(),
      ]);

      return {
        totalImages,
        totalSizeBytes: totalSize[0]?.total || 0,
        bySource: bySource.reduce(
          (acc, item) => ({ ...acc, [item._id]: item.count }),
          {},
        ),
        byModel: byModel.reduce(
          (acc, item) => ({ ...acc, [item._id || "unknown"]: item.count }),
          {},
        ),
      };
    } catch (error) {
      console.error("Failed to get storage stats:", error);
      return { totalImages: 0, totalSizeBytes: 0, bySource: {}, byModel: {} };
    }
  }

  async cleanup(): Promise<void> {
    if (this.mongoClient) {
      await this.mongoClient.close();
    }
  }

  private getExtensionFromMimeType(mimeType: string): string {
    const mimeToExt: Record<string, string> = {
      "image/jpeg": "jpg",
      "image/jpg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
      "image/gif": "gif",
      "image/svg+xml": "svg",
    };
    return mimeToExt[mimeType.toLowerCase()] || "svg";
  }
}
