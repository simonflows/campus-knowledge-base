import type { Metadata } from "next";

import { BrowserDemo } from "@/components/demo/browser-demo";

export const metadata: Metadata = {
  title: "Демо-режим · Канон",
  robots: { index: false, follow: false },
};

export default function DemoPage() {
  return <BrowserDemo />;
}
