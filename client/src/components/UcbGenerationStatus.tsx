import { useEffect, useRef, useState } from "react";
import { UcbGenerationStatusResp } from "../types";

interface Props {
  generationId: string;
  onDone: (status: UcbGenerationStatusResp) => void;
  onError: (msg: string) => void;
}

export default function UcbGenerationStatusPanel({ generationId, onDone, onError }: Props) {
  const stopped = useRef(false);
  const [status, setStatus] = useState<string>("Queued");

  useEffect(() => {
    stopped.current = false;
    let delay = 1500;

    async function poll() {
      if (stopped.current) return;
      try {
        const res = await fetch(`/api/ucb-status/${generationId}`);
        const data: UcbGenerationStatusResp = await res.json();
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

        if (data.commitError) {
          throw new Error(`Generation succeeded but committing to Workspace failed: ${data.commitError}`);
        }
        if (data.error) throw new Error(data.error);

        setStatus(data.status);

        if (data.workspaceCommitted) {
          onDone(data);
        } else if (data.status === "Failure" || data.status === "Cancelled") {
          throw new Error(`Generation ${data.status}`);
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
  }, [generationId]);

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <span className="spinner" style={{ width: 18, height: 18, borderWidth: 2 }} />
        <div className="section-title" style={{ margin: 0 }}>Generating to Workspace…</div>
      </div>
      <p style={{ fontSize: 13, color: "#666" }}>Status: {status}</p>
    </div>
  );
}
