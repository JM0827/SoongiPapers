import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../services/api";
import { useAuthStore } from "../../store/auth.store";
import { useProjectStore } from "../../store/project.store";
import type {
  EbookResponse,
  ProjectContent,
  CoverInfo,
  EbookDetails,
  CoverStatus,
  CoverAssetRole,
  ProjectTranslationOption,
} from "../../types/domain";

interface ExportPanelProps {
  content?: ProjectContent | null;
}

type EbookFormat = "pdf" | "epub";

const formatLabels: Record<EbookFormat, string> = {
  pdf: "PDF (print friendly)",
  epub: "EPUB (ebook readers)",
};

const formatOptions: EbookFormat[] = ["pdf", "epub"];

const fallbackCover =
  "https://dummyimage.com/320x480/ede9fe/4338ca.png&text=Project-T1";

const coverStatusLabel: Record<CoverStatus, string> = {
  queued: "대기 중",
  generating: "생성 중",
  ready: "완료",
  failed: "실패",
};

const assetOrder: CoverAssetRole[] = ["wrap", "front", "spine", "back"];

const coverAssetLabels: Record<CoverAssetRole, string> = {
  front: "앞표지",
  back: "뒷표지",
  spine: "책등",
  wrap: "전체",
};

const formatDateTime = (value?: string | null) => {
  if (!value) return "기록 없음";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "기록 없음";
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

  const [format, setFormat] = useState<EbookFormat>("pdf");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EbookResponse | null>(null);
  const [coverInfo, setCoverInfo] = useState<CoverInfo | null>(null);
  const [coverLoading, setCoverLoading] = useState(false);
  const [coverError, setCoverError] = useState<string | null>(null);
  const [isRegeneratingCover, setIsRegeneratingCover] = useState(false);
  const [coverPreviewUrl, setCoverPreviewUrl] = useState<string | null>(null);
  const [coverPreviewLoading, setCoverPreviewLoading] = useState(false);
  const [coverAssetUrls, setCoverAssetUrls] = useState<Record<string, string>>(
    {},
  );
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

  const fetchCoverInfo = useCallback(async () => {
    if (!token || !projectId) {
      setCoverInfo(null);
      setCoverLoading(false);
      setCoverPreviewUrl(null);
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
        err instanceof Error ? err.message : "표지 정보를 불러오지 못했습니다.",
      );
    } finally {
      setCoverLoading(false);
    }
  }, [token, projectId]);

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
        err instanceof Error
          ? err.message
          : "전자책 정보를 불러오지 못했습니다.",
      );
    } finally {
      setEbookLoading(false);
    }
  }, [token, projectId]);

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
            : "번역본 목록을 불러오지 못했습니다.",
        );
      } finally {
        setTranslationsLoading(false);
      }
    },
    [projectId, selectedTranslationId, token],
  );

  const projectTitle =
    currentProject?.title ||
    content?.projectProfile?.title ||
    "Untitled Manuscript";
  const profileMeta =
    (content?.projectProfile?.meta as Record<string, unknown> | undefined) ??
    undefined;
  const originLangMeta =
    typeof profileMeta?.originLang === "string"
      ? (profileMeta.originLang as string)
      : undefined;
  const targetLangMeta =
    typeof profileMeta?.targetLang === "string"
      ? (profileMeta.targetLang as string)
      : undefined;
  const originLang = currentProject?.origin_lang || originLangMeta || "Unknown";
  const targetLang = currentProject?.target_lang || targetLangMeta || "Unknown";
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
  const awardTitle = (projectMeta.awardTitle ??
    profileMeta?.awardTitle ??
    null) as string | null;

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
    token,
    projectId,
    loadTranslationOptions,
    result?.recommendation?.translationFileId,
  ]);

  useEffect(() => {
    const hasPending = (coverInfo?.coverSets ?? []).some(
      (set) => set.status === "queued" || set.status === "generating",
    );
    if (!hasPending) return;

    const interval = window.setInterval(() => {
      void fetchCoverInfo();
    }, 5000);

    return () => window.clearInterval(interval);
  }, [coverInfo?.coverSets, fetchCoverInfo]);

  useEffect(() => {
    const sets = coverInfo?.coverSets ?? [];
    if (!sets.length) {
      setCoverSetIndex(0);
      setCoverPreviewUrl(coverInfo?.fallbackUrl ?? null);
      setCoverError(null);
      return;
    }

    const currentIndex = sets.findIndex((set) => set.isCurrent);
    const indexToUse = currentIndex >= 0 ? currentIndex : 0;
    setCoverSetIndex(indexToUse);
    setCoverError(null);
  }, [coverInfo?.coverSets, coverInfo?.fallbackUrl]);

  useEffect(() => {
    if (!translationOptions.length) return;
    if (
      selectedTranslationId &&
      translationOptions.some(
        (opt) => opt.translationFileId === selectedTranslationId,
      )
    ) {
      return;
    }
    setSelectedTranslationId(translationOptions[0].translationFileId);
  }, [translationOptions, selectedTranslationId]);

  useEffect(() => {
    const currentSet = coverInfo?.coverSets?.[coverSetIndex] ?? null;
    const assets = currentSet?.assets ?? [];

    if (!token || !projectId || !assets.length) {
      setCoverAssetUrls({});
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

        const urlMap: Record<string, string> = {};
        downloads.forEach((entry) => {
          if (entry) {
            urlMap[entry.assetId] = entry.url;
          }
        });
        setCoverAssetUrls(urlMap);

        const wrapAsset = assets.find((asset) => asset.role === "wrap");
        const primaryAsset = wrapAsset ?? assets[0];
        const primaryUrl = primaryAsset
          ? urlMap[primaryAsset.assetId]
          : undefined;
        setCoverPreviewUrl(primaryUrl ?? coverInfo?.fallbackUrl ?? null);
        setCoverError(null);
      } catch (error) {
        if (!cancelled) {
          setCoverAssetUrls({});
          setCoverPreviewUrl(coverInfo?.fallbackUrl ?? null);
          setCoverError(
            error instanceof Error
              ? error.message
              : "표지 이미지를 불러오지 못했습니다.",
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
    token,
    projectId,
    coverInfo?.coverSets,
    coverInfo?.fallbackUrl,
    coverSetIndex,
  ]);

  const currentEbook = result?.ebook;
  const recommendation = result?.recommendation;
  const coverSets = coverInfo?.coverSets ?? [];
  const currentCoverSet = coverSets[coverSetIndex] ?? null;
  const secondaryAssets = currentCoverSet
    ? currentCoverSet.assets
        .filter((asset) => asset.role !== "wrap")
        .sort((a, b) => assetOrder.indexOf(a.role) - assetOrder.indexOf(b.role))
    : [];
  const coverStatusText = currentCoverSet
    ? coverStatusLabel[currentCoverSet.status]
    : coverSets.length
      ? coverStatusLabel[coverSets[0].status]
      : "미생성";
  const generatedLabel = currentCoverSet
    ? new Date(currentCoverSet.generatedAt).toLocaleString()
    : null;
  const currentFailureReason = currentCoverSet?.failureReason ?? null;
  const hasPendingCoverJob =
    coverSets.some(
      (set) => set.status === "queued" || set.status === "generating",
    ) ||
    isRegeneratingCover ||
    coverLoading;
  const coverImageSrc =
    coverPreviewUrl || coverInfo?.fallbackUrl || fallbackCover;
  const latestVersion = ebookDetails?.latestVersion ?? null;
  const latestAsset = latestVersion?.asset ?? null;
  const metadata = ebookDetails?.metadata ?? {
    writerNote: null,
    translatorNote: null,
    isbn: null,
  };
  const downloadUrl =
    latestAsset?.publicUrl ?? currentEbook?.storageRef ?? null;
  const downloadFilename =
    latestAsset?.fileName ?? currentEbook?.filename ?? "ebook";
  const downloadAssetId = latestAsset?.assetId ?? currentEbook?.assetId ?? null;

  const handleGenerate = async () => {
    if (!token || !projectId) {
      setError("로그인 상태를 다시 확인해 주세요.");
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.recommendOrCreateEbook(token, {
        projectId,
        format,
        translationFileId: selectedTranslationId ?? undefined,
      });
      setResult(response);
      await fetchEbookDetailsInfo();
      if (response.requiresConfirmation) {
        void loadTranslationOptions(
          response.recommendation?.translationFileId ?? null,
        );
      }
    } catch (err) {
      setResult(null);
      setError(
        err instanceof Error ? err.message : "전자책 생성에 실패했습니다.",
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleRegenerateCover = async () => {
    if (!token || !projectId) {
      setCoverError("로그인 상태를 다시 확인해 주세요.");
      return;
    }
    setIsRegeneratingCover(true);
    setCoverError(null);
    try {
      await api.regenerateCover(token, projectId);
      await fetchCoverInfo();
    } catch (err) {
      setCoverError(
        err instanceof Error ? err.message : "표지 재생성에 실패했습니다.",
      );
    } finally {
      setIsRegeneratingCover(false);
    }
  };

  const handleDownload = useCallback(async () => {
    if (!token || !projectId) {
      setDownloadError("로그인 상태를 다시 확인해 주세요.");
      return;
    }

    if (!downloadAssetId) {
      if (downloadUrl) {
        setDownloadError(null);
        if (typeof window !== "undefined") {
          window.open(downloadUrl, "_blank", "noopener,noreferrer");
        } else {
          setDownloadError("브라우저 환경에서만 다운로드할 수 있습니다.");
        }
        return;
      }
      setDownloadError("다운로드 가능한 전자책 파일이 없습니다.");
      return;
    }

    let objectUrl: string | null = null;
    try {
      setDownloadLoading(true);
      setDownloadError(null);
      const blob = await api.downloadEbook(token, projectId, downloadAssetId);
      if (typeof document === "undefined") {
        setDownloadError("브라우저 환경에서만 다운로드할 수 있습니다.");
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
        err instanceof Error ? err.message : "전자책 다운로드에 실패했습니다.",
      );
    } finally {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
      setDownloadLoading(false);
    }
  }, [downloadAssetId, downloadFilename, downloadUrl, projectId, token]);

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-700">Export eBook</h2>
          <p className="text-xs text-slate-500">
            번역본을 전자책으로 내보내고 메타데이터를 검토하세요.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span>Project</span>
          <span className="rounded border border-slate-200 bg-slate-50 px-2 py-1 text-slate-700">
            {projectTitle}
          </span>
        </div>
      </header>

      <section className="flex-1 space-y-4 overflow-auto">
        <div className="flex flex-col items-center gap-6 rounded border border-slate-200 bg-white p-6 shadow-sm">
          <div className="w-full">
            <h3 className="text-xs font-semibold uppercase text-slate-500">
              표지 미리보기
            </h3>
            <div className="mt-4 flex justify-center">
              <img
                src={coverImageSrc}
                alt="ebook cover preview"
                className="h-[320px] w-full max-w-4xl rounded border border-slate-200 bg-slate-100 object-contain shadow"
              />
            </div>
            <p className="mt-2 text-center text-[11px] font-medium text-slate-500">
              전체 (앞·책등·뒤 연속)
            </p>
            <div className="mt-2 text-center text-[11px] text-slate-500">
              {coverPreviewLoading
                ? "표지 이미지를 불러오는 중…"
                : coverStatusText}
              {generatedLabel && !coverPreviewLoading && (
                <span className="block text-[10px] text-slate-400">
                  {generatedLabel}
                </span>
              )}
            </div>
            {coverSets.length > 1 && (
              <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
                <button
                  type="button"
                  onClick={() => {
                    setCoverSetIndex((prev) => (prev > 0 ? prev - 1 : prev));
                  }}
                  disabled={coverSetIndex === 0}
                  className="rounded border border-slate-200 px-2 py-1 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  이전 커버
                </button>
                <span>
                  {coverSetIndex + 1} / {coverSets.length}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setCoverSetIndex((prev) =>
                      prev < coverSets.length - 1 ? prev + 1 : prev,
                    );
                  }}
                  disabled={coverSetIndex >= coverSets.length - 1}
                  className="rounded border border-slate-200 px-2 py-1 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  다음 커버
                </button>
              </div>
            )}
            {secondaryAssets.length > 0 && (
              <div className="mt-4 grid w-full gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {secondaryAssets.map((asset) => {
                  const url =
                    coverAssetUrls[asset.assetId] ??
                    coverInfo?.fallbackUrl ??
                    coverPreviewUrl ??
                    fallbackCover;
                  return (
                    <div
                      key={asset.assetId}
                      className="flex flex-col items-center gap-2"
                    >
                      <img
                        src={url}
                        alt={`${coverAssetLabels[asset.role]} preview`}
                        className="h-56 w-full max-w-xs rounded border border-slate-200 bg-slate-100 object-contain shadow"
                      />
                      <span className="text-[11px] font-medium text-slate-500">
                        {coverAssetLabels[asset.role]}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="mt-3 space-y-2 text-xs text-slate-600">
              <div className="flex items-center justify-between">
                <span>표지 상태</span>
                <span className="font-medium text-slate-700">
                  {coverStatusText}
                  {(coverLoading ||
                    isRegeneratingCover ||
                    coverPreviewLoading) &&
                    " · 업데이트 중…"}
                </span>
              </div>
              {currentCoverSet?.status === "queued" && (
                <p className="rounded border border-slate-200 bg-slate-100 p-2 text-slate-600">
                  새 표지 작업이 대기 중입니다. 잠시 후 자동으로 생성됩니다.
                </p>
              )}
              {currentCoverSet?.status === "failed" && (
                <p className="rounded border border-rose-200 bg-rose-50 p-2 text-rose-600">
                  자동 표지 생성에 실패했습니다. 다시 시도해 주세요.
                </p>
              )}
              {currentFailureReason && (
                <p className="rounded border border-rose-100 bg-rose-50 p-2 text-[11px] text-rose-500">
                  사유: {currentFailureReason}
                </p>
              )}
              {coverError && <p className="text-rose-600">{coverError}</p>}
              <button
                type="button"
                onClick={handleRegenerateCover}
                disabled={hasPendingCoverJob || !token || !projectId}
                className={`w-full rounded border px-3 py-1 font-semibold transition ${
                  hasPendingCoverJob
                    ? "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400"
                    : "border-indigo-200 bg-indigo-50 text-indigo-700 hover:border-indigo-300 hover:bg-indigo-100"
                }`}
              >
                {isRegeneratingCover || coverLoading
                  ? "표지 재생성 중…"
                  : "표지 재생성"}
              </button>
              {!coverSets.length && !hasPendingCoverJob && (
                <p className="text-xs text-slate-500">
                  표지를 아직 생성하지 않았습니다. ‘표지 재생성’을 눌러 새
                  표지를 만들어 보세요.
                </p>
              )}
            </div>
          </div>
          <div className="w-full text-xs text-slate-600">
            <h3 className="text-xs font-semibold uppercase text-slate-500">
              메타데이터
            </h3>
            <dl className="mt-2 space-y-1">
              <div className="flex justify-between">
                <dt className="text-slate-500">Origin language</dt>
                <dd className="font-medium text-slate-800">{originLang}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">Target language</dt>
                <dd className="font-medium text-slate-800">{targetLang}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">Author</dt>
                <dd className="font-medium text-slate-800">
                  {authorName ?? "미등록"}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">Translated by</dt>
                <dd className="font-medium text-slate-800">
                  {translatorName ?? "미등록"}
                </dd>
              </div>
              {currentEbook?.qualityScore !== null &&
                currentEbook?.qualityScore !== undefined && (
                  <div className="flex justify-between">
                    <dt className="text-slate-500">Quality score</dt>
                    <dd className="font-medium text-slate-800">
                      {currentEbook.qualityScore}
                    </dd>
                  </div>
                )}
              {awardTitle && (
                <div className="flex justify-between">
                  <dt className="text-slate-500">Award</dt>
                  <dd className="font-medium text-slate-800">{awardTitle}</dd>
                </div>
              )}
              {metadata.isbn && (
                <div className="flex justify-between">
                  <dt className="text-slate-500">ISBN</dt>
                  <dd className="font-medium text-slate-800">
                    {metadata.isbn}
                  </dd>
                </div>
              )}
            </dl>
            {metadata.writerNote && (
              <div className="mt-3">
                <h4 className="text-[11px] font-semibold uppercase text-slate-500">
                  Writer&apos;s note
                </h4>
                <p className="mt-1 whitespace-pre-wrap rounded border border-slate-100 bg-slate-50 p-2 text-slate-700">
                  {metadata.writerNote}
                </p>
              </div>
            )}
            {metadata.translatorNote && (
              <div className="mt-3">
                <h4 className="text-[11px] font-semibold uppercase text-slate-500">
                  Translator&apos;s note
                </h4>
                <p className="mt-1 whitespace-pre-wrap rounded border border-slate-100 bg-slate-50 p-2 text-slate-700">
                  {metadata.translatorNote}
                </p>
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <section className="rounded border border-slate-200 bg-white p-4 shadow-sm">
            <h3 className="text-xs font-semibold uppercase text-slate-500">
              출력 포맷
            </h3>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              {formatOptions.map((option) => (
                <label
                  key={option}
                  className={`flex cursor-pointer items-start gap-3 rounded border px-3 py-2 text-sm transition ${
                    format === option
                      ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                      : "border-slate-200 bg-white text-slate-700"
                  }`}
                >
                  <input
                    type="radio"
                    name="ebook-format"
                    className="mt-1"
                    checked={format === option}
                    onChange={() => setFormat(option)}
                  />
                  <div>
                    <p className="font-semibold">{formatLabels[option]}</p>
                    <p className="text-xs text-slate-500">
                      {option === "pdf"
                        ? "인쇄 및 검수용 고정 레이아웃."
                        : "전자책 리더 호환 유동 레이아웃."}
                    </p>
                  </div>
                </label>
              ))}
            </div>
            <button
              type="button"
              className="mt-4 inline-flex items-center justify-center rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-indigo-300"
              onClick={handleGenerate}
              disabled={isLoading || !token || !projectId}
            >
              {isLoading ? "생성 중..." : "전자책 생성"}
            </button>
            {(downloadAssetId || downloadUrl) && (
              <div className="mt-3">
                <button
                  type="button"
                  onClick={handleDownload}
                  disabled={downloadLoading}
                  className="inline-flex items-center rounded border border-indigo-200 bg-indigo-50 px-3 py-1 text-sm font-medium text-indigo-700 transition hover:border-indigo-300 hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {downloadLoading
                    ? "다운로드 준비 중…"
                    : `${downloadFilename} 다운로드`}
                </button>
              </div>
            )}
            {downloadError && (
              <p className="mt-2 text-xs text-rose-600">{downloadError}</p>
            )}
            {error && <p className="mt-3 text-xs text-rose-600">{error}</p>}
          </section>

          <section className="rounded border border-slate-200 bg-white p-4 text-sm shadow-sm">
            <h3 className="text-xs font-semibold uppercase text-slate-500">
              생성 결과
            </h3>
            {ebookLoading && (
              <p className="mt-2 text-xs text-slate-500">
                전자책 정보를 불러오는 중입니다…
              </p>
            )}
            {ebookError && (
              <p className="mt-2 text-xs text-rose-600">{ebookError}</p>
            )}
            {!ebookDetails?.ebook && !ebookLoading && (
              <p className="mt-2 text-xs text-slate-500">
                전자책을 생성하면 결과가 여기에 표시됩니다.
              </p>
            )}
            {!translationOptions.length && !translationsLoading && (
              <button
                type="button"
                onClick={() =>
                  loadTranslationOptions(
                    result?.recommendation?.translationFileId ?? null,
                  )
                }
                className="mt-3 inline-flex items-center justify-center rounded border border-slate-200 px-3 py-1 text-xs text-slate-600 hover:border-indigo-300 hover:text-indigo-600"
              >
                번역본 목록 불러오기
              </button>
            )}
            {ebookDetails?.ebook && (
              <div className="mt-3 space-y-2 text-xs text-slate-600">
                <p>
                  상태:{" "}
                  <span className="font-semibold text-slate-800">
                    {ebookDetails.status}
                  </span>
                </p>
                {result?.requiresConfirmation && (
                  <div className="space-y-1 rounded border border-amber-200 bg-amber-50 p-3 text-amber-700">
                    <p className="font-semibold">
                      전자책 생성 전에 확인이 필요합니다.
                    </p>
                    <ul className="list-disc pl-4 text-xs">
                      <li>
                        사용할 번역본을 선택해 주세요. 아래 추천 번역본을
                        확인하거나 수동으로 지정할 수 있습니다.
                      </li>
                    </ul>
                  </div>
                )}
                {(translationsLoading ||
                  translationOptions.length > 0 ||
                  translationsError) && (
                  <div className="space-y-3 rounded border border-slate-200 bg-slate-50 p-3 text-slate-600">
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-semibold uppercase text-slate-500">
                        번역본 선택
                      </h4>
                      <button
                        type="button"
                        onClick={() =>
                          loadTranslationOptions(selectedTranslationId)
                        }
                        className="rounded border border-slate-200 px-2 py-0.5 text-[11px] text-slate-500 hover:border-indigo-300 hover:text-indigo-600"
                      >
                        목록 새로고침
                      </button>
                    </div>
                    {translationsLoading ? (
                      <p className="text-xs">
                        번역본 목록을 불러오는 중입니다…
                      </p>
                    ) : translationOptions.length ? (
                      <div className="space-y-2">
                        {translationOptions.map((option, index) => {
                          const isSelected =
                            selectedTranslationId === option.translationFileId;
                          const isRecommended =
                            result?.recommendation?.translationFileId ===
                            option.translationFileId;
                          const timestamp =
                            option.completedAt ??
                            option.updatedAt ??
                            option.createdAt;
                          return (
                            <label
                              key={option.translationFileId}
                              className={`flex cursor-pointer flex-col gap-1 rounded border px-3 py-2 text-xs transition ${
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
                                    onChange={() =>
                                      setSelectedTranslationId(
                                        option.translationFileId,
                                      )
                                    }
                                  />
                                  <span className="font-semibold text-slate-700">
                                    번역본 {index + 1}
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
                                    품질 {option.qualityScore.toFixed(1)}점
                                  </span>
                                )}
                                {isRecommended && (
                                  <span className="rounded bg-emerald-100 px-2 py-0.5 text-emerald-700">
                                    추천
                                  </span>
                                )}
                              </div>
                            </label>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="text-xs text-slate-500">
                        사용 가능한 번역본이 없습니다. 번역을 먼저 완료해
                        주세요.
                      </p>
                    )}
                    {translationsError && (
                      <p className="text-xs text-rose-600">
                        {translationsError}
                      </p>
                    )}
                  </div>
                )}
                {latestVersion && (
                  <div className="space-y-1">
                    <p>
                      최신 버전:{" "}
                      <span className="font-semibold text-slate-800">
                        v{latestVersion.versionNumber}
                      </span>{" "}
                      · {latestVersion.format.toUpperCase()}
                    </p>
                    {latestVersion.wordCount !== null && (
                      <p>
                        단어 수: {latestVersion.wordCount?.toLocaleString()}
                      </p>
                    )}
                  </div>
                )}
                {recommendation && (
                  <div className="rounded border border-dashed border-slate-200 bg-slate-50 p-3">
                    <p className="font-semibold text-slate-700">추천 번역본</p>
                    <p className="text-xs text-slate-500">
                      번역 파일 ID: {recommendation.translationFileId}
                    </p>
                    <p className="text-xs text-slate-500">
                      품질 점수: {recommendation.qualityScore}
                    </p>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      </section>
    </div>
  );
};

export default ExportPanel;
