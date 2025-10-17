import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import mammoth from "mammoth";
import epub2 from "epub2";
import WordExtractor from "word-extractor";
import cleanText from "../../utils/cleanText";

const SUPPORTED_EXTENSIONS = [
  ".txt",
  ".doc",
  ".docx",
  ".pdf",
  ".epub",
  ".hwp",
  ".hwpx",
];

const FILE_SIZE_LIMIT = 10 * 1024 * 1024; // 10MB

const DEFAULT_PYTHON_BIN =
  process.env.PYTHON_BIN ||
  (process.platform === "win32" ? "python" : "python3");
const PYTHON_SCRIPT_PATH = path.join(__dirname, "hwp_extractor.py");

type PdfParseResult = {
  text: string;
};

type PdfParseFn = (buffer: Buffer) => Promise<PdfParseResult>;

let pdfParseFn: PdfParseFn | null = null;

export interface OriginExtractionInput {
  buffer: Buffer;
  filename: string;
  mimeType?: string | null;
}

export interface OriginExtractionResult {
  text: string;
  metadata: {
    originalName: string;
    mimeType: string | null;
    extension: string;
    fileSize: number;
    extractor: string;
    characterCount: number;
    wordCount: number;
  };
  binary: Buffer;
}

export class UnsupportedOriginFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedOriginFileError";
  }
}

export class OriginFileTooLargeError extends Error {
  constructor(limitBytes: number) {
    super(
      `File exceeds maximum allowed size of ${Math.round(limitBytes / (1024 * 1024))}MB.`,
    );
    this.name = "OriginFileTooLargeError";
  }
}

export async function extractOriginFromUpload(
  input: OriginExtractionInput,
): Promise<OriginExtractionResult> {
  const { buffer, filename } = input;
  const extension = path.extname(filename || "").toLowerCase();

  if (!buffer || buffer.length === 0) {
    throw new Error("Uploaded file is empty");
  }

  if (buffer.length > FILE_SIZE_LIMIT) {
    throw new OriginFileTooLargeError(FILE_SIZE_LIMIT);
  }

  if (!SUPPORTED_EXTENSIONS.includes(extension)) {
    throw new UnsupportedOriginFileError(
      `Unsupported file type: ${extension || "unknown"}`,
    );
  }

  let extractor = "";
  let text = "";

  switch (extension) {
    case ".txt":
      extractor = "plain";
      text = buffer.toString("utf8");
      break;
    case ".docx":
      extractor = "mammoth";
      text = await extractDocx(buffer);
      break;
    case ".doc":
      extractor = "word-extractor";
      text = await extractDoc(buffer);
      break;
    case ".pdf":
      extractor = "pdf-parse";
      text = await extractPdf(buffer);
      break;
    case ".epub":
      extractor = "epub2";
      text = await extractEpub(buffer);
      break;
    case ".hwp":
    case ".hwpx":
      extractor = "hwp-extractor";
      text = await extractHwp(buffer, extension);
      break;
    default:
      throw new UnsupportedOriginFileError(
        `Unsupported file type: ${extension || "unknown"}`,
      );
  }

  const cleaned = cleanText(text, {
    source:
      extension === ".pdf" ? "pdf" : extension === ".txt" ? "txt" : "auto",
  });

  const normalized = normalizeExtractedText(cleaned);
  if (!normalized) {
    throw new Error("No textual content was extracted from the file");
  }

  const characterCount = normalized.length;
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;

  return {
    text: normalized,
    metadata: {
      originalName: filename,
      mimeType: input.mimeType ?? null,
      extension,
      fileSize: buffer.length,
      extractor,
      characterCount,
      wordCount,
    },
    binary: buffer,
  };
}

