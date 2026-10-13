import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AgentSlack",
  description: "A workplace for your AI agent team",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans">{children}</body>
    </html>
  );
}
