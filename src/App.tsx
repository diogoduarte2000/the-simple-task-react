import { useEffect, useRef, useState } from 'react';
import './App.css';

const DEFAULT_API_URL = 'http://127.0.0.1:5000';
const API_URL = (import.meta.env.VITE_API_URL || DEFAULT_API_URL).replace(/\/$/, '');
const TOKEN_KEY = 'tarefas_auth_token';
const SHOW_DEV_OTP = import.meta.env.DEV || import.meta.env.VITE_SHOW_DEV_OTP === 'true';

type AuthMode = 'login' | 'register';
type AuthStage = 'auth' | 'otp' | 'recovery-request' | 'recovery-reset';
type ChallengePurpose = 'login' | 'register' | 'password_reset';

interface User {
  id: string;
  username: string;
  email: string;
}

interface Tarefa {
  _id: string;
  texto: string;
  concluida: boolean;
  createdAt: string;
}

interface AuthResponse {
  token: string;
  user: User;
}

interface ChallengeResponse {
  requiresOtp: true;
  challengeToken: string;
  purpose: ChallengePurpose;
  maskedDestination: string;
  devCode?: string;
}

interface AuthFormState {
  username: string;
  email: string;
  password: string;
}

function isLocalApiUrl(url: string) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(url);
}

function isHostedFrontendWithoutPublishedApi() {
  return (
    typeof window !== 'undefined' &&
    window.location.hostname.endsWith('github.io') &&
    isLocalApiUrl(API_URL)
  );
}

function getRequestErrorMessage(error: unknown, fallback: string) {
  if (error instanceof TypeError && isHostedFrontendWithoutPublishedApi()) {
    return 'O frontend esta publicado, mas a API ainda aponta para localhost. Publica o backend e define VITE_API_URL antes do deploy.';
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
}

async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
  token?: string
): Promise<T> {
  const headers = new Headers(options.headers);

  if (!headers.has('Content-Type') && options.body) {
    headers.set('Content-Type', 'application/json');
  }

  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.erro || 'O pedido falhou');
  }

  return data as T;
}

function getStoredToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

function getAvatarLabel(user: User | null) {
  if (!user) return '?';
  return (user.username[0] || user.email[0] || '?').toUpperCase();
}

function getDisplayName(user: User | null) {
  if (!user) return '';

  const rawName = (user.username || user.email || '').trim();
  const baseName = rawName.includes('@') ? rawName.split('@')[0] : rawName;

  if (baseName.length <= 18) {
    return baseName;
  }

  return `${baseName.slice(0, 18)}...`;
}

