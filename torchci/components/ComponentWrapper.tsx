import { ReactNode } from 'react';

interface ComponentWrapperProps {
  children: ReactNode;
  className?: string;
}

// A reusable wrapper component that applies consistent styling
// for components that should have the component background color
export default function ComponentWrapper({ children, className = '' }: ComponentWrapperProps) {
  return (
    <div className={`component-bg ${className}`} style={{ 
      padding: '1rem', 
      borderRadius: '0.5rem',
      border: '1px solid var(--border-color)',
    }}>
      {children}
    </div>
  );
}