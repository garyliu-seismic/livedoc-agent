import { AdhocInputResp, LiveDocVersionResp, ManualSelectContentItem, ImageUploadContentItem, AdHocInputValue, VarListInputValue, GenerateRequest, PrefillValues } from "../types";
import TextWidget from "./widgets/TextWidget";
import NumberWidget from "./widgets/NumberWidget";
import DateWidget from "./widgets/DateWidget";
import ToggleWidget from "./widgets/ToggleWidget";
import TableWidget from "./widgets/TableWidget";
import SlidePickerWidget from "./widgets/SlidePickerWidget";
import ImageUploadWidget from "./widgets/ImageUploadWidget";

interface TableValue { columns: string[]; rows: unknown[][]; }

interface FormState {
  adhocValues: Record<string, unknown>;
  varListValues: Record<string, Record<string, unknown>>;
  slideItems: ManualSelectContentItem[];
  imageItems: ImageUploadContentItem[];
  selectedOutputs: string[];
}

interface Props {
  template: LiveDocVersionResp;
  state: FormState;
  onChange: (s: FormState) => void;
}

function isTableInput(input: AdhocInputResp): boolean {
  return input.type === "TABLE" || !!(input.columns && input.columns.length > 0);
}

function isBool(type: string): boolean {
  return type === "BOOL" || type === "BOOLEAN";
}

function defaultTableValue(input: AdhocInputResp): TableValue {
  return { columns: input.columns!.map(c => c.name), rows: [] };
}

function renderScalarWidget(
  input: AdhocInputResp,
  value: unknown,
  onUpdate: (v: unknown) => void,
  prefix = ""
) {
  const key = prefix + input.name;
  if (input.type === "INTEGER") return <NumberWidget key={key} name={key} label={input.name} value={String(value ?? "")} onChange={onUpdate} />;
  if (input.type === "FLOAT") return <NumberWidget key={key} name={key} label={input.name} value={String(value ?? "")} isFloat onChange={onUpdate} />;
  if (isBool(input.type)) return <ToggleWidget key={key} name={key} label={input.name} value={!!value} onChange={onUpdate} />;
  if (input.type === "DATE") return <DateWidget key={key} name={key} label={input.name} value={String(value ?? "")} onChange={onUpdate} />;
  return <TextWidget key={key} name={key} label={input.name} value={String(value ?? "")} onChange={v => onUpdate(v)} />;
}

export function buildGenerateRequest(template: LiveDocVersionResp, state: FormState): GenerateRequest {
  const adHocInputs: AdHocInputValue[] = (template.adhocInputs ?? []).map(input => {
    const raw = state.adhocValues[input.name];
    if (isTableInput(input)) {
      const tv = (raw as TableValue | undefined) ?? defaultTableValue(input);
      return {
        name: input.name,
        value: {
          columns: tv.columns,
          rows: tv.rows.map(row =>
            (row as unknown[]).map((cell, ci) => {
              const colType = input.columns![ci]?.type;
              if (colType === "INTEGER") return parseInt(String(cell), 10) || 0;
              if (colType === "FLOAT") return parseFloat(String(cell)) || 0;
              if (isBool(colType ?? "")) return !!cell;
              return cell;
            })
          ),
        },
      };
    }
    return { name: input.name, value: coerceValue(input.type, raw) };
  });

  const variableListData: VarListInputValue[] = (template.variableListData ?? []).map(vl => ({
    variableListName: vl.variableListName,
    variableInputs: (vl.variableInputs ?? []).map(input => {
      const raw = state.varListValues[vl.variableListName]?.[input.name];
      if (isTableInput(input)) {
        const tv = (raw as TableValue | undefined) ?? defaultTableValue(input);
        return {
          name: input.name,
          value: {
            columns: tv.columns,
            rows: tv.rows.map(row =>
              (row as unknown[]).map((cell, ci) => {
                const colType = input.columns![ci]?.type;
                if (colType === "INTEGER") return parseInt(String(cell), 10) || 0;
                if (colType === "FLOAT") return parseFloat(String(cell)) || 0;
                if (isBool(colType ?? "")) return !!cell;
                return cell;
              })
            ),
          },
        };
      }
      return { name: input.name, value: coerceValue(input.type, raw) };
    }),
  }));

  const req: GenerateRequest = {
    adHocInputs,
    outputs: state.selectedOutputs.map(fmt => ({ format: fmt })),
  };

  if (variableListData.length) req.variableListData = variableListData;

  if (state.slideItems.length) {
    req.manualSelectContentInput = {
      manualSelectContentItems: state.slideItems.flatMap(item => {
        // Group/Section items map 1:1. Items with candidates can have multiple documents
        // attached to the same slot — emit one manualSelectContentItem PER SELECTED candidate
        // (all sharing this slot's id/name), or a single isInclude:false item if none selected.
        if (!item.candidates) {
          return [{
            id: item.id,
            name: item.name,
            contentType: item.contentType ?? "Group",
            isInclude: item.isInclude,
            orderIndex: item.orderIndex,
          }];
        }
        const selected = item.candidates.filter(c => (item.selectedVersionIds ?? []).includes(c.versionId));
        if (!selected.length) {
          return [{ id: item.id, name: item.name, contentType: "LiveSlide", isInclude: false, orderIndex: item.orderIndex }];
        }
        return selected.map(c => ({
          id: item.id,
          name: item.name,
          contentType: c.format.toUpperCase() === "PDF" ? "ResourcePDF" : "LiveSlide",
          versionId: c.versionId,
          sourceBlobId: c.sourceBlobId ?? undefined,
          isInclude: true,
          orderIndex: item.orderIndex,
        }));
      }),
    };
  }

  if (state.imageItems.some(i => i.blobId)) {
    req.imageUploadContentInput = {
      imageUploadContentItems: state.imageItems
        .filter(i => i.blobId)
        .map(i => ({ id: i.id, name: i.name, blobId: i.blobId! })),
    };
  }

  return req;
}

