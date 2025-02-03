export interface RectangleData {
  name: string;
  start: Date;
  end: Date;
  color?: string;
}

export interface TimeData {
  name: string;
  start_time: string;
  end_time: string;
}

export interface D3LineRecord {
  date: Date;
  value: number;
}
