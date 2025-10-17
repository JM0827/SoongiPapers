import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import mammoth from "mammoth";
import epub2 from "epub2";
import WordExtractor from "word-extractor";

type PdfParseResult = {
  text: string;
};

type PdfParseFn = (buffer: Buffer) => Promise<PdfParseResult>;

let pdfParseFn: PdfParseFn | null = null;

import { loadConfig } from "../config";
import { upsertDraftContent } from "../repositories/draftContentRepository";

const SUPPORTED_EXTENSIONS = [".txt", ".doc", ".docx", ".pdf", ".epub", ".hwp"];

export type DraftSourceInput = {
  userId: string;
  pastedText?: string;
  file?: {
    buffer: Buffer;
    name: string;
    mimeType: string;
    size: number;
  } | null;
};

export type DraftIngestResult = {
  text: string;
  characterCount: number;
  wordCount: number;
};

export async function ingestDraftSource(
  input: DraftSourceInput,
): Promise<DraftIngestResult> {
  const { userId, pastedText, file } = input;

  if (!pastedText && !file) {
    throw new Error("Missing content: provide text or a file");
  }

  if (file && file.size > 10 * 1024 * 1024) {
    throw new Error("File exceeds 10MB limit");
  }

  let extractedText = pastedText?.trim() ?? "";

  if (!extractedText && file) {
    extractedText = (await extractTextFromFile(file)).trim();
  }

  if (!extractedText) {
    throw new Error("No textual content was found in the source");
  }

  await upsertDraftContent({
    userId,
    text: extractedText,
    rawFile: file
      ? {
          buffer: file.buffer,
          name: file.name,
          type: file.mimeType,
        }
      : null,
  });

  const characterCount = extractedText.length;
  const wordCount = extractedText.split(/\s+/).filter(Boolean).length;

  return { text: extractedText, characterCount, wordCount };
}

async function extractTextFromFile(
  file: NonNullable<DraftSourceInput["file"]>,
): Promise<string> {
  const ext = path.extname(file.name).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    throw new Error(`Unsupported file type: ${ext || file.mimeType}`);
  }

  switch (ext) {
    case ".txt":
      return file.buffer.toString("utf8");
    case ".docx":
      return extractDocx(file.buffer);
    case ".doc":
      return extractDoc(file.buffer);
    case ".pdf":
      return extractPdf(file.buffer);
    case ".epub":
      return extractEpub(file.buffer);
    case ".hwp":
      return extractHwp(file.buffer);
    default:
      throw new Error(`Unsupported file extension: ${ext}`);
  }
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
    const module = await import("pdf-parse/lib/pdf-parse.js");
    const candidate: unknown = (module as any)?.default ?? module;
    if (typeof candidate !== "function") {
      throw new Error("Failed to load pdf-parse module");
    }
    pdfParseFn = candidate as PdfParseFn;
  }

  const result = await pdfParseFn(buffer);
  return result.text;
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

async function extractHwp(buffer: Buffer): Promise<string> {
  const { PYTHON_BIN } = loadConfig();
  const tempPath = await writeTempFile(buffer, ".hwp");
  const scriptPath = path.resolve(__dirname, "hwp_extractor.py");

  try {
    if (process.env.NODE_ENV !== "production") {
      console.info("[extractHwp] python", {
        pythonBin: PYTHON_BIN,
        cwd: process.cwd(),
      });
    }
    const text = await runPythonExtractor(PYTHON_BIN, scriptPath, tempPath);
    return text;
  } finally {
    await safeCleanup(tempPath);
  }
}

async function writeTempFile(
  buffer: Buffer,
  extension: string,
): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bookko-"));
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

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      const output = (stderr || stdout || "").trim();
      const normalized = output.toLowerCase();

      if (normalized.includes("hwp_extract module is not installed")) {
        reject(
          new Error(
            `${"HWP extraction requires the optional 'hwp-extract' Python package. Install it with `pip install hwp-extract` or upload a PDF/Docx file instead."}\n\n${output}`,
          ),
        );
        return;
      }

      reject(new Error(output || `Python extractor exited with code ${code}`));
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(
          new Error(
            `Python executable "${pythonBin}" was not found. Install Python or set PYTHON_BIN to a valid path to enable .hwp extraction.`,
          ),
        );
        return;
      }
      reject(error);
    });
  });
}
