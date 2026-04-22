// src/components/layout/Layout.jsx
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';

export default function Layout() {
  return (
    <div className="flex h-screen bg-gray-950 text-gray-100 overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-y-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// src/components/layout/Sidebar.jsx
import { NavLink, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, MessageSquare, Github, Rocket,
  Bug, Send, Settings, LogOut, Zap,
} from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import clsx from 'clsx';

const NAV = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/chat',      icon: MessageSquare,   label: 'RAG Chat' },
  { to: '/github',    icon: Github,          label: 'GitHub' },
  { to: '/deploy',    icon: Rocket,          label: 'Deploy' },
  { to: '/debug',     icon: Bug,             label: 'Debug' },
  { to: '/telegram',  icon: Send,            label: 'Telegram' },
  { to: '/workspace', icon: Settings,        label: 'Workspace' },
];

export default function Sidebar() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();

  return (
    <div className="w-60 bg-gray-900 border-r border-gray-800 flex flex-col">
      {/* Logo */}
      <div className="px-5 py-4 border-b border-gray-800 flex items-center gap-2">
        <div className="w-7 h-7 rounded-lg bg-brand-500 flex items-center justify-center">
          <Zap size={14} className="text-white" />
        </div>
        <span className="font-semibold text-white text-sm">SoumyaOps</span>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-0.5">
        {NAV.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) => clsx(
              'flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors',
              isActive
                ? 'bg-brand-500/20 text-brand-400 font-medium'
                : 'text-gray-400 hover:bg-gray-800 hover:text-gray-100',
            )}
          >
            <Icon size={16} />
            {label}
          </NavLink>
        ))}
      </nav>

      {/* User */}
      {user && (
        <div className="px-3 py-3 border-t border-gray-800 flex items-center gap-2">
          <img
            src={user.avatar_url}
            alt={user.username}
            className="w-7 h-7 rounded-full border border-gray-700"
          />
          <span className="flex-1 text-xs text-gray-300 truncate">{user.username}</span>
          <button
            onClick={() => { logout(); navigate('/login'); }}
            className="text-gray-500 hover:text-gray-200 transition-colors"
            title="Logout"
          >
            <LogOut size={14} />
          </button>
        </div>
      )}
    </div>
  );
}