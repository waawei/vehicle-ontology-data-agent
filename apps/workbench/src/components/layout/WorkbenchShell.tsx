import { WifiOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";

export function WorkbenchShell() {
  const [online, setOnline] = useState(() => navigator.onLine);
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const markOnline = () => setOnline(true);
    const markOffline = () => setOnline(false);
    window.addEventListener("online", markOnline);
    window.addEventListener("offline", markOffline);
    return () => {
      window.removeEventListener("online", markOnline);
      window.removeEventListener("offline", markOffline);
    };
  }, []);

  useEffect(() => {
    mainRef.current?.focus({ preventScroll: true });
  }, [location.pathname]);

  return (
    <div className="agent-shell-root">
      <a className="skip-link" href="#main-content">跳转主内容</a>
      {!online && <div className="system-banner warning" role="status"><WifiOff aria-hidden="true" />当前离线</div>}
      <main id="main-content" ref={mainRef} tabIndex={-1}><Outlet /></main>
    </div>
  );
}
