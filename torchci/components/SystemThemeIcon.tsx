import React from 'react';

interface SystemThemeIconProps {
  size?: number;
  color?: string;
}

// Custom icon that shows half sun/half moon to represent system theme
export default function SystemThemeIcon({ size = 16, color = 'currentColor' }: SystemThemeIconProps) {
  return (
    <svg 
      xmlns="http://www.w3.org/2000/svg" 
      width={size} 
      height={size} 
      viewBox="0 0 24 24" 
      fill="none" 
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round" 
      strokeLinejoin="round"
    >
      {/* Split down the middle with a sun and moon */}
      <g>
        {/* Left half (sun) */}
        <path d="M12 16a4 4 0 0 0 0-8" strokeWidth="2" />
        <path d="M12 4v2" strokeWidth="2" />
        <path d="M12 18v2" strokeWidth="2" />
        <path d="M5 12h2" strokeWidth="2" />
        <path d="M7 7l1.5 1.5" strokeWidth="2" />
        <path d="M7 17l1.5-1.5" strokeWidth="2" />
      </g>
      <g>
        {/* Right half (moon) */}
        <path d="M12 16c1.5 0 3-1 3-4s-1.5-4-3-4" strokeWidth="2" />
        <path d="M19 12c0-4-3-7-7-7" strokeWidth="2" />
        <path d="M19 12c0 4-3 7-7 7" strokeWidth="2" />
      </g>
    </svg>
  );
}