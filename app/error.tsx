'use client';

import {useEffect} from 'react';

export default function ErrorScreen({error, reset}: {error: Error & {digest?: string}; reset: () => void}) {
  useEffect(() => {
    console.error(JSON.stringify({op: 'ui.error', digest: error.digest ?? null}));
  }, [error]);
  return (
    <main className="login">
      <h1>Something went wrong</h1>
      <p>Deevaa could not render this page. Your connected accounts were not changed.</p>
      <button type="button" onClick={() => reset()}>Try again</button>
    </main>
  );
}
