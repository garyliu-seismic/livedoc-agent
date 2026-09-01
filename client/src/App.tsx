import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import TemplateSearch from "./components/TemplateSearch";
import ChatPanel from "./components/ChatPanel";

const styles = `
  .app-header { background: #fff; border-bottom: 1px solid #e5e5e5; padding: 0 24px; height: 52px; display: flex; align-items: center; gap: 12px; position: sticky; top: 0; z-index: 10; }
  .app-logo { font-weight: 700; font-size: 15px; color: #0066cc; letter-spacing: -0.3px; }
  .app-main { max-width: 900px; margin: 0 auto; padding: 32px 24px; }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 16px; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; border: none; transition: background 0.15s; }
  .btn-primary { background: #0066cc; color: #fff; }
  .btn-primary:hover { background: #0055b3; }
  .btn-primary:disabled { background: #99c2e8; cursor: not-allowed; }
  .btn-secondary { background: #f0f0f0; color: #1d1d1f; }
  .btn-secondary:hover { background: #e5e5e5; }
  .card { background: #fff; border-radius: 12px; border: 1px solid #e5e5e5; padding: 20px; }
  .field-group { margin-bottom: 18px; }
  .field-label { display: block; font-size: 13px; font-weight: 600; color: #444; margin-bottom: 6px; }
  .field-input { width: 100%; padding: 8px 12px; border: 1px solid #d0d0d0; border-radius: 8px; font-size: 14px; outline: none; transition: border-color 0.15s; }
  .field-input:focus { border-color: #0066cc; }
  .field-hint { font-size: 12px; color: #888; margin-top: 4px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 100px; font-size: 12px; font-weight: 600; }
  .badge-blue { background: #e8f0fe; color: #0066cc; }
  .badge-green { background: #e6f4ea; color: #1a7340; }
  .badge-red { background: #fce8e8; color: #b31412; }
  .badge-grey { background: #f0f0f0; color: #666; }
  .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid #e5e5e5; border-top-color: #0066cc; border-radius: 50%; animation: spin 0.7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .error-box { background: #fce8e8; border: 1px solid #f5c6c6; border-radius: 8px; padding: 12px 16px; color: #b31412; font-size: 14px; }
  .section-title { font-size: 16px; font-weight: 700; margin-bottom: 16px; color: #1d1d1f; }
  .divider { border: none; border-top: 1px solid #e5e5e5; margin: 24px 0; }
`;

export default function App() {
  return (
    <>
      <style>{styles}</style>
      <BrowserRouter>
        <header className="app-header">
          <span className="app-logo">LiveDoc Generator</span>
        </header>
        <main className="app-main">
          <Routes>
            <Route path="/" element={<TemplateSearch />} />
            <Route path="/form" element={<ChatPanel />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </BrowserRouter>
    </>
  );
}
