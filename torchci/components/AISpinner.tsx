import React from 'react';
import styled from '@emotion/styled';
import { keyframes } from '@emotion/react';
import { useTheme } from '@mui/material';

// Define animations for the cubes and sparkles
const pulse = keyframes`
  0% { transform: scale(0.8); opacity: 0.3; }
  50% { transform: scale(1); opacity: 1; }
  100% { transform: scale(0.8); opacity: 0.3; }
`;

const float = keyframes`
  0% { transform: translateY(0) rotate(0); opacity: 0.2; }
  50% { transform: translateY(-10px) rotate(45deg); opacity: 1; }
  100% { transform: translateY(-20px) rotate(90deg); opacity: 0; }
`;

const sparkle = keyframes`
  0% { transform: scale(0); opacity: 0; }
  50% { transform: scale(1); opacity: 1; }
  100% { transform: scale(0); opacity: 0; }
`;

const Container = styled.div`
  position: relative;
  width: 70px;
  height: 70px;
  display: flex;
  justify-content: center;
  align-items: center;
  margin-right: 6px; // Ensures the sparkles don't overlap with text
`;

const CubeContainer = styled.div`
  position: relative;
  width: 65px;
  height: 65px;
  transform-style: preserve-3d;
  transform: rotateX(45deg) rotateZ(45deg);
`;

const Cube = styled.div<{ delay: number, color: string, size: string }>`
  position: absolute;
  width: ${props => props.size};
  height: ${props => props.size};
  background: ${props => props.color};
  opacity: 0.8;
  border-radius: 2px;
  animation: ${pulse} 1.8s ease-in-out infinite;
  animation-delay: ${props => props.delay}s;
  box-shadow: 0 0 10px rgba(255, 255, 255, 0.3);
`;

const Sparkle = styled.div<{ delay: number, color: string, size: string, top: string, left: string }>`
  position: absolute;
  width: ${props => props.size};
  height: ${props => props.size};
  top: ${props => props.top};
  left: ${props => props.left};
  background: ${props => props.color};
  border-radius: 50%;
  opacity: 0.8;
  animation: ${sparkle} 2s ease-in-out infinite;
  animation-delay: ${props => props.delay}s;
  box-shadow: 0 0 8px ${props => props.color};
`;

const FloatingParticle = styled.div<{ delay: number, color: string, size: string, top: string, left: string }>`
  position: absolute;
  width: ${props => props.size};
  height: ${props => props.size};
  top: ${props => props.top};
  left: ${props => props.left};
  background: ${props => props.color};
  opacity: 0;
  animation: ${float} 3s ease-in-out infinite;
  animation-delay: ${props => props.delay}s;
`;

const AISpinner: React.FC = () => {
  const theme = useTheme();
  const primaryColor = theme.palette.primary.main;
  const secondaryColor = theme.palette.secondary.main;

  // Position for the 4 cubes in a grid - more square now
  const cubes = [
    { top: '0px', left: '0px', delay: 0, size: '28px' },
    { top: '0px', left: '32px', delay: 0.3, size: '28px' },
    { top: '32px', left: '0px', delay: 0.6, size: '28px' },
    { top: '32px', left: '32px', delay: 0.9, size: '28px' }
  ];

  // Create sparkles
  const sparkles = [
    { top: '-10px', left: '20px', delay: 0.2, size: '6px', color: primaryColor },
    { top: '20px', left: '-10px', delay: 0.7, size: '5px', color: secondaryColor },
    { top: '50px', left: '20px', delay: 0.4, size: '7px', color: primaryColor },
    { top: '20px', left: '65px', delay: 0.9, size: '5px', color: secondaryColor },
    { top: '70px', left: '60px', delay: 1.2, size: '4px', color: primaryColor },
    { top: '-15px', left: '50px', delay: 1.5, size: '5px', color: secondaryColor }
  ];

  // Floating particles
  const particles = [
    { top: '20px', left: '5px', delay: 0.2, size: '5px', color: primaryColor },
    { top: '15px', left: '60px', delay: 0.8, size: '4px', color: secondaryColor },
    { top: '55px', left: '55px', delay: 1.3, size: '6px', color: primaryColor },
    { top: '40px', left: '-5px', delay: 1.7, size: '3px', color: secondaryColor }
  ];

  return (
    <Container>
      <CubeContainer>
        {cubes.map((cube, index) => (
          <Cube
            key={`cube-${index}`}
            style={{ top: cube.top, left: cube.left }}
            delay={cube.delay}
            size={cube.size}
            color={index % 2 === 0 ? primaryColor : secondaryColor}
          />
        ))}
      </CubeContainer>
      
      {/* Add sparkles */}
      {sparkles.map((spark, index) => (
        <Sparkle
          key={`sparkle-${index}`}
          delay={spark.delay}
          color={spark.color}
          size={spark.size}
          top={spark.top}
          left={spark.left}
        />
      ))}
      
      {/* Add floating particles */}
      {particles.map((particle, index) => (
        <FloatingParticle
          key={`particle-${index}`}
          delay={particle.delay}
          color={particle.color}
          size={particle.size}
          top={particle.top}
          left={particle.left}
        />
      ))}
    </Container>
  );
};

export default AISpinner;