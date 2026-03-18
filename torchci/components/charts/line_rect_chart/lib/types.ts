export interface RectangleData {
  name: string;
  start: Date;
  end: Date;
  color?: string;
  opacity?: number;
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

export interface Line {
  name: string;
  records: D3LineRecord[];
  color?: string;
  hidden?: boolean;
  id: string;
}

export interface PickerConfig {
  category: string;
  types: PickerConfigType[];
}

export interface PickerConfigType {
  name: string;
  tags: string[];
}

export function containsAllSubstrings(
  mainString: string,
  substrings: string[]
) {
  return substrings.every((substring) => mainString.includes(substring));
}
