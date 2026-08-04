import { useState } from "react";
import { useNavigate } from "react-router-dom";

interface TemplateResult {
  title: string;
  format: string;
  contentVersionId: string;
  teamSiteId: string;
  modifiedDate: string;
  description?: string | null;
}

export default function TemplateSearch() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TemplateResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  async function search() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ searchText: query, page_size: 20 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setResults(data.results ?? []);
      setSearched(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  function select(t: TemplateResult) {
    navigate(`/form?teamSiteId=${t.teamSiteId}&versionId=${t.contentVersionId}`);
  }

  return (
    <div>
      <div className="section-title">Find a Template</div>
      <div className="card" style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", gap: 10 }}>
          <input
            className="field-input"
            placeholder="Search templates by name or keyword…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === "Enter" && search()}
          />
          <button className="btn btn-primary" onClick={search} disabled={loading} style={{ whiteSpace: "nowrap" }}>
            {loading ? <span className="spinner" /> : "Search"}
          </button>
        </div>
      </div>

      {error && <div className="error-box" style={{ marginBottom: 16 }}>{error}</div>}

      {searched && results.length === 0 && !loading && (
        <div style={{ color: "#888", fontSize: 14, textAlign: "center", padding: "40px 0" }}>No templates found.</div>
      )}

      {results.map(t => (
        <div key={t.contentVersionId} className="card" style={{ marginBottom: 12, cursor: "pointer" }} onClick={() => select(t)}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>{t.title}</div>
              {t.description && <div style={{ fontSize: 13, color: "#666", marginBottom: 6 }}>{t.description}</div>}
              <div style={{ fontSize: 12, color: "#999" }}>{new Date(t.modifiedDate).toLocaleDateString()}</div>
            </div>
            <div style={{ display: "flex", gap: 6, flexShrink: 0, marginLeft: 16 }}>
              <span className="badge badge-blue">{t.format}</span>
              <button className="btn btn-primary" style={{ padding: "6px 14px", fontSize: 13 }} onClick={e => { e.stopPropagation(); select(t); }}>
                Open →
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
