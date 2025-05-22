import React from 'react';
import styled from '@emotion/styled';
import { SvgIcon, Box } from '@mui/material';
import Image from 'next/image';

const IconWrapper = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  margin-right: 8px;
  overflow: visible;
`;

// Default tool icon
const DefaultToolIcon = () => (
  <SvgIcon viewBox="0 0 24 24">
    <path
      fill="currentColor" 
      d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z"
    />
  </SvgIcon>
);

interface ToolIconProps {
  toolName: string;
}

const ToolIcon: React.FC<ToolIconProps> = ({ toolName }) => {
  const lowerCaseName = toolName.toLowerCase();
  
  if (lowerCaseName.includes('clickhouse')) {
    return (
      <IconWrapper>
        <Box position="relative" width="24px" height="24px">
          <Image 
            src="/icons/clickhouse_icon.png"
            alt="ClickHouse Icon"
            width={24}
            height={24}
            style={{objectFit: 'contain'}}
          />
        </Box>
      </IconWrapper>
    );
  } 
  
  if (lowerCaseName.includes('grafana')) {
    return (
      <IconWrapper>
        <Box position="relative" width="24px" height="24px">
          <Image 
            src="/icons/grafana_icon.svg"
            alt="Grafana Icon"
            width={24}
            height={24}
            style={{objectFit: 'contain'}}
          />
        </Box>
      </IconWrapper>
    );
  }
  
  if (lowerCaseName === 'bash') {
    return (
      <IconWrapper>
        <Box position="relative" width="24px" height="24px">
          <Image 
            src="/icons/bash_icon.svg"
            alt="Bash Icon"
            width={24}
            height={24}
            style={{objectFit: 'contain'}}
          />
        </Box>
      </IconWrapper>
    );
  }
  
  return (
    <IconWrapper>
      <DefaultToolIcon />
    </IconWrapper>
  );
};

export default ToolIcon;