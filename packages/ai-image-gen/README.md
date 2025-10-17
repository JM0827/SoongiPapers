# AI Image Generation Module

A reusable TypeScript/Node.js module for AI-powered image generation using Google Gemini 2.5 Flash. Generates lightweight SVG images with optional MongoDB storage and metadata management.

## Features

- 🎨 **AI-Powered SVG Generation** using Google Gemini 2.5 Flash
- 📦 **Lightweight & Fast** - generates 2-4KB SVG files
- 💾 **Optional Storage** with MongoDB metadata management
- 🔧 **TypeScript Support** with full type definitions
- 🚀 **Easy Integration** - works with any Node.js application
- 📱 **Scalable Images** - SVGs work perfectly at any resolution

## Installation

```bash
npm install @bookko/ai-image-gen
# or
yarn add @bookko/ai-image-gen
# or
pnpm add @bookko/ai-image-gen
```

## Quick Start

### Basic Usage (Generation Only)

```typescript
import { AIImageService, ConfigBuilder } from "@bookko/ai-image-gen";

// Create service with minimal configuration
const config = new ConfigBuilder().withGeminiApi("your-gemini-api-key").build();

const service = new AIImageService(config);
await service.initialize();

// Generate an image
const result = await service.generateImage(
  "A magical library with floating books",
  {
    width: 800,
    height: 600,
    style: "artistic",
  },
);

console.log(result.svgContent); // Raw SVG string
console.log(result.dataUrl); // Data URL for direct use in HTML
```

### Full Setup with Storage

```typescript
import { AIImageService, ConfigBuilder } from "@bookko/ai-image-gen";

// Complete configuration with MongoDB storage
const config = new ConfigBuilder()
  .withGeminiApi("your-gemini-api-key")
  .withMongoStorage("mongodb://localhost:27017", "my_app", {
    physicalDir: "./storage/images",
    publicDir: "./public/uploads",
    baseUrl: "/uploads",
  })
  .build();

const service = new AIImageService(config);
await service.initialize();

// Generate and store image
const result = await service.generateImage("Professional book cover design", {
  storeImage: true,
  createdBy: "user-123",
  tags: ["book-cover", "ai-generated"],
  style: "book-cover",
});

console.log(result.stored?.publicUrl); // /uploads/abc123.svg
```

### Environment Variables Setup

Create a `.env` file:

```env
GEMINI_API_KEY=your-gemini-api-key-here
MONGODB_URI=mongodb://localhost:27017
MONGODB_DB_NAME=my_app
STORAGE_PHYSICAL_DIR=./storage/images
STORAGE_PUBLIC_DIR=./public/uploads
STORAGE_BASE_URL=/uploads
```

Then use:

```typescript
import { AIImageService, ConfigBuilder } from "@bookko/ai-image-gen";

const config = ConfigBuilder.fromEnv();
const service = new AIImageService(config);
```

## API Reference

### AIImageService

#### Constructor

```typescript
new AIImageService(config: AIImageServiceConfig)
```

#### Methods

##### `initialize(): Promise<void>`

Initialize the service and storage (if configured).

##### `generateImage(prompt: string, options?: GenerateAndStoreOptions): Promise<GenerationResult>`

Generate an SVG image from a text prompt.

**Options:**

- `width?: number` - Image width (default: 900)
- `height?: number` - Image height (default: 600)
- `style?: 'realistic' | 'artistic' | 'book-cover' | 'minimalist'` - Style preset
- `quality?: 'standard' | 'high'` - Quality level
- `storeImage?: boolean` - Whether to store the image (requires storage config)
- `createdBy?: string` - User ID for attribution
- `tags?: string[]` - Tags for categorization

##### `generateBookCover(title: string, summary: string, genre?: string, options?: GenerateAndStoreOptions): Promise<GenerationResult>`

Generate a book cover with optimized prompt.

##### `generateArticleIllustration(title: string, content: string, options?: GenerateAndStoreOptions): Promise<GenerationResult>`

Generate an article illustration with optimized prompt.

##### `getStats(): Promise<StorageStats | undefined>`

Get storage statistics (if storage is configured).

##### `cleanup(): Promise<void>`

Clean up resources and close connections.

