import { Suspense } from "react";
import { connection } from "next/server";
import Link from "next/link";
import { brand } from "@/config/brand";
import { isLocalMode } from "@/lib/local/paths";
export default function DownloadPage() {
  return <Suspense fallback={<main className="p-12">Loading desktop status…</main>}><DownloadStatus /></Suspense>;
}
async function DownloadStatus() {
  await connection();
  return <main className="mx-auto max-w-3xl space-y-7 px-6 py-20">
    <h1 className="font-serif text-4xl">{brand.name} on your computer</h1>
    <p>{isLocalMode() ? "The local workspace is running on this computer." : "Build the desktop application to run your workspace locally."}</p>
    <Link href="/app" className="inline-block rounded-lg border px-5 py-3">Open workspace</Link>
    <h2 className="text-2xl">Desktop installer build targets</h2>
    <ul className="list-disc space-y-3 pl-6"><li>Windows 10/11: interactive Setup EXE, enterprise MSI, portable EXE. x64, ARM64, and 32-bit x86.</li><li>Linux: AppImage, Debian package, RPM. x64 and ARM64.</li><li>macOS: DMG, PKG, ZIP. Universal Intel and Apple Silicon.</li></ul>
    <p>Installer artifacts are produced by the repository’s native-platform release workflow. See README.md for build commands, signing requirements, and current validation limits.</p>
    <p>Closing the desktop window keeps the agent and schedules running in the system tray. Choose “Quit Completely” to stop background services.</p>
  </main>;
}
