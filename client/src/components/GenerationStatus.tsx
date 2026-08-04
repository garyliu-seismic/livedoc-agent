import { useEffect, useRef, useState } from "react";
import { GenerationStatus, GeneratedOutput } from "../types";

interface Props {
  generatedLivedocId: string;
  onDone: (status: GenerationStatus) => void;
  onError: (msg: string) => void;
}

function statusBadgeClass(s: string): string {
  if (s === "Completed") return "badge-green";
  if (s === "Failed") return "badge-red";
  if (s === "Generating") return "badge-blue";
  return "badge-grey";
}

function OutputRow({ output }: { output: GeneratedOutput }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid #f0f0f0" }}>
      <div>
        <span style={{ fontWeight: 600, fontSize: 14 }}>{output.name || output.format.toUpperCase()}</span>
        {output.fileName && <span style={{ fontSize: 12, color: "#888", marginLeft: 8 }}>{output.fileName}</span>}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {(output.status === "Queued" || output.status === "Generating") && <span className="spinner" />}
        <span className={`badge ${statusBadgeClass(output.status)}`}>{output.status}</span>
        {output.errorString && <span style={{ fontSize: 12, color: "#cc0000" }}>{output.errorString}</span>}
      </div>
    </div>
  );
}

export default function GenerationStatusPanel({ generatedLivedocId, onDone, onError }: Props) {
  const stopped = useRef(false);
  const [outputs, setOutputs] = useState<GeneratedOutput[]>([]);

  useEffect(() => {
    stopped.current = false;
    let delay = 1500;

    async function poll() {
      if (stopped.current) return;
      try {
        const res = await fetch(`/api/status/${generatedLivedocId}`);
        const data: GenerationStatus = await res.json();
        if (!res.ok) throw new Error((data as unknown as { error: string }).error ?? `HTTP ${res.status}`);
        setOutputs(data.outputs);
        if (data.allDone) {
          onDone(data);
        } else {
          delay = Math.min(delay * 1.3, 5000);
          setTimeout(poll, delay);
        }
      } catch (e: unknown) {
        onError(e instanceof Error ? e.message : String(e));
      }
    }

    poll();
    return () => { stopped.current = true; };
  }, [generatedLivedocId]);

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <span className="spinner" style={{ width: 18, height: 18, borderWidth: 2 }} />
        <div className="section-title" style={{ margin: 0 }}>Generating…</div>
      </div>
      {outputs.length === 0 ? (
        <p style={{ fontSize: 13, color: "#666" }}>Starting generation, please wait…</p>
      ) : (
        outputs.map(o => <OutputRow key={o.id} output={o} />)
      )}
    </div>
  );
}
