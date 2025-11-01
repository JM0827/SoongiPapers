import { loadSpec, Spec } from "./config";
export async function getProofreadingSpec(
  _projectId: string,
  _jobId: string,
): Promise<Spec> {
  const specPath =
    process.env.PROOFREADING_SPEC_PATH || __dirname + "/proofreading.spec.json";
  return loadSpec(specPath);
}
