import { QueryClientProvider } from "@tanstack/react-query";
import * as Tooltip from "@radix-ui/react-tooltip";
import { ThemeProvider } from "next-themes";
import { RouterProvider } from "react-router-dom";
import { Toaster } from "sonner";
import { AuthProvider, useAuth } from "./auth";
import { AppErrorBoundary } from "./error-boundary";
import { queryClient } from "./query-client";
import { workbenchRouter } from "./router";
import { preferenceKeys } from "../state/preferences";
import { AuthScreen } from "../features/auth/AuthScreen";

function AuthenticatedApplication() {
  const auth = useAuth();
  if (auth.state === "checking") return <main className="auth-shell"><section className="route-state loading-state" aria-label="正在验证登录状态"><span className="skeleton heading" /><span className="skeleton surface" /></section></main>;
  if (auth.state === "unavailable") return <main className="auth-shell"><section className="route-state"><h1>认证服务不可用</h1><p>暂时无法验证当前会话。</p><button className="command-button" type="button" onClick={auth.retry}>重新连接</button></section></main>;
  if (auth.state === "required") return <AuthScreen onAuthenticated={auth.markAvailable} />;
  return <RouterProvider router={workbenchRouter} />;
}

export function WorkbenchApp() {
  return (
    <AppErrorBoundary>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem storageKey={preferenceKeys.theme}>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <Tooltip.Provider delayDuration={300}>
              <AuthenticatedApplication />
            </Tooltip.Provider>
            <Toaster position="bottom-right" richColors />
          </AuthProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </AppErrorBoundary>
  );
}
