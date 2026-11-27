import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
const exec = promisify(execFile);
export interface DesktopInput { action: "click" | "move" | "scroll" | "type_text" | "press_key"; x?: number; y?: number; text?: string; key?: string; delta?: number }
async function command(program: string, args: string[]): Promise<string> {
  const { stdout } = await exec(program, args, { timeout: 10000, windowsHide: true, maxBuffer: 1000000 }); return stdout.trim();
}
export async function foregroundTitle(): Promise<string> {
  if (process.platform === "darwin") return command("osascript", ["-e", 'tell application "System Events" to get name of first application process whose frontmost is true']);
  if (process.platform === "win32") return command("powershell.exe", ["-NoProfile", "-Command", `Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public class Foreground { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n); }
'@; $s=New-Object System.Text.StringBuilder 512; [void][Foreground]::GetWindowText([Foreground]::GetForegroundWindow(),$s,512); $s.ToString()`]);
  return command("xdotool", ["getactivewindow", "getwindowname"]);
}
export async function captureFrame(): Promise<Buffer> {
  if (process.env.OPENMAN_CAPTURE_TOKEN) {
    const res = await fetch(`http://127.0.0.1:${process.env.OPENMAN_CAPTURE_PORT || 8644}/capture`, { headers: { Authorization: `Bearer ${process.env.OPENMAN_CAPTURE_TOKEN}` }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error("Screen capture permission is required in desktop settings.");
    return Buffer.from(await res.arrayBuffer());
  }
  const dest = join(tmpdir(), `om-screen-${randomUUID()}.png`);
  try {
    if (process.platform === "darwin") await command("screencapture", ["-x", dest]);
    else if (process.platform === "win32") await command("powershell.exe", ["-NoProfile", "-Command", `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $i=New-Object System.Drawing.Bitmap($b.Width,$b.Height); $g=[System.Drawing.Graphics]::FromImage($i); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $i.Save('${dest.replace(/'/g, "''")}'); $g.Dispose(); $i.Dispose()`]);
    else {
      try { await command("gnome-screenshot", ["-f", dest]); } catch { await command("scrot", [dest]); }
    }
    return await readFile(dest);
  } finally { await rm(dest, { force: true }); }
}
export async function desktopInput(input: DesktopInput): Promise<void> {
  const x = Math.max(0, Math.min(32000, Math.round(Number(input.x) || 0)));
  const y = Math.max(0, Math.min(32000, Math.round(Number(input.y) || 0)));
  const text = String(input.text ?? "").slice(0, 10000);
  const key = String(input.key ?? "");
  const parts = key.split("+");
  const baseKey = parts.pop() || "";
  const modifiers = parts.map(part => ({ ctrl: "Control", control: "Control", alt: "Alt", option: "Alt", shift: "Shift", meta: "Meta", super: "Meta", command: "Meta" })[part.toLowerCase()]);
  if (input.action === "press_key" && (modifiers.some(part => !part) || !/^[A-Za-z0-9_ -]{1,50}$/.test(baseKey))) throw new Error("Unsupported key chord");
  if (process.platform === "linux") {
    if (input.action === "move" || input.action === "click") { await command("xdotool", ["mousemove", String(x), String(y)]); if (input.action === "click") await command("xdotool", ["click", "1"]); }
    else if (input.action === "scroll") await command("xdotool", ["click", "--repeat", "3", (input.delta ?? 0) > 0 ? "5" : "4"]);
    else if (input.action === "type_text") await command("xdotool", ["type", "--clearmodifiers", "--", text]);
    else if (input.action === "press_key" && /^[A-Za-z0-9_+ -]{1,100}$/.test(key)) await command("xdotool", ["key", "--clearmodifiers", [...modifiers.map(mod => ({ Control: "ctrl", Alt: "alt", Shift: "shift", Meta: "super" })[mod!]), ({ Enter: "Return", ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down" })[baseKey] || baseKey].join("+")]);
    return;
  }
  if (process.platform === "darwin") {
    if (input.action === "type_text") await command("osascript", ["-e", `tell application "System Events" to keystroke ${JSON.stringify(text)}`]);
    else if (input.action === "press_key") {
      const codes: Record<string, number> = { Enter: 36, Return: 36, Tab: 48, Escape: 53, Backspace: 51, ArrowLeft: 123, ArrowRight: 124, ArrowDown: 125, ArrowUp: 126 };
      const using = modifiers.length ? ` using {${modifiers.map(mod => ({ Control: "control down", Alt: "option down", Shift: "shift down", Meta: "command down" })[mod!]).join(", ")}}` : "";
      const action = baseKey in codes ? `key code ${codes[baseKey]}` : baseKey.length === 1 ? `keystroke ${JSON.stringify(baseKey.toLowerCase())}` : "";
      if (!action) throw new Error("Unsupported macOS key");
      await command("osascript", ["-e", `tell application "System Events" to ${action}${using}`]);
    } else if (input.action === "click" || input.action === "move") {
      const program = `ObjC.import('CoreGraphics'); var point=$.CGPointMake(${x},${y}); var move=$.CGEventCreateMouseEvent(null,$.kCGEventMouseMoved,point,$.kCGMouseButtonLeft); $.CGEventPost($.kCGHIDEventTap,move);` + (input.action === "click" ? `var down=$.CGEventCreateMouseEvent(null,$.kCGEventLeftMouseDown,point,$.kCGMouseButtonLeft); $.CGEventPost($.kCGHIDEventTap,down); var up=$.CGEventCreateMouseEvent(null,$.kCGEventLeftMouseUp,point,$.kCGMouseButtonLeft); $.CGEventPost($.kCGHIDEventTap,up);` : "");
      await command("osascript", ["-l", "JavaScript", "-e", program]);
    } else if (input.action === "scroll") {
      await command("osascript", ["-l", "JavaScript", "-e", `ObjC.import('CoreGraphics'); var event=$.CGEventCreateScrollWheelEvent(null,0,1,${(input.delta ?? 0) > 0 ? -3 : 3}); $.CGEventPost($.kCGHIDEventTap,event);`]);
    } else throw new Error("Unsupported macOS input action");
    return;
  }
  const prefix = `Add-Type @'
using System; using System.Runtime.InteropServices;
public class Pointer { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e); }
'@; `;
  if (input.action === "click" || input.action === "move") await command("powershell.exe", ["-NoProfile", "-Command", prefix + `[void][Pointer]::SetCursorPos(${x},${y});` + (input.action === "click" ? "[Pointer]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [Pointer]::mouse_event(4,0,0,0,[UIntPtr]::Zero)" : "")]);
  else if (input.action === "press_key") {
    const virtual: Record<string, number> = { Enter: 13, Return: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34 };
    const code = virtual[baseKey] ?? (baseKey.length === 1 ? baseKey.toUpperCase().charCodeAt(0) : 0);
    if (!code) throw new Error("Unsupported Windows key");
    const mods = modifiers.map(mod => ({ Control: 17, Shift: 16, Alt: 18, Meta: 91 })[mod!]);
    const keys = [...mods, code];
    await command("powershell.exe", ["-NoProfile", "-Command", `Add-Type 'using System; using System.Runtime.InteropServices; public class Keys { [DllImport("user32.dll")] public static extern void keybd_event(byte v, byte s, uint f, UIntPtr e); }'; ` + keys.map(v => `[Keys]::keybd_event(${v},0,0,[UIntPtr]::Zero);`).join(" ") + keys.reverse().map(v => `[Keys]::keybd_event(${v},0,2,[UIntPtr]::Zero);`).join(" ")]);
  }
  else if (input.action === "type_text") {
    const escaped = text.replace(/[+^%~(){}\[\]]/g, "{$&}").replace(/'/g, "''");
    await command("powershell.exe", ["-NoProfile", "-Command", `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped}')`]);
  } else if (input.action === "scroll") await command("powershell.exe", ["-NoProfile", "-Command", prefix + `[Pointer]::mouse_event(2048,0,0,${(input.delta ?? 0) > 0 ? "4294967176" : "120"},[UIntPtr]::Zero)`]);
  else throw new Error("Unsupported Windows input action");
}
