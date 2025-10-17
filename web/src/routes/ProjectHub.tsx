import { useProjectStore } from "../store/project.store";
import { useProjectList } from "../hooks/useProjectData";
import { ProjectCard } from "../components/project/ProjectCard";
import { useCreateProject } from "../hooks/useCreateProject";

export const ProjectHub = () => {
  const { data, isLoading } = useProjectList();
  const projects = useProjectStore((state) => state.projects);
  const { createProject, isCreating } = useCreateProject();

  const handleCreate = async () => {
    try {
      await createProject();
    } catch (err) {
      console.error("[project-hub] failed to create project", err);
      window.alert("새 프로젝트 생성에 실패했습니다. 다시 시도해 주세요.");
    }
  };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-800">Project hub</h1>
        <button
          className="rounded border border-slate-300 px-3 py-1 text-sm disabled:opacity-50"
          onClick={handleCreate}
          disabled={isCreating}
        >
          New project
        </button>
      </header>
      {isLoading && (
        <p className="text-sm text-slate-500">Loading projects...</p>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {(data ?? projects).map((project) => (
          <ProjectCard key={project.project_id} project={project} />
        ))}
      </div>
    </div>
  );
};
