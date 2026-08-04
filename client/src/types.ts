export interface AdhocInputResp {
  id: string;
  name: string;
  type: string; // STRING | INTEGER | FLOAT | BOOL | BOOLEAN | DATE | TABLE
  format?: string | null;
  columns?: AdhocInputResp[]; // non-empty → TABLE type
}

export interface VariableListData {
  variableListName: string;
  dataSourceId?: string | null;
  dataSourceName?: string | null;
  variableInputs: AdhocInputResp[];
}

export interface ContentCandidate {
  versionId: string;
  sourceBlobId?: string | null;
  title: string;
  format: string;
}

export interface ManualSelectContentItem {
  id: string;
  name: string;
  isInclude: boolean;
  orderIndex: number;
  contentType?: string | null;
  previewBlobId?: string | null;
  // Present only for non-Group/Section items — real content resolved server-side via search,
  // using the item's own filter (never a free-text guess from its display name).
  candidates?: ContentCandidate[];
  candidatesTotalCount?: number;
  // Which candidate versionIds are currently checked — multiple documents can be attached to
  // the same slot. Defaults to the first candidate on load.
  selectedVersionIds?: string[];
}

export interface ManualSelectContentInput {
  manualSelectContentItems: ManualSelectContentItem[];
}

export interface ImageUploadContentItem {
  id: string;
  name: string;
  blobId?: string | null;
}

export interface ImageUploadContentInput {
  imageUploadContentItems: ImageUploadContentItem[];
}

export interface FormOutput {
  format: string;
  name: string;
}

export interface FormOutputResp {
  id: string;
  name: string;
  isDefault: boolean;
  outputs: FormOutput[];
}

export interface LiveDocVersionResp {
  name?: string;
  adhocInputs: AdhocInputResp[];
  variableListData: VariableListData[];
  manualSelectContentInput?: ManualSelectContentInput;
  imageUploadContentInput?: ImageUploadContentInput;
  forms: FormOutputResp[];
}

// Generation request payload
export interface AdHocInputValue {
  name: string;
  value: unknown;
}

export interface VarListInputValue {
  variableListName: string;
  variableInputs: AdHocInputValue[];
}

export interface OutputRequest {
  format: string;
  name?: string;
  fileName?: string;
}

export interface ManualSelectContentItemReq {
  id: string;
  name?: string;
  contentType: string;
  versionId?: string;
  sourceBlobId?: string;
  isInclude: boolean;
  orderIndex?: number;
}

export interface GenerateRequest {
  adHocInputs: AdHocInputValue[];
  outputs: OutputRequest[];
  variableListData?: VarListInputValue[];
  manualSelectContentInput?: { manualSelectContentItems: ManualSelectContentItemReq[] };
  imageUploadContentInput?: { imageUploadContentItems: { id: string; name: string; blobId: string }[] };
}

// Prefill values passed via URL from MCP (optional AI-generated defaults)
export interface PrefillValues {
  adHocInputs?: Array<{ name: string; value: unknown }>;
  variableListData?: Array<{
    variableListName: string;
    variableInputs: Array<{ name: string; value: unknown }>;
  }>;
}

// Generation status
export interface GeneratedOutput {
  id: string;
  status: string; // Queued | Generating | Completed | Failed
  format: string;
  name: string;
  fileName: string;
  errorString?: string | null;
}

export interface GenerationStatus {
  generatedLivedocId: string;
  allDone: boolean;
  outputs: GeneratedOutput[];
}