function App() {
  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [authStage, setAuthStage] = useState<AuthStage>('auth');
  const [authForm, setAuthForm] = useState<AuthFormState>({
    username: '',
    email: '',
    password: '',
  });
  const [recoveryEmail, setRecoveryEmail] = useState('');
  const [recoveryPassword, setRecoveryPassword] = useState('');
  const [pendingChallenge, setPendingChallenge] = useState<ChallengeResponse | null>(null);
  const [otpCode, setOtpCode] = useState('');
  const [authInfo, setAuthInfo] = useState('');
  const [token, setToken] = useState(getStoredToken);
  const [user, setUser] = useState<User | null>(null);
  const [tarefas, setTarefas] = useState<Tarefa[]>([]);
  const [novaTarefa, setNovaTarefa] = useState('');
  const [editingId, setEditingId] = useState('');
  const [editingTexto, setEditingTexto] = useState('');
  const [authError, setAuthError] = useState('');
  const [taskError, setTaskError] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [otpLoading, setOtpLoading] = useState(false);
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const [resendLoading, setResendLoading] = useState(false);
  const [tasksLoading, setTasksLoading] = useState(Boolean(token));
  const [accountLoading, setAccountLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function handleOutsideClick(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }

    window.addEventListener('mousedown', handleOutsideClick);
    return () => window.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  useEffect(() => {
    if (!token) {
      setTasksLoading(false);
      return;
    }

    let cancelled = false;

    async function restoreSession() {
      try {
        const profile = await apiRequest<{ user: User }>('/auth/me', {}, token);
        const taskList = await apiRequest<Tarefa[]>('/tarefas', {}, token);

        if (cancelled) return;

        setUser(profile.user);
        setTarefas(taskList);
        setAuthError('');
      } catch (error) {
        if (cancelled) return;
        handleLogout();
        setAuthError(getRequestErrorMessage(error, 'Sessao invalida'));
      } finally {
        if (!cancelled) {
          setTasksLoading(false);
        }
      }
    }

    restoreSession();

    return () => {
      cancelled = true;
    };
  }, [token]);

  function persistSession(auth: AuthResponse) {
    localStorage.setItem(TOKEN_KEY, auth.token);
    setToken(auth.token);
    setUser(auth.user);
    setTarefas([]);
    setPendingChallenge(null);
    setOtpCode('');
    setAuthStage('auth');
    setAuthError('');
    setAuthInfo('');
    setTaskError('');
    setTasksLoading(true);
  }

  function resetAuthFlow(nextMode?: AuthMode) {
    setPendingChallenge(null);
    setOtpCode('');
    setRecoveryEmail('');
    setRecoveryPassword('');
    setAuthError('');
    setAuthInfo('');
    setAuthLoading(false);
    setOtpLoading(false);
    setRecoveryLoading(false);
    setResendLoading(false);
    setAuthStage('auth');
    if (nextMode) {
      setAuthMode(nextMode);
    }
  }

  function handleLogout() {
    localStorage.removeItem(TOKEN_KEY);
    setToken('');
    setUser(null);
    setTarefas([]);
    setNovaTarefa('');
    setEditingId('');
    setEditingTexto('');
    setPendingChallenge(null);
    setOtpCode('');
    setMenuOpen(false);
    setTasksLoading(false);
  }

  async function handleAuthSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthLoading(true);
    setAuthError('');
    setAuthInfo('');

    try {
      const path = authMode === 'login' ? '/auth/login' : '/auth/register';
      const payload =
        authMode === 'login'
          ? {
              email: authForm.email,
              password: authForm.password,
            }
          : authForm;

      const result = await apiRequest<ChallengeResponse>(path, {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      setPendingChallenge(result);
      setOtpCode('');
      setAuthStage('otp');
    } catch (error) {
      setAuthError(getRequestErrorMessage(error, 'Erro na autenticacao'));
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleVerifyOtp(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pendingChallenge) return;

    setOtpLoading(true);
    setAuthError('');
    setAuthInfo('');

    try {
      const auth = await apiRequest<AuthResponse>('/auth/otp/verify', {
        method: 'POST',
        body: JSON.stringify({
          challengeToken: pendingChallenge.challengeToken,
          code: otpCode,
        }),
      });

      persistSession(auth);
      setAuthForm({
        username: '',
        email: '',
        password: '',
      });
    } catch (error) {
      setAuthError(getRequestErrorMessage(error, 'Erro ao validar codigo'));
    } finally {
      setOtpLoading(false);
    }
  }

  async function handleResendOtp() {
    if (!pendingChallenge) return;

    setResendLoading(true);
    setAuthError('');
    setAuthInfo('');

    try {
      const challenge = await apiRequest<ChallengeResponse>('/auth/otp/resend', {
        method: 'POST',
        body: JSON.stringify({
          challengeToken: pendingChallenge.challengeToken,
        }),
      });

      setPendingChallenge(challenge);
      setOtpCode('');
      setAuthInfo('Novo codigo enviado para o teu email.');
    } catch (error) {
      setAuthError(getRequestErrorMessage(error, 'Erro ao reenviar codigo'));
    } finally {
      setResendLoading(false);
    }
  }

  async function handleRecoveryRequest(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRecoveryLoading(true);
    setAuthError('');
    setAuthInfo('');

    try {
      const challenge = await apiRequest<ChallengeResponse>('/auth/password/forgot', {
        method: 'POST',
        body: JSON.stringify({ email: recoveryEmail }),
      });

      setPendingChallenge(challenge);
      setOtpCode('');
      setRecoveryPassword('');
      setAuthStage('recovery-reset');
      setAuthInfo('Enviamos um codigo para recuperares a password.');
    } catch (error) {
      setAuthError(getRequestErrorMessage(error, 'Erro ao iniciar recuperacao'));
    } finally {
      setRecoveryLoading(false);
    }
  }

  async function handleRecoveryReset(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pendingChallenge) return;

    setRecoveryLoading(true);
    setAuthError('');
    setAuthInfo('');

    try {
      await apiRequest<{ message: string }>('/auth/password/reset', {
        method: 'POST',
        body: JSON.stringify({
          challengeToken: pendingChallenge.challengeToken,
          code: otpCode,
          password: recoveryPassword,
        }),
      });

      setPendingChallenge(null);
      setOtpCode('');
      setRecoveryPassword('');
      setAuthStage('auth');
      setAuthMode('login');
      setAuthForm((current) => ({ ...current, password: '', email: recoveryEmail }));
      setAuthInfo('Password atualizada. Agora podes iniciar sessao.');
    } catch (error) {
      setAuthError(getRequestErrorMessage(error, 'Erro ao redefinir a password'));
    } finally {
      setRecoveryLoading(false);
    }
  }

  async function handleAddTask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const texto = novaTarefa.trim();
    if (!texto || !token) return;

    try {
      const createdTask = await apiRequest<Tarefa>(
        '/tarefas',
        {
          method: 'POST',
          body: JSON.stringify({ texto }),
        },
        token
      );

      setTarefas((current) => [createdTask, ...current]);
      setNovaTarefa('');
      setTaskError('');
    } catch (error) {
      setTaskError(getRequestErrorMessage(error, 'Erro ao criar tarefa'));
    }
  }

  async function handleToggleTask(taskId: string) {
    if (!token) return;

    try {
      const updatedTask = await apiRequest<Tarefa>(
        `/tarefas/${taskId}`,
        { method: 'PUT' },
        token
      );

      setTarefas((current) =>
        current.map((task) => (task._id === taskId ? updatedTask : task))
      );
    } catch (error) {
      setTaskError(getRequestErrorMessage(error, 'Erro ao atualizar tarefa'));
    }
  }

  async function handleDeleteTask(taskId: string) {
    if (!token) return;

    try {
      await apiRequest<{ message: string }>(
        `/tarefas/${taskId}`,
        { method: 'DELETE' },
        token
      );

      setTarefas((current) => current.filter((task) => task._id !== taskId));
    } catch (error) {
      setTaskError(getRequestErrorMessage(error, 'Erro ao apagar tarefa'));
    }
  }

  async function handleDeleteAccount() {
    if (!token) return;

    const confirmed = window.confirm(
      'Queres mesmo remover a tua conta? Esta acao apaga tambem todas as tuas tarefas.'
    );

    if (!confirmed) return;

    setAccountLoading(true);
    setTaskError('');

    try {
      await apiRequest<{ message: string }>(
        '/auth/me',
        { method: 'DELETE' },
        token
      );
      handleLogout();
    } catch (error) {
      setTaskError(getRequestErrorMessage(error, 'Erro ao remover conta'));
    } finally {
      setAccountLoading(false);
    }
  }

  function startEditing(task: Tarefa) {
    setEditingId(task._id);
    setEditingTexto(task.texto);
  }

  async function saveTaskEdit(taskId: string) {
    const texto = editingTexto.trim();
    if (!texto || !token) return;

    try {
      const updatedTask = await apiRequest<Tarefa>(
        `/tarefas/${taskId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ texto }),
        },
        token
      );

      setTarefas((current) =>
        current.map((task) => (task._id === taskId ? updatedTask : task))
      );
      setEditingId('');
      setEditingTexto('');
      setTaskError('');
    } catch (error) {
      setTaskError(getRequestErrorMessage(error, 'Erro ao editar tarefa'));
    }
  }

  const isAuthenticated = Boolean(user && token);
  const completedCount = tarefas.filter((task) => task.concluida).length;
  const displayName = getDisplayName(user);
  const showHostedApiNotice = !isAuthenticated && isHostedFrontendWithoutPublishedApi();

  function renderAuthCard() {
    if (authStage === 'otp' && pendingChallenge) {
      return (
        <form className="auth-card" onSubmit={handleVerifyOtp}>
          <h2>Codigo de seguranca</h2>
          <p className="verification-copy">
            Introduz o codigo enviado para {pendingChallenge.maskedDestination}.
          </p>

          <label>
            Codigo
            <input
              value={otpCode}
              onChange={(event) => setOtpCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              inputMode="numeric"
              required
            />
          </label>

          {SHOW_DEV_OTP && pendingChallenge.devCode ? (
            <p className="feedback feedback--info">
              Modo dev: codigo atual {pendingChallenge.devCode}
            </p>
          ) : null}

          {authInfo ? <p className="feedback feedback--info">{authInfo}</p> : null}
          {authError ? <p className="feedback feedback--error">{authError}</p> : null}

          <button type="submit" className="primary-button" disabled={otpLoading}>
            {otpLoading ? 'A validar...' : 'Validar codigo'}
          </button>

          <div className="auth-actions-row">
            <button
              type="button"
              className="secondary-button"
              onClick={() => void handleResendOtp()}
              disabled={resendLoading}
            >
              {resendLoading ? 'A reenviar...' : 'Reenviar codigo'}
            </button>

            <button type="button" className="auth-link" onClick={() => resetAuthFlow()}>
              Voltar
            </button>
          </div>
        </form>
      );
    }

    if (authStage === 'recovery-request') {
      return (
        <form className="auth-card" onSubmit={handleRecoveryRequest}>
          <h2>Recuperar password</h2>
          <p className="verification-copy">
            Enviamos um codigo para o email associado a tua conta.
          </p>

          <label>
            Email
            <input
              type="email"
              value={recoveryEmail}
              onChange={(event) => setRecoveryEmail(event.target.value)}
              placeholder="nome@email.com"
              required
            />
          </label>

          {authInfo ? <p className="feedback feedback--info">{authInfo}</p> : null}
          {authError ? <p className="feedback feedback--error">{authError}</p> : null}

          <button type="submit" className="primary-button" disabled={recoveryLoading}>
            {recoveryLoading ? 'A enviar...' : 'Enviar codigo'}
          </button>

          <button type="button" className="auth-link" onClick={() => resetAuthFlow('login')}>
            Voltar ao login
          </button>
        </form>
      );
    }

    if (authStage === 'recovery-reset' && pendingChallenge) {
      return (
        <form className="auth-card" onSubmit={handleRecoveryReset}>
          <h2>Nova password</h2>
          <p className="verification-copy">
            Introduz o codigo enviado para {pendingChallenge.maskedDestination} e define a nova password.
          </p>

          <label>
            Codigo
            <input
              value={otpCode}
              onChange={(event) => setOtpCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              inputMode="numeric"
              required
            />
          </label>

          <label>
            Nova password
            <input
              type="password"
              value={recoveryPassword}
              onChange={(event) => setRecoveryPassword(event.target.value)}
              placeholder="Minimo de 6 caracteres"
              required
            />
          </label>

          {SHOW_DEV_OTP && pendingChallenge.devCode ? (
            <p className="feedback feedback--info">
              Modo dev: codigo atual {pendingChallenge.devCode}
            </p>
          ) : null}

          {authInfo ? <p className="feedback feedback--info">{authInfo}</p> : null}
          {authError ? <p className="feedback feedback--error">{authError}</p> : null}

          <button type="submit" className="primary-button" disabled={recoveryLoading}>
            {recoveryLoading ? 'A atualizar...' : 'Atualizar password'}
          </button>

          <div className="auth-actions-row">
            <button
              type="button"
              className="secondary-button"
              onClick={() => void handleResendOtp()}
              disabled={resendLoading}
            >
              {resendLoading ? 'A reenviar...' : 'Reenviar codigo'}
            </button>

            <button type="button" className="auth-link" onClick={() => resetAuthFlow('login')}>
              Cancelar
            </button>
          </div>
        </form>
      );
    }

    return (
      <form className="auth-card" onSubmit={handleAuthSubmit}>
        <h2>{authMode === 'login' ? 'Iniciar sessao' : 'Registar conta'}</h2>

        {authMode === 'register' ? (
          <label>
            Username
            <input
              value={authForm.username}
              onChange={(event) =>
                setAuthForm((current) => ({ ...current, username: event.target.value }))
              }
              placeholder="O teu nome"
              required
            />
          </label>
        ) : null}

        <label>
          Email
          <input
            type="email"
            value={authForm.email}
            onChange={(event) =>
              setAuthForm((current) => ({ ...current, email: event.target.value }))
            }
            placeholder="nome@email.com"
            required
          />
        </label>

        <label>
          Password
          <input
            type="password"
            value={authForm.password}
            onChange={(event) =>
              setAuthForm((current) => ({ ...current, password: event.target.value }))
            }
            placeholder="Minimo de 6 caracteres"
            required
          />
        </label>

        {authInfo ? <p className="feedback feedback--info">{authInfo}</p> : null}
        {authError ? <p className="feedback feedback--error">{authError}</p> : null}

        <button type="submit" className="primary-button" disabled={authLoading}>
          {authLoading
            ? 'A processar...'
            : authMode === 'login'
              ? 'Continuar'
              : 'Criar conta'}
        </button>

        <div className="auth-actions-row auth-actions-row--stack">
          {authMode === 'login' ? (
            <button
              type="button"
              className="auth-link"
              onClick={() => {
                setAuthStage('recovery-request');
                setAuthError('');
                setAuthInfo('');
                setRecoveryEmail(authForm.email);
              }}
            >
              Esqueci-me da password
            </button>
          ) : null}

          <button
            type="button"
            className="auth-link"
            onClick={() => resetAuthFlow(authMode === 'login' ? 'register' : 'login')}
          >
            {authMode === 'login'
              ? 'Ainda nao tens conta? Regista-te'
              : 'Ja tens conta? Entra aqui'}
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="app-shell">
      <nav className="topbar">
        <div className="brand-block">
          <span className="brand-kicker">Productivity</span>
          <strong className="brand-title">Lista de Tarefas</strong>
        </div>

        {isAuthenticated ? (
          <div className="account-menu" ref={menuRef}>
            <button
              type="button"
              className="avatar-button"
              onClick={() => setMenuOpen((current) => !current)}
            >
              <span className="avatar-circle">{getAvatarLabel(user)}</span>
              <span className="avatar-name">{displayName}</span>
            </button>

            {menuOpen ? (
              <div className="account-dropdown">
                <p className="dropdown-email">{user?.email}</p>
                <button type="button" className="dropdown-action" onClick={handleLogout}>
                  Logout
                </button>
                <button
                  type="button"
                  className="dropdown-danger"
                  onClick={() => void handleDeleteAccount()}
                  disabled={accountLoading}
                >
                  {accountLoading ? 'A remover...' : 'Remover conta'}
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <button
            type="button"
            className="nav-switch"
            onClick={() => resetAuthFlow(authMode === 'login' ? 'register' : 'login')}
          >
            {authMode === 'login' ? 'Criar conta' : 'Ja tenho conta'}
          </button>
        )}
      </nav>

      <main className={`page-frame ${isAuthenticated ? 'page-frame--tasks' : ''}`}>
        {isAuthenticated ? (
          <section className="task-panel">
            <header className="panel-heading">
              <div className="panel-intro">
                <span className="panel-kicker">Conta ativa</span>
                <h1>{displayName}, aqui esta a tua lista.</h1>
                <p className="panel-copy">
                  Cada conta ve apenas as suas tarefas guardadas no MongoDB.
                </p>
              </div>

              <div className="hero-metrics">
                <div className="metric-card">
                  <span className="metric-label">Total</span>
                  <strong>{tarefas.length}</strong>
                </div>
                <div className="metric-card">
                  <span className="metric-label">Concluidas</span>
                  <strong>{completedCount}</strong>
                </div>
              </div>
            </header>

            <form className="task-creator" onSubmit={handleAddTask}>
              <input
                value={novaTarefa}
                onChange={(event) => setNovaTarefa(event.target.value)}
                placeholder="Escreve uma nova tarefa"
              />
              <button type="submit">Adicionar</button>
            </form>

            {taskError ? <p className="feedback feedback--error">{taskError}</p> : null}

            {tasksLoading ? (
              <p className="empty-state">A carregar tarefas...</p>
            ) : tarefas.length === 0 ? (
              <p className="empty-state">Ainda nao tens tarefas. Cria a primeira.</p>
            ) : (
              <ul className="task-list">
                {tarefas.map((task) => (
                  <li key={task._id} className={task.concluida ? 'task-card is-done' : 'task-card'}>
                    <button
                      type="button"
                      className="task-check"
                      onClick={() => handleToggleTask(task._id)}
                    >
                      {task.concluida ? 'Feita' : 'Por fazer'}
                    </button>

                    <div className="task-content">
                      {editingId === task._id ? (
                        <input
                          className="task-edit-input"
                          value={editingTexto}
                          onChange={(event) => setEditingTexto(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              void saveTaskEdit(task._id);
                            }
                          }}
                        />
                      ) : (
                        <p>{task.texto}</p>
                      )}
                    </div>

                    <div className="task-actions">
                      {editingId === task._id ? (
                        <>
                          <button type="button" className="ghost-button" onClick={() => saveTaskEdit(task._id)}>
                            Guardar
                          </button>
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => {
                              setEditingId('');
                              setEditingTexto('');
                            }}
                          >
                            Cancelar
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() => startEditing(task)}
                        >
                          Editar
                        </button>
                      )}

                      <button
                        type="button"
                        className="danger-button"
                        onClick={() => handleDeleteTask(task._id)}
                      >
                        Apagar
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : (
          <section className="auth-layout">
            <div className="auth-copy">
              <span className="panel-kicker">
                {authStage === 'recovery-request' || authStage === 'recovery-reset'
                  ? 'Recuperacao'
                  : authStage === 'otp'
                    ? 'Verificacao extra'
                    : 'Autenticacao'}
              </span>
              <h1>
                {authStage === 'otp'
                  ? 'Valida o codigo para abrir a tua conta.'
                  : authStage === 'recovery-request'
                    ? 'Recupera o acesso por email.'
                    : authStage === 'recovery-reset'
                      ? 'Define uma nova password.'
                      : 'Cria conta ou entra para gerir a tua lista.'}
              </h1>
              <p>
                {authStage === 'otp'
                  ? `Foi enviado um codigo de 6 digitos para ${pendingChallenge?.maskedDestination || 'o teu email'}.`
                  : authStage === 'recovery-request'
                    ? 'Se tiveres acesso ao email da conta, podes redefinir a password em poucos passos.'
                    : authStage === 'recovery-reset'
                      ? `Usa o codigo enviado para ${pendingChallenge?.maskedDestination || 'o teu email'} e escolhe uma nova password.`
                      : 'Cada utilizador passa a ter a propria area de tarefas com criacao, edicao, conclusao e remocao.'}
              </p>
              {showHostedApiNotice ? (
                <p className="feedback feedback--warning">
                  O frontend no GitHub Pages esta visivel, mas a API ainda usa <strong>localhost</strong>.
                  Publica o backend noutro servico e define <code>VITE_API_URL</code> antes do deploy.
                </p>
              ) : null}
              <div className="hero-notes">
                <div className="hero-note">
                  <strong>Seguranca por email</strong>
                  <span>O acesso e validado com codigo enviado para o email da conta.</span>
                </div>
                <div className="hero-note">
                  <strong>Recuperacao incluida</strong>
                  <span>Se esqueceres a password, podes redefini-la tambem por email.</span>
                </div>
              </div>
            </div>

            {renderAuthCard()}
          </section>
        )}
      </main>
    </div>
  );
}

export default App;
