import type { ProjectSummary } from "../../types/domain";

interface ProjectCardProps {
  project: ProjectSummary;
}

export const ProjectCard = ({ project }: ProjectCardProps) => (
  <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
    <h3 className="text-lg font-semibold text-slate-800">
      {project.title || "Untitled Project"}
    </h3>
    <p className="mt-1 text-sm text-slate-500">
      {project.description || "No description yet."}
    </p>
    <div className="mt-3 text-xs text-slate-500">
      <span>
        {project.origin_lang} → {project.target_lang}
      </span>
    </div>
  </div>
);
