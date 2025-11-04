import {
  Fragment,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { RightPanelExtraTab } from "../../store/ui.store";
import { useUILocale } from "../../hooks/useUILocale";
import { translate } from "../../lib/locale";

interface UserProfileMenuProps {
  avatarInitial: string | null;
  avatarTone: string;
  avatarPreview: string | null;
  userName: string | null;
  userEmail: string | null;
  onOpenTab: (tab: RightPanelExtraTab, label: string) => void;
  onLogout: () => void;
  advancedProofreadEnabled: boolean;
  onToggleAdvancedProofread: () => void;
}

export const UserProfileMenu = ({
  avatarInitial,
  avatarTone,
  avatarPreview,
  userName,
  userEmail,
  onOpenTab,
  onLogout,
  advancedProofreadEnabled,
  onToggleAdvancedProofread,
}: UserProfileMenuProps) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const { locale } = useUILocale();

  const localize = useCallback(
    (key: string, fallback: string) => {
      const resolved = translate(key, locale);
      return resolved === key ? fallback : resolved;
    },
    [locale],
  );

  const mainItems = useMemo(
    () =>
      [
        { key: "profile" as RightPanelExtraTab, label: localize("user_menu_profile", "My profile") },
        { key: "settings" as RightPanelExtraTab, label: localize("user_menu_settings", "My settings") },
        { key: "activity" as RightPanelExtraTab, label: localize("user_menu_activity", "My activity") },
      ],
    [localize],
  );

  const secondaryItems = useMemo(
    () =>
      [
        {
          key: "terms" as Extract<RightPanelExtraTab, "terms" | "privacy">,
          label: localize("user_menu_terms", "Terms"),
        },
        {
          key: "privacy" as Extract<RightPanelExtraTab, "terms" | "privacy">,
          label: localize("user_menu_privacy", "Privacy"),
        },
      ],
    [localize],
  );

  useEffect(() => {
    if (!menuOpen) return undefined;

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
  }, [menuOpen]);

  const handleMainClick = (
    tab: RightPanelExtraTab,
    label: string,
  ) => {
    onOpenTab(tab, label);
    setMenuOpen(false);
  };

  const handleSecondaryClick = (
    tab: Extract<RightPanelExtraTab, "terms" | "privacy">,
    label: string,
  ) => {
    onOpenTab(tab, label);
    setMenuOpen(false);
  };

  const handleAdvancedProofreadToggle = (
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => {
    event.preventDefault();
    onToggleAdvancedProofread();
    setMenuOpen(false);
  };

  const handleLogout = () => {
    setMenuOpen(false);
    onLogout();
  };

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        className={`ml-2 flex h-9 w-9 items-center justify-center overflow-hidden rounded-full text-sm font-semibold text-white transition hover:brightness-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white ${avatarPreview ? "bg-slate-200" : avatarTone}`}
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
      {menuOpen && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-3 w-56 rounded-lg border border-slate-200 bg-white p-3 text-sm shadow-lg"
        >
          <div className="mb-3 border-b border-slate-100 pb-2">
            <p className="text-xs uppercase text-slate-400">
              {localize("user_menu_signed_in", "Signed in")}
            </p>
            <p className="font-semibold text-slate-700">
              {userName ?? localize("user_menu_current_user", "Current user")}
            </p>
            <p className="text-xs text-slate-500">
              {userEmail ?? localize("user_menu_no_email", "No email on file")}
            </p>
          </div>
          <div className="flex flex-col gap-1" role="none">
            {mainItems.map((item, index) => (
              <Fragment key={item.key}>
                <button
                  className="rounded px-2.5 py-1.5 text-left text-slate-700 transition hover:bg-slate-100 focus:bg-slate-100 focus:outline-none"
                  type="button"
                  role="menuitem"
                  onClick={() => handleMainClick(item.key, item.label)}
                >
                  {item.label}
                </button>
                {index === 0 ? (
                  <div
                    className="border-t border-slate-100"
                    role="separator"
                    aria-hidden="true"
                  />
                ) : null}
              </Fragment>
            ))}
            <button
              className="rounded px-2.5 py-1.5 text-left text-slate-700 transition hover:bg-slate-100 focus:bg-slate-100 focus:outline-none"
              type="button"
              role="menuitem"
              onClick={handleAdvancedProofreadToggle}
            >
              {advancedProofreadEnabled
                ? localize(
                    "user_menu_hide_advanced_proofread",
                    "Hide Advanced Proofread",
                  )
                : localize(
                    "user_menu_advanced_proofread",
                    "Advanced Proofread",
                  )}
            </button>
            <div
              className="border-t border-slate-100"
              role="separator"
              aria-hidden="true"
            />
            <button
              className="rounded px-2.5 py-1.5 text-left text-rose-600 transition hover:bg-rose-50 focus:bg-rose-50 focus:outline-none"
              type="button"
              role="menuitem"
              onClick={handleLogout}
            >
              {localize("user_menu_logout", "Log out")}
            </button>
          </div>
          <div
            className="my-2 border-t border-slate-100"
            role="separator"
            aria-hidden="true"
          />
          <div
            className="flex items-center justify-between gap-2 text-xs text-slate-500"
            role="none"
          >
            {secondaryItems.map((item) => (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                className="rounded px-1.5 py-1 transition hover:bg-slate-100 hover:text-slate-700 focus:bg-slate-100 focus:outline-none"
                onClick={() => handleSecondaryClick(item.key, item.label)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