function coerceValue(type: string, raw: unknown): unknown {
  if (raw === undefined || raw === null || raw === "") return "";
  if (type === "INTEGER") return parseInt(String(raw), 10) || 0;
  if (type === "FLOAT") return parseFloat(String(raw)) || 0;
  if (isBool(type)) return !!raw;
  return raw;
}

function applyTablePrefill(pv: unknown, input: AdhocInputResp): TableValue {
  if (pv && typeof pv === "object" && !Array.isArray(pv)) {
    const t = pv as { columns?: string[]; rows?: unknown[][] };
    if (Array.isArray(t.columns) && Array.isArray(t.rows)) return { columns: t.columns, rows: t.rows };
  }
  return defaultTableValue(input);
}

export function initFormState(template: LiveDocVersionResp, prefill?: PrefillValues): FormState {
  const padhoc: Record<string, unknown> = {};
  for (const item of (prefill?.adHocInputs ?? [])) padhoc[item.name] = item.value;

  const pvl: Record<string, Record<string, unknown>> = {};
  for (const vl of (prefill?.variableListData ?? [])) {
    pvl[vl.variableListName] = {};
    for (const item of (vl.variableInputs ?? [])) pvl[vl.variableListName][item.name] = item.value;
  }

  const adhocValues: Record<string, unknown> = {};
  for (const input of (template.adhocInputs ?? [])) {
    if (input.name in padhoc) {
      adhocValues[input.name] = isTableInput(input) ? applyTablePrefill(padhoc[input.name], input) : padhoc[input.name];
    } else {
      adhocValues[input.name] = isTableInput(input) ? defaultTableValue(input) : (isBool(input.type) ? false : "");
    }
  }

  const varListValues: Record<string, Record<string, unknown>> = {};
  for (const vl of (template.variableListData ?? [])) {
    varListValues[vl.variableListName] = {};
    const vlp = pvl[vl.variableListName] ?? {};
    for (const input of (vl.variableInputs ?? [])) {
      if (input.name in vlp) {
        varListValues[vl.variableListName][input.name] = isTableInput(input) ? applyTablePrefill(vlp[input.name], input) : vlp[input.name];
      } else {
        varListValues[vl.variableListName][input.name] = isTableInput(input) ? defaultTableValue(input) : (isBool(input.type) ? false : "");
      }
    }
  }

  const slideItems = (template.manualSelectContentInput?.manualSelectContentItems ?? []).map(item => (
    item.candidates?.length ? { ...item, selectedVersionIds: [item.candidates[0].versionId] } : item
  ));
  const imageItems = template.imageUploadContentInput?.imageUploadContentItems ?? [];

  const firstForm = (template.forms ?? [])[0];
  const selectedOutputs = firstForm ? firstForm.outputs.map(o => o.format) : [];

  return { adhocValues, varListValues, slideItems, imageItems, selectedOutputs };
}

