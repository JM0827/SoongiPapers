import { SidebarSection } from "./SidebarSection";

interface SidebarActivitySectionProps {
  isOpen: boolean;
  onToggle: (open: boolean) => void;
  items: Array<{ id: string; text: string }>;
}

export const SidebarActivitySection = ({
  isOpen,
  onToggle,
  items,
}: SidebarActivitySectionProps) => {
  return (
    <SidebarSection title="최근 업데이트" isOpen={isOpen} onToggle={onToggle}>
      {items.length === 0 ? (
        <p className="text-[11px] text-slate-500">최근 업데이트 정보가 없습니다.</p>
      ) : (
        <ul className="text-[11px] text-slate-600">
          {items.map((item) => (
            <li key={item.id} className="py-0.5">
              {item.text}
            </li>
          ))}
        </ul>
      )}
    </SidebarSection>
  );
};
