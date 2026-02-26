import { useCallback, useEffect, useRef, useState } from "react";

export function useApi<T>(fetcher: () => Promise<T>, intervalMs = 5000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const doFetch = useCallback(async () => {
    try {
      const result = await fetcherRef.current();
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, []);

  useEffect(() => {
    doFetch();
    const timer = setInterval(doFetch, intervalMs);
    return () => clearInterval(timer);
  }, [doFetch, intervalMs]);

  return { data, error, refetch: doFetch };
}
