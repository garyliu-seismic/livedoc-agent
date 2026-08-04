import { AdhocInputResp } from "../../types";

interface TableValue {
  columns: string[];
  rows: unknown[][];
}

interface Props {
  name: string;
  label: string;
  columns: AdhocInputResp[];
  value: TableValue;
  onChange: (v: TableValue) => void;
}

function isBool(t: string) { return t === "BOOL" || t === "BOOLEAN"; }

function emptyRow(cols: AdhocInputResp[]): unknown[] {
  return cols.map(c => isBool(c.type) ? false : "");
}

export default function TableWidget({ name, label, columns, value, onChange }: Props) {
  const cols = value.columns.length ? value.columns : columns.map(c => c.name);
  const rows = value.rows;

  function updateCell(ri: number, ci: number, v: unknown) {
    const newRows = rows.map((r, i) => i === ri ? r.map((c, j) => j === ci ? v : c) : r);
    onChange({ columns: cols, rows: newRows });
  }

  function addRow() {
    onChange({ columns: cols, rows: [...rows, emptyRow(columns)] });
  }

  function removeRow(ri: number) {
    onChange({ columns: cols, rows: rows.filter((_, i) => i !== ri) });
  }

  const colTypes = columns.map(c => c.type);

  return (
    <div className="field-group">
      <label className="field-label">{label}</label>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr>
              {cols.map(c => (
                <th key={c} style={{ textAlign: "left", padding: "6px 8px", background: "#f5f5f7", border: "1px solid #e5e5e5", fontWeight: 600 }}>{c}</th>
              ))}
              <th style={{ width: 40, background: "#f5f5f7", border: "1px solid #e5e5e5" }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri}>
                {(row as unknown[]).map((cell, ci) => (
                  <td key={ci} style={{ padding: "4px 6px", border: "1px solid #e5e5e5" }}>
                    {isBool(colTypes[ci]) ? (
                      <input type="checkbox" checked={!!cell} onChange={e => updateCell(ri, ci, e.target.checked)} />
                    ) : colTypes[ci] === "INTEGER" ? (
                      <input type="number" step="1" value={cell as string} onChange={e => updateCell(ri, ci, e.target.value)} style={{ width: "100%", border: "none", padding: "2px 4px", fontSize: 13 }} />
                    ) : colTypes[ci] === "FLOAT" ? (
                      <input type="number" step="any" value={cell as string} onChange={e => updateCell(ri, ci, e.target.value)} style={{ width: "100%", border: "none", padding: "2px 4px", fontSize: 13 }} />
                    ) : colTypes[ci] === "DATE" ? (
                      <input type="date" value={cell as string} onChange={e => updateCell(ri, ci, e.target.value)} style={{ width: "100%", border: "none", padding: "2px 4px", fontSize: 13 }} />
                    ) : (
                      <input type="text" value={cell as string} onChange={e => updateCell(ri, ci, e.target.value)} style={{ width: "100%", border: "none", padding: "2px 4px", fontSize: 13 }} />
                    )}
                  </td>
                ))}
                <td style={{ textAlign: "center", border: "1px solid #e5e5e5" }}>
                  <button onClick={() => removeRow(ri)} style={{ background: "none", border: "none", color: "#cc0000", cursor: "pointer", fontSize: 16, lineHeight: 1 }} title="Remove row">×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button className="btn btn-secondary" onClick={addRow} style={{ marginTop: 8, fontSize: 13 }}>
        + Add Row
      </button>
      <div id={name} />
    </div>
  );
}
