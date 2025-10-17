const { AIImageService, ConfigBuilder } = require("../dist/index");

async function testAIImageGeneration() {
  console.log("🧪 Testing AI Image Generation Module...");

  try {
    // Create configuration
    const config = new ConfigBuilder()
      .withGeminiApi(process.env.GEMINI_API_KEY || "your-api-key-here")
      .build();

    // Initialize service
    const service = new AIImageService(config);
    await service.initialize();

    console.log("✅ Service initialized");

    // Test basic image generation
    console.log("📝 Generating basic image...");
    const result = await service.generateImage(
      "A magical library with floating books",
      {
        width: 800,
        height: 600,
        style: "artistic",
      },
    );

    console.log("✅ Image generated!");
    console.log(`📊 SVG size: ${result.svgContent.length} bytes`);
    console.log(`🔗 Data URL length: ${result.dataUrl.length} characters`);

    // Test book cover generation
    console.log("📚 Generating book cover...");
    const bookCover = await service.generateBookCover(
      "The Art of Programming",
      "A comprehensive guide to elegant code and software craftsmanship",
      "Technology",
    );

    console.log("✅ Book cover generated!");
    console.log(`📊 Book cover SVG size: ${bookCover.svgContent.length} bytes`);

    await service.cleanup();
    console.log("🎉 All tests passed!");
  } catch (error) {
    console.error("❌ Test failed:", error);
    process.exit(1);
  }
}

// Run test if this file is executed directly
if (require.main === module) {
  testAIImageGeneration();
}

module.exports = { testAIImageGeneration };
