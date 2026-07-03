import { DelegationSpawnForm } from "./DelegationSpawnForm.js";

export function SubsidiaryProjectSpawnForm({
  subsidiaryId,
  className = "",
}: {
  subsidiaryId: string;
  className?: string;
}) {
  return <DelegationSpawnForm subsidiaryId={subsidiaryId} className={className} />;
}
