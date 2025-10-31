import { useState } from "react";
import { Film, Share2, Sparkles } from "lucide-react";
import type { PromoState } from "./ebookTypes";
import { CoverPreview, type CoverPreviewProps } from "./CoverPreview";

interface PromotionPanelProps {
  t: (key: string, params?: Record<string, string | number>) => string;
  coverProps: Omit<CoverPreviewProps, "t"> & {
    coverUrl: string | null;
  };
}

export function PromotionPanel({ t, coverProps }: PromotionPanelProps) {
  const [tab, setTab] = useState<"basic" | "advanced">("basic");
  const [promoState, setPromoState] = useState<PromoState>("idle");

  const canTriggerVideo = promoState !== "idle";
  const canTriggerCards = promoState === "video" || promoState === "cards";

  const renderPromoStatus = () => {
    switch (promoState) {
      case "scene":
        return t("export.promotion.scene.status");
      case "video":
        return t("export.promotion.video.status");
      case "cards":
        return t("export.promotion.cards.status");
      default:
        return t("export.promotion.idle.status");
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2 text-sm text-slate-600">
        <div className="flex gap-2">
          <button
            type="button"
            className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
              tab === "basic"
                ? "bg-indigo-100 text-indigo-700"
                : "bg-slate-100 text-slate-500"
            }`}
            onClick={() => setTab("basic")}
            aria-label={t("export.promotion.tabs.basic.aria")}
          >
            {t("export.promotion.tabs.basic.label")}
          </button>
          <button
            type="button"
            className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
              tab === "advanced"
                ? "bg-indigo-100 text-indigo-700"
                : "bg-slate-100 text-slate-500"
            }`}
            onClick={() => setTab("advanced")}
            aria-label={t("export.promotion.tabs.advanced.aria")}
          >
            {t("export.promotion.tabs.advanced.label")}
          </button>
        </div>
        <span className="text-xs text-slate-400">
          {t("export.promotion.subtitle")}
        </span>
      </div>

      <div className="p-4">
        {tab === "basic" ? (
          <CoverPreview t={t} {...coverProps} />
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              {t("export.promotion.advanced.description")}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold transition ${
                  promoState === "scene"
                    ? "border-indigo-400 bg-indigo-50 text-indigo-700"
                    : "border-slate-200 bg-white text-slate-600 hover:border-indigo-300 hover:text-indigo-600"
                }`}
                onClick={() => setPromoState("scene")}
                aria-label={t("export.promotion.scene.action")}
              >
                <Sparkles className="h-4 w-4" aria-hidden />
                <span>{t("export.promotion.scene.label")}</span>
              </button>
              <button
                type="button"
                className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold transition ${
                  promoState === "video"
                    ? "border-indigo-400 bg-indigo-50 text-indigo-700"
                    : "border-slate-200 bg-white text-slate-600 hover:border-indigo-300 hover:text-indigo-600"
                }`}
                onClick={() => canTriggerVideo && setPromoState("video")}
                disabled={!canTriggerVideo}
                aria-label={t("export.promotion.video.action")}
              >
                <Film className="h-4 w-4" aria-hidden />
                <span>{t("export.promotion.video.label")}</span>
              </button>
              <button
                type="button"
                className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold transition ${
                  promoState === "cards"
                    ? "border-indigo-400 bg-indigo-50 text-indigo-700"
                    : "border-slate-200 bg-white text-slate-600 hover:border-indigo-300 hover:text-indigo-600"
                }`}
                onClick={() => canTriggerCards && setPromoState("cards")}
                disabled={!canTriggerCards}
                aria-label={t("export.promotion.cards.action")}
              >
                <Share2 className="h-4 w-4" aria-hidden />
                <span>{t("export.promotion.cards.label")}</span>
              </button>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
              {renderPromoStatus()}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
