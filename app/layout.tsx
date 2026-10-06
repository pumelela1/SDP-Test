import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RAT — Repo Analysis Tool",
  description: "Git repository metrics dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <a href="/">RAT</a>
          <span>Repo Analysis Tool</span>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
