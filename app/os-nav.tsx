const LINKS = [
  ['/', 'Today'],
  ['/chat', 'Chat'],
  ['/blueprint', 'Life Blueprint'],
  ['/projects', 'Projects'],
  ['/agents', 'Agents'],
  ['/approvals', 'Approvals'],
  ['/calendar', 'Calendar'],
  ['/memory', 'Memory'],
  ['/settings', 'Settings']
] as const;

export function OsNav() {
  return (
    <nav className="os-nav" aria-label="Deevaa">
      {LINKS.map(([href, label]) => (
        <a key={href} href={href}>
          {label}
        </a>
      ))}
    </nav>
  );
}
