import { useEffect, useState } from 'react';
import { FlowList } from './components/FlowList';
import { Designer } from './components/Designer';

function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash.replace(/^#/, '') || '/';
}

export function App() {
  const route = useHashRoute();
  const m = route.match(/^\/flows\/([^/]+)$/);
  return m ? <Designer key={m[1]} flowId={m[1]} /> : <FlowList />;
}
