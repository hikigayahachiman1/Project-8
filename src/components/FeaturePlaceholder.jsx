export default function FeaturePlaceholder({ title, description }) {
  return (
    <section className="feature-panel">
      <div className="panel-head">
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      <article className="card">
        <h3>Belum dimigrasi</h3>
        <p>
          Struktur feature sudah tersedia agar logic existing bisa dipindah bertahap tanpa mengubah
          kontrak API atau flow bisnis.
        </p>
      </article>
    </section>
  );
}
