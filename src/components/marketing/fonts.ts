// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Organic Intelligence, Inc.
/** Serif used by marketing headings. Exposes `--font-libre-baskerville`, which `font-serif` reads. */
import localFont from "next/font/local";

export const libreBaskerville = localFont({
  src: [
    { path: "../../../public/fonts/LibreBaskerville.ttf", weight: "400 700", style: "normal" },
    { path: "../../../public/fonts/LibreBaskerville-Italic.ttf", weight: "400 700", style: "italic" },
  ],
  variable: "--font-libre-baskerville",
  display: "swap",
});
