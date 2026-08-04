import "./globals.css";

export const metadata = {
  title: {
    default: "OdontoartPix",
    template: "%s | OdontoartPix"
  },
  description: "Sistema web para análise segura de mensalidades de associados.",
  applicationName: "OdontoartPix",
  authors: [{ name: "OdontoartPix" }],
  robots: {
    index: false,
    follow: false
  },
  icons: {
    icon: "/favicon.svg"
  }
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `(() => { const saved = localStorage.getItem("theme"); const dark = saved ? saved === "dark" : matchMedia("(prefers-color-scheme: dark)").matches; document.documentElement.classList.toggle("dark", dark); document.documentElement.dataset.theme = dark ? "dark" : "light"; })()` }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
