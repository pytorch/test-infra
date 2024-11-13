import React, { Profiler } from "react";
/**
 * Profiler Wrapper to estimate the render time of a component. Notice this is not only log the parent component,
 * but also all children comp's render time.
 *
 * See more details on https://react.dev/reference/react/Profiler.
 * Do not use it in prod, as each use adds some CPU and memory overhead to an application.
 * Only use it for local development to collect metrics.
 *
 * Usage:
 * const MyComponent()=>{
 *   reutrn (
 *      <>
 *         <MeasureRenderTimeProfiler id="My Component">
 *              <ChildComponentICare />
 *         </MeasureRenderTimeProfiler>
 *      </>
 *    )
 * }
 */
const MeasureRenderTimeProfiler = ({
  children,
  id = "Component",
}: {
  children: React.ReactNode;
  id: string;
}) => {
  const onRenderCallback = (
    id: string, // The "id" prop of the Profiler tree that has just committed
    phase: "mount" | "update", // Either "mount" (for initial render) or "update" (for re-renders)
    actualDuration: number, // Time spent rendering the committed update
    baseDuration: number, // Estimated time to render the entire subtree without memoization
    startTime: number, // When React began rendering this update
    commitTime: number // When React committed this update
  ) => {
    const loggingObject = {
      "Profiler ID": id,
      Phase: phase,
      "Actual Duration": `${actualDuration.toFixed(2)} ms`,
      "Base Duration": `${baseDuration.toFixed(2)} ms`,
      "Start Time": `${startTime.toFixed(2)} ms`,
      "Commit Time": `${commitTime.toFixed(2)} ms`,
    };
    console.log(JSON.stringify(loggingObject, null, 2));
  };
  return (
    <Profiler id={id} onRender={onRenderCallback}>
      {children}
    </Profiler>
  );
};

export default MeasureRenderTimeProfiler;
