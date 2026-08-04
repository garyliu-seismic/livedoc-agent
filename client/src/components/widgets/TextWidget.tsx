interface Props {
  name: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
}

export default function TextWidget({ name, label, value, onChange, required }: Props) {
  return (
    <div className="field-group">
      <label className="field-label" htmlFor={name}>
        {label}{required && <span style={{ color: "#cc0000" }}> *</span>}
      </label>
      <textarea
        id={name}
        className="field-input"
        value={value}
        onChange={e => onChange(e.target.value)}
        rows={value.length > 80 ? 3 : 1}
        style={{ resize: "vertical", lineHeight: 1.5 }}
      />
    </div>
  );
}
