import * as d3 from "d3";
import { D3LineRecord } from "./types";

export function setDimensions(chartWidth?: number) {
  let dimensions = {
    width: chartWidth ? chartWidth : 1000,
    height: 400,
    margins: 50,
    ctrWidth: 0,
    ctrHeight: 0,
  };

  dimensions.ctrWidth = dimensions.width - dimensions.margins * 2;
  dimensions.ctrHeight = dimensions.height - dimensions.margins * 2;

  return dimensions;
}

export function processLineData(
  lines: {
    name: string;
    records: { ts: string; value: number }[];
    color?: string;
  }[]
) {
  return lines.map((el) => {
    return {
      name: el.name,
      records: el.records.map((el) => {
        const record: D3LineRecord = {
          date: convertDate(el.ts),
          value: el.value,
        };
        return record;
      }),
    };
  });
}

export function processRectData(
  rectangles: {
    name: string;
    start_at: string;
    end_at: string;
    color?: string;
  }[]
) {
  if (!rectangles || rectangles.length == 0) {
    return [];
  }

  return rectangles.map((el) => {
    return {
      name: el.name,
      start: convertDate(el.start_at),
      end: convertDate(el.end_at),
      color: el.color,
    };
  });
}

// Convert date string to Date object
function convertDate(dateString: string) {
  const date = new Date(dateString);
  return date;
}

export function getRecordyDate(
  records: D3LineRecord[],
  date: Date
): D3LineRecord {
  const idx = dateBisector(records, date);
  if (idx <= 0) {
    return records[0];
  }
  return records[idx];
}

export function formatDate(date: Date): string {
  return date.toISOString().replace("T"," ")
}

// custom bisect to find the closest data point to the mouse position
export const dateBisector = d3.bisector((d: D3LineRecord) => d.date).left;
export const xAccessor = (d: D3LineRecord) => d.date;
export const yAccessor = (d: D3LineRecord) => d.value;
