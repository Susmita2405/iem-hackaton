// src/pages/Deploy.jsx
import { useState, useEffect } from 'react';
import { useAuthStore } from '../store/authStore';
import { api } from '../lib/api';
import { Rocket, Plus, ExternalLink, Clock, CheckCircle, XCircle, Loader } from 'lucide-react';

const STATUS_ICON = {
  queued:   <Clock size={14} className="text-yellow-400" />,
  building: <Loader size={14} className="text-blue-400 animate-spin" />,
  deployed: <CheckCircle size={14} className="text-emerald-400" />,
  failed:   <XCircle size={14} className="text-red-400" />,
};

export default function Deploy() {
  const { workspaceId, user } = useAuthStore();
  const [repos, setRepos] = useState([]);
  const [deployments, setDeployments] = useState([]);
  const [selectedRepo, setSelectedRepo] = useState('');
  const [envVars, setEnvVars] = useState([{ key: '', value: '' }]);
  const [deploying, setDeploying] = useState(false);

  useEffect(() => {
    if (!workspaceId) return;
    api.get(`/github/repos?workspaceId=${workspaceId}`).then(r => setRepos(r.data)).catch(() => {});
    api.get(`/deploy?workspaceId=${workspaceId}`).then(r => setDeployments(r.data)).catch(() => {});
  }, [workspaceId]);

  async function handleDeploy() {
    if (!selectedRepo) return;
    setDeploying(true);
    const evVars = Object.fromEntries(
      envVars.filter(e => e.key).map(e => [e.key, e.value])
    );
    await api.post('/deploy', { workspaceId, repoId: selectedRepo, envVars: evVars }).catch(() => {});
    setDeploying(false);
    setTimeout(() => api.get(`/deploy?workspaceId=${workspaceId}`).then(r => setDeployments(r.data)), 2000);
  }

  const repo = repos.find(r => r.id === selectedRepo);
  const detectedEnvVars = repo?.detected_stack
    ? (typeof repo.detected_stack === 'string'
        ? JSON.parse(repo.detected_stack)
        : repo.detected_stack)?.envVarsNeeded || []
    : [];

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-xl font-semibold text-white">Deploy</h1>
        <p className="text-sm text-gray-400">Deploy frontend to Vercel or backend to Railway automatically</p>
      </div>

      {/* Deploy form */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
        <h2 className="text-sm font-semibold text-gray-200">New Deployment</h2>

        <div>
          <label className="text-xs text-gray-400 mb-1.5 block">Select Repository</label>
          <select
            value={selectedRepo}
            onChange={e => setSelectedRepo(e.target.value)}
            className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2
                       text-sm text-gray-200 outline-none focus:border-brand-500"
          >
            <option value="">— choose a repo —</option>
            {repos.map(r => (
              <option key={r.id} value={r.id}>
                {r.repo_full_name} ({r.detected_type || 'unknown'})
              </option>
            ))}
          </select>
        </div>

        {/* Detected ENV vars */}
        {detectedEnvVars.length > 0 && (
          <div>
            <label className="text-xs text-gray-400 mb-1.5 block">
              Detected ENV variables (from .env.example)
            </label>
            <div className="space-y-2">
              {detectedEnvVars.map((v, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    value={v.key}
                    readOnly
                    className="w-40 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5
                               text-xs font-mono text-gray-300"
                  />
                  <input
                    placeholder={v.defaultValue || 'value'}
                    onChange={e => {
                      const newVars = [...envVars];
                      const idx = newVars.findIndex(x => x.key === v.key);
                      if (idx >= 0) newVars[idx].value = e.target.value;
                      else newVars.push({ key: v.key, value: e.target.value });
                      setEnvVars(newVars);
                    }}
                    className="flex-1 bg-gray-950 border border-gray-700 rounded-lg px-3 py-1.5
                               text-xs text-gray-200 outline-none focus:border-brand-500"
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Manual ENV vars */}
        <div>
          <label className="text-xs text-gray-400 mb-1.5 block">Additional ENV variables</label>
          {envVars.map((v, i) => (
            <div key={i} className="flex gap-2 mb-2">
              <input
                value={v.key}
                onChange={e => {
                  const n = [...envVars]; n[i].key = e.target.value; setEnvVars(n);
                }}
                placeholder="KEY"
                className="w-40 bg-gray-950 border border-gray-700 rounded-lg px-3 py-1.5
                           text-xs font-mono text-gray-200 outline-none focus:border-brand-500"
              />
              <input
                value={v.value}
                onChange={e => {
                  const n = [...envVars]; n[i].value = e.target.value; setEnvVars(n);
                }}
                placeholder="value"
                type="password"
                className="flex-1 bg-gray-950 border border-gray-700 rounded-lg px-3 py-1.5
                           text-xs text-gray-200 outline-none focus:border-brand-500"
              />
            </div>
          ))}
          <button
            onClick={() => setEnvVars(v => [...v, { key: '', value: '' }])}
            className="text-xs text-gray-500 hover:text-gray-300 flex items-center gap-1"
          >
            <Plus size={12} /> Add variable
          </button>
        </div>

        <button
          onClick={handleDeploy}
          disabled={!selectedRepo || deploying}
          className="flex items-center gap-2 px-5 py-2.5 bg-brand-500 text-white rounded-xl
                     text-sm font-medium hover:bg-brand-600 disabled:opacity-50 transition-colors"
        >
          <Rocket size={15} />
          {deploying ? 'Deploying...' : 'Deploy Now'}
        </button>
      </div>

      {/* Deployment history */}
      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-gray-300">Deployment History</h2>
        {deployments.map(d => (
          <div key={d.id} className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3 flex items-center gap-3">
            {STATUS_ICON[d.status] || <Clock size={14} className="text-gray-500" />}
            <div className="flex-1 min-w-0">
              <p className="text-sm text-gray-200 font-medium truncate">{d.repo_full_name}</p>
              <p className="text-xs text-gray-500">{d.platform} · {new Date(d.created_at).toLocaleString()}</p>
            </div>
            {d.live_url && (
              <a href={d.live_url} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1 text-xs text-brand-400 hover:underline">
                <ExternalLink size={12} /> Live
              </a>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// src/pages/GitHub.jsx
import { useState, useEffect } from 'react';
import { useAuthStore } from '../store/authStore';
import { api } from '../lib/api';
import { Github, Plus, GitPullRequest, ExternalLink, RefreshCw } from 'lucide-react';

export default function GitHub() {
  const { workspaceId } = useAuthStore();
  const [repos, setRepos] = useState([]);
  const [prs, setPRs] = useState([]);
  const [repoUrl, setRepoUrl] = useState('');
  const [adding, setAdding] = useState(false);

  const load = () => {
    if (!workspaceId) return;
    api.get(`/github/repos?workspaceId=${workspaceId}`).then(r => setRepos(r.data)).catch(() => {});
    api.get(`/github/prs?workspaceId=${workspaceId}`).then(r => setPRs(r.data)).catch(() => {});
  };

  useEffect(() => { load(); }, [workspaceId]);

  async function addRepo() {
    if (!repoUrl.trim()) return;
    setAdding(true);
    await api.post('/github/repos', { workspaceId, repoUrl }).catch(() => {});
    setRepoUrl('');
    setAdding(false);
    setTimeout(load, 1000);
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white">GitHub</h1>
          <p className="text-sm text-gray-400">Connect repos — SoumyaOps analyzes and indexes your code</p>
        </div>
        <button onClick={load} className="text-gray-500 hover:text-gray-300 transition-colors">
          <RefreshCw size={16} />
        </button>
      </div>

      {/* Add repo */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex gap-3">
        <input
          value={repoUrl}
          onChange={e => setRepoUrl(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && addRepo()}
          placeholder="https://github.com/owner/repo"
          className="flex-1 bg-gray-950 border border-gray-700 rounded-lg px-3 py-2
                     text-sm text-gray-200 placeholder-gray-600 outline-none focus:border-brand-500"
        />
        <button
          onClick={addRepo}
          disabled={adding}
          className="px-4 py-2 bg-brand-500 text-white rounded-lg text-sm font-medium
                     hover:bg-brand-600 disabled:opacity-50 transition-colors flex items-center gap-2"
        >
          <Plus size={14} />
          {adding ? 'Adding...' : 'Add Repo'}
        </button>
      </div>

      {/* Repos */}
      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-gray-300">Connected Repos</h2>
        {repos.map(r => (
          <div key={r.id} className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
            <div className="flex items-center gap-3">
              <Github size={15} className="text-gray-400" />
              <div className="flex-1">
                <p className="text-sm text-gray-100 font-medium">{r.repo_full_name}</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  {r.detected_type
                    ? `${r.detected_type} · ${JSON.stringify(r.detected_stack?.frontend || r.detected_stack?.backend || '')}`
                    : 'Analyzing...'}
                </p>
              </div>
              <span className={`text-xs px-2 py-0.5 rounded-full border
                ${r.last_analyzed
                  ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
                  : 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'}`}>
                {r.last_analyzed ? 'Indexed' : 'Queued'}
              </span>
            </div>
          </div>
        ))}
        {repos.length === 0 && <p className="text-sm text-gray-600 py-2">No repos connected yet.</p>}
      </div>

      {/* PRs */}
      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-gray-300">
          Pull Requests created by SoumyaOps
        </h2>
        {prs.map(pr => (
          <div key={pr.id} className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
            <div className="flex items-start gap-3">
              <GitPullRequest size={15} className="text-emerald-400 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-gray-100 font-medium truncate">
                  PR #{pr.pr_number} · {pr.error_type}
                </p>
                <p className="text-xs text-gray-500 line-clamp-1 mt-0.5">{pr.explanation}</p>
              </div>
              <a href={pr.pr_url} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1 text-xs text-brand-400 hover:underline flex-shrink-0">
                <ExternalLink size={12} /> View
              </a>
            </div>
          </div>
        ))}
        {prs.length === 0 && <p className="text-sm text-gray-600 py-2">No PRs created yet.</p>}
      </div>
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// src/pages/Telegram.jsx
import { useState, useEffect } from 'react';
import { useAuthStore } from '../store/authStore';
import { api } from '../lib/api';
import { Send, CheckCircle, AlertCircle } from 'lucide-react';

export default function Telegram() {
  const { workspaceId } = useAuthStore();
  const [botToken, setBotToken] = useState('');
  const [workspaces, setWorkspaces] = useState([]);
  const [selectedWs, setSelectedWs] = useState(workspaceId || '');
  const [connecting, setConnecting] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    api.get('/workspaces').then(r => setWorkspaces(r.data)).catch(() => {});
  }, []);

  async function connect() {
    setConnecting(true);
    setResult(null);
    const ws = workspaces.find(w => w.id === selectedWs);
    try {
      const { data } = await api.post('/telegram/connect', {
        workspaceId: selectedWs,
        workspaceSlug: ws?.slug,
        botToken,
      });
      setResult({ ok: true, ...data });
    } catch (e) {
      setResult({ ok: false, error: e.response?.data?.error || 'Connection failed' });
    }
    setConnecting(false);
  }

  return (
    <div className="space-y-6 max-w-xl">
      <div>
        <h1 className="text-xl font-semibold text-white">Telegram Bot</h1>
        <p className="text-sm text-gray-400">Connect a Telegram bot to ingest team messages automatically</p>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
        <div className="bg-gray-800/60 rounded-lg p-3 text-xs text-gray-400 space-y-1">
          <p className="font-medium text-gray-300">Setup steps:</p>
          <p>1. Open @BotFather on Telegram</p>
          <p>2. Create a new bot with /newbot</p>
          <p>3. Copy the bot token and paste below</p>
          <p>4. Add the bot to your team group</p>
        </div>

        <div>
          <label className="text-xs text-gray-400 mb-1.5 block">Workspace</label>
          <select
            value={selectedWs}
            onChange={e => setSelectedWs(e.target.value)}
            className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2
                       text-sm text-gray-200 outline-none focus:border-brand-500"
          >
            {workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </div>

        <div>
          <label className="text-xs text-gray-400 mb-1.5 block">Bot Token</label>
          <input
            type="password"
            value={botToken}
            onChange={e => setBotToken(e.target.value)}
            placeholder="123456789:AABBCCddEEff..."
            className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2
                       text-sm font-mono text-gray-200 placeholder-gray-600 outline-none
                       focus:border-brand-500"
          />
        </div>

        <button
          onClick={connect}
          disabled={connecting || !botToken || !selectedWs}
          className="flex items-center gap-2 px-5 py-2.5 bg-brand-500 text-white rounded-xl
                     text-sm font-medium hover:bg-brand-600 disabled:opacity-50 transition-colors"
        >
          <Send size={15} />
          {connecting ? 'Connecting...' : 'Connect Bot'}
        </button>

        {result && (
          <div className={`flex items-start gap-2 p-3 rounded-lg text-sm
            ${result.ok ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
            {result.ok
              ? <CheckCircle size={15} className="mt-0.5" />
              : <AlertCircle size={15} className="mt-0.5" />}
            <div>
              {result.ok
                ? <>Bot <strong>@{result.botUsername}</strong> connected! Webhook set.</>
                : result.error}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// src/pages/Workspace.jsx
import { useState, useEffect } from 'react';
import { useAuthStore } from '../store/authStore';
import { api } from '../lib/api';
import { Plus, Check } from 'lucide-react';

export default function Workspace() {
  const { workspaceId, setWorkspaceId } = useAuthStore();
  const [workspaces, setWorkspaces] = useState([]);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api.get('/workspaces').then(r => setWorkspaces(r.data)).catch(() => {});
  }, []);

  async function create() {
    if (!newName.trim()) return;
    setCreating(true);
    const { data } = await api.post('/workspaces', { name: newName });
    setWorkspaces(w => [data, ...w]);
    setWorkspaceId(data.id);
    setNewName('');
    setCreating(false);
  }

  return (
    <div className="space-y-6 max-w-xl">
      <div>
        <h1 className="text-xl font-semibold text-white">Workspaces</h1>
        <p className="text-sm text-gray-400">Each workspace has its own knowledge base and team members</p>
      </div>

      <div className="flex gap-2">
        <input
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && create()}
          placeholder="Workspace name"
          className="flex-1 bg-gray-900 border border-gray-700 rounded-xl px-3 py-2
                     text-sm text-gray-200 placeholder-gray-600 outline-none focus:border-brand-500"
        />
        <button
          onClick={create}
          disabled={creating}
          className="px-4 py-2 bg-brand-500 text-white rounded-xl text-sm font-medium
                     hover:bg-brand-600 disabled:opacity-50 transition-colors flex items-center gap-2"
        >
          <Plus size={14} />
          Create
        </button>
      </div>

      <div className="space-y-2">
        {workspaces.map(ws => (
          <div
            key={ws.id}
            onClick={() => setWorkspaceId(ws.id)}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl border cursor-pointer transition-colors
              ${workspaceId === ws.id
                ? 'bg-brand-500/10 border-brand-500/40'
                : 'bg-gray-900 border-gray-800 hover:border-gray-700'}`}
          >
            <div className="flex-1">
              <p className="text-sm font-medium text-gray-100">{ws.name}</p>
              <p className="text-xs text-gray-500">/{ws.slug}</p>
            </div>
            {workspaceId === ws.id && <Check size={14} className="text-brand-400" />}
          </div>
        ))}
      </div>
    </div>
  );
}