export default function JobFilterInput({
  currentFilter,
  handleSubmit,
  handleInput,
  width,
  handleFocus,
}: {
  currentFilter: string | null;
  handleSubmit: () => void;
  handleInput: (value: string) => void;
  handleFocus: () => void;
  width?: string;
}) {
  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSubmit();
        }}
      >
        <label htmlFor="name_filter">
          Job filter: (press enter to change url, esc to clear):{" "}
        </label>
        <input
          style={{ width: width }}
          onChange={(e) => {
            handleInput(e.currentTarget.value);
          }}
          type="search"
          name="name_filter"
          value={currentFilter || ""}
          onFocus={handleFocus}
        />
        <input type="submit" value="Go" />
      </form>
    </div>
  );
}
