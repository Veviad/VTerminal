export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-border-subtle bg-bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-text-muted">
      {children}
    </kbd>
  );
}
