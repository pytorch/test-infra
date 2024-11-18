import { useEffect, useState } from "react";

export default function JobFilterInput({
  currentFilter,
  handleSubmit,
  width,
  handleFocus,
}: {
  currentFilter: string | null;
  handleSubmit: (f: any) => void;
  handleFocus?: () => void;
  width?: string;
}) {
  const [currVal, setCurrVal] = useState<string>(currentFilter ?? "");
  useEffect(() => {
    // something about hydration and states is making it so that currVal remains
    // as "" when currentFilter changes
    setCurrVal(currentFilter ?? "");
  }, [currentFilter]);
  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSubmit(currVal);
        }}
      >
        <label htmlFor="name_filter">Job filter: </label>
        <input
          style={{ width: width }}
          type="text"
          name="name_filter"
          value={currVal}
          onChange={(e) => setCurrVal(e.target.value)}
          onFocus={handleFocus}
        />
        <input type="submit" value="Go" />
      </form>
    </div>
  );
}
