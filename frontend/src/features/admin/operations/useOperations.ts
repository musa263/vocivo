import { useCallback, useEffect, useRef, useState } from 'react';
type Api = (path: string, options?: any) => Promise<any>;
export function useOperations(api: Api, path: string, interval = 0) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [revision, refresh] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    const epoch = ++generation.current;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setData(null); setError('');
    async function load() {
      setLoading(true);
      try {
        const result = await api(path, { signal: controller.signal });
        if (generation.current === epoch) { setData(result); setError(''); }
      } catch (err) {
        if (generation.current === epoch && !controller.signal.aborted) { setData(null); setError(err instanceof Error ? err.message : 'Data unavailable'); }
      } finally {
        if (generation.current === epoch) {
          setLoading(false);
          if (interval) timer = setTimeout(load, interval);
        }
      }
    }
    void load();
    return () => { generation.current++; controller.abort(); clearTimeout(timer); };
  }, [api, path, interval, revision]);
  return { data, error, loading, refresh: useCallback(() => refresh(v => v + 1), []) };
}
