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
    icon: "/favicon.ico"
  }
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body className="bg-slate-50 text-slate-950 antialiased">{children}</body>
    </html>
  );
}