### ConfigBuilder

#### Methods

##### `withGeminiApi(apiKey: string, model?: string): ConfigBuilder`

Set Gemini API configuration.

##### `withMongoStorage(mongoUri: string, dbName: string, paths: StoragePaths): ConfigBuilder`

Set MongoDB storage configuration.

##### `build(): AIImageServiceConfig`

Build the final configuration.

##### `static fromEnv(): AIImageServiceConfig`

Create configuration from environment variables.

## Integration Examples

### Express.js Route

```typescript
import express from "express";
import { AIImageService, ConfigBuilder } from "@bookko/ai-image-gen";

const app = express();
const config = ConfigBuilder.fromEnv();
const imageService = new AIImageService(config);

app.post("/api/generate-cover", async (req, res) => {
  try {
    const { title, summary, genre } = req.body;

    const result = await imageService.generateBookCover(title, summary, genre, {
      storeImage: true,
      createdBy: req.user.id,
      tags: ["book-cover", genre],
    });

    res.json({
      success: true,
      imageUrl: result.stored?.publicUrl,
      dataUrl: result.dataUrl,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});
```

### React Component

```tsx
import React, { useState } from "react";

const CoverGenerator: React.FC = () => {
  const [imageUrl, setImageUrl] = useState<string>("");
  const [loading, setLoading] = useState(false);

  const generateCover = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/generate-cover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "My Book Title",
          summary: "An amazing story about...",
          genre: "Fiction",
        }),
      });

      const data = await response.json();
      if (data.success) {
        setImageUrl(data.imageUrl);
      }
    } catch (error) {
      console.error("Failed to generate cover:", error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <button onClick={generateCover} disabled={loading}>
        {loading ? "Generating..." : "Generate Cover"}
      </button>

      {imageUrl && <img src={imageUrl} alt="Generated Cover" />}
    </div>
  );
};
```

### Next.js API Route

```typescript
// pages/api/generate-image.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { AIImageService, ConfigBuilder } from "@bookko/ai-image-gen";

const service = new AIImageService(ConfigBuilder.fromEnv());

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  try {
    const { prompt, options } = req.body;

    const result = await service.generateImage(prompt, {
      ...options,
      storeImage: true,
    });

    res.status(200).json({
      success: true,
      imageUrl: result.stored?.publicUrl,
      metadata: result.stored?.metadata,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}
```

## Storage Architecture

When storage is enabled, the module creates this structure:

```
Physical Storage: /storage/images/[uuid].svg (private)
       ↓ symlink/copy
Public Serving:  /public/uploads/[uuid].svg (served by web server)
       ↓
Public URL:      /uploads/[uuid].svg (accessible to users)
```

MongoDB stores comprehensive metadata:

- Image ID and file paths
- Generation prompt and parameters
- AI model used and settings
- User attribution and timestamps
- Usage analytics and tags

## Requirements

- Node.js 16+
- Google Gemini API key
- MongoDB (optional, for storage)
- TypeScript 4.5+ (for TypeScript projects)

## Migration from Existing Code

To migrate from your current implementation:

1. **Install the module**: `npm install @bookko/ai-image-gen`

2. **Replace existing imports**:

   ```typescript
   // Before
   import { ImageGenAiAgent } from "./agents/imageGenAiAgent";
   import { ImageStorageService } from "./agents/imageStorageService";

   // After
   import { AIImageService, ConfigBuilder } from "@bookko/ai-image-gen";
   ```

3. **Update configuration**:

   ```typescript
   // Before
   const agent = new ImageGenAiAgent();
   const storage = new ImageStorageService();

   // After
   const service = new AIImageService(ConfigBuilder.fromEnv());
   await service.initialize();
   ```

4. **Update generation calls**:

   ```typescript
   // Before
   const imageUrl = await agent.textToImage(prompt);

   // After
   const result = await service.generateImage(prompt, { storeImage: true });
   const imageUrl = result.stored?.publicUrl;
   ```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Ensure TypeScript compilation passes
5. Submit a pull request

## License

MIT

## Support

For issues and questions:

- GitHub Issues: [repository-url]/issues
- Documentation: [repository-url]/docs
- Examples: [repository-url]/examples
