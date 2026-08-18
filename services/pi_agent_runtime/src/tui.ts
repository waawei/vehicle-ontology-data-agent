import {
  Container,
  Editor,
  Key,
  ProcessTerminal,
  Spacer,
  Text,
  TuiAltScreen,
  matchesKey,
} from "@earendil-works/pi-tui";

import { PiRuntimeClient, RuntimeClientError, type RuntimeThread } from "./tui-client.js";

const RESET = "\x1b[0m";
const CYAN = (text: string) => `\x1b[36m${text}${RESET}`;
const DIM = (text: string) => `\x1b[2m${text}${RESET}`;
const GREEN = (text: string) => `\x1b[32m${text}${RESET}`;
const RED = (text: string) => `\x1b[31m${text}${RESET}`;

async function main(): Promise<void> {
  const runtimeUrl = process.env.PI_AGENT_RUNTIME_URL || "http://127.0.0.1:8091";
  const sessionCookie = process.env.PI_AGENT_SESSION_COOKIE?.trim() || "";
  const client = new PiRuntimeClient(runtimeUrl, sessionCookie);

  let thread: RuntimeThread;
  try {
    await client.ensureReady();
    thread = await client.createThread();
  } catch (error) {
    console.error(formatStartupError(error));
    process.exitCode = 1;
    return;
  }

  const terminal = new ProcessTerminal();
  const tui = new TuiAltScreen(terminal);
  const transcript = new Container();
  const status = new Text(DIM("空闲"), 1, 0);
  const editor = new Editor(tui, editorTheme(), { paddingX: 1 });
  let pending = false;
  let stopped = false;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    tui.stop();
  };

  tui.addChild(
    new Text(
      [
        CYAN("Pi Agent / governed vehicle TUI"),
        DIM(`Runtime: ${runtimeUrl}`),
        DIM(`Thread:  ${thread.id}`),
        DIM(
          sessionCookie
            ? "会话: 已转发当前登录 Cookie，受治理数据查询可用"
            : "会话: 未配置登录 Cookie；语义问答可用，真实数据聚合需要已认证会话",
        ),
        DIM("输入问题后按 Enter 发送，Ctrl+C 退出。API key 只在服务端配置。"),
      ].join("\n"),
      1,
      0,
    ),
  );
  tui.addChild(new Spacer(1));
  tui.addChild(transcript);
  tui.addChild(status);
  tui.addChild(editor);
  tui.setFocus(editor);

  tui.addInputListener((data: string) => {
    if (matchesKey(data, Key.ctrl("c"))) {
      stop();
      return { consume: true };
    }
    return undefined;
  });

  editor.onSubmit = (value) => {
    const content = value.trim();
    if (!content || pending) return;
    void submit(content);
  };

  async function submit(content: string): Promise<void> {
    pending = true;
    editor.disableSubmit = true;
    editor.setText("");
    editor.addToHistory(content);
    transcript.addChild(new Text(`${CYAN("你")}\n${content}`, 1, 0));
    status.setText(DIM("运行中..."));
    tui.requestRender();

    try {
      const result = await client.prompt(thread.id, content);
      const activity = formatActivity(result.events);
      if (activity) transcript.addChild(new Text(DIM(activity), 1, 0));
      transcript.addChild(
        new Text(`${GREEN("Pi Agent")}\n${result.answer || DIM("未返回文本答案")}`, 1, 0),
      );
      status.setText(`${GREEN("已完成")} ${DIM(`run ${result.runId}`)}`);
    } catch (error) {
      transcript.addChild(new Text(`${RED("错误")}\n${formatError(error)}`, 1, 0));
      status.setText(RED("运行失败"));
    } finally {
      pending = false;
      editor.disableSubmit = false;
      tui.setFocus(editor);
      tui.requestRender();
    }
  }

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  tui.start();
}

function editorTheme() {
  return {
    borderColor: CYAN,
    selectList: {
      selectedPrefix: (text: string) => CYAN(text),
      selectedText: (text: string) => CYAN(text),
      description: (text: string) => DIM(text),
      scrollInfo: (text: string) => DIM(text),
      noMatch: (text: string) => DIM(text),
    },
  };
}

function formatActivity(events: Array<Record<string, unknown>>): string {
  const loaded = [...events].reverse().find((event) => event.type === "skill_loaded");
  const tools = [...new Set(
    events
      .filter((event) => event.type === "tool_execution_start")
      .map((event) => (typeof event.toolName === "string" ? event.toolName : ""))
      .filter(Boolean),
  )];
  const parts = loaded?.label ? [`Skill: ${loaded.label}`] : [];
  if (tools.length > 0) parts.push(`工具活动: ${tools.join(", ")}`);
  return parts.join("\n");
}

function formatStartupError(error: unknown): string {
  if (error instanceof RuntimeClientError && error.code === "RUNTIME_NOT_READY") {
    return [
      "Pi Agent runtime 尚未 ready。",
      error.message,
      "先运行: powershell -ExecutionPolicy Bypass -File .\\scripts\\configure-pi-agent.ps1",
      "再运行: powershell -ExecutionPolicy Bypass -File .\\scripts\\start-pi-agent.ps1 -Restart",
    ].join("\n");
  }
  return `无法连接 Pi Agent runtime: ${formatError(error)}`;
}

function formatError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]").slice(0, 500);
}

await main();
