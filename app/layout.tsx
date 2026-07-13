import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PETCAM | 보호자 실시간 펫 카메라",
  description: "AWS Kinesis Video Streams WebRTC 기반 펫 로봇 실시간 카메라",
  referrer: "no-referrer",
  icons: {
    icon: "/favicon.svg",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
