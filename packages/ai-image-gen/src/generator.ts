import { GoogleGenerativeAI } from "@google/generative-ai";

export interface ImageGenerationOptions {
  width?: number;
  height?: number;
  style?: "realistic" | "artistic" | "book-cover" | "minimalist";
  quality?: "standard" | "high";
}

export interface ImageToImageOptions extends ImageGenerationOptions {
  strength?: number; // 0-1, how much to change the original image
  preserveComposition?: boolean;
}

export interface AIImageConfig {
  geminiApiKey: string;
  model?: string;
}

export type GenerationMode = "text-to-image" | "image-to-image";

/**
 * AI Image Generator using Google Gemini 2.5 Flash
 * Generates SVG images from text prompts
 */
export class AIImageGenerator {
  private genAI: GoogleGenerativeAI;
  private model: any;
  private config: AIImageConfig;

  constructor(config: AIImageConfig) {
    if (!config.geminiApiKey) {
      throw new Error("GEMINI_API_KEY is required for AI image generation");
    }

    this.config = config;
    this.genAI = new GoogleGenerativeAI(config.geminiApiKey);
    this.model = this.genAI.getGenerativeModel({
      model: config.model || "gemini-2.5-flash",
    });
  }

  /**
   * Generate SVG image from text prompt
   */
  async textToImage(
    prompt: string,
    options: ImageGenerationOptions = {},
  ): Promise<string> {
    const {
      width = 900,
      height = 600,
      style = "book-cover",
      quality = "standard",
    } = options;

    console.log(`🎨 AI Generator: Creating image for prompt: "${prompt}"`);
    console.log(
      `📐 Dimensions: ${width}x${height}, Style: ${style}, Quality: ${quality}`,
    );

    try {
      // Request SVG generation from Gemini
      const imageRequest = `Create a simple SVG image based on this description: "${prompt}". 
Make it ${width}x${height} pixels, style: ${style}. 
Generate actual SVG code that I can use directly. 
Keep the file size small (under 3KB). 
Make it visually appealing and professional.
Start your response with '<svg' and end with '</svg>'.`;

      console.log(`📝 Requesting SVG from Gemini...`);
      const result = await this.model.generateContent(imageRequest);
      const response = result.response;
      const text = response.text();

      console.log(`📄 Gemini response length: ${text.length} characters`);

      // Extract SVG content
      if (text.includes("<svg") && text.includes("</svg>")) {
        console.log(`✅ Got SVG from Gemini!`);

        const svgMatch = text.match(/<svg[\s\S]*?<\/svg>/i);
        if (svgMatch) {
          const svgContent = svgMatch[0];
          console.log(`🎨 SVG size: ${svgContent.length} bytes`);

          // Return the raw SVG content
          return svgContent;
        }
      }

      throw new Error("No valid SVG content generated");
    } catch (error) {
      console.error("AI image generation failed:", error);
      throw new Error(`Failed to generate image: ${error}`);
    }
  }

  /**
   * Transform existing image with AI (placeholder for future implementation)
   */
  async imageToImage(
    sourceImageUrl: string,
    prompt: string,
    options: ImageToImageOptions = {},
  ): Promise<string> {
    console.log(
      `🖼️ Transforming image: ${sourceImageUrl} with prompt: "${prompt}"`,
    );

    // For now, just generate a new image based on the prompt
    return this.textToImage(prompt, options);
  }

  /**
   * Generate data URL from SVG content
   */
  svgToDataUrl(svgContent: string): string {
    return `data:image/svg+xml;base64,${Buffer.from(svgContent).toString("base64")}`;
  }

  /**
   * Generate optimized prompt for book covers
   */
  createBookCoverPrompt(
    title: string,
    summary: string,
    genre?: string,
  ): string {
    const genreContext = genre ? `Genre: ${genre}. ` : "";

    return `Create a professional book cover design for "${title}". 
${genreContext}Summary: ${summary}
Style: Modern, eye-catching, suitable for digital publishing.
Include visual elements that represent the content theme.
Use professional typography layout and attractive color scheme.`;
  }

  /**
   * Generate optimized prompt for article illustrations
   */
  createArticleIllustrationPrompt(title: string, content: string): string {
    const contentSummary =
      content.length > 300 ? content.substring(0, 300) + "..." : content;

    return `Create an illustration for the article "${title}".
Content summary: ${contentSummary}
Style: Clean, modern, informative illustration.
Make it suitable as a header image or thumbnail.`;
  }

  /**
   * Validate SVG content
   */
  private isValidSVG(content: string): boolean {
    return (
      content.includes("<svg") &&
      content.includes("</svg>") &&
      content.includes('xmlns="http://www.w3.org/2000/svg"')
    );
  }
}
