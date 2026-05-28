export default function ParserFeature() {
  return (
    <section className="feature-panel">
      <div className="panel-head">
        <h2>Parser QRIS</h2>
        <p>Folder feature sudah disiapkan. Logic parser lama belum dipindah dari versi legacy.</p>
      </div>
      <div className="placeholder-grid">
        <article className="card">
          <h3>Deposit QRIS</h3>
          <p>Tempat migrasi UI dan logic parser deposit existing.</p>
        </article>
        <article className="card">
          <h3>AutoWD QRIS</h3>
          <p>Tempat migrasi fitur AutoWD tanpa mencampur logic Bonus Harian.</p>
        </article>
      </div>
    </section>
  );
}
