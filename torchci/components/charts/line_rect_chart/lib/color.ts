// Color choice to keep the chart rendering consistent
const ChartColorChoice = [
  "#FF69B4",
  "#3498DB",
  "#F1C40F",
  "#2ECC71",
  "#9B59B6",
  "#16A085",
  "#E74C3C",
  "#1ABC9C",
  "#2980B9",
  "#F7DC6F",
  "#8E44AD",
  "#27AE60",
  "#C0392B",
  "#4CAF50",
  "#95A5A6",
  "#7F8C8D",
  "#03A9F4",
  "#FF9800",
  "#2196F3",
  "#009688",
];

export function getRandomColor(index: number): string {
  return ChartColorChoice[index % ChartColorChoice.length];
}