function normalizeExtractedText(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function extractDocx(buffer: Buffer): Promise<string> {
  const { value } = await mammoth.extractRawText({ buffer });
  return value;
}

async function extractDoc(buffer: Buffer): Promise<string> {
  const extractor = new WordExtractor();
  const tempPath = await writeTempFile(buffer, ".doc");
  try {
    const document = await extractor.extract(tempPath);
    return document.getBody();
  } finally {
    await safeCleanup(tempPath);
  }
}

async function extractPdf(buffer: Buffer): Promise<string> {
  if (!pdfParseFn) {
    const module = await import("pdf-parse");
    const candidate: unknown = (module as any)?.default ?? module;
    if (typeof candidate !== "function") {
      throw new Error("Failed to load pdf-parse module");
    }
    pdfParseFn = candidate as PdfParseFn;
  }

  const result = await pdfParseFn(buffer);
  return result.text ?? "";
}

async function extractEpub(buffer: Buffer): Promise<string> {
  const EPubCtor = (epub2 as any)?.default ?? (epub2 as any)?.EPub ?? epub2;
  if (typeof EPubCtor !== "function") {
    throw new Error("epub2 module did not provide an EPub constructor");
  }

  const tempPath = await writeTempFile(buffer, ".epub");

  try {
    const epub = new EPubCtor(tempPath);

    await new Promise<void>((resolve, reject) => {
      epub.on("end", () => resolve());
      epub.on("error", (error: unknown) => reject(error));
      epub.parse();
    });

    const flow: Array<{ id?: string; href?: string }> = Array.isArray(epub.flow)
      ? epub.flow
      : [];
    const chapters: string[] = [];

    for (const item of flow) {
      const chapterId = item?.id ?? item?.href;
      if (!chapterId) continue;

      const text: string = await new Promise((resolve, reject) => {
        epub.getChapter(chapterId, (error: unknown, result: string) => {
          if (error) reject(error);
          else resolve(result ?? "");
        });
      });

      const normalized = text
        .replace(/<br\s*\/?>(\s*)/gi, "\n")
        .replace(/<p[^>]*>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/\s+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

      if (normalized) {
        chapters.push(normalized);
      }
    }

    if (chapters.length === 0) {
      throw new Error("No textual content found in EPUB");
    }

    return chapters.join("\n\n");
  } finally {
    await safeCleanup(tempPath);
  }
}

async function extractHwp(buffer: Buffer, extension: string): Promise<string> {
  const tempPath = await writeTempFile(
    buffer,
    extension === ".hwpx" ? ".hwpx" : ".hwp",
  );
  try {
    const pythonBin = DEFAULT_PYTHON_BIN;
    const text = await runPythonExtractor(
      pythonBin,
      PYTHON_SCRIPT_PATH,
      tempPath,
    );
    return text;
  } finally {
    await safeCleanup(tempPath);
  }
}

async function writeTempFile(
  buffer: Buffer,
  extension: string,
): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "project-t1-"));
  const tempPath = path.join(tempDir, `upload${extension}`);
  await fs.writeFile(tempPath, buffer);
  return tempPath;
}

async function safeCleanup(filePath: string): Promise<void> {
  try {
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

const PYTHON_TIMEOUT_MS = Number(process.env.HWP_EXTRACT_TIMEOUT_MS || 30_000);

function runPythonExtractor(
  pythonBin: string,
  scriptPath: string,
  filePath: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, [scriptPath, filePath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        new Error(
          "HWP extractor timed out. Please try again with a smaller file or convert to PDF/Docx.",
        ),
      );
    }, PYTHON_TIMEOUT_MS);

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      const output = (stderr || stdout || "").trim();
      const normalized = output.toLowerCase();

      if (normalized.includes("hwp_extract module is not installed")) {
        reject(
          new Error(
            "HWP extraction requires the optional 'hwp-extract' Python package. Install it with `pip install hwp-extract` or upload a supported alternative format.\n\n" +
              output,
          ),
        );
        return;
      }

      reject(new Error(output || `Python extractor exited with code ${code}`));
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error.code === "ENOENT") {
        reject(
          new Error(
            `Python executable \"${pythonBin}\" was not found. Install Python or set PYTHON_BIN to a valid path to enable .hwp extraction.`,
          ),
        );
        return;
      }
      reject(error);
    });
  });
}

export const OriginExtraction = {
  SUPPORTED_EXTENSIONS,
  FILE_SIZE_LIMIT,
  extractOriginFromUpload,
  UnsupportedOriginFileError,
  OriginFileTooLargeError,
};

export default OriginExtraction;
