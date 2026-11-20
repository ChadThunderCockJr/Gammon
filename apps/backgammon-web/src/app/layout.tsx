import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import { headers } from "next/headers";
import { Cinzel, Cormorant_Garamond, Josefin_Sans, JetBrains_Mono, Pinyon_Script } from "next/font/google";
import { SITE_URL } from "@/lib/config";
import { RootClientProviders } from "./RootClientProviders";
import { routeTitle } from "@/lib/route-metadata";
import "./globals.css";

const cinzel = Cinzel({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-cinzel",
  display: "swap",
});
const cormorant = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-cormorant",
  display: "swap",
});
const josefinSans = Josefin_Sans({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-josefin",
  display: "swap",
});
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-jetbrains",
  display: "swap",
});
const pinyonScript = Pinyon_Script({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-pinyon",
  display: "swap",
});

const description = "Play backgammon online, practice against the computer, and review every match.";

export async function generateMetadata(): Promise<Metadata> {
  const pathname = (await headers()).get("x-gammon-pathname");
  const title = pathname ? routeTitle(pathname) : "Gammon";
  return {
    metadataBase: new URL(SITE_URL),
    title,
    description,
    manifest: "/manifest.json",
    appleWebApp: { capable: true, statusBarStyle: "black-translucent" },
    openGraph: {
      title,
      description,
      type: "website",
      url: SITE_URL,
      images: [{ url: "/logo.png", width: 512, height: 512, alt: "Gammon backgammon board" }],
    },
    twitter: { card: "summary", images: ["/logo.png"] },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#F5F1EB",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  await connection();
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("gammon-theme");document.documentElement.className=t==="lux"?"lux":t==="dark"?"dark":"light"}catch(e){}})()`,
          }}
        />
      </head>
      <body className={`${cinzel.variable} ${cormorant.variable} ${josefinSans.variable} ${jetbrainsMono.variable} ${pinyonScript.variable} antialiased`}>
        <RootClientProviders>{children}</RootClientProviders>
      </body>
    </html>
  );
}
