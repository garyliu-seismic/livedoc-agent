import { useState } from "react";
import { ImageUploadContentItem } from "../../types";

interface Props {
  items: ImageUploadContentItem[];
  onChange: (items: ImageUploadContentItem[]) => void;
}

export default function ImageUploadWidget({ items, onChange }: Props) {
  const [uploading, setUploading] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function handleFile(placeholderId: string, file: File) {
    setUploading(u => ({ ...u, [placeholderId]: true }));
    setErrors(e => ({ ...e, [placeholderId]: "" }));
    try {
      const buf = await file.arrayBuffer();
      const res = await fetch("/api/image/upload", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: buf,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const blobId: string = data?.data?.blobid ?? data?.blobid ?? data?.BlobId;
      onChange(items.map(it => it.id === placeholderId ? { ...it, blobId } : it));
    } catch (e: unknown) {
      setErrors(err => ({ ...err, [placeholderId]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setUploading(u => ({ ...u, [placeholderId]: false }));
    }
  }

  if (!items.length) return null;

  return (
    <div className="field-group">
      <label className="field-label">Image Uploads</label>
      {items.map(item => (
        <div key={item.id} className="card" style={{ marginBottom: 10, padding: "12px 16px" }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>{item.name}</div>
          {item.blobId ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span className="badge badge-green">Uploaded</span>
              <span style={{ fontSize: 12, color: "#666" }}>blobId: {item.blobId.slice(0, 8)}…</span>
              <button className="btn btn-secondary" style={{ fontSize: 12, padding: "4px 10px" }}
                onClick={() => onChange(items.map(it => it.id === item.id ? { ...it, blobId: null } : it))}>
                Replace
              </button>
            </div>
          ) : (
            <div>
              <input
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp,image/bmp"
                disabled={uploading[item.id]}
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(item.id, f); }}
              />
              {uploading[item.id] && <span className="spinner" style={{ marginLeft: 8 }} />}
              {errors[item.id] && <div style={{ color: "#cc0000", fontSize: 12, marginTop: 4 }}>{errors[item.id]}</div>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
