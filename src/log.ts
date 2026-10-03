import { appendFileSync } from "node:fs";

let logFile: string | null = null;

export const setLogFile = (path: string | null): void => {
  logFile = path;
};

const pad = (n: number): string => String(n).padStart(2, "0");

function stamp(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// DEBUG 는 화면에 안 띄우고 파일에만 남긴다 (SMARTSTORE_DEBUG=1 이면 화면에도).
// 구매 흐름이 어디서 무엇을 눌렀는지는 틀렸을 때만 필요하다 — 평소 화면을 덮을 이유가 없다.
const SHOW_DEBUG = !!process.env.SMARTSTORE_DEBUG;

function emit(level: string, msg: string): void {
  const line = `${stamp()} [${level}] ${msg}`;
  if (level !== "DEBUG" || SHOW_DEBUG) (level === "INFO" || level === "DEBUG" ? console.log : console.error)(line);
  if (logFile) {
    try {
      appendFileSync(logFile, line + "\n", "utf8");
    } catch {
      // 로그 파일을 못 쓴다고 감시를 멈출 이유는 없다
    }
  }
}

export const log = {
  info: (msg: string): void => emit("INFO", msg),
  warn: (msg: string): void => emit("WARNING", msg),
  error: (msg: string): void => emit("ERROR", msg),
  debug: (msg: string): void => emit("DEBUG", msg),
};

/** Ctrl+C 로 깨울 수 있는 sleep. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
