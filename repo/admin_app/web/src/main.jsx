import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth.jsx';
import { ErrorBox, Loading, TYPE_LABELS } from './components/ui.jsx';
import ConfigEdit from './pages/ConfigEdit.jsx';
import History from './pages/History.jsx';
import Patterns from './pages/Patterns.jsx';
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
        <p className="muted login-sub">Sign in to manage SDK configuration.</p>
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

const ICONS = {
  database: (
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
      <path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
    </>
  ),
  ingestion: (
    <>
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </>
  ),
  tenants: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="m11 12 9-9" />
      <path d="m17 6 3 3" />
      <path d="m15 8 2 2" />
    </>
  ),
  'ip-intel': (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18" />
      <path d="M12 3a14 14 0 0 0 0 18" />
    </>
  ),
  'http-security': (
    <>
      <path d="M12 3 4 6v6c0 5 3.4 8.3 8 9 4.6-.7 8-4 8-9V6l-8-3Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  'custom-patterns': (
    <>
      <path d="m8 7-5 5 5 5" />
      <path d="m16 7 5 5-5 5" />
      <path d="m14 4-4 16" />
    </>
  ),
  instances: (
    <>
      <rect x="3" y="4" width="18" height="6" rx="1.5" />
      <rect x="3" y="14" width="18" height="6" rx="1.5" />
      <path d="M7 7h.01M7 17h.01" />
    </>
  ),
  audit: (
    <>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z" />
      <path d="M14 3v6h6" />
      <path d="M8 13h8M8 17h5" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c.6-3.4 3.2-5.5 6.5-5.5s5.9 2.1 6.5 5.5" />
      <path d="M16 4.5a3.5 3.5 0 0 1 0 7" />
      <path d="M18.5 14.8c1.6.8 2.7 2.6 3 5.2" />
    </>
  ),
  logout: (
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </>
  ),
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
};

function Icon({ name }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

const CONFIG_MODULES = ['database', 'ingestion', 'tenants', 'ip-intel', 'http-security', 'custom-patterns'];

function Shell() {
  const { user, logout, can } = useAuth();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  if (user === undefined) return <Loading />;
  if (user === null) return <Login />;
  const close = () => setNavOpen(false);
  return (
    <div className={`shell ${navOpen ? 'nav-open' : ''}`}>
      <header className="topbar">
        <button className="icon-button" onClick={() => setNavOpen(!navOpen)} aria-label="Toggle navigation">
          <Icon name="menu" />
        </button>
        <div className="brand">
          <span className="brand-mark">X</span> Xylium Admin
        </div>
      </header>
      <div className="nav-backdrop" onClick={close} />
      <aside className="nav">
        <div className="brand">
          <span className="brand-mark">X</span>
          <span>
            Xylium <span className="brand-sub">Admin</span>
          </span>
        </div>
        <nav onClick={close}>
          <div className="nav-section">Configuration</div>
          {CONFIG_MODULES.map((key) => (
            <NavLink key={key} to={`/configs/${key}`}>
              <Icon name={key} />
              <span>{TYPE_LABELS[key]}</span>
            </NavLink>
          ))}
          <div className="nav-section">Operations</div>
          <NavLink to="/instances">
            <Icon name="instances" />
            <span>SDK instances</span>
          </NavLink>
          {can('admin') && (
            <NavLink to="/audit">
              <Icon name="audit" />
              <span>Audit log</span>
            </NavLink>
          )}
          {can('superadmin') && (
            <NavLink to="/users">
              <Icon name="users" />
              <span>Users</span>
            </NavLink>
          )}
        </nav>
        <div className="me">
          <div className="avatar">{(user.email || '?')[0].toUpperCase()}</div>
          <div className="me-text">
            <div className="me-email" title={user.email}>
              {user.email}
            </div>
            <div className="me-role">{user.role}</div>
          </div>
          <button className="icon-button" onClick={logout} title="Sign out" aria-label="Sign out">
            <Icon name="logout" />
          </button>
        </div>
      </aside>
      <main key={location.pathname}>
        <Routes>
          <Route path="/" element={<Navigate to="/configs/database" replace />} />
          <Route path="/configs" element={<Navigate to="/configs/database" replace />} />
          <Route path="/configs/custom-patterns" element={<Patterns />} />
          <Route path="/configs/:type" element={<ConfigEdit />} />
          <Route path="/configs/:type/history" element={<History />} />
          <Route path="/instances" element={<Instances />} />
          <Route path="/audit" element={can('admin') ? <Audit /> : <Navigate to="/" />} />
          <Route path="/users" element={can('superadmin') ? <Users /> : <Navigate to="/" />} />
          <Route path="*" element={<p className="muted">Page not found.</p>} />
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
