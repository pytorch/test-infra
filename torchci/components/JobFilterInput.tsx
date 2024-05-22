export default function JobFilterInput({
  currentFilter,
  handleSubmit,
  handleInput,
  width,
  handleFocus,
}: {
  currentFilter: string | null;
  handleSubmit: () => void;
  handleInput: (_value: string) => void;
  handleFocus?: () => void;
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
        <label htmlFor="name_filter">Job filter: </label>
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
