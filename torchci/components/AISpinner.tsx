import React from 'react';
import styled from '@emotion/styled';
import { keyframes } from '@emotion/react';
import { Box, useTheme } from '@mui/material';

// Define animations for the cubes
const pulse = keyframes`
  0% { transform: scale(0.8); opacity: 0.3; }
  50% { transform: scale(1); opacity: 1; }
  100% { transform: scale(0.8); opacity: 0.3; }
`;

const rotate = keyframes`
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
`;

const Container = styled.div`
  position: relative;
  width: 50px;
  height: 50px;
  display: flex;
  justify-content: center;
  align-items: center;
`;

const SpinnerRing = styled.div<{ color: string }>`
  position: absolute;
  width: 50px;
  height: 50px;
  border: 2px solid transparent;
  border-top: 2px solid ${props => props.color};
  border-radius: 50%;
  animation: ${rotate} 1.5s linear infinite;
`;

const CubeContainer = styled.div`
  position: relative;
  width: 30px;
  height: 30px;
  transform-style: preserve-3d;
  transform: rotateX(45deg) rotateZ(45deg);
`;

const Cube = styled.div<{ delay: number, color: string }>`
  position: absolute;
  width: 10px;
  height: 10px;
  background: ${props => props.color};
  opacity: 0.7;
  animation: ${pulse} 1.5s ease-in-out infinite;
  animation-delay: ${props => props.delay}s;
`;

const AISpinner: React.FC = () => {
  const theme = useTheme();
  const primaryColor = theme.palette.primary.main;
  const secondaryColor = theme.palette.secondary.main;

  // Position for the 3 cubes
  const positions = [
    { top: '0px', left: '0px', delay: 0 },
    { top: '0px', left: '15px', delay: 0.2 },
    { top: '15px', left: '0px', delay: 0.4 },
    { top: '15px', left: '15px', delay: 0.6 }
  ];

  return (
    <Container>
      <SpinnerRing color={primaryColor} />
      <CubeContainer>
        {positions.map((pos, index) => (
          <Cube
            key={index}
            style={{ top: pos.top, left: pos.left }}
            delay={pos.delay}
            color={index % 2 === 0 ? primaryColor : secondaryColor}
          />
        ))}
      </CubeContainer>
    </Container>
  );
};

export default AISpinner;