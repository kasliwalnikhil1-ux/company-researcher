import type { Viewport } from 'next';

// The hosted chat page is the chat and nothing else: on a phone it must not pinch-zoom or zoom into the message box.
export const viewport: Viewport = { width: 'device-width', initialScale: 1, maximumScale: 1, userScalable: false };

export default function StandaloneChatLayout({ children }: { children: React.ReactNode }) {
  return children;
}
