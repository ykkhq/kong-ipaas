import { useEffect, useState } from 'react';
import { FlowList } from './components/FlowList';
import { Designer } from './components/Designer';
import { ConnectionsPage } from './components/ConnectionsPage';
import { EdiPage } from './components/EdiPage';

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
  if (m) return <Designer key={m[1]} flowId={m[1]} />;
  if (route === '/connections') return <ConnectionsPage />;
  if (route.startsWith('/edi')) return <EdiPage />;
  return <FlowList />;
}
