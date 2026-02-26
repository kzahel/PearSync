import { getStatus, type StatusInfo } from "./api";
import { Dashboard } from "./components/Dashboard";
import { Setup } from "./components/Setup";
import { useApi } from "./hooks/useApi";

export function App() {
  const { data: status, refetch } = useApi<StatusInfo>(getStatus, 3000);

  if (!status || status.state === "setup") {
    return <Setup onComplete={refetch} />;
  }

  return <Dashboard />;
}
