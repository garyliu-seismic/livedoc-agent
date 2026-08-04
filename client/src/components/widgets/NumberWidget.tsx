interface Props {
  name: string;
  label: string;
  value: string;
  isFloat?: boolean;
  onChange: (v: string) => void;
}

export default function NumberWidget({ name, label, value, isFloat, onChange }: Props) {
  return (
    <div className="field-group">
      <label className="field-label" htmlFor={name}>{label}</label>
      <input
        id={name}
        type="number"
        className="field-input"
        value={value}
        step={isFloat ? "any" : "1"}
        onChange={e => onChange(e.target.value)}
        style={{ maxWidth: 200 }}
      />
    </div>
  );
}
