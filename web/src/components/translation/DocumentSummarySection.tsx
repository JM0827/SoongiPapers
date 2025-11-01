import {
  type ReactNode,
  type MouseEvent as ReactMouseEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useMemo,
  useState,
} from "react";
import { Loader2, CheckCircle2, Circle } from "lucide-react";

import type {
  DocumentProfileSummary,
  DocumentSummaryFallback,
} from "../../types/domain";
import type { LocalizeFn } from "../../types/localize";
import {
  handleKeyboardToggle,
  isEventFromInteractive,
} from "../common/collapsibleUtils";
import {
  type TranslationNotesSectionProps,
  TranslationNotesSection,
} from "./TranslationNotesSection";

export type SummaryStatus = "pending" | "running" | "done";

export interface DocumentSummaryCardProps {
  title: string;
  profile: DocumentProfileSummary | null;
  localize: LocalizeFn;
  isLoading?: boolean;
  defaultOpen?: boolean;
  status?: SummaryStatus;
  fallbackSummary?: {
    story?: string | null;
    intention?: string | null;
    readerPoints?: string[];
  } | null;
  fallbackMetrics?: {
    wordCount?: number | null;
    charCount?: number | null;
    paragraphCount?: number | null;
    readingTimeMinutes?: number | null;
    readingTimeLabel?: string | null;
  } | null;
  fallbackTimestamp?: string | null;
  fallbackLanguage?: string | null;
  fallbackVersion?: number | null;
  headerAccessory?: ReactNode;
}

