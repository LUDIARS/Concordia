/** /chores は Cc v5 で依頼窓口 (/desk) にまとめた。旧 URL からの案内だけを残す (過去の雑務は /desk の欄で読める)。 */
import { Navigate } from "react-router-dom";

export function Chores() {
  return <Navigate to="/desk" replace />;
}
