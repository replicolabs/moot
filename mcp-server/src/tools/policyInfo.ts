import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPolicyFromFile, PolicyDocument } from "@moot/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

export function getPolicy(actionType: "transfer" | "escrow" = "transfer"): PolicyDocument {
  return loadPolicyFromFile(join(REPO_ROOT, "policies", `${actionType}.yaml`));
}
