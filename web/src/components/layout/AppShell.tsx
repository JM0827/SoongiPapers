import { type ReactNode, useCallback, useEffect } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useUIStore } from "../../store/ui.store";
import { LeftSidebar } from "./LeftSidebar";
import { RightPanel } from "./RightPanel";

interface AppShellProps {
  left?: ReactNode;
  children: ReactNode;
  right?: ReactNode;
}

const MIN_LEFT_WIDTH = 120;
const LEFT_COLLAPSED_WIDTH = 60;
const MAX_LEFT_RATIO = 0.3;

const MIN_RIGHT_WIDTH = 400;
const MAX_RIGHT_RATIO = 0.9;

export const AppShell = ({
  left = <LeftSidebar />,
  children,
  right = <RightPanel />,
}: AppShellProps) => {
  const isSidebarCollapsed = useUIStore((state) => state.isSidebarCollapsed);
  const leftPanelWidth = useUIStore((state) => state.leftPanelWidth);
  const setLeftPanelWidth = useUIStore((state) => state.setLeftPanelWidth);
  const rightPanelWidth = useUIStore((state) => state.rightPanelWidth);
  const setRightPanelWidth = useUIStore((state) => state.setRightPanelWidth);

  const clampLeftWidth = useCallback((width: number) => {
    const maxWidth = Math.max(
      MIN_LEFT_WIDTH,
      window.innerWidth * MAX_LEFT_RATIO,
    );
    return Math.min(Math.max(width, MIN_LEFT_WIDTH), maxWidth);
  }, []);

  const clampWidth = useCallback((width: number) => {
    const maxWidth = Math.max(
      MIN_RIGHT_WIDTH,
      window.innerWidth * MAX_RIGHT_RATIO,
    );
    const clamped = Math.min(Math.max(width, MIN_RIGHT_WIDTH), maxWidth);
    return clamped;
  }, []);

  const handleLeftResizeStart = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (isSidebarCollapsed) return;
      const startX = event.clientX;
      const startWidth = leftPanelWidth;

      const onMouseMove = (moveEvent: MouseEvent) => {
        const delta = moveEvent.clientX - startX;
        const candidate = startWidth + delta;
        const nextWidth = clampLeftWidth(candidate);
        setLeftPanelWidth(nextWidth);
      };

      const onMouseUp = () => {
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
      };

      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [isSidebarCollapsed, leftPanelWidth, clampLeftWidth, setLeftPanelWidth],
  );

  const handleResizeStart = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const startX = event.clientX;
      const startWidth = rightPanelWidth;

      const onMouseMove = (moveEvent: MouseEvent) => {
        const delta = startX - moveEvent.clientX;
        const candidate = startWidth + delta;
        const nextWidth = clampWidth(candidate);
        setRightPanelWidth(nextWidth);
      };

      const onMouseUp = () => {
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
      };

      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [rightPanelWidth, setRightPanelWidth, clampWidth],
  );

  useEffect(() => {
    const syncLeftWidth = () => {
      setLeftPanelWidth((current) => clampLeftWidth(current));
    };
    syncLeftWidth();
    window.addEventListener("resize", syncLeftWidth);
    return () => window.removeEventListener("resize", syncLeftWidth);
  }, [clampLeftWidth, setLeftPanelWidth]);

  useEffect(() => {
    const syncWidth = () => {
      setRightPanelWidth((current) => {
        const next = clampWidth(current);
        return next === current ? current : next;
      });
    };

    syncWidth();
    window.addEventListener("resize", syncWidth);
    return () => window.removeEventListener("resize", syncWidth);
  }, [clampWidth, setRightPanelWidth]);

  const effectiveLeftWidth = isSidebarCollapsed
    ? LEFT_COLLAPSED_WIDTH
    : leftPanelWidth;

  return (
    <div className="flex h-screen overflow-hidden bg-slate-100 text-slate-900">
      <aside
        className="border-r border-slate-200 bg-white transition-all"
        style={{ width: effectiveLeftWidth }}
      >
        {left}
      </aside>
      <div
        className={`h-full w-1 cursor-col-resize bg-slate-200 hover:bg-slate-300 ${
          isSidebarCollapsed ? "pointer-events-none opacity-0" : ""
        }`}
        onMouseDown={handleLeftResizeStart}
      />
      <div className="flex h-full flex-1 overflow-hidden bg-white text-slate-900">
        <main className="flex-1 overflow-y-auto bg-white">
          <div className="mx-auto flex h-full w-full max-w-[1200px] flex-col">
            {children}
          </div>
        </main>
        <div
          className="h-full w-1 cursor-col-resize bg-slate-200/70 hover:bg-slate-400/70"
          onMouseDown={handleResizeStart}
        />
        <section
          className="h-full border-l border-slate-200 bg-white"
          style={{ width: rightPanelWidth }}
        >
          {right}
        </section>
      </div>
    </div>
  );
};
