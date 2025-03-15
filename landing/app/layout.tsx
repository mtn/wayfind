import type React from "react"
import type { Metadata } from "next"
import { JetBrains_Mono } from "next/font/google"
import "./globals.css"

const mono = JetBrains_Mono({ subsets: ["latin"] })

export const metadata: Metadata = {
  title: "Wayfind",
  description: "Navigation simplified",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body className={mono.className}>{children}</body>
    </html>
  )
}

