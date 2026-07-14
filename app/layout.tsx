import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PETCAM | 보호자 실시간 펫 카메라",
  description: "AWS Kinesis Video Streams 기반 펫 로봇 실시간 영상, 양방향 음성, 7일 클라우드 녹화",
  referrer: "no-referrer",
  icons: {
    icon: "/favicon.svg",
  },
  openGraph: {
    title: "PETCAM | 보호자 실시간 펫 카메라",
    description: "실시간 영상과 양방향 음성, 최근 7일 클라우드 녹화를 한곳에서 확인합니다.",
    images: [
      {
        url: "/og.png",
        width: 1732,
        height: 908,
        alt: "클라우드와 보호자 휴대전화에 연결된 PETCAM 펫 로봇",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
