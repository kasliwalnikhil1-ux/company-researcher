import React from 'react';

const LIGHT_SPARKLE_COLORS = [
  'rgba(147, 197, 253, 0.9)',   // blue-300
  'rgba(216, 180, 254, 0.9)',   // purple-300
  'rgba(249, 168, 212, 0.9)',   // pink-300
  'rgba(103, 232, 249, 0.9)',   // cyan-300
  'rgba(253, 230, 138, 0.9)',   // amber-200
  'rgba(255, 255, 255, 0.9)',   // white
];

interface SparklesProps {
  count?: number;
  sizeRange?: { min: number; max: number };
  colors?: string[];
  className?: string;
}

export const Sparkles: React.FC<SparklesProps> = ({
  count = 25,
  sizeRange = { min: 8, max: 18 },
  className = ''
}) => {
  // Use ref to store sparkles permanently - they only generate once on mount
  const sparklesRef = React.useRef<Array<{
    size: number;
    duration: number;
    delay: number;
    color: string;
    moveX: number;
    moveY: number;
    startOpacity: number;
    left: number;
    top: number;
  }>>([]);

  // Always use explicit light rgba colors so no sparkle can inherit black
  const safePalette = LIGHT_SPARKLE_COLORS;

  // Generate sparkles only once on mount
  if (sparklesRef.current.length === 0) {
    sparklesRef.current = [...Array(count)].map((_, i) => {
      const size = Math.random() * (sizeRange.max - sizeRange.min) + sizeRange.min;
      const duration = Math.random() * 3 + 2; // 2-5 seconds
      const delay = i < count * 0.5 ? 0 : Math.random() * 1;
      const color = safePalette[Math.floor(Math.random() * safePalette.length)];
      const moveX = Math.random() * 80 - 40;
      const moveY = Math.random() * 80 - 40;
      const startOpacity = delay === 0 ? (Math.random() * 0.5 + 0.5) : 0;
      const left = Math.random() * 100;
      const top = Math.random() * 100;

      return { size, duration, delay, color, moveX, moveY, startOpacity, left, top };
    });
  }

  const sparkles = sparklesRef.current;

  return (
    <div className={`absolute inset-0 overflow-hidden pointer-events-none ${className}`}>
      {sparkles.map((sparkle, i) => {
        return (
          <div
            key={i}
            className="absolute"
            style={{
              left: `${sparkle.left}%`,
              top: `${sparkle.top}%`,
              width: `${sparkle.size}px`,
              height: `${sparkle.size}px`,
              color: sparkle.color,
              animation: `sparkle-${i} ${sparkle.duration}s ease-in-out ${sparkle.delay}s infinite`,
              filter: 'drop-shadow(0 0 4px currentColor)',
              zIndex: 0,
              opacity: sparkle.startOpacity
            }}
          >
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M12,2L9,12L2,12L10,18L7,28L18,18L22,18L14,12L18,2L12,2Z" />
            </svg>
            <style dangerouslySetInnerHTML={{
              __html: `
                @keyframes sparkle-${i} {
                  0% {
                    opacity: ${sparkle.startOpacity};
                    transform: translate(0, 0) rotate(0deg) scale(${sparkle.startOpacity > 0 ? 0.8 : 0.5});
                  }
                  25% {
                    opacity: 1;
                  }
                  50% {
                    opacity: 0.8;
                    transform: translate(${sparkle.moveX}px, ${sparkle.moveY}px) rotate(180deg) scale(1);
                  }
                  100% {
                    opacity: 0;
                    transform: translate(${sparkle.moveX * 1.5}px, ${sparkle.moveY * 1.5}px) rotate(360deg) scale(0.6);
                  }
                }
              `
            }} />
          </div>
        );
      })}
    </div>
  );
};

export default Sparkles;
