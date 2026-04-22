// src/App.jsx
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useEffect } from 'react';
import { useAuthStore } from './store/authStore';
import Layout from './components/layout/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import ChatRAG from './pages/ChatRAG';
import GitHub from './pages/GitHub';
import Deploy from './pages/Deploy';
import Debug from './pages/Debug';
import Telegram from './pages/Telegram';
import Workspace from './pages/Workspace';
import AuthCallback from './pages/AuthCallback';

function ProtectedRoute({ children }) {
  const { token } = useAuthStore();
  if (!token) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/auth/callback" element={<AuthCallback />} />
        <Route path="/" element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard"  element={<Dashboard />} />
          <Route path="chat"       element={<ChatRAG />} />
          <Route path="github"     element={<GitHub />} />
          <Route path="deploy"     element={<Deploy />} />
          <Route path="debug"      element={<Debug />} />
          <Route path="telegram"   element={<Telegram />} />
          <Route path="workspace"  element={<Workspace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// src/store/authStore.js
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const useAuthStore = create(
  persist(
    (set, get) => ({
      token: null,
      user: null,
      workspaceId: null,

      setToken: (token) => set({ token }),
      setUser: (user)   => set({ user }),
      setWorkspaceId: (id) => set({ workspaceId: id }),
      logout: () => set({ token: null, user: null, workspaceId: null }),
    }),
    { name: 'soumyaops-auth' },
  ),
);


// ─────────────────────────────────────────────────────────────────────────────
// src/lib/api.js
import axios from 'axios';
import { useAuthStore } from '../store/authStore';

export const api = axios.create({
  baseURL: '/api',
});

// Attach JWT to every request
api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Auto-logout on 401
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      useAuthStore.getState().logout();
      window.location.href = '/login';
    }
    return Promise.reject(err);
  },
);