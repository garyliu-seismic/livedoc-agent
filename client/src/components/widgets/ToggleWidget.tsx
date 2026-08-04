interface Props {
  name: string;
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}

export default function ToggleWidget({ name, label, value, onChange }: Props) {
  return (
    <div className="field-group">
      <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
        <input
          id={name}
          type="checkbox"
          checked={value}
          onChange={e => onChange(e.target.checked)}
          style={{ width: 18, height: 18, cursor: "pointer" }}
        />
        <span className="field-label" style={{ margin: 0 }}>{label}</span>
      </label>
    </div>
  );
}