export default function FormBuilder({ template, state, onChange }: Props) {
  function updateAdhoc(name: string, value: unknown) {
    onChange({ ...state, adhocValues: { ...state.adhocValues, [name]: value } });
  }

  function updateVarList(listName: string, fieldName: string, value: unknown) {
    onChange({
      ...state,
      varListValues: {
        ...state.varListValues,
        [listName]: { ...state.varListValues[listName], [fieldName]: value },
      },
    });
  }

  const allForms = template.forms ?? [];
  const selectedKey = state.selectedOutputs.slice().sort().join(",");

  function selectForm(form: typeof allForms[number]) {
    onChange({ ...state, selectedOutputs: form.outputs.map(o => o.format) });
  }

  const scalarAdhoc = (template.adhocInputs ?? []).filter(i => !isTableInput(i));
  const tableAdhoc  = (template.adhocInputs ?? []).filter(i => isTableInput(i));

  return (
    <div>
      {/* Form title */}
      {template.name && (
        <div className="section-title" style={{ marginBottom: 20 }}>
          {template.name} — inputs
        </div>
      )}

      {/* Scalar ad-hoc inputs in a responsive grid */}
      {scalarAdhoc.length > 0 && (
        <section style={{ marginBottom: 24 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "12px 16px", alignItems: "end" }}>
            {scalarAdhoc.map(input =>
              renderScalarWidget(input, state.adhocValues[input.name], v => updateAdhoc(input.name, v))
            )}
          </div>
        </section>
      )}

      {/* Table ad-hoc inputs */}
      {tableAdhoc.map(input => (
        <section key={input.name} style={{ marginBottom: 24 }}>
          <TableWidget
            name={input.name}
            label={input.name}
            columns={input.columns!}
            value={(state.adhocValues[input.name] as TableValue | undefined) ?? defaultTableValue(input)}
            onChange={v => updateAdhoc(input.name, v)}
          />
        </section>
      ))}

      {/* Variable lists */}
      {(template.variableListData ?? []).map(vl => {
        const scalarVl = (vl.variableInputs ?? []).filter(i => !isTableInput(i));
        const tableVl  = (vl.variableInputs ?? []).filter(i => isTableInput(i));
        return (
          <section key={vl.variableListName} style={{ marginBottom: 24 }}>
            <div className="section-title" style={{ fontSize: 14, color: "#555", marginBottom: 12 }}>
              Variable list — {vl.variableListName}
              {vl.dataSourceName && <span className="badge badge-blue" style={{ marginLeft: 8, fontSize: 11 }}>{vl.dataSourceName}</span>}
            </div>
            {scalarVl.length > 0 && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "12px 16px", alignItems: "end", marginBottom: tableVl.length ? 16 : 0 }}>
                {scalarVl.map(input =>
                  renderScalarWidget(
                    input,
                    state.varListValues[vl.variableListName]?.[input.name],
                    v => updateVarList(vl.variableListName, input.name, v),
                    `${vl.variableListName}__`
                  )
                )}
              </div>
            )}
            {tableVl.map(input => (
              <TableWidget
                key={input.name}
                name={`${vl.variableListName}__${input.name}`}
                label={input.name}
                columns={input.columns!}
                value={(state.varListValues[vl.variableListName]?.[input.name] as TableValue | undefined) ?? defaultTableValue(input)}
                onChange={v => updateVarList(vl.variableListName, input.name, v)}
              />
            ))}
          </section>
        );
      })}

      {/* Slide picker */}
      {state.slideItems.length > 0 && (
        <section style={{ marginBottom: 24 }}>
          <div className="section-title" style={{ fontSize: 14, color: "#555", marginBottom: 12 }}>Content Selection</div>
          <SlidePickerWidget
            items={state.slideItems}
            onChange={items => onChange({ ...state, slideItems: items })}
          />
        </section>
      )}

      {/* Image uploads */}
      {state.imageItems.length > 0 && (
        <section style={{ marginBottom: 24 }}>
          <div className="section-title" style={{ fontSize: 14, color: "#555", marginBottom: 12 }}>Images</div>
          <ImageUploadWidget
            items={state.imageItems}
            onChange={items => onChange({ ...state, imageItems: items })}
          />
        </section>
      )}

      {/* Output format — one button per form entry */}
      <section style={{ marginBottom: 8 }}>
        <div className="section-title" style={{ fontSize: 14, color: "#555", marginBottom: 12 }}>Output format</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {allForms.map(form => {
            const formKey = form.outputs.map(o => o.format).sort().join(",");
            const active = formKey === selectedKey;
            return (
              <button
                key={form.id}
                onClick={() => selectForm(form)}
                style={{
                  padding: "7px 18px",
                  borderRadius: 20,
                  border: "none",
                  background: active ? "#0066cc" : "#f0f0f0",
                  color: active ? "#fff" : "#444",
                  fontSize: 14,
                  fontWeight: 500,
                  cursor: "pointer",
                  transition: "background 0.15s",
                }}
              >
                {form.outputs.map(o => o.format.toUpperCase()).join(" + ")}
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
