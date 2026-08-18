import { LogIn, Sparkles, UserPlus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { AuthApiError, login, register, type Principal } from "../../api/auth";

interface AuthScreenProps {
  // eslint-disable-next-line no-unused-vars
  onAuthenticated(principal: Principal): void;
}

export function AuthScreen({ onAuthenticated }: AuthScreenProps) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [tenantName, setTenantName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const principal = mode === "login"
        ? await login(email, password)
        : await register({ email, password, displayName, tenantName });
      setPassword("");
      onAuthenticated(principal);
    } catch (nextError) {
      setError(nextError instanceof AuthApiError ? nextError.message : "认证未完成，请重试。");
    } finally {
      setBusy(false);
    }
  }

  function switchMode(nextMode: "login" | "register") {
    setMode(nextMode);
    setError("");
  }

  return (
    <main className="auth-shell">
      <section className="auth-intro" aria-label="车域智析工作台"><div className="auth-intro-brand"><span className="brand-mark"><Sparkles /></span><strong>车域智析</strong></div><div className="auth-intro-copy"><p className="eyebrow">Governed vehicle data</p><h1>车辆业务分析，<br />从一个问题开始。</h1></div></section>
      <section className="auth-panel" aria-labelledby="auth-title">
        <header className="auth-heading">
          <span className="brand-mark" aria-hidden="true"><Sparkles /></span>
          <div><strong>欢迎使用</strong><small>进入车域智析工作台</small></div>
        </header>
        <div className="auth-mode" role="group" aria-label="认证方式">
          <button type="button" aria-pressed={mode === "login"} onClick={() => switchMode("login")}><LogIn aria-hidden="true" />登录</button>
          <button type="button" aria-pressed={mode === "register"} onClick={() => switchMode("register")}><UserPlus aria-hidden="true" />注册</button>
        </div>
        <form className="auth-form" onSubmit={submit}>
          <div>
            <p className="eyebrow">安全工作台</p>
            <h1 id="auth-title">{mode === "login" ? "登录" : "创建账号"}</h1>
          </div>
          {mode === "register" && <>
            <label htmlFor="auth-display-name">姓名<input id="auth-display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" maxLength={160} required /></label>
            <label htmlFor="auth-tenant-name">企业名称<input id="auth-tenant-name" value={tenantName} onChange={(event) => setTenantName(event.target.value)} autoComplete="organization" maxLength={160} required /></label>
          </>}
          <label htmlFor="auth-email">邮箱<input id="auth-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required /></label>
          <label htmlFor="auth-password">密码<input id="auth-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === "register" ? "new-password" : "current-password"} minLength={mode === "register" ? 12 : 1} maxLength={256} required /></label>
          {error && <p className="auth-error" role="alert">{error}</p>}
          <button className="command-button auth-submit" type="submit" disabled={busy}>{busy ? "请稍候" : mode === "login" ? "登录工作台" : "创建并登录"}</button>
        </form>
      </section>
    </main>
  );
}
