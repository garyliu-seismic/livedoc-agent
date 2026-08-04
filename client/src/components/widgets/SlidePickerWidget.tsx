import { ManualSelectContentItem } from "../../types";

interface Props {
  items: ManualSelectContentItem[];
  onChange: (items: ManualSelectContentItem[]) => void;
}

export default function SlidePickerWidget({ items, onChange }: Props) {
  function toggleGroup(id: string) {
    onChange(items.map(item => item.id === id ? { ...item, isInclude: !item.isInclude } : item));
  }

  // Multiple documents can be attached to the same slot, so each candidate is its own
  // checkbox rather than a single-select dropdown.
  function toggleCandidate(id: string, versionId: string) {
    onChange(items.map(item => {
      if (item.id !== id) return item;
      const current = item.selectedVersionIds ?? [];
      const selectedVersionIds = current.includes(versionId)
        ? current.filter(v => v !== versionId)
        : [...current, versionId];
      return { ...item, selectedVersionIds };
    }));
  }

  if (!items.length) return null;

  return (
    <div className="field-group">
      <label className="field-label">Content Sections</label>
      <div className="card" style={{ padding: "12px 16px" }}>
        {items.map(item => {
          if (!item.candidates) {
            return (
              <label key={item.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", cursor: "pointer", borderBottom: "1px solid #f0f0f0" }}>
                <input
                  type="checkbox"
                  checked={item.isInclude}
                  onChange={() => toggleGroup(item.id)}
                  style={{ width: 16, height: 16 }}
                />
                <span style={{ fontSize: 14 }}>{item.name}</span>
                {item.contentType && <span className="badge badge-grey" style={{ fontSize: 11 }}>{item.contentType}</span>}
              </label>
            );
          }

          if (!item.candidates.length) {
            return (
              <div key={item.id} style={{ padding: "10px 0", borderBottom: "1px solid #f0f0f0" }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{item.name}</div>
                <span className="badge badge-red">No matching content found</span>
              </div>
            );
          }

          const truncated = (item.candidatesTotalCount ?? item.candidates.length) > item.candidates.length;
          const selected = item.selectedVersionIds ?? [];

          return (
            <div key={item.id} style={{ padding: "10px 0", borderBottom: "1px solid #f0f0f0" }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
                {item.name}
                {truncated && (
                  <span className="badge badge-grey" style={{ marginLeft: 8, fontSize: 11, fontWeight: 500 }}>
                    Showing {item.candidates.length} of {item.candidatesTotalCount} matches
                  </span>
                )}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {item.candidates.map(c => (
                  <label key={c.versionId} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={selected.includes(c.versionId)}
                      onChange={() => toggleCandidate(item.id, c.versionId)}
                      style={{ width: 16, height: 16 }}
                    />
                    <span style={{ fontSize: 14 }}>{c.title}</span>
                    <span className="badge badge-blue" style={{ fontSize: 11 }}>{c.format}</span>
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
