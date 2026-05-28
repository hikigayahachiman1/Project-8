export default function AppLayout({ children }) {
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-row">
          <div className="app-logo-mark" aria-hidden="true">Q</div>
          <div>
            <h1>Parser Transaksi <em>QRIS</em></h1>
            <p>Bonus Control · Vite React Migration Shell</p>
          </div>
        </div>
        <div className="status-card">
          <span>Status</span>
          <strong>Aktif</strong>
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}
