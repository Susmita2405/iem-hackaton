// src/pages/Login.jsx
import { Github, Zap } from 'lucide-react';

export default function Login() {
  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <div className="text-center space-y-6 max-w-sm w-full px-6">
        <div className="flex justify-center">
          <div className="w-14 h-14 rounded-2xl bg-brand-500 flex items-center justify-center">
            <Zap size={28} className="text-white" />
          </div>
        </div>
        <div>
          <h1 className="text-2xl font-bold text-white">SoumyaOps</h1>
          <p className="text-gray-400 mt-2 text-sm">
            AI-powered team knowledge & DevOps platform
          </p>
        </div>
        <a
          href="/api/auth/github"
          className="flex items-center justify-center gap-3 w-full px-5 py-3
                     bg-white text-gray-900 rounded-xl font-medium text-sm
                     hover:bg-gray-100 transition-colors"
        >
          <Github size={18} />
          Continue with GitHub
        </a>
        <p className="text-xs text-gray-600">
          Requires GitHub repo access to connect your codebase
        </p>
      </div>
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// src/pages/AuthCallback.jsx
import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { api } from '../lib/api';

export default function AuthCallback() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { setToken, setUser } = useAuthStore();

  useEffect(() => {
    const token = params.get('token');
    if (!token) { navigate('/login'); return; }

    setToken(token);
    api.get('/auth/me').then(({ data }) => {
      setUser(data);
      navigate('/dashboard');
    }).catch(() => navigate('/login'));
  }, []);

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <div className="text-gray-400 text-sm">Authenticating...</div>
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// src/pages/Dashboard.jsx
import { useEffect, useState } from 'react';
import { useAuthStore } from '../store/authStore';
import { api } from '../lib/api';
import { MessageSquare, Github, Rocket, Bug, Zap } from 'lucide-react';

export default function Dashboard() {
  const { workspaceId, user } = useAuthStore();
  const [stats, setStats] = useState({});

  useEffect(() => {
    if (!workspaceId) return;
    Promise.all([
      api.get(`/rag/history?workspaceId=${workspaceId}&limit=1`),
      api.get(`/github/repos?workspaceId=${workspaceId}`),
      api.get(`/deploy?workspaceId=${workspaceId}`),
      api.get(`/debug/errors?workspaceId=${workspaceId}`),
    ]).then(([queries, repos, deploys, errors]) => {
      setStats({
        queries: queries.data.length,
        repos: repos.data.length,
        deploys: deploys.data.filter(d => d.status === 'deployed').length,
        errors: errors.data.filter(e => e.status === 'open').length,
      });
    }).catch(() => {});
  }, [workspaceId]);

  const cards = [
    { label: 'RAG Queries',      icon: MessageSquare, value: stats.queries ?? '—', color: 'text-blue-400' },
    { label: 'Repos Connected',  icon: Github,        value: stats.repos ?? '—',   color: 'text-purple-400' },
    { label: 'Deployments',      icon: Rocket,        value: stats.deploys ?? '—', color: 'text-emerald-400' },
    { label: 'Open Errors',      icon: Bug,           value: stats.errors ?? '—',  color: 'text-red-400' },
  ];

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-xl font-semibold text-white">
          Welcome back, {user?.username} 👋
        </h1>
        <p className="text-gray-400 text-sm mt-1">Here's your workspace at a glance</p>
      </div>

      {!workspaceId && (
        <div className="bg-brand-500/10 border border-brand-500/30 rounded-xl p-4 text-sm text-brand-300">
          <Zap size={14} className="inline mr-2" />
          No workspace selected. Go to{' '}
          <a href="/workspace" className="underline">Workspace settings</a> to create one.
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map(({ label, icon: Icon, value, color }) => (
          <div key={label} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <Icon size={18} className={`${color} mb-3`} />
            <div className="text-2xl font-bold text-white">{value}</div>
            <div className="text-xs text-gray-500 mt-1">{label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// src/pages/ChatRAG.jsx
import { useState, useRef, useEffect } from 'react';
import { useAuthStore } from '../store/authStore';
import { Send, Bot, User, ExternalLink } from 'lucide-react';
import ReactMarkdown from 'react-markdown';

export default function ChatRAG() {
  const { workspaceId, token } = useAuthStore();
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      content: "Hello! I'm your SoumyaOps AI assistant. Ask me anything about your team's knowledge base, codebase, or past decisions.",
      sources: [],
    },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function handleSend() {
    if (!input.trim() || loading) return;
    const question = input.trim();
    setInput('');
    setMessages(m => [...m, { role: 'user', content: question }]);
    setLoading(true);

    // Use SSE streaming endpoint
    const url = `/api/rag/query/stream?question=${encodeURIComponent(question)}&workspaceId=${workspaceId}`;
    const evtSource = new EventSource(url);

    let assistantMsg = { role: 'assistant', content: '', sources: [] };
    setMessages(m => [...m, assistantMsg]);

    evtSource.onmessage = (e) => {
      if (e.data === '[DONE]') {
        evtSource.close();
        setLoading(false);
        return;
      }
      const chunk = JSON.parse(e.data);
      if (chunk.type === 'text') {
        assistantMsg.content += chunk.text;
        setMessages(m => [...m.slice(0, -1), { ...assistantMsg }]);
      } else if (chunk.type === 'sources') {
        assistantMsg.sources = chunk.sources;
        setMessages(m => [...m.slice(0, -1), { ...assistantMsg }]);
      }
    };

    evtSource.onerror = () => {
      evtSource.close();
      setLoading(false);
    };
  }

  return (
    <div className="flex flex-col h-full max-w-3xl mx-auto">
      <div className="mb-4">
        <h1 className="text-xl font-semibold text-white">RAG Chat</h1>
        <p className="text-sm text-gray-400">Ask questions — answers always include source references</p>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto space-y-4 pb-4">
        {messages.map((msg, i) => (
          <div key={i} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
            <div className={`w-7 h-7 rounded-full flex-shrink-0 flex items-center justify-center mt-0.5
              ${msg.role === 'assistant' ? 'bg-brand-500' : 'bg-gray-700'}`}>
              {msg.role === 'assistant' ? <Bot size={14} className="text-white" /> : <User size={14} className="text-gray-200" />}
            </div>
            <div className={`max-w-xl ${msg.role === 'user' ? 'items-end' : 'items-start'} flex flex-col gap-2`}>
              <div className={`px-4 py-3 rounded-2xl text-sm leading-relaxed
                ${msg.role === 'user'
                  ? 'bg-brand-500 text-white rounded-tr-sm'
                  : 'bg-gray-900 border border-gray-800 text-gray-100 rounded-tl-sm'}`}>
                <ReactMarkdown>{msg.content || '...'}</ReactMarkdown>
              </div>
              {/* Sources */}
              {msg.sources?.length > 0 && (
                <div className="space-y-1">
                  {msg.sources.map((s, j) => (
                    <div key={j} className="flex items-start gap-2 px-3 py-2 bg-gray-900/50
                                            border border-gray-800 rounded-lg text-xs text-gray-400">
                      <span className="text-brand-400 font-mono">[{j + 1}]</span>
                      <div>
                        <span className="text-gray-300 font-medium capitalize">{s.source}</span>
                        {s.senderName && <span className="ml-1">• {s.senderName}</span>}
                        {s.fileName && <span className="ml-1">• {s.fileName}</span>}
                        <p className="text-gray-500 mt-0.5 line-clamp-2">{s.excerpt}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t border-gray-800 pt-4">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleSend()}
            placeholder="Ask anything about your team's knowledge..."
            className="flex-1 bg-gray-900 border border-gray-700 rounded-xl px-4 py-2.5
                       text-sm text-gray-100 placeholder-gray-500 outline-none
                       focus:border-brand-500 transition-colors"
          />
          <button
            onClick={handleSend}
            disabled={loading || !input.trim()}
            className="w-10 h-10 bg-brand-500 rounded-xl flex items-center justify-center
                       hover:bg-brand-600 disabled:opacity-50 transition-colors flex-shrink-0"
          >
            <Send size={16} className="text-white" />
          </button>
        </div>
      </div>
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// src/pages/Debug.jsx
import { useState, useEffect } from 'react';
import { useAuthStore } from '../store/authStore';
import { api } from '../lib/api';
import { Bug, Zap, GitPullRequest, ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';
import clsx from 'clsx';

const STATUS_COLOR = {
  open:       'bg-red-500/20 text-red-400 border-red-500/30',
  fixing:     'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  fixed:      'bg-blue-500/20 text-blue-400 border-blue-500/30',
  pr_created: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
};

export default function Debug() {
  const { workspaceId } = useAuthStore();
  const [errors, setErrors] = useState([]);
  const [fixes, setFixes] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const [loading, setLoading] = useState({});
  const [logInput, setLogInput] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = () => {
    if (!workspaceId) return;
    api.get(`/debug/errors?workspaceId=${workspaceId}`).then(r => setErrors(r.data)).catch(() => {});
    api.get(`/debug/fixes?workspaceId=${workspaceId}`).then(r => setFixes(r.data)).catch(() => {});
  };

  useEffect(() => { load(); }, [workspaceId]);

  async function submitLog() {
    if (!logInput.trim()) return;
    setSubmitting(true);
    await api.post('/ingest/logs', { workspaceId, rawLog: logInput }).catch(() => {});
    setLogInput('');
    setSubmitting(false);
    setTimeout(load, 2000);
  }

  async function generateFix(logEntryId) {
    setLoading(l => ({ ...l, [logEntryId]: 'generating' }));
    await api.post('/debug/fix', { logEntryId, workspaceId }).catch(() => {});
    setTimeout(() => { load(); setLoading(l => ({ ...l, [logEntryId]: null })); }, 3000);
  }

  async function createPR(fixId) {
    setLoading(l => ({ ...l, [fixId]: 'pr' }));
    await api.post('/debug/pr', { fixId, workspaceId }).catch(() => {});
    load();
    setLoading(l => ({ ...l, [fixId]: null }));
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-xl font-semibold text-white">Debug & Fix</h1>
        <p className="text-sm text-gray-400">Paste logs to detect errors — SoumyaOps suggests RAG-powered fixes</p>
      </div>

      {/* Log paste area */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
        <label className="text-sm font-medium text-gray-300">Paste logs</label>
        <textarea
          value={logInput}
          onChange={e => setLogInput(e.target.value)}
          rows={5}
          placeholder="Paste error logs here..."
          className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2
                     text-xs font-mono text-gray-300 placeholder-gray-600 outline-none
                     focus:border-brand-500 transition-colors resize-none"
        />
        <button
          onClick={submitLog}
          disabled={submitting}
          className="px-4 py-2 bg-brand-500 text-white rounded-lg text-sm font-medium
                     hover:bg-brand-600 disabled:opacity-50 transition-colors"
        >
          {submitting ? 'Processing...' : 'Detect Errors'}
        </button>
      </div>

      {/* Errors list */}
      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-gray-300">Detected Errors</h2>
        {errors.length === 0 && (
          <div className="text-sm text-gray-600 py-4">No errors detected yet.</div>
        )}
        {errors.map(err => {
          const fix = fixes.find(f => f.log_entry_id === err.id);
          const isOpen = expanded === err.id;

          return (
            <div key={err.id} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <div
                className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-gray-800/50"
                onClick={() => setExpanded(isOpen ? null : err.id)}
              >
                <Bug size={15} className="text-red-400 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-100 font-medium truncate">{err.error_type}</p>
                  <p className="text-xs text-gray-500 truncate">{err.error_message}</p>
                </div>
                <span className={clsx('text-xs px-2 py-0.5 rounded-full border', STATUS_COLOR[err.status])}>
                  {err.status}
                </span>
                {isOpen ? <ChevronUp size={14} className="text-gray-500" /> : <ChevronDown size={14} className="text-gray-500" />}
              </div>

              {isOpen && (
                <div className="border-t border-gray-800 px-4 py-3 space-y-3">
                  {err.stack_trace && (
                    <pre className="text-xs text-gray-400 bg-gray-950 p-3 rounded-lg overflow-x-auto">
                      {err.stack_trace.slice(0, 600)}
                    </pre>
                  )}
                  {err.file_path && (
                    <p className="text-xs text-gray-500">
                      <span className="text-gray-400 font-mono">{err.file_path}</span>
                      {err.line_number && `:${err.line_number}`}
                    </p>
                  )}

                  {/* Fix section */}
                  {fix ? (
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-gray-300">Suggested Fix</p>
                      <p className="text-xs text-gray-400 bg-gray-950 p-3 rounded-lg">{fix.explanation}</p>
                      {!fix.pr_url ? (
                        <button
                          onClick={() => createPR(fix.id)}
                          disabled={loading[fix.id]}
                          className="flex items-center gap-2 px-3 py-1.5 bg-emerald-500/20
                                     text-emerald-400 border border-emerald-500/30 rounded-lg
                                     text-xs hover:bg-emerald-500/30 transition-colors"
                        >
                          <GitPullRequest size={13} />
                          {loading[fix.id] === 'pr' ? 'Creating PR...' : 'Create Pull Request'}
                        </button>
                      ) : (
                        <a
                          href={fix.pr_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-2 px-3 py-1.5 text-xs text-brand-400
                                     hover:underline"
                        >
                          <ExternalLink size={12} />
                          View PR #{fix.pr_number}
                        </a>
                      )}
                    </div>
                  ) : err.status === 'open' && (
                    <button
                      onClick={() => generateFix(err.id)}
                      disabled={!!loading[err.id]}
                      className="flex items-center gap-2 px-3 py-1.5 bg-brand-500/20
                                 text-brand-400 border border-brand-500/30 rounded-lg
                                 text-xs hover:bg-brand-500/30 transition-colors"
                    >
                      <Zap size={13} />
                      {loading[err.id] ? 'Generating fix...' : 'Generate AI Fix'}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}