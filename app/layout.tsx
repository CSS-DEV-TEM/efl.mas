import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'MAS AUTOMATE PICK SYSTEM',
  description: 'EFL · MAS weekly plan tracking from ZMMBE, KFC, PFC, PLANT and TRR reports',
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* v148: the theme chosen on this device, set before the first paint (no flash) */}
        <script dangerouslySetInnerHTML={{ __html: "try{var t=localStorage.getItem('mas-theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}" }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Montserrat:wght@400;500;600;700;800&family=IBM+Plex+Sans+Condensed:wght@500;600&family=IBM+Plex+Sans:wght@400;500;600&family=Noto+Sans+Sinhala:wght@400;600&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
