import { useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { LiveDocVersionResp, GenerationStatus, UcbGenerationStatusResp, UcbWorkspaceConfig, UcbOriginConfig } from "../types";
import FormBuilder, { initFormState, buildGenerateRequest } from "./FormBuilder";
import GenerationStatusPanel from "./GenerationStatus";
import UcbGenerationStatusPanel from "./UcbGenerationStatus";
import DownloadPanel from "./DownloadPanel";

type Phase = "loading" | "form" | "generating" | "done" | "error";

interface FormState {
  adhocValues: Record<string, unknown>;
  varListValues: Record<string, Record<string, unknown>>;
  slideItems: import("../types").ManualSelectContentItem[];
  imageItems: import("../types").ImageUploadContentItem[];
  selectedOutputs: string[];
}

export default function FormPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const teamSiteId = params.get("teamSiteId") ?? "";
  const versionId = params.get("versionId") ?? "";
  const contextB64 = params.get("context") ?? "";
  const resultToken = params.get("token") ?? "";
  const prefillB64 = params.get("prefill") ?? "";
  const workspaceB64 = params.get("workspace") ?? "";
  const originB64 = params.get("origin") ?? "";

  // Present only when open_form_ui was called with workspace/origin context — routes
  // submission through the UCB Workspace generation endpoint instead of the default
  // download flow.
  const ucbWorkspace: UcbWorkspaceConfig | null = workspaceB64
    ? (() => { try { return JSON.parse(atob(workspaceB64)); } catch { return null; } })()
    : null;
  const ucbOrigin: UcbOriginConfig | null = originB64
    ? (() => { try { return JSON.parse(atob(originB64)); } catch { return null; } })()
    : null;
  const isUcbMode = !!(ucbWorkspace && ucbOrigin);

  const [phase, setPhase] = useState<Phase>("loading");
  const [template, setTemplate] = useState<LiveDocVersionResp | null>(null);
  const [formState, setFormState] = useState<FormState | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [generatedId, setGeneratedId] = useState<string | null>(null);
  const [doneStatus, setDoneStatus] = useState<GenerationStatus | null>(null);
  const [ucbDoneStatus, setUcbDoneStatus] = useState<UcbGenerationStatusResp | null>(null);

  // When generation completes: POST result back to Express so MCP can read it, then auto-close
  useEffect(() => {
    if (phase === "done" && doneStatus) {
      const allOk = doneStatus.outputs.every(o => o.status === "Completed");
      if (resultToken) {
        fetch(`/api/result/${resultToken}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ generatedLivedocId: doneStatus.generatedLivedocId, outputs: doneStatus.outputs }),
        }).catch(() => {});
      }
      if (allOk) {
        const t = setTimeout(() => window.close(), 2000);
        return () => clearTimeout(t);
      }
    }
    if (phase === "done" && ucbDoneStatus) {
      if (resultToken) {
        fetch(`/api/result/${resultToken}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ generationId: ucbDoneStatus.generationId, workspaceUrl: ucbDoneStatus.workspaceUrl }),
        }).catch(() => {});
      }
      const t = setTimeout(() => window.close(), 2000);
      return () => clearTimeout(t);
    }
  }, [phase, doneStatus, ucbDoneStatus]);

  useEffect(() => {
    if (!teamSiteId || !versionId) {
      setErrorMsg("Missing teamSiteId or versionId in URL parameters.");
      setPhase("error");
      return;
    }
    fetch(`/api/template/${teamSiteId}/${versionId}`)
      .then(r => r.json().then(d => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!ok) {
          const detail = d.detail ? (typeof d.detail === "string" ? d.detail : JSON.stringify(d.detail)) : "";
          throw new Error(`${d.error ?? "Failed to load template"}${detail ? `: ${detail}` : ""}`);
        }
        const t = d as LiveDocVersionResp;
        setTemplate(t);
        const prefill = prefillB64 ? (() => { try { return JSON.parse(atob(prefillB64)); } catch { return undefined; } })() : undefined;
        setFormState(initFormState(t, prefill));
        if (contextB64) prefillFromContext(t);
        setPhase("form");
      })
      .catch((e: unknown) => {
        setErrorMsg(e instanceof Error ? e.message : String(e));
        setPhase("error");
      });
  }, [teamSiteId, versionId]);

  function prefillFromContext(_t: LiveDocVersionResp) {
    // future: call /api/claude/assist with decoded context to get suggested values
  }

  async function submit() {
    if (!template || !formState) return;
    if (formState.selectedOutputs.length === 0) {
      setErrorMsg("Please select at least one output format.");
      return;
    }
    setSubmitting(true);
    setErrorMsg(null);
    try {
      const payload = buildGenerateRequest(template, formState);
      // UCB requires exactly one output. The selected button may bundle multiple formats
      // (e.g. "PPTX + PDF") in whatever order the API happened to return them — prefer PPTX
      // explicitly rather than relying on array order, falling back to the first format.
      const ucbFormat = payload.outputs.find(o => o.format.toUpperCase() === "PPTX")?.format ?? payload.outputs[0].format;
      const endpoint = isUcbMode ? `/api/ucb-generate/${teamSiteId}/${versionId}` : `/api/generate/${teamSiteId}/${versionId}`;
      const body = isUcbMode
        ? {
            adHocInputs: payload.adHocInputs,
            variableListData: payload.variableListData,
            outputs: [{ format: ucbFormat }],
            workspace: {
              spaceId: ucbWorkspace!.spaceId,
              folderId: ucbWorkspace!.folderId,
              name: ucbWorkspace!.name || template.name || "LiveDoc",
              format: ucbFormat,
            },
            origin: ucbOrigin,
          }
        : payload;

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        const detail = data.detail ? (typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail)) : "";
        throw new Error(`${data.error ?? `HTTP ${res.status}`}${detail ? `: ${detail}` : ""}`);
      }

      if (isUcbMode) {
        if (!data.generationId) throw new Error("No generationId in response");
        setGeneratedId(data.generationId);
      } else {
        const id = data.generatedLivedocId ?? data.id;
        if (!id) throw new Error("No generatedLivedocId in response");
        setGeneratedId(id);
      }
      setPhase("generating");
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const context = contextB64 ? (() => { try { return atob(contextB64); } catch { return ""; } })() : "";

  if (phase === "loading") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "60px 0", justifyContent: "center" }}>
        <span className="spinner" style={{ width: 24, height: 24, borderWidth: 3 }} />
        <span style={{ color: "#666" }}>Loading template…</span>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div>
        <div className="error-box" style={{ marginBottom: 16 }}>{errorMsg}</div>
        <button className="btn btn-secondary" onClick={() => navigate("/")}>← Back to Search</button>
      </div>
    );
  }

  if (phase === "generating" && generatedId) {
    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
          <div className="section-title" style={{ margin: 0 }}>Generating Document</div>
        </div>
        {isUcbMode ? (
          <UcbGenerationStatusPanel
            generationId={generatedId}
            onDone={s => { setUcbDoneStatus(s); setPhase("done"); }}
            onError={msg => { setErrorMsg(msg); setPhase("error"); }}
          />
        ) : (
          <GenerationStatusPanel
            generatedLivedocId={generatedId}
            onDone={s => { setDoneStatus(s); setPhase("done"); }}
            onError={msg => { setErrorMsg(msg); setPhase("error"); }}
          />
        )}
      </div>
    );
  }

  if (phase === "done" && doneStatus) {
    const allSucceeded = doneStatus.outputs.every(o => o.status === "Completed");
    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
          <div className="section-title" style={{ margin: 0 }}>
            {allSucceeded ? "✓ Document Ready" : "Generation Complete"}
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            {allSucceeded && (
              <button className="btn btn-primary" onClick={() => window.close()} style={{ fontSize: 13 }}>
                Close &amp; Return to Claude
              </button>
            )}
            <button className="btn btn-secondary" onClick={() => { setPhase("form"); setGeneratedId(null); setDoneStatus(null); }}>Generate Again</button>
          </div>
        </div>
        {allSucceeded && (
          <div style={{ background: "#f0faf0", border: "1px solid #b2dfb2", borderRadius: 8, padding: "10px 16px", marginBottom: 16, fontSize: 14, color: "#2e7d32" }}>
            Generation complete! Closing this tab automatically… or click "Close &amp; Return to Claude" above.
          </div>
        )}
        <DownloadPanel status={doneStatus} generatedLivedocId={generatedId ?? undefined} />
      </div>
    );
  }

  if (phase === "done" && ucbDoneStatus) {
    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
          <div className="section-title" style={{ margin: 0 }}>✓ Saved to Workspace</div>
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn btn-primary" onClick={() => window.close()} style={{ fontSize: 13 }}>
              Close &amp; Return to Claude
            </button>
            <button className="btn btn-secondary" onClick={() => { setPhase("form"); setGeneratedId(null); setUcbDoneStatus(null); }}>Generate Again</button>
          </div>
        </div>
        <div style={{ background: "#f0faf0", border: "1px solid #b2dfb2", borderRadius: 8, padding: "10px 16px", marginBottom: 16, fontSize: 14, color: "#2e7d32" }}>
          Document generated and committed to Workspace! Closing this tab automatically… or click "Close &amp; Return to Claude" above.
        </div>
        {ucbDoneStatus.workspaceUrl && (
          <div className="card">
            <a href={ucbDoneStatus.workspaceUrl} target="_blank" rel="noopener noreferrer" className="btn btn-primary" style={{ display: "inline-flex" }}>
              Open in Workspace →
            </a>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <button className="btn btn-secondary" style={{ marginBottom: 12, fontSize: 13 }} onClick={() => navigate("/")}>← Back</button>
          {!template?.name && <div className="section-title" style={{ margin: 0 }}>Fill Out Template</div>}
          {context && (
            <div style={{ fontSize: 13, color: "#666", marginTop: 4 }}>
              Context: <em>{context.slice(0, 120)}{context.length > 120 ? "…" : ""}</em>
            </div>
          )}
        </div>
      </div>

      {errorMsg && <div className="error-box" style={{ marginBottom: 16 }}>{errorMsg}</div>}

      {isUcbMode && (
        <div style={{ background: "#e8f0fe", border: "1px solid #b3d1fb", borderRadius: 8, padding: "10px 16px", marginBottom: 16, fontSize: 13, color: "#0066cc" }}>
          This will save directly to Seismic Workspace (space: {ucbWorkspace!.spaceId}, folder: {ucbWorkspace!.folderId}) instead of downloading. Only the first selected output format will be used.
        </div>
      )}

      <div className="card" style={{ marginBottom: 24 }}>
        {template && formState && (
          <FormBuilder
            template={template}
            state={formState}
            onChange={setFormState}
          />
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          className="btn btn-primary"
          onClick={submit}
          disabled={submitting || !formState?.selectedOutputs.length}
          style={{ padding: "10px 28px", fontSize: 15 }}
        >
          {submitting ? <><span className="spinner" /> Submitting…</> : (isUcbMode ? "Generate to Workspace →" : "Generate Document →")}
        </button>
      </div>
    </div>
  );
}