export const DocumentSummaryCard = ({
  title,
  profile,
  localize,
  isLoading = false,
  defaultOpen = true,
  status = "pending",
  fallbackSummary,
  fallbackMetrics,
  fallbackTimestamp,
  fallbackLanguage,
  fallbackVersion,
  headerAccessory,
}: DocumentSummaryCardProps) => {
  const effectiveTimestamp =
    profile?.updatedAt ?? profile?.createdAt ?? fallbackTimestamp ?? null;
  const timestampLabel = effectiveTimestamp
    ? new Date(effectiveTimestamp).toLocaleString()
    : null;
  const summary =
    profile?.summary ??
    (fallbackSummary
      ? {
          story: fallbackSummary.story ?? "",
          intention: fallbackSummary.intention ?? "",
          readerPoints: fallbackSummary.readerPoints ?? [],
        }
      : null);
  const wordsLabel = profile?.metrics?.wordCount ?? fallbackMetrics?.wordCount;
  const charsLabel = profile?.metrics?.charCount ?? fallbackMetrics?.charCount;
  const minutesLabel =
    profile?.metrics?.readingTimeMinutes ?? fallbackMetrics?.readingTimeMinutes;

  const toggleDisabled = Boolean(isLoading && !summary);
  const [isOpen, setIsOpen] = useState(defaultOpen);

  const toggle = () => {
    if (!profile && !isLoading) return;
    setIsOpen((prev) => !prev);
  };

  const handleHeaderClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (toggleDisabled || isEventFromInteractive(event.target)) {
      return;
    }
    toggle();
  };

  const handleHeaderKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (toggleDisabled || isEventFromInteractive(event.target)) {
      return;
    }
    handleKeyboardToggle(event, toggle);
  };

  const headerClass = toggleDisabled
    ? "flex flex-1 cursor-default flex-col gap-1 focus:outline-none"
    : "flex flex-1 cursor-pointer flex-col gap-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white";

  const renderFooter = () => {
    const parts = [
      wordsLabel
        ? localize("rightpanel_summary_metric_words", `${wordsLabel} words`, {
            count: wordsLabel,
          })
        : null,
      charsLabel
        ? localize(
            "rightpanel_summary_metric_characters",
            `${charsLabel} characters`,
            { count: charsLabel },
          )
        : null,
      minutesLabel
        ? localize(
            "rightpanel_summary_metric_minutes",
            `${minutesLabel} mins`,
            { count: minutesLabel },
          )
        : null,
      timestampLabel
        ? localize(
            "rightpanel_summary_metric_updated",
            `update: ${timestampLabel}`,
            { timestamp: timestampLabel },
          )
        : null,
    ].filter(Boolean);
    if (!parts.length) return null;
    return <p className="mt-4 text-[11px] text-slate-400">{parts.join(" ")}</p>;
  };

  const statusIcon = () => {
    if (status === "running") {
      return (
        <Loader2
          className="h-4 w-4 animate-spin text-indigo-500"
          aria-hidden="true"
        />
      );
    }
    if (status === "done") {
      return (
        <CheckCircle2 className="h-4 w-4 text-emerald-500" aria-hidden="true" />
      );
    }
    return <Circle className="h-4 w-4 text-slate-300" aria-hidden="true" />;
  };

  const statusDescription = useMemo(() => {
    if (profile) {
      const languageSuffix = profile.language ? `.${profile.language}` : "";
      return (
        <p className="text-xs text-slate-500">
          {localize(
            "rightpanel_summary_status_version",
            `Version v${profile.version}${languageSuffix}`,
            {
              version: profile.version ?? "",
              languageSuffix,
            },
          )}
        </p>
      );
    }
    if (fallbackSummary) {
      const versionLabel = fallbackVersion ? ` · v${fallbackVersion}` : "";
      const languageLabel = fallbackLanguage ? `.${fallbackLanguage}` : "";
      return (
        <p className="text-xs text-slate-500">
          {localize(
            "rightpanel_summary_status_fallback",
            `Temporary summary${versionLabel}${languageLabel}`,
            {
              versionLabel,
              languageLabel,
            },
          )}
        </p>
      );
    }
    if (status === "running" || isLoading) {
      return (
        <p className="text-xs text-slate-500">
          {localize("rightpanel_summary_status_loading", "Fetching analysis…")}
        </p>
      );
    }
    return (
      <p className="text-xs text-slate-400">
        {localize(
          "rightpanel_summary_status_empty",
          "Summary has not been generated yet.",
        )}
      </p>
    );
  }, [
    fallbackLanguage,
    fallbackSummary,
    fallbackVersion,
    isLoading,
    localize,
    profile,
    status,
  ]);

  return (
    <section className="rounded border border-slate-200 bg-white p-4 shadow-sm">
      <header className="flex items-start justify-between gap-3">
        <div
          className={headerClass}
          role="button"
          tabIndex={toggleDisabled ? -1 : 0}
          aria-expanded={isOpen}
          aria-disabled={toggleDisabled}
          onClick={handleHeaderClick}
          onKeyDown={handleHeaderKeyDown}
        >
          <div className="flex items-center gap-2">
            {statusIcon()}
            <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
            {headerAccessory ? (
              <div className="flex items-center" data-collapsible-ignore>
                {headerAccessory}
              </div>
            ) : null}
          </div>
          {statusDescription}
        </div>
        <button
          type="button"
          className="flex h-6 w-6 items-center justify-center rounded text-xs text-slate-500 transition hover:bg-slate-100 disabled:opacity-50"
          onClick={toggle}
          aria-label={
            isOpen
              ? localize(
                  "rightpanel_summary_action_collapse",
                  `Collapse ${title}`,
                  {
                    title,
                  },
                )
              : localize(
                  "rightpanel_summary_action_expand",
                  `Expand ${title}`,
                  {
                    title,
                  },
                )
          }
          title={
            isOpen
              ? localize(
                  "rightpanel_summary_action_collapse",
                  `Collapse ${title}`,
                  {
                    title,
                  },
                )
              : localize(
                  "rightpanel_summary_action_expand",
                  `Expand ${title}`,
                  {
                    title,
                  },
                )
          }
          disabled={toggleDisabled}
          data-collapsible-ignore
        >
          {isOpen ? "˄" : "˅"}
        </button>
      </header>
      {isOpen &&
        (summary ? (
          <>
            {summary.intention && (
              <div className="mt-4 text-sm text-slate-700">
                <span className="font-medium text-slate-800">
                  {localize("rightpanel_summary_intention_label", "Intention:")}
                </span>{" "}
                <span className="whitespace-pre-wrap text-slate-600">
                  {summary.intention}
                </span>
              </div>
            )}
            {summary.story && (
              <div className="mt-3 text-sm text-slate-700">
                <span className="font-medium text-slate-800">
                  {localize("rightpanel_summary_story_label", "Story:")}
                </span>{" "}
                <span className="whitespace-pre-wrap text-slate-600">
                  {summary.story}
                </span>
              </div>
            )}
            {summary.readerPoints?.length ? (
              <div className="mt-4 space-y-1 text-sm text-slate-700">
                <p className="font-medium text-slate-800">
                  {localize(
                    "rightpanel_summary_reader_points_label",
                    "Reader points",
                  )}
                </p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-slate-600">
                  {summary.readerPoints.map((point, index) => (
                    <li key={`${profile?.id ?? "fallback"}-point-${index}`}>
                      {point}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {renderFooter()}
          </>
        ) : status === "running" || isLoading ? (
          <p className="mt-4 text-sm text-slate-500">
            {localize("rightpanel_summary_loading", "Fetching analysis…")}
          </p>
        ) : null)}
    </section>
  );
};

export interface DocumentSummarySectionProps {
  origin: DocumentProfileSummary | null;
  translation: DocumentProfileSummary | null;
  localize: LocalizeFn;
  isLoading?: boolean;
  onEditTranslationNotes?: TranslationNotesSectionProps["onEdit"];
  translationNotesEditable?: TranslationNotesSectionProps["editable"];
  translationNotesSaving?: TranslationNotesSectionProps["isSaving"];
  translationNotesError?: TranslationNotesSectionProps["error"];
  onReanalyze?: TranslationNotesSectionProps["onRefresh"];
  isReanalyzing?: TranslationNotesSectionProps["isRefreshing"];
  canReanalyze?: TranslationNotesSectionProps["canRefresh"];
  reanalysisError?: TranslationNotesSectionProps["refreshError"];
  originStatus?: SummaryStatus;
  translationStatus?: SummaryStatus;
  translationFallback?: DocumentSummaryFallback | null;
  originFallback?: DocumentSummaryFallback | null;
  originHeaderAccessory?: ReactNode;
  translationHeaderAccessory?: ReactNode;
}

export const DocumentSummarySection = ({
  origin,
  translation,
  localize,
  isLoading = false,
  onEditTranslationNotes,
  translationNotesEditable = false,
  translationNotesSaving = false,
  translationNotesError = null,
  onReanalyze,
  isReanalyzing = false,
  canReanalyze = true,
  reanalysisError = null,
  originStatus = "pending",
  translationStatus = "pending",
  translationFallback = null,
  originFallback = null,
  originHeaderAccessory,
  translationHeaderAccessory,
}: DocumentSummarySectionProps) => (
  <div className="space-y-4">
    <DocumentSummaryCard
      title={localize(
        "rightpanel_origin_summary_title",
        "Summary of manuscript",
      )}
      localize={localize}
      profile={origin}
      isLoading={isLoading && !origin}
      status={originStatus}
      fallbackSummary={originFallback?.summary}
      fallbackMetrics={originFallback?.metrics}
      fallbackTimestamp={originFallback?.timestamp ?? null}
      fallbackLanguage={originFallback?.language ?? null}
      fallbackVersion={originFallback ? 0 : null}
      headerAccessory={originHeaderAccessory}
    />
    <TranslationNotesSection
      notes={origin?.translationNotes ?? null}
      localize={localize}
      editable={translationNotesEditable}
      onEdit={onEditTranslationNotes}
      isSaving={translationNotesSaving}
      error={translationNotesError}
      onRefresh={onReanalyze}
      isRefreshing={isReanalyzing}
      canRefresh={canReanalyze}
      refreshError={reanalysisError}
    />
    <DocumentSummaryCard
      title={localize(
        "rightpanel_translation_summary_title",
        "Summary of translation",
      )}
      localize={localize}
      profile={translation}
      isLoading={isLoading && !translation}
      status={translationStatus}
      fallbackSummary={translationFallback?.summary}
      fallbackMetrics={translationFallback?.metrics}
      fallbackTimestamp={translationFallback?.timestamp ?? null}
      fallbackLanguage={translationFallback?.language ?? null}
      fallbackVersion={translationFallback ? 0 : null}
      headerAccessory={translationHeaderAccessory}
    />
  </div>
);
