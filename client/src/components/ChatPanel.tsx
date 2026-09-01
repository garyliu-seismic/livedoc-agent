import React, { useState, useEffect, useRef } from 'react';

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  toolsUsed?: boolean;
}

export default function ChatPanel() {
  const [sessionId, setSessionId] = useState<string>('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Create a new session on mount
  useEffect(() => {
    setSessionId(crypto.randomUUID());
    setMessages([{ 
      role: 'system', 
      content: '👋 **LiveDoc Agent Ready!**\n\nI can search your Seismic template library, generate LiveDoc PDFs, and fill out forms for you automatically. What would you like to do?', 
      timestamp: Date.now() 
    }]);
  }, []);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, isSending]);

  const sendMessage = async () => {
    if (!input.trim() || !sessionId) return;

    const userMsg: ChatMessage = { role: 'user', content: input, timestamp: Date.now() };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsSending(true);

    try {
      const res = await fetch(`/api/agent/chat/${sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMsg.content }),
      });
      const data = await res.json();

      if (!res.ok || !data.success) throw new Error(data.error || data.detail);

      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: data.message,
        timestamp: Date.now(),
        toolsUsed: !!data.toolsUsed,
      };
      
      setMessages(prev => [...prev, assistantMsg]);

      if (data.formUrl) {
        window.open(data.formUrl, '_blank', 'noopener,noreferrer');
      }
    } catch (err: any) {
      console.error(err);
      setMessages(prev => [...prev, { 
        role: 'system', 
        content: `❌ Error: ${err.message}`, 
        timestamp: Date.now() 
      }]);
    } finally {
      setIsSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 116px)', padding: '20px', border: '1px solid #e5e5e5', borderRadius: '12px' }}>
      {/* Messages Area */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', marginBottom: '16px', paddingRight: '8px' }}>
        {messages.map((msg, i) => (
          <div key={i} style={{ 
            marginBottom: msg.role === 'assistant' ? '24px' : '12px', 
            maxWidth: '85%', 
            marginLeft: msg.role === 'user' ? 'auto' : '0', 
            marginRight: msg.role === 'assistant' ? '0' : 'auto',
          }}>
            <div style={{ 
              padding: '14px 18px', 
              borderRadius: '16px', 
              marginBottom: '8px',
              background: msg.role === 'user' ? '#0066cc' : (msg.role === 'system' ? '#fff0f0' : '#f7f7f8'),
              color: msg.role === 'user' ? '#ffffff' : '#1a1a1a',
              fontWeight: msg.role === 'assistant' ? 500 : 400,
              fontSize: '14px',
              lineHeight: 1.6,
              boxShadow: msg.role !== 'system' ? '0 2px 8px rgba(0,0,0,0.05)' : 'none'
            }}>
              {msg.content.split('\n').map((line, idx) => <div key={idx}>{line}</div>)}
            </div>
            {msg.role === 'assistant' && ( // Simple markdown-like bold/italic detection
              <span style={{ fontSize: '10px', color: '#999', marginLeft: '8px' }}>{new Date(msg.timestamp).toLocaleTimeString()}</span>
            )}
          </div>
        ))}
        
        {isSending && (
          <div style={{ textAlign: 'center', color: '#888', fontSize: '13px', marginTop: '20px', marginBottom: '6px' }}>
            Agent is thinking and executing tools...
          </div>
        )}

        {/* Only show the badge when a tool actually ran for the last reply */}
        {messages.slice(-1)[0]?.role === 'assistant' && messages.slice(-1)[0]?.toolsUsed && (
          <div style={{ textAlign: 'center', marginTop: '12px', color: '#666', fontSize: '13px' }}>
             ✅ Response generated from MCP tool calls.
          </div>
        )}
      </div>

      {/* Input Area */}
      <div style={{ display: 'flex', gap: '8px' }}>
        <input 
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder='Try: "帮我找销售模板" or "生成PDF"'
          disabled={isSending}
          style={{ 
            flex: 1, padding: '12px', borderRadius: '10px', border: '1px solid #d0d0d0', fontSize: '14px'
          }}
        />
        <button 
          onClick={sendMessage} 
          disabled={!input.trim() || isSending}
          style={{ 
            background: input.trim() && !isSending ? '#0066cc' : '#ccc', 
            color: '#fff', border: 'none', borderRadius: '10px', padding: '0 24px', cursor: 'pointer', fontWeight: 600, fontSize: '14px'
          }}
        >
          {isSending ? '...' : '发送'}
        </button>
      </div>
    </div>
  );
}
