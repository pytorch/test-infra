// This file provides a function to set chart themes for ECharts

export function applyChartTheme(isDarkMode: boolean) {
  // This function can be called after charts are rendered to help fix legend colors
  setTimeout(() => {
    const legendTexts = document.querySelectorAll('.echarts-for-react text');
    const textColor = isDarkMode ? '#E0E0E0' : '#212529';
    
    legendTexts.forEach((text) => {
      if (text instanceof SVGTextElement) {
        text.style.fill = textColor;
        text.setAttribute('fill', textColor);
      }
    });
    
    // Also try to update any spans in legend
    const legendSpans = document.querySelectorAll('.echarts-for-react span');
    legendSpans.forEach((span) => {
      span.style.color = textColor;
    });
  }, 100);
}

// Register global chart theme
export function registerChartThemes() {
  // This could be used to register global chart themes if needed
  if (typeof window !== 'undefined') {
    window.addEventListener('dark-mode-changed', (e: any) => {
      // Apply the theme whenever dark mode changes
      applyChartTheme(e.detail.darkMode);
    });
  }
}