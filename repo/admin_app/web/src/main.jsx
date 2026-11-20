import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth.jsx';
import { ErrorBox, Loading } from './components/ui.jsx';
import ConfigEdit from './pages/ConfigEdit.jsx';
import History from './pages/History.jsx';
import Patterns from './pages/Patterns.jsx';
import { ConfigList, Dashboard } from './pages/Overview.jsx';
import { Audit, Instances, Users } from './pages/Admin.jsx';
import './styles.css';

function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <div className="brand big">
          <span className="brand-mark">X</span> Xylium Admin
        </div>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        <ErrorBox error={error} />
        <button type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

function Shell() {
  const { user, logout, can } = useAuth();
  const location = useLocation();
  if (user === undefined) return <Loading />;
  if (user === null) return <Login />;
  return (
    <div className="shell">
      <aside className="nav">
        <div className="brand">
          <span className="brand-mark">X</span> Xylium Admin
        </div>
        <nav>
          <NavLink to="/" end>
            Overview
          </NavLink>
          <NavLink to="/configs/database">Database</NavLink>
          <NavLink to="/configs" end>
            All configuration
          </NavLink>
          <NavLink to="/configs/custom-patterns">Custom patterns</NavLink>
          <NavLink to="/instances">SDK instances</NavLink>
          {can('admin') && <NavLink to="/audit">Audit log</NavLink>}
          {can('superadmin') && <NavLink to="/users">Users</NavLink>}
        </nav>
        <div className="me">
          <div>{user.email}</div>
          <div className="muted small">{user.role}</div>
          <button className="link" onClick={logout}>
            Sign out
          </button>
        </div>
      </aside>
      <main key={location.pathname}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/configs" element={<ConfigList />} />
          <Route path="/configs/custom-patterns" element={<Patterns />} />
          <Route path="/configs/:type" element={<ConfigEdit />} />
          <Route path="/configs/:type/history" element={<History />} />
          <Route path="/instances" element={<Instances />} />
          <Route path="/audit" element={can('admin') ? <Audit /> : <Navigate to="/" />} />
          <Route path="/users" element={can('superadmin') ? <Users /> : <Navigate to="/" />} />
          <Route path="*" element={<p>Page not found.</p>} />
        </Routes>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <Shell />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>
);
