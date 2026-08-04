interface Props {
  name: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
}

export default function DateWidget({ name, label, value, onChange }: Props) {
  return (
    <div className="field-group">
      <label className="field-label" htmlFor={name}>{label}</label>
      <input
        id={name}
        type="date"
        className="field-input"
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{ maxWidth: 200 }}
      />
    </div>
  );
}
