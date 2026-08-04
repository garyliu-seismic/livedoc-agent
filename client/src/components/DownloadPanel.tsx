import { useState } from "react";
import { GenerationStatus, GeneratedOutput } from "../types";

interface Props {
  status: GenerationStatus;
  generatedLivedocId?: string;
}

function DownloadButton({ output, jobId }: { output: GeneratedOutput; jobId?: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setLoading(true);
    setError(null);
    try {
      const qs = jobId ? `?jobId=${encodeURIComponent(jobId)}` : "";
      const res = await fetch(`/api/download/${output.id}${qs}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = output.fileName || `${output.name || "document"}.${output.format.toLowerCase()}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  if (output.status === "Failed") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="badge badge-red">Failed</span>
        {output.errorString && <span style={{ fontSize: 12, color: "#cc0000" }}>{output.errorString}</span>}
      </div>
    );
  }

  return (
    <div>
      <button className="btn btn-primary" onClick={download} disabled={loading}>
        {loading ? <><span className="spinner" /> Downloading…</> : `Download ${output.format.toUpperCase()}`}
      </button>
      {error && <div style={{ color: "#cc0000", fontSize: 12, marginTop: 4 }}>{error}</div>}
    </div>
  );
}

export default function DownloadPanel({ status, generatedLivedocId }: Props) {
  return (
    <div className="card">
      <div className="section-title" style={{ color: "#1a7340" }}>Generation Complete</div>
      {status.outputs.map(output => (
        <div key={output.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 0", borderBottom: "1px solid #f0f0f0" }}>
          <div>
            <span style={{ fontWeight: 600, fontSize: 14 }}>{output.name || output.format.toUpperCase()}</span>
            {output.fileName && <span style={{ fontSize: 12, color: "#888", marginLeft: 8 }}>{output.fileName}</span>}
          </div>
          <DownloadButton output={output} jobId={generatedLivedocId} />
        </div>
      ))}
    </div>
  );
}
