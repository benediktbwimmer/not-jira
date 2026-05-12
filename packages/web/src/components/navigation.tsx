import type { ReactNode } from "react";
import type { StatusFilter } from "../types";

export function NavButton({ active, icon, label, onClick }: { active: boolean; icon: ReactNode; label: string; onClick: () => void }) {
  return <button className={active ? "nav-button active" : "nav-button"} onClick={onClick}>{icon}<span>{label}</span></button>;
}

export function StatusTabs({ value, onChange }: { value: StatusFilter[]; onChange: (status: StatusFilter) => void }) {
  const filters: Array<{ value: StatusFilter; label: string }> = [
    { value: "ready", label: "Ready" },
    { value: "blocked", label: "Blocked" },
    { value: "started", label: "Started" },
    { value: "finished", label: "Finished" },
    { value: "archived", label: "Archived" }
  ];
  return (
    <div className="status-tabs" role="tablist" aria-label="Task status filter">
      {filters.map((filter) => (
        <button
          key={filter.value}
          className={value.includes(filter.value) ? "status-tab active" : "status-tab"}
          onClick={() => onChange(filter.value)}
          role="tab"
          aria-selected={value.includes(filter.value)}
          aria-pressed={value.includes(filter.value)}
        >
          {filter.label}
        </button>
      ))}
    </div>
  );
}
