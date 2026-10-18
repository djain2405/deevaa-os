export function healthPayload(store: 'postgres' | 'embedded') {
  return {ok: true as const, service: 'deevaa-os', store};
}
