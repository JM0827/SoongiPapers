import { useEffect, useRef, useState } from "react";
import type { RightPanelExtraTab } from "../../../store/ui.store";

interface SidebarHeaderProps {
  projectTitle: string;
  originLabel?: string | null;
  targetLabel?: string | null;
  updatedLabel?: string | null;
  userName?: string | null;
  userEmail?: string | null;
  avatarInitial?: string | null;
  avatarTone: string;
  avatarPreview?: string | null;
  onOpenExtraTab?: (tab: RightPanelExtraTab, label: string) => void;
  onLogout?: () => void;
  showUserMenu?: boolean;
}

export const SidebarHeader = ({
  projectTitle,
  originLabel,
  targetLabel,
  updatedLabel,
  userName,
  userEmail,
  avatarInitial,
  avatarTone,
  avatarPreview,
  onOpenExtraTab,
  onLogout,
  showUserMenu = true,
}: SidebarHeaderProps) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return undefined;
    if (!showUserMenu) return undefined;

    const handleClickOutside = (event: MouseEvent) => {
      if (
        menuRef.current &&
        event.target instanceof Node &&
        !menuRef.current.contains(event.target)
      ) {
        setMenuOpen(false);
      }
    };

    const handleEsc = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEsc);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEsc);
    };
  }, [menuOpen, showUserMenu]);

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <h2 className="text-base font-semibold text-slate-800">
            {projectTitle || "프로젝트"}
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            {originLabel && targetLabel
              ? `${originLabel} → ${targetLabel}`
              : originLabel || targetLabel || "언어 정보 없음"}
          </p>
          {updatedLabel ? (
            <p className="text-[11px] text-slate-400">{updatedLabel}</p>
          ) : null}
        </div>
        {showUserMenu ? (
          <div ref={menuRef} className="relative">
            <button
              type="button"
              className={`flex h-10 w-10 items-center justify-center overflow-hidden rounded-full text-sm font-semibold text-white ${avatarPreview ? "bg-slate-200" : avatarTone}`}
              onClick={() => setMenuOpen((prev) => !prev)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              {avatarPreview ? (
                <img
                  src={avatarPreview}
                  alt={userName ?? "User avatar"}
                  className="h-full w-full object-cover"
                />
              ) : (
                <span>{avatarInitial ?? "?"}</span>
              )}
            </button>
            {menuOpen && onOpenExtraTab && (
              <div
                role="menu"
                className="absolute right-0 z-50 mt-3 w-56 rounded-lg border border-slate-200 bg-white p-3 text-sm shadow-lg"
              >
                <div className="mb-3 border-b border-slate-100 pb-2">
                  <p className="text-xs uppercase text-slate-400">Signed in</p>
                  <p className="font-semibold text-slate-700">
                    {userName ?? "Current user"}
                  </p>
                  <p className="text-xs text-slate-500">
                    {userEmail ?? "No email on file"}
                  </p>
                </div>
                <div className="flex flex-col gap-1" role="none">
                  <button
                    className="rounded px-3 py-2 text-left text-slate-700 hover:bg-slate-100 focus:bg-slate-100 focus:outline-none"
                    type="button"
                    onClick={() => {
                      onOpenExtraTab("profile", "My profile");
                      setMenuOpen(false);
                    }}
                    role="menuitem"
                  >
                    My profile
                  </button>
                  <button
                    className="rounded px-3 py-2 text-left text-slate-700 hover:bg-slate-100 focus:bg-slate-100 focus:outline-none"
                    type="button"
                    onClick={() => {
                      onOpenExtraTab("settings", "My settings");
                      setMenuOpen(false);
                    }}
                    role="menuitem"
                  >
                    My settings
                  </button>
                  <button
                    className="rounded px-3 py-2 text-left text-slate-700 hover:bg-slate-100 focus:bg-slate-100 focus:outline-none"
                    type="button"
                    onClick={() => {
                      onOpenExtraTab("activity", "My activity");
                      setMenuOpen(false);
                    }}
                    role="menuitem"
                  >
                    My activity
                  </button>
                  <button
                    className="rounded px-3 py-2 text-left text-slate-700 hover:bg-slate-100 focus:bg-slate-100 focus:outline-none"
                    type="button"
                    onClick={() => {
                      onOpenExtraTab("terms", "Terms");
                      setMenuOpen(false);
                    }}
                    role="menuitem"
                  >
                    Terms
                  </button>
                  <button
                    className="rounded px-3 py-2 text-left text-slate-700 hover:bg-slate-100 focus:bg-slate-100 focus:outline-none"
                    type="button"
                    onClick={() => {
                      onOpenExtraTab("privacy", "Privacy");
                      setMenuOpen(false);
                    }}
                    role="menuitem"
                  >
                    Privacy
                  </button>
                  <button
                    className="rounded px-3 py-2 text-left text-rose-600 hover:bg-rose-50 focus:bg-rose-50 focus:outline-none"
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      onLogout?.();
                    }}
                    role="menuitem"
                  >
                    Log out
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
};
