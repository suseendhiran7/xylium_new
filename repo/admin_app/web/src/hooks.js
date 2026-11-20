import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

/** GET `url` on mount (and when `url` changes); `reload()` re-fetches. */
export function useApi(url, { pollMs } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);

  const reload = useCallback(async () => {
    if (!url) return;
    try {
      const d = await api.get(url);
      if (alive.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (alive.current) setError(e);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    alive.current = true;
    setLoading(true);
    reload();
    let t = null;
    if (pollMs) t = setInterval(reload, pollMs);
    return () => {
      alive.current = false;
      if (t) clearInterval(t);
    };
  }, [reload, pollMs]);

  return { data, error, loading, reload };
}

export const fmtTime = (t) => (t ? new Date(t).toLocaleString() : '—');

export function timeAgo(t) {
  if (!t) return '—';
  const s = Math.round((Date.now() - new Date(t).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
