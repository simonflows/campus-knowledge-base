import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AmbientBackdrop } from "@/components/motion/ambient-backdrop";
import { Toaster } from "@/components/ui/sonner";
import { appName } from "@/components/navigation/campus-chrome";

const description =
  "Карточки семи университетов-резидентов Челябинской области, паспорт кампуса, проверка фактов и редактор публикаций.";
export const metadata: Metadata = {
  title: appName,
  description,
  openGraph: { title: appName, description, type: "website", locale: "ru_RU" },
  other: { "page-type": "software", "site-kind": "software" },
};
export const viewport: Viewport = { themeColor: "#102332" };

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const assetBase = process.env.BASE_PATH || "";
  return (
    <html
      suppressHydrationWarning
      lang="ru"
      data-type="software"
      data-ground="sky"
      data-radius="soft"
      data-buttons="solid"
      data-motion="auto"
      className="font-sans"
    >
      <head>
        <link rel="stylesheet" href={`${assetBase}/atlas/motion/motion.css`} />
      </head>
      <body className="flex min-h-screen flex-col antialiased">
        <AmbientBackdrop />
        {children}
        <Toaster richColors position="top-right" offset={{ top: 96 }} />
      </body>
    </html>
  );
}
