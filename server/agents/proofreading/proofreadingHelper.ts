import { loadSpec, Spec } from "./config";
export async function getProofreadingSpec(
  _projectId: string,
  _jobId: string,
): Promise<Spec> {
  void _projectId;
  void _jobId;
  const specPath =
    process.env.PROOFREADING_SPEC_PATH || __dirname + "/proofreading.spec.json";
  return loadSpec(specPath);
}
