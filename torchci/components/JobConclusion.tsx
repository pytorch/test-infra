import { getConclusionChar } from "lib/JobClassifierUtil";
import { JobStatus } from "./GroupJobConclusion";
import styles from "./JobConclusion.module.css";
import { JobData } from "../lib/types";
import { useContext } from "react";
import { StylishFailuresContext } from "../pages/hud/[repoOwner]/[repoName]/[branch]/[[...page]]";

/**
 * `getFailureStyle` is a function that generates a style object for a job failure based on the conclusion and job data.
 *
 * @param {string} conclusion - The conclusion of the job. It should be `JobStatus.Failure` for the function to proceed.
 * @param {JobData} jobData - The data of the job. It should contain `failureLines` for the function to proceed.
 *
 * @returns {Object} An object containing CSS properties for styling. The properties include fontSize, color, textShadow, transform, fontWeight, and textDecoration.
 * These properties are generated based on a hash value derived from the first line of `failureLines` in `jobData`.
 * If the conclusion is not `JobStatus.Failure` or `jobData.failureLines` is not defined or empty, an empty object is returned.
 */
const getFailureStyle = (conclusion?: string, jobData?: JobData) => {
  if (
    conclusion !== JobStatus.Failure ||
    !jobData?.failureLines ||
    !jobData.failureLines[0]
  ) {
    return {};
  }
  const error = jobData?.failureLines && jobData.failureLines[0];

  // Generate hash value from the error string
  let hashValue = hashJobFailureString(error);

  // Generate color variations based on the hash value
  const hue = (hashValue % 30) + 330;
  const saturation = 70 + (hashValue % 30);
  const lightness = 50 + (hashValue % 20);
  const color = `hsl(${hue}, ${saturation}%, ${lightness}%)`;

  // Generate text shadow based on the hash value
  const shadowX = (hashValue % 5) - 2;
  const shadowY = (hashValue % 3) - 1;

  // Generate color variations based on the hash value
  const sHue = hashValue % 360; // This will give a hue between 0 and 360
  const sSaturation = hashValue % 100; // Keep saturation low for gray color
  const sLightness = 50 + (hashValue % 50); // Adjust lightness to a mid value
  const shadowColor = `hsl(${sHue}, ${sSaturation}%, ${sLightness}%)`;

  const shadowBlur = hashValue % 4;
  const textShadow = `${shadowX}px ${shadowY}px ${shadowBlur}px ${shadowColor}`;

  hashValue = hashValue >> 3;

  // Generate rotation based on the hash value
  const rotation = (hashValue % 60) - 30;
  let transform = `rotate(${rotation}deg)`;

  // Generate vertical squeeze based on the hash value
  const scaleY = 1 - (hashValue % 20) / 100; // This will give a scale between 0.8 and 1
  transform += ` scaleY(${scaleY})`;

  // Generate font weight based on the hash value
  const fontWeight = hashValue % 2 === 0 ? "bold" : "normal";

  // Generate font size based on the hash value
  const fontSize = 13 + (hashValue % 5);

  // Generate text decoration based on the hash value
  let textDecoration = "";
  if (hashValue & 1) {
    textDecoration += "underline ";
  }
  if (hashValue & 2) {
    textDecoration += "overline ";
  }
  if (hashValue & 4) {
    textDecoration += "line-through ";
  }
  // If no decoration was added, set it to none
  if (textDecoration === "") {
    textDecoration = "none";
  }

  // Create and return the style object
  return {
    display: "inline-block",
    fontSize,
    color,
    textShadow,
    transform,
    fontWeight,
    textDecoration,
  };
};

/**
 * Generate a hash value from a job failure string.
 */
const hashJobFailureString = (str: string) => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    // skip whitespace, newlines and digits
    if (char === 32 || char === 10 || (char >= 48 && char <= 57)) {
      continue;
    }
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
};

export default function JobConclusion({
  conclusion,
  classified = false,
  failedPreviousRun = false,
  warningOnly = false,
  jobData,
}: {
  conclusion?: string;
  classified?: boolean;
  failedPreviousRun?: boolean;
  warningOnly?: boolean;
  jobData?: JobData;
}) {
  const style = warningOnly
    ? styles["warning"]
    : classified
    ? styles["classified"]
    : conclusion == JobStatus.Success && failedPreviousRun
    ? styles["flaky"]
    : styles[conclusion ?? "none"];

  const [stylishFailures] = useContext(StylishFailuresContext);

  return (
    <span className={styles.conclusion}>
      <span
        className={style}
        style={getFailureStyle(
          stylishFailures ? conclusion : undefined,
          jobData
        )}
      >
        {getConclusionChar(conclusion, failedPreviousRun)}
      </span>
    </span>
  );
}
