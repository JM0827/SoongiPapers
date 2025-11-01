import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../services/api";
import { useAuthStore } from "../../store/auth.store";
import { useProjectStore } from "../../store/project.store";
import type {
  CoverInfo,
  EbookDetails,
  EbookResponse,
  ProjectContent,
  ProjectTranslationOption,
} from "../../types/domain";
import { projectKeys } from "../../hooks/useProjectData";
import { useUILocale } from "../../hooks/useUILocale";
import { translate } from "../../lib/locale";
import { trackEvent } from "../../lib/telemetry";
import { evaluateReadiness } from "../../lib/ebook/readiness";
import {
  type BuildState,
  type EssentialsSnapshot,
  type GenerationFormat,
  type GenerationProgressChip,
  type MetadataDraft,
  type TranslationSummary,
  getGenerateQueue,
} from "./ebookTypes";
import { ExportEssentialsCard } from "./ExportEssentialsCard";
import { PromotionPanel } from "./PromotionPanel";

const fallbackCover =
  "https://dummyimage.com/320x480/ede9fe/4338ca.png&text=Project-T1";

interface ExportPanelProps {
  content?: ProjectContent | null;
}

const formatDateTime = (value?: string | null) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

export const ExportPanel = ({ content }: ExportPanelProps) => {
  const token = useAuthStore((state) => state.token);
  const projectId = useProjectStore((state) => state.activeProjectId);
  const projects = useProjectStore((state) => state.projects);
  const currentProject = useMemo(
    () => projects.find((project) => project.project_id === projectId) ?? null,
    [projects, projectId],
  );
  const queryClient = useQueryClient();
  const { locale } = useUILocale();
  const t = useCallback(
    (key: string, params?: Record<string, string | number>) =>
      translate(key, locale, params),
    [locale],
  );

  const [formats, setFormats] = useState<{ pdf: boolean; epub: boolean }>(
    () => ({ pdf: true, epub: false }),
  );
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EbookResponse | null>(null);
  const [coverInfo, setCoverInfo] = useState<CoverInfo | null>(null);
  const [coverLoading, setCoverLoading] = useState(false);
  const [coverError, setCoverError] = useState<string | null>(null);
  const [isRegeneratingCover, setIsRegeneratingCover] = useState(false);
  const [coverPreviewUrl, setCoverPreviewUrl] = useState<string | null>(null);
  const [coverPreviewLoading, setCoverPreviewLoading] = useState(false);
  const [coverSetIndex, setCoverSetIndex] = useState(0);
  const [ebookDetails, setEbookDetails] = useState<EbookDetails | null>(null);
  const [ebookLoading, setEbookLoading] = useState(false);
  const [ebookError, setEbookError] = useState<string | null>(null);
  const [translationOptions, setTranslationOptions] = useState<
    ProjectTranslationOption[]
  >([]);
  const [translationsLoading, setTranslationsLoading] = useState(false);
  const [translationsError, setTranslationsError] = useState<string | null>(
    null,
  );
  const [selectedTranslationId, setSelectedTranslationId] = useState<
    string | null
  >(null);
  const [downloadLoading, setDownloadLoading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [rightsAccepted, setRightsAccepted] = useState(false);
  const [metadataDraft, setMetadataDraft] = useState<MetadataDraft>({
    title: "",
    writer: "",
    translator: "",
    writerNote: null,
    translatorNote: null,
    language: null,
    identifier: null,
    modifiedISO: null,
  });
  const [generationProgress, setGenerationProgress] = useState<
    GenerationProgressChip[]
  >([]);
  const [uploadedCoverUrl, setUploadedCoverUrl] = useState<string | null>(null);
  const uploadedCoverObjectUrlRef = useRef<string | null>(null);
  const [isTranslationDialogOpen, setIsTranslationDialogOpen] = useState(false);

  const selectedTranslation = useMemo(() => {
    return (
      translationOptions.find(
        (option) => option.translationFileId === selectedTranslationId,
      ) ?? null
    );
  }, [translationOptions, selectedTranslationId]);

  const fetchCoverInfo = useCallback(async () => {
    if (!token || !projectId) {
      setCoverInfo(null);
      setCoverLoading(false);
      if (!uploadedCoverUrl) setCoverPreviewUrl(null);
      return;
    }
    try {
      setCoverLoading(true);
      setCoverError(null);
      const data = await api.fetchCover(token, projectId);
      setCoverInfo(data);
    } catch (err) {
      setCoverInfo(null);
      setCoverError(
        err instanceof Error ? err.message : t("export.cover.error.fetch"),
      );
    } finally {
      setCoverLoading(false);
    }
  }, [projectId, t, token, uploadedCoverUrl]);

  const fetchEbookDetailsInfo = useCallback(async () => {
    if (!token || !projectId) {
      setEbookDetails(null);
      setEbookLoading(false);
      return;
    }
    try {
      setEbookLoading(true);
      setEbookError(null);
      const data = await api.fetchEbookDetails(token, projectId);
      setEbookDetails(data);
    } catch (err) {
      setEbookDetails(null);
      setEbookError(
        err instanceof Error ? err.message : t("export.summary.error.fetch"),
      );
    } finally {
      setEbookLoading(false);
    }
  }, [projectId, t, token]);

  const loadTranslationOptions = useCallback(
    async (preferredId?: string | null) => {
      if (!token || !projectId) return;
      try {
        setTranslationsLoading(true);
        setTranslationsError(null);
        const data = await api.fetchProjectTranslations(token, projectId);
        const sorted = [...data].sort((a, b) => {
          const dateA = new Date(
            a.completedAt ?? a.updatedAt ?? a.createdAt ?? 0,
          ).getTime();
          const dateB = new Date(
            b.completedAt ?? b.updatedAt ?? b.createdAt ?? 0,
          ).getTime();
          return dateB - dateA;
        });
        setTranslationOptions(sorted);

        const preferred =
          preferredId &&
          sorted.find((item) => item.translationFileId === preferredId)
            ? preferredId
            : null;

        if (preferred) {
          setSelectedTranslationId(preferred);
        } else if (!selectedTranslationId && sorted.length) {
          setSelectedTranslationId(sorted[0].translationFileId);
        }
      } catch (err) {
        setTranslationsError(
          err instanceof Error
            ? err.message
            : t("export.translation.dialog.error"),
        );
      } finally {
        setTranslationsLoading(false);
      }
    },
    [projectId, selectedTranslationId, t, token],
  );

  const projectTitle =
    currentProject?.title ||
    content?.projectProfile?.title ||
    "Untitled Manuscript";
  const profileMeta =
    (content?.projectProfile?.meta as Record<string, unknown> | undefined) ??
    undefined;
  const targetLangMeta =
    typeof profileMeta?.targetLang === "string"
      ? (profileMeta.targetLang as string)
      : undefined;
  const targetLang = currentProject?.target_lang || targetLangMeta || "";
  const projectMeta =
    (currentProject as unknown as { meta?: Record<string, unknown> })?.meta ??
    {};
  const authorName = (ebookDetails?.ebook?.author ??
    projectMeta.author ??
    profileMeta?.author ??
    null) as string | null;
  const translatorName = (ebookDetails?.ebook?.translator ??
    projectMeta.translator ??
    profileMeta?.translator ??
    null) as string | null;
  const targetLangTitle =
    (profileMeta?.bookTitleEn as string | undefined) ??
    (projectMeta.bookTitleEn as string | undefined) ??
    undefined;

  useEffect(() => {
    void fetchCoverInfo();
  }, [fetchCoverInfo]);

  useEffect(() => {
    void fetchEbookDetailsInfo();
  }, [fetchEbookDetailsInfo]);

  useEffect(() => {
    if (!token || !projectId) {
      setTranslationOptions([]);
      setSelectedTranslationId(null);
      return;
    }
    void loadTranslationOptions(
      result?.recommendation?.translationFileId ?? null,
    );
  }, [
    loadTranslationOptions,
    projectId,
    result?.recommendation?.translationFileId,
    token,
  ]);

  useEffect(() => {
    const sets = coverInfo?.coverSets ?? [];
    if (!sets.length) {
      setCoverSetIndex(0);
      if (!uploadedCoverUrl) setCoverPreviewUrl(coverInfo?.fallbackUrl ?? null);
      setCoverError(null);
      return;
    }

    const currentIndex = sets.findIndex((set) => set.isCurrent);
    const indexToUse = currentIndex >= 0 ? currentIndex : 0;
    setCoverSetIndex(indexToUse);
    if (!uploadedCoverUrl) setCoverPreviewUrl(null);
    setCoverError(null);
  }, [coverInfo?.coverSets, coverInfo?.fallbackUrl, uploadedCoverUrl]);

  useEffect(() => {
    if (uploadedCoverUrl) {
      setCoverPreviewLoading(false);
      return;
    }

    const sets = coverInfo?.coverSets ?? [];
    const currentSet = sets[coverSetIndex] ?? null;
    const assets = currentSet?.assets ?? [];

    if (!token || !projectId || !assets.length) {
      setCoverPreviewUrl(coverInfo?.fallbackUrl ?? null);
      setCoverPreviewLoading(false);
      return;
    }

    let cancelled = false;
    const objectUrls: string[] = [];

    const loadImages = async () => {
      try {
        setCoverPreviewLoading(true);
        const downloads = await Promise.all(
          assets.map(async (asset) => {
            try {
              const blob = await api.fetchCoverImage(
                token,
                projectId,
                asset.assetId,
              );
              if (cancelled) return null;
              const url = URL.createObjectURL(blob);
              objectUrls.push(url);
              return { assetId: asset.assetId, url };
            } catch (error) {
              if (!cancelled) {
                console.warn("[cover] failed to load asset", error);
              }
              return null;
            }
          }),
        );

        if (cancelled) return;

        const wrapAsset = assets.find((asset) => asset.role === "wrap");
        const primaryAsset = wrapAsset ?? assets[0];
        const primaryUrl = primaryAsset
          ? downloads.find((entry) => entry?.assetId === primaryAsset.assetId)
              ?.url
          : undefined;
        setCoverPreviewUrl(primaryUrl ?? coverInfo?.fallbackUrl ?? null);
        setCoverError(null);
      } catch (error) {
        if (!cancelled) {
          setCoverPreviewUrl(coverInfo?.fallbackUrl ?? null);
          setCoverError(
            error instanceof Error
              ? error.message
              : t("export.cover.error.load"),
          );
        }
      } finally {
        if (!cancelled) {
          setCoverPreviewLoading(false);
        }
      }
    };

    void loadImages();

    return () => {
      cancelled = true;
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [
    coverInfo?.coverSets,
    coverInfo?.fallbackUrl,
    coverSetIndex,
    projectId,
    t,
    token,
    uploadedCoverUrl,
  ]);

  useEffect(() => {
    return () => {
      if (uploadedCoverObjectUrlRef.current) {
        URL.revokeObjectURL(uploadedCoverObjectUrlRef.current);
      }
    };
  }, []);

  const currentEbook = result?.ebook;
  const coverSets = coverInfo?.coverSets ?? [];
  const hasPendingCoverJob =
    coverSets.some(
      (set) => set.status === "queued" || set.status === "generating",
    ) ||
    isRegeneratingCover ||
    coverLoading;
  const coverImageSrc =
    uploadedCoverUrl ||
    coverPreviewUrl ||
    coverInfo?.fallbackUrl ||
    fallbackCover;
  const latestVersion = ebookDetails?.latestVersion ?? null;
  const latestAsset = latestVersion?.asset ?? null;
  const metadata = ebookDetails?.metadata ?? {
    writerNote: null,
    translatorNote: null,
    isbn: null,
  };

  useEffect(() => {
    setMetadataDraft((prev) => {
      let changed = false;
      const next: MetadataDraft = { ...prev };
      if (!prev.title) {
        const fallbackTitle = targetLangTitle ?? projectTitle;
        if (fallbackTitle) {
          next.title = fallbackTitle;
          changed = true;
        }
      }
      if (!prev.language && targetLang) {
        next.language = targetLang;
        changed = true;
      }
      if (!prev.writer && authorName) {
        next.writer = authorName;
        changed = true;
      }
      if (!prev.translator && translatorName) {
        next.translator = translatorName;
        changed = true;
      }
      if (prev.writerNote == null && metadata.writerNote != null) {
        next.writerNote = metadata.writerNote;
        changed = true;
      }
      if (prev.translatorNote == null && metadata.translatorNote != null) {
        next.translatorNote = metadata.translatorNote;
        changed = true;
      }
      if (!prev.identifier) {
        const identifier = ebookDetails?.ebook?.ebookId ?? projectId ?? null;
        if (identifier) {
          next.identifier = identifier;
          changed = true;
        }
      }
      if (!prev.modifiedISO) {
        const modified =
          ebookDetails?.ebook?.updatedAt ?? new Date().toISOString();
        next.modifiedISO = modified;
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [
    authorName,
    ebookDetails?.ebook?.ebookId,
    ebookDetails?.ebook?.updatedAt,
    metadata.translatorNote,
    metadata.writerNote,
    projectId,
    projectTitle,
    targetLang,
    targetLangTitle,
    translatorName,
  ]);

  const downloadUrl =
    latestAsset?.publicUrl ?? currentEbook?.storageRef ?? null;
  const downloadFilename =
    latestAsset?.fileName ?? currentEbook?.filename ?? "ebook";
  const downloadAssetId = latestAsset?.assetId ?? currentEbook?.assetId ?? null;
  const latestVersionLabel = latestVersion
    ? `v${latestVersion.versionNumber} · ${latestVersion.format.toUpperCase()}`
    : null;

  const translationSummary: TranslationSummary = useMemo(
    () => ({
      exists: Boolean(selectedTranslationId),
      id: selectedTranslationId ?? undefined,
      qaScore: selectedTranslation?.qualityScore ?? null,
      targetLang: targetLang || "",
    }),
    [selectedTranslation?.qualityScore, selectedTranslationId, targetLang],
  );

  const essentialsSnapshot: EssentialsSnapshot = useMemo(
    () => ({
      translation: translationSummary,
      meta: { ...metadataDraft },
      wantPDF: formats.pdf,
      wantEPUB: formats.epub,
      accepted: rightsAccepted,
    }),
    [
      formats.epub,
      formats.pdf,
      metadataDraft,
      rightsAccepted,
      translationSummary,
    ],
  );

  const readiness = useMemo(
    () =>
      evaluateReadiness({
        core: {
          title: metadataDraft.title,
          writer: metadataDraft.writer,
          translator: metadataDraft.translator,
          language: metadataDraft.language ?? targetLang ?? undefined,
          rightsAccepted,
          identifier: metadataDraft.identifier ?? undefined,
          modifiedISO: metadataDraft.modifiedISO ?? undefined,
        },
        translationExists: Boolean(selectedTranslationId),
        wantPDF: formats.pdf,
        wantEPUB: formats.epub,
        accepted: rightsAccepted,
      }),
    [
      formats.epub,
      formats.pdf,
      metadataDraft.identifier,
      metadataDraft.language,
      metadataDraft.modifiedISO,
      metadataDraft.title,
      metadataDraft.translator,
      metadataDraft.writer,
      rightsAccepted,
      selectedTranslationId,
      targetLang,
    ],
  );

  const generationQueue = useMemo(
    () => getGenerateQueue(formats.pdf, formats.epub),
    [formats.pdf, formats.epub],
  );

  const generationDisabled =
    isLoading ||
    !generationQueue.length ||
    (formats.pdf && !readiness.pdf.ok) ||
    (formats.epub && !readiness.epub.ok);

  const buildState: BuildState = isLoading
    ? "running"
    : error
      ? "error"
      : currentEbook
        ? "done"
        : "idle";

  const buildPercent = useMemo(() => {
    if (!generationProgress.length) return 0;
    const total = generationProgress.length;
    const completed = generationProgress.filter(
      (chip) => chip.status === "done",
    ).length;
    const errored = generationProgress.some((chip) => chip.status === "error");
    const running = generationProgress.some(
      (chip) => chip.status === "running",
    );
    if (errored) {
      return (completed / total) * 100;
    }
    if (running) {
      return ((completed + 0.5) / total) * 100;
    }
    return (completed / total) * 100;
  }, [generationProgress]);

  const runGenerateForFormat = useCallback(
    async (format: GenerationFormat) => {
      if (!token || !projectId) {
        throw new Error("missing_auth");
      }
      const response = await api.recommendOrCreateEbook(token, {
        projectId,
        format,
        translationFileId: selectedTranslationId ?? undefined,
      });
      setResult(response);
      await fetchEbookDetailsInfo();
      if (projectId) {
        queryClient.invalidateQueries({
          queryKey: projectKeys.content(projectId),
        });
        queryClient.invalidateQueries({
          queryKey: projectKeys.workflow(projectId),
        });
      }
      if (response.requiresConfirmation) {
        void loadTranslationOptions(
          response.recommendation?.translationFileId ?? null,
        );
      }
    },
    [
      fetchEbookDetailsInfo,
      loadTranslationOptions,
      projectId,
      queryClient,
      selectedTranslationId,
      token,
    ],
  );

  const handleGenerateSelected = useCallback(async () => {
    if (!token || !projectId) {
      setError(t("export.errors.auth"));
      return;
    }

    if (!generationQueue.length) {
      setError(t("export.errors.format"));
      return;
    }

    setError(null);
    setIsLoading(true);
    setGenerationProgress(
      generationQueue.map((format, index) => ({
        format,
        status: index === 0 ? "running" : "pending",
      })),
    );
    trackEvent("ebook_generate_clicked", {
      projectId,
      formats: generationQueue,
    });

    try {
      for (let index = 0; index < generationQueue.length; index += 1) {
        const format = generationQueue[index];
        try {
          await runGenerateForFormat(format);
          setGenerationProgress((chips) =>
            chips.map((chip, chipIndex) => {
              if (chip.format === format) {
                return { ...chip, status: "done" };
              }
              if (chip.status === "pending" && chipIndex === index + 1) {
                return { ...chip, status: "running" };
              }
              return chip;
            }),
          );
        } catch (err) {
          setGenerationProgress((chips) =>
            chips.map((chip) =>
              chip.format === format ? { ...chip, status: "error" } : chip,
            ),
          );
          throw err;
        }
      }
    } catch (err) {
      setResult(null);
      setError(
        err instanceof Error ? err.message : t("export.errors.generate"),
      );
    } finally {
      setIsLoading(false);
    }
  }, [generationQueue, projectId, runGenerateForFormat, t, token]);

  const handleRegenerateCover = async () => {
    if (!token || !projectId) {
      setCoverError(t("export.cover.error.auth"));
      return;
    }
    setIsRegeneratingCover(true);
    setCoverError(null);
    try {
      await api.regenerateCover(token, projectId);
      await fetchCoverInfo();
    } catch (err) {
      setCoverError(
        err instanceof Error ? err.message : t("export.cover.error.regenerate"),
      );
    } finally {
      setIsRegeneratingCover(false);
    }
  };

  const handleCoverUpload = useCallback(
    (file: File) => {
      if (uploadedCoverObjectUrlRef.current) {
        URL.revokeObjectURL(uploadedCoverObjectUrlRef.current);
      }
      const objectUrl = URL.createObjectURL(file);
      uploadedCoverObjectUrlRef.current = objectUrl;
      setUploadedCoverUrl(objectUrl);
      trackEvent("cover_upload_clicked", {
        projectId,
        size: file.size,
        type: file.type,
      });
    },
    [projectId],
  );

  const handleRemoveUploadedCover = useCallback(() => {
    if (uploadedCoverObjectUrlRef.current) {
      URL.revokeObjectURL(uploadedCoverObjectUrlRef.current);
      uploadedCoverObjectUrlRef.current = null;
    }
    setUploadedCoverUrl(null);
  }, []);

  const handleToggleFormat = useCallback(
    (format: GenerationFormat, value: boolean) => {
      setFormats((prev) => ({ ...prev, [format]: value }));
    },
    [],
  );

  const handleSnapshotChange = useCallback((draft: EssentialsSnapshot) => {
    setFormats({ pdf: draft.wantPDF, epub: draft.wantEPUB });
    setRightsAccepted(draft.accepted);
    setMetadataDraft((prev) => ({
      ...prev,
      ...draft.meta,
    }));
  }, []);

  const openTranslationPicker = useCallback(() => {
    setIsTranslationDialogOpen(true);
  }, []);

  const closeTranslationPicker = useCallback(() => {
    setIsTranslationDialogOpen(false);
  }, []);

  const handleDownload = useCallback(async () => {
    if (!token || !projectId) {
      setDownloadError(t("export.errors.auth"));
      return;
    }

    if (!downloadAssetId) {
      if (downloadUrl) {
        setDownloadError(null);
        if (typeof window !== "undefined") {
          window.open(downloadUrl, "_blank", "noopener,noreferrer");
        } else {
          setDownloadError(t("export.download.browserOnly"));
        }
        return;
      }
      setDownloadError(t("export.download.unavailable"));
      return;
    }

    let objectUrl: string | null = null;
    try {
      setDownloadLoading(true);
      setDownloadError(null);
      const blob = await api.downloadEbook(token, projectId, downloadAssetId);
      if (typeof document === "undefined") {
        setDownloadError(t("export.download.browserOnly"));
        return;
      }
      objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = downloadFilename || "ebook";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch (err) {
      setDownloadError(
        err instanceof Error ? err.message : t("export.download.error"),
      );
    } finally {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
      setDownloadLoading(false);
    }
  }, [downloadAssetId, downloadFilename, downloadUrl, projectId, t, token]);

  const downloadAvailable = downloadAssetId !== null || Boolean(downloadUrl);
  const downloadLabel = downloadLoading
    ? t("export.download.loading")
    : downloadFilename
      ? t("export.download.labelWithName", { name: downloadFilename })
      : t("export.download.label");

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-4">
      <ExportEssentialsCard
        t={t}
        snap={essentialsSnapshot}
        setSnap={handleSnapshotChange}
        readiness={readiness}
        buildState={buildState}
        buildPercent={buildPercent}
        progress={generationProgress}
        translation={translationSummary}
        onOpenTranslation={openTranslationPicker}
        onToggleFormat={handleToggleFormat}
        onGenerate={handleGenerateSelected}
        generationDisabled={generationDisabled}
        errorMessage={error}
        onDownload={downloadAvailable ? handleDownload : undefined}
        downloadDisabled={downloadLoading || !downloadAvailable}
        downloadLabel={downloadLabel}
        downloadLoading={downloadLoading}
        downloadError={downloadError}
      />

      <PromotionPanel
        t={t}
        coverProps={{
          coverUrl: coverImageSrc,
          isGenerating: coverPreviewLoading,
          isRegenerating: hasPendingCoverJob,
          onUpload: handleCoverUpload,
          onRemove: handleRemoveUploadedCover,
          onGenerate: handleRegenerateCover,
          onRegenerate: handleRegenerateCover,
        }}
      />

      {coverError && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-600">
          {coverError}
        </div>
      )}

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-700">
          {t("export.summary.title")}
        </h3>
        {ebookLoading ? (
          <p className="mt-2 text-xs text-slate-500">
            {t("export.summary.loading")}
          </p>
        ) : ebookDetails?.ebook ? (
          <dl className="mt-3 space-y-2 text-xs text-slate-600">
            <div className="flex justify-between">
              <dt>{t("export.summary.status")}</dt>
              <dd className="font-semibold text-slate-800">
                {ebookDetails.status}
              </dd>
            </div>
            {metadataDraft.writer && (
              <div className="flex justify-between">
                <dt>{t("export.summary.sourceAuthor")}</dt>
                <dd className="font-semibold text-slate-800">
                  {metadataDraft.writer}
                </dd>
              </div>
            )}
            {metadataDraft.translator && (
              <div className="flex justify-between">
                <dt>{t("export.summary.translator")}</dt>
                <dd className="font-semibold text-slate-800">
                  {metadataDraft.translator}
                </dd>
              </div>
            )}
            {latestVersionLabel && (
              <div className="flex justify-between">
                <dt>{t("export.summary.latest")}</dt>
                <dd className="font-semibold text-slate-800">
                  {latestVersionLabel}
                </dd>
              </div>
            )}
            {latestVersion && latestVersion.wordCount !== null && (
              <div className="flex justify-between">
                <dt>{t("export.summary.words")}</dt>
                <dd className="font-semibold text-slate-800">
                  {latestVersion.wordCount.toLocaleString()}
                </dd>
              </div>
            )}
            {metadataDraft.language && (
              <div className="flex justify-between">
                <dt>{t("export.summary.language")}</dt>
                <dd className="font-semibold text-slate-800">
                  {metadataDraft.language}
                </dd>
              </div>
            )}
          </dl>
        ) : (
          <p className="mt-2 text-xs text-slate-500">
            {t("export.summary.empty")}
          </p>
        )}
        {ebookError && (
          <p className="mt-2 text-xs text-rose-600">{ebookError}</p>
        )}
      </section>

      {isTranslationDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4 py-8">
          <div className="max-h-full w-full max-w-2xl overflow-hidden rounded-2xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
              <h3 className="text-sm font-semibold text-slate-800">
                {t("export.translation.dialog.title")}
              </h3>
              <button
                type="button"
                className="text-xs text-slate-500 hover:text-slate-700"
                onClick={closeTranslationPicker}
              >
                {t("export.translation.dialog.close")}
              </button>
            </div>
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2 text-xs text-slate-500">
              <span>{t("export.translation.dialog.subtitle")}</span>
              <button
                type="button"
                onClick={() => loadTranslationOptions(selectedTranslationId)}
                className="rounded-full border border-slate-200 px-3 py-1 text-[11px] text-slate-600 hover:border-indigo-300 hover:text-indigo-600"
              >
                {t("export.translation.dialog.refresh")}
              </button>
            </div>
            <div className="max-h-[60vh] overflow-auto px-4 py-3 space-y-2">
              {translationsLoading ? (
                <p className="text-xs text-slate-500">
                  {t("export.translation.dialog.loading")}
                </p>
              ) : translationOptions.length ? (
                translationOptions.map((option, index) => {
                  const isSelected =
                    selectedTranslationId === option.translationFileId;
                  const isRecommended =
                    result?.recommendation?.translationFileId ===
                    option.translationFileId;
                  const timestamp =
                    option.completedAt ?? option.updatedAt ?? option.createdAt;
                  return (
                    <label
                      key={option.translationFileId}
                      className={`flex cursor-pointer flex-col gap-1 rounded-xl border px-3 py-2 text-xs transition ${
                        isSelected
                          ? "border-indigo-500 bg-white shadow-sm"
                          : "border-slate-200 bg-white hover:border-indigo-300"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <input
                            type="radio"
                            name="translation-choice"
                            checked={isSelected}
                            onChange={() => {
                              setSelectedTranslationId(
                                option.translationFileId,
                              );
                              closeTranslationPicker();
                            }}
                          />
                          <span className="font-semibold text-slate-700">
                            {t("export.translation.dialog.option", {
                              index: index + 1,
                            })}
                          </span>
                        </div>
                        <span className="text-[11px] text-slate-500">
                          {formatDateTime(timestamp)}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                        <span>
                          {option.filename
                            ? option.filename
                            : `ID ${option.translationFileId.slice(0, 6)}…`}
                        </span>
                        {option.qualityScore !== null && (
                          <span className="rounded bg-indigo-50 px-2 py-0.5 text-indigo-600">
                            {t("export.translation.dialog.score", {
                              score: option.qualityScore.toFixed(1),
                            })}
                          </span>
                        )}
                        {isRecommended && (
                          <span className="rounded bg-emerald-100 px-2 py-0.5 text-emerald-700">
                            {t("export.translation.dialog.recommended")}
                          </span>
                        )}
                      </div>
                    </label>
                  );
                })
              ) : (
                <p className="text-xs text-slate-500">
                  {t("export.translation.dialog.empty")}
                </p>
              )}
              {translationsError && (
                <p className="text-xs text-rose-600">{translationsError}</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ExportPanel;
