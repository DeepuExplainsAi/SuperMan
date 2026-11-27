"use client";
import { useEffect, useRef } from "react";
import type { VncViewerProps, VncHandle } from "./vnc-viewer";

export function NativeViewer({ interactive, onStateChange, onReady, className }: VncViewerProps) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const socket = useRef<WebSocket | null>(null);
  const notify = useRef(onStateChange); const ready = useRef(onReady);
  useEffect(() => { notify.current = onStateChange; ready.current = onReady; }, [onStateChange, onReady]);
  useEffect(() => {
    let stopped = false;
    const send = (input: unknown) => { if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(input)); };
    notify.current?.("connecting", null);
    fetch("/api/local/desktop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ interactive }) }).then(async (res) => {
      if (!res.ok) throw new Error("Could not authorize desktop stream");
      const body = await res.json(); if (stopped) return;
      const ws = new WebSocket(body.url); socket.current = ws;
      ws.onmessage = (event) => {
        if (stopped) return;
        const frame = JSON.parse(event.data);
        if (frame.type === "error") { notify.current?.("failed", frame.message); return; }
        if (frame.type !== "frame") return;
        const image = new Image(); image.onload = () => {
          if (!canvas.current || stopped) return;
          canvas.current.width = image.width; canvas.current.height = image.height;
          canvas.current.getContext("2d")?.drawImage(image, 0, 0); notify.current?.("connected", null);
        }; image.src = `data:image/png;base64,${frame.data}`;
      };
      ws.onerror = () => notify.current?.("failed", "Local screen service unavailable or permission denied");
      ws.onclose = () => { if (!stopped) notify.current?.("failed", "Desktop stream disconnected"); };
      if (host.current) {
        const handle: VncHandle = { host: host.current, canvas: () => canvas.current, paste: (text) => { if (interactive) send({ action: "type_text", text }); }, sendKeys: (keysyms) => {
          if (!interactive) return;
          const named: Record<number, string> = { 0xffe1: "Shift", 0xffe2: "Shift", 0xffe3: "Control", 0xffe4: "Control", 0xffe9: "Alt", 0xffea: "Alt", 0xffeb: "Meta", 0xffec: "Meta", 0xff0d: "Enter", 0xff1b: "Escape", 0xff09: "Tab", 0xff08: "Backspace", 0xffff: "Delete", 0xff51: "ArrowLeft", 0xff52: "ArrowUp", 0xff53: "ArrowRight", 0xff54: "ArrowDown" };
          const keys = keysyms.map(code => named[code] || (code >= 32 && code < 127 ? String.fromCharCode(code) : ""));
          if (keys.every(Boolean)) send({ action: "press_key", key: keys.join("+") });
        }, focus: () => canvas.current?.focus() };
        ready.current?.(handle);
      }
    }).catch((error) => { if (!stopped) notify.current?.("failed", error.message); });
    return () => { stopped = true; socket.current?.close(); socket.current = null; ready.current?.(null); };
  }, [interactive]);
  const input = (value: unknown) => { if (interactive && socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(value)); };
  return <div ref={host} className={className ?? "flex h-full w-full items-center justify-center bg-black"}>
    <canvas ref={canvas} tabIndex={interactive ? 0 : -1} aria-label={interactive ? "Interactive local desktop" : "Local desktop, view only"} className="max-h-full max-w-full object-contain outline-none" onClick={(event) => {
      const bounds = event.currentTarget.getBoundingClientRect(); event.currentTarget.focus();
      input({ action: "click", x: (event.clientX - bounds.left) * event.currentTarget.width / bounds.width, y: (event.clientY - bounds.top) * event.currentTarget.height / bounds.height });
    }} onKeyDown={(event) => { if (!interactive) return; event.preventDefault(); if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return;
      const chord = [event.ctrlKey && "Control", event.altKey && "Alt", event.metaKey && "Meta", event.shiftKey && "Shift", event.key].filter(Boolean).join("+");
      input(event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey ? { action: "type_text", text: event.key } : { action: "press_key", key: chord }); }} onWheel={(event) => input({ action: "scroll", delta: event.deltaY })} />
  </div>;
}
