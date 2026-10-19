import { ModelDefaultsSection } from "./ModelDefaultsSection.js";

/** Task permissions live in the original mode control; this section selects its reviewer. */
export function PermissionTierSection() {
  return <ModelDefaultsSection approvalOnly />;
}
